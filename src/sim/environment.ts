import { Config } from "./config";
import { Rng } from "./rng";
import { FUEL, Terrain, Tile, clamp, neighbours4 } from "./terrain";

export enum Fire {
  Unburnt = 0,
  Burning = 1,
  Burnt = 2,
}

export interface Wind {
  angle: number; // radians, direction the wind blows TOWARDS
  speed: number; // 0..1
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 0.7], [1, -1, 0.7], [-1, 1, 0.7], [-1, -1, 0.7],
];

// The TRUE state of the world. Drones never read this directly — only through
// their sensors (see Drone.sense) — otherwise the decentralisation would be fake.
export class Environment {
  readonly w: number;
  readonly h: number;
  fire: Uint8Array;
  severity: Float32Array; // 0..maxSeverity while burning
  burnLeft: Float32Array; // ticks of fuel left
  waterApplied: Float32Array; // water dropped on a burning tile so far
  wetness: Float32Array; // 0..1 on unburnt tiles, reduces ignition chance
  smoke: Float32Array;
  wind: Wind;
  villageLost = false;
  villageLostAt = -1;
  burntAt: Int32Array; // tick a tile stopped burning (burnt out or extinguished), -1 = n/a
  regrownAt: Int32Array; // tick a burnt tile last grew back, -1 = never
  private everBurnt: Uint8Array;
  private everBurntCount = 0; // tiles that have burned at least once (regrowth can hide them again)
  private smokeBuf: Float32Array;

  /**
   * @param regrowRng regrowth has its own random stream, so switching it on never changes
   *                  which tiles the fire itself would have reached.
   */
  constructor(readonly terrain: Terrain, readonly cfg: Config, private rng: Rng, private regrowRng: Rng = new Rng(1)) {
    this.w = terrain.w;
    this.h = terrain.h;
    const n = this.w * this.h;
    this.fire = new Uint8Array(n);
    this.severity = new Float32Array(n);
    this.burnLeft = new Float32Array(n);
    this.waterApplied = new Float32Array(n);
    this.wetness = new Float32Array(n);
    this.smoke = new Float32Array(n);
    this.smokeBuf = new Float32Array(n);
    this.burntAt = new Int32Array(n).fill(-1);
    this.regrownAt = new Int32Array(n).fill(-1);
    this.everBurnt = new Uint8Array(n);
    this.wind = { angle: rng.range(0, Math.PI * 2), speed: rng.range(0.3, 0.7) };
  }

  idx(x: number, y: number) {
    return y * this.w + x;
  }

  ignite(i: number, severity = 1) {
    const t = this.terrain.type[i] as Tile;
    if (FUEL[t].ignite === 0 || this.fire[i] !== Fire.Unburnt) return false;
    this.fire[i] = Fire.Burning;
    this.severity[i] = severity;
    this.burnLeft[i] = FUEL[t].burnTicks;
    this.waterApplied[i] = 0;
    if (!this.everBurnt[i]) {
      this.everBurnt[i] = 1;
      this.everBurntCount++;
    }
    return true;
  }

  // Start fires upwind of the village so there is a real threat to fight.
  seedIgnitions(count: number) {
    const v = this.terrain.village[4];
    const vx = v % this.w;
    const vy = Math.floor(v / this.w);
    let placed = 0;
    for (let tries = 0; tries < 500 && placed < count; tries++) {
      const dist = this.rng.range(18, 30);
      const ang = this.wind.angle + Math.PI + this.rng.range(-0.8, 0.8); // upwind
      const x = Math.round(vx + Math.cos(ang) * dist);
      const y = Math.round(vy + Math.sin(ang) * dist);
      if (x < 1 || y < 1 || x >= this.w - 1 || y >= this.h - 1) continue;
      if (this.ignite(this.idx(x, y), 1)) placed++;
    }
  }

  burningCount() {
    let c = 0;
    for (let i = 0; i < this.fire.length; i++) if (this.fire[i] === Fire.Burning) c++;
    return c;
  }

