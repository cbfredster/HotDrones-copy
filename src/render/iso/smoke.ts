// Smoke: grey, semi-transparent low-poly puffs over every tile that env.smoke says is
// smoky. Opacity and darkness follow density; puffs slide downwind (wind.angle is the
// direction the wind blows TOWARDS) and sit at about drone altitude, so a drone that
// the sim says is in smoke is visibly in it.
import { Color, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, MeshLambertMaterial } from "three";
import { World } from "../../sim/world";
import { TerrainLayer } from "./terrain";
import { V_SCALE, addInstanceAlpha, clamp01, hash01, mixColor, rgb, setInstance, uploadUsed, withInstanceAlpha } from "./util";

const THRESHOLD = 0.05; // below this a tile gets no puff
const MAX_TILES = 1800;
const PUFFS_PER_TILE = 2; // half a cycle apart, so coverage stays even as each one fades
const THIN = rgb(0xc2c5ca);
const THICK = rgb(0x4f5257);

export class SmokeLayer {
  readonly group = new Group();
  private readonly puffs: InstancedMesh;
  private readonly alpha: InstancedBufferAttribute;
  private readonly order: Uint32Array; // tiles in a fixed shuffled order, so hitting the cap thins evenly
  private readonly active = new Uint32Array(MAX_TILES);
  private readonly density = new Float32Array(MAX_TILES);
  private activeCount = 0;
  private readonly tmp = new Color();

  constructor(private world: World, private terrain: TerrainLayer) {
    const n = terrain.w * terrain.h;
    const geo = new IcosahedronGeometry(0.5, 0);
    const mat = withInstanceAlpha(new MeshLambertMaterial({ flatShading: true, depthWrite: false }));
    this.puffs = new InstancedMesh(geo, mat, MAX_TILES * PUFFS_PER_TILE);
    this.puffs.count = 0;
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = 5;
    this.puffs.setColorAt(0, this.tmp.set(0xffffff));
    this.alpha = addInstanceAlpha(this.puffs, MAX_TILES * PUFFS_PER_TILE);
    this.group.add(this.puffs);

    this.order = new Uint32Array(n);
    const keyed = Array.from({ length: n }, (_, i) => [hash01(i, 41), i] as const).sort((a, b) => a[0] - b[0]);
    keyed.forEach(([, i], k) => (this.order[k] = i));
  }

  /** Rebuild the list of smoky tiles. Call when the sim has advanced. */
  sync() {
    const smoke = this.world.env.smoke;
    let k = 0;
    for (let j = 0; j < this.order.length && k < MAX_TILES; j++) {
      const i = this.order[j];
      const d = smoke[i];
      if (d > THRESHOLD) {
        this.active[k] = i;
        this.density[k] = d;
        k++;
      }
    }
    this.activeCount = k;
  }

  update(time: number, visible: boolean) {
    this.group.visible = visible;
    if (!visible) return;
    const { w, topY } = this.terrain;
    const cfg = this.world.cfg;
    const wind = this.world.env.wind;
    const wx = Math.cos(wind.angle);
    const wz = Math.sin(wind.angle);
    const drift = 0.18 + 0.75 * wind.speed; // cycles per second: faster wind, faster drift
    const baseAlt = (cfg.droneAltitude + 0.4) * V_SCALE;
    const c = this.tmp;
    const alpha = this.alpha.array as Float32Array;

    let k = 0;
    for (let a = 0; a < this.activeCount; a++) {
      const i = this.active[a];
      const d = this.density[a];
      const x = i % w;
      const y = (i - x) / w;
      const thick = clamp01(d / (cfg.thickSmoke * 2)); // 0 = wisp, 1 = dense enough to block radio
      const size = 0.8 + 0.6 * thick;
      const opacity = Math.min(0.62, 0.1 + 0.6 * clamp01(d / (cfg.thickSmoke * 1.6)));
      mixColor(c, THIN, THICK, thick);
      for (let p = 0; p < PUFFS_PER_TILE; p++) {
        const seed = hash01(i, 42 + p);
        const phase = (time * drift * (0.8 + 0.4 * seed) + seed + p / PUFFS_PER_TILE) % 1;
        const slide = phase - 0.5; // -0.5 .. 0.5 tiles along the wind
        const fade = Math.sin(Math.PI * phase); // fade in upwind, out downwind: hides the wrap
        const bob = 0.1 * Math.sin(time * 0.9 + seed * 6.283);
        setInstance(
          this.puffs,
          k,
          x + wx * slide * 1.2 + (seed - 0.5) * 0.3,
          topY[i] + baseAlt + bob + 0.25 * thick + 0.18 * p,
          y + wz * slide * 1.2 + (hash01(i, 44 + p) - 0.5) * 0.3,
          size,
          size * (0.7 + 0.35 * thick),
          size,
          seed * 6.283,
        );
        this.puffs.setColorAt(k, c);
        alpha[k] = opacity * fade;
        k++;
      }
    }
    this.puffs.count = k;
    uploadUsed(this.puffs.instanceMatrix, k);
    uploadUsed(this.puffs.instanceColor, k);
    uploadUsed(this.alpha, k);
  }
}