  // Area burnt so far. Without regrowth this is simply every tile that is not Unburnt;
  // with it, regrown tiles still count (they did burn), so use the running total.
  burntCount() {
    if (this.cfg.regrowth) return this.everBurntCount;
    let c = 0;
    for (let i = 0; i < this.fire.length; i++) if (this.fire[i] !== Fire.Unburnt) c++;
    return c;
  }

  // Drop one unit of water centred on tile i (also wets the 4 neighbours a little).
  dropWater(i: number, amount: number) {
    const x = i % this.w;
    const y = Math.floor(i / this.w);
    this.applyWater(i, amount);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < this.w && ny < this.h) this.applyWater(this.idx(nx, ny), amount * 0.35);
    }
  }

  private applyWater(i: number, amount: number) {
    if (this.fire[i] === Fire.Burning) {
      this.waterApplied[i] += amount;
      if (this.waterApplied[i] >= Math.max(0.5, this.severity[i]) * this.cfg.waterPerSeverity) {
        this.fire[i] = Fire.Burnt; // extinguished (it still counts as burnt area)
        this.severity[i] = 0;
        this.wetness[i] = 1;
        this.burntAt[i] = this.lastTick;
      }
    } else if (this.fire[i] === Fire.Unburnt) {
      this.wetness[i] = Math.min(1, this.wetness[i] + amount);
    }
  }

  private lastTick = 0;

  step(tick: number) {
    this.lastTick = tick;
    this.stepWind();
    this.stepFire(tick);
    if (this.cfg.regrowth) this.stepRegrowth(tick);
    this.stepSmoke();
  }

  // Burnt ground grows back after cfg.regrowAfter ticks, but only where at least one
  // 4-neighbour is healthy vegetation to reseed it from. Regrown tiles can burn again.
  private stepRegrowth(tick: number) {
    const { w, h, cfg } = this;
    const type = this.terrain.type;
    for (let i = 0; i < this.fire.length; i++) {
      if (this.fire[i] !== Fire.Burnt) continue;
      if (tick - this.burntAt[i] < cfg.regrowAfter) continue;
      if (FUEL[type[i] as Tile].ignite === 0) continue;
      if (!this.hasHealthyNeighbour(i, w, h)) continue;
      if (this.regrowRng.next() < cfg.regrowChance) {
        this.fire[i] = Fire.Unburnt;
        this.severity[i] = 0;
        this.wetness[i] = 0;
        this.waterApplied[i] = 0;
        this.regrownAt[i] = tick;
      }
    }
  }

  /** Is any 4-neighbour of tile i unburnt grass or forest? */
  hasHealthyNeighbour(i: number, w = this.w, h = this.h): boolean {
    const type = this.terrain.type;
    for (const j of neighbours4(i % w, Math.floor(i / w), w, h)) {
      if (this.fire[j] === Fire.Unburnt && FUEL[type[j] as Tile].ignite > 0) return true;
    }
    return false;
  }

  private stepWind() {
    if (!this.cfg.windDrift) return;
    this.wind.angle += this.rng.normal() * 0.01;
    this.wind.speed = clamp(this.wind.speed + this.rng.normal() * 0.005, 0.1, 1);
  }

  private stepFire(tick: number) {
    const { w, h, cfg } = this;
    const { type, height, village } = this.terrain;
    const wx = Math.cos(this.wind.angle);
    const wy = Math.sin(this.wind.angle);
    const newFires: [number, number][] = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (this.wetness[i] > 0 && this.fire[i] === Fire.Unburnt) this.wetness[i] = Math.max(0, this.wetness[i] - cfg.wetDecay);
        if (this.fire[i] !== Fire.Burning) continue;

        // Burning: grow in severity, use up fuel.
        this.severity[i] = Math.min(cfg.maxSeverity, this.severity[i] + cfg.severityGrowth);
        this.burnLeft[i] -= 1;
        if (this.burnLeft[i] <= 0) {
          this.fire[i] = Fire.Burnt;
          this.severity[i] = 0;
          this.burntAt[i] = tick;
          continue;
        }

        // Spread to neighbours.
        const sev = this.severity[i];
        for (const [dx, dy, dw] of DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (this.fire[j] !== Fire.Unburnt) continue;
          const fuel = FUEL[type[j] as Tile].ignite;
          if (fuel === 0) continue;
          const len = Math.hypot(dx, dy);
          const windF = Math.exp(cfg.windStrength * this.wind.speed * ((dx * wx + dy * wy) / len));
          const slopeF = Math.exp(clamp(cfg.slopeStrength * (height[j] - height[i]), -1.5, 1.5));
          const sevF = 0.5 + sev / cfg.maxSeverity;
          const p = cfg.spreadBase * fuel * windF * slopeF * sevF * dw * (1 - this.wetness[j]);
          if (this.rng.next() < p) newFires.push([j, Math.max(1, sev * 0.6)]);
        }

        // Embers: intense fires occasionally throw a spot fire downwind.
        if (cfg.embers && sev > 2.2 && this.rng.next() < 0.0015 * this.wind.speed) {
          const d = this.rng.range(4, 9);
          const ex = Math.round(x + wx * d + this.rng.normal());
          const ey = Math.round(y + wy * d + this.rng.normal());
          if (ex >= 0 && ey >= 0 && ex < w && ey < h) newFires.push([ey * w + ex, 1]);
        }
      }
    }
    for (const [j, s] of newFires) this.ignite(j, s);

    if (!this.villageLost) {
      for (const v of village) {
        if (this.fire[v] === Fire.Burning) {
          this.villageLost = true;
          this.villageLostAt = tick;
          break;
        }
      }
    }
  }

  // Smoke is emitted by burning tiles, drifts downwind, spreads slightly and fades.
  private stepSmoke() {
    const { w, h, cfg } = this;
    const src = this.smoke;
    const dst = this.smokeBuf;
    const vx = Math.cos(this.wind.angle) * this.wind.speed * 0.8;
    const vy = Math.sin(this.wind.angle) * this.wind.speed * 0.8;
    const massed = cfg.smokeModel === "massed";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Semi-Lagrangian advection: look back along the wind.
        const sx = clamp(x - vx, 0, w - 1.001);
        const sy = clamp(y - vy, 0, h - 1.001);
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const a = src[y0 * w + x0];
        const b = src[y0 * w + Math.min(w - 1, x0 + 1)];
        const c = src[Math.min(h - 1, y0 + 1) * w + x0];
        const d = src[Math.min(h - 1, y0 + 1) * w + Math.min(w - 1, x0 + 1)];
        let v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        const i = y * w + x;
        if (this.fire[i] === Fire.Burning) {
          let emit = cfg.smokeEmission * this.severity[i];
          if (massed) {
            // Smoke needs several burning tiles: scale by how much of the surrounding 3x3
            // block is alight, squared, so a lone tile (or a pair) only ever makes a wisp.
            const m = Math.min(1, this.burningAround(x, y) / cfg.smokeMassTiles);
            emit *= m * m;
          }
          v += emit;
        }
        dst[i] = v * cfg.smokeDecay;
      }
    }
    this.smoke = dst;
    this.smokeBuf = src;
  }

  /** Burning tiles in the 3x3 block centred on (x, y), the centre included. */
  burningAround(x: number, y: number): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= this.h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < this.w && this.fire[yy * this.w + xx] === Fire.Burning) n++;
      }
    }
    return n;
  }

  // Smoke density at a fractional position (used for sensing / damage).
  smokeAt(x: number, y: number) {
    const ix = clamp(Math.round(x), 0, this.w - 1);
    const iy = clamp(Math.round(y), 0, this.h - 1);
    return this.smoke[iy * this.w + ix];
  }
}
