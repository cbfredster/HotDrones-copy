// Drones: tiny quadcopters with spinning rotors, body colour by state (the same
// colours as the 2D view), an ID label and water / battery / damage bars. Positions
// are interpolated between sim ticks; altitude is the sim's own (terrain + droneAltitude).
import { BoxGeometry, Color, Euler, Group, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from "three";
import { terrainHeightAt } from "../../sim/comms";
import { Fire } from "../../sim/environment";
import { World } from "../../sim/world";
import { STATE_COLOUR } from "../renderer";
import { IsoCamera } from "./camera";
import { ParticleLayer } from "./particles";
import { TerrainLayer } from "./terrain";
import { V_SCALE, rgb } from "./util";

const SCALE = 1.15; // drones are drawn a little oversized so they read at map zoom
const ARM_END = 0.335;
const ROTOR_Y = 0.065;
const NOSE = rgb(0x1f2329);
const ARM = rgb(0x2c3037);
const ROTOR = rgb(0xe3e9f0);
const TANK = rgb(0x4cc9f0);
const WRECK = rgb(0x26262a);

// Drones that share a sim position (refilling at the same pond, docked at base) would
// otherwise be drawn exactly on top of each other. Each gets a small fixed offset, and a
// parking slot on the pad while charging. Cosmetic only: under a quarter of a tile in flight.
const SEPARATION = 0.2;
const PAD_SLOT_RADIUS = 0.82;

export class DroneLayer {
  readonly group = new Group();
  /** Interpolated world-space position of each drone. Links and overlays read these. */
  readonly pos: Vector3[] = [];
  /** Screen position (CSS px) of each drone from the last frame, for picking. */
  readonly screenX: Float32Array;
  readonly screenY: Float32Array;

  private readonly bodies: InstancedMesh;
  private readonly noses: InstancedMesh;
  private readonly arms: InstancedMesh;
  private readonly rotors: InstancedMesh;
  private readonly tanks: InstancedMesh;
  private readonly labels: HTMLElement[] = [];
  private readonly bars: { w: HTMLElement; b: HTMLElement; d: HTMLElement }[] = [];
  private readonly shown: Int16Array; // last bar values written to the DOM (percent), per drone x 3

  private readonly prevX: Float32Array;
  private readonly prevY: Float32Array;
  private readonly curX: Float32Array;
  private readonly curY: Float32Array;
  private readonly heading: Float32Array;
  private readonly dock: Float32Array; // 0 = flying, 1 = parked on the pad
  private readonly lastDropped: Int32Array;
  private readonly deadAt: Float64Array;
  private readonly fallFrom: Float32Array;
  private readonly nextPuff: Float64Array;
  private readonly lastState: string[] = [];
  private readonly n: number;

  private readonly m = new Matrix4();
  private readonly local = new Matrix4();
  private readonly out = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler(0, 0, 0, "YXZ");
  private readonly s = new Vector3(SCALE, SCALE, SCALE);
  private readonly p = new Vector3();
  private readonly colour = new Color();
  private readonly armLocal = [new Matrix4().makeRotationY(Math.PI / 4), new Matrix4().makeRotationY(-Math.PI / 4)];
  private readonly screen = { x: 0, y: 0 };

  constructor(
    private world: World,
    private terrain: TerrainLayer,
    private particles: ParticleLayer,
    private labelLayer: HTMLElement,
    private padTopY: number,
  ) {
    const n = (this.n = world.drones.length);
    const cap = Math.max(1, n);
    const lambert = () => new MeshLambertMaterial({ flatShading: true });
    this.bodies = new InstancedMesh(new BoxGeometry(0.36, 0.13, 0.36), lambert(), cap);
    this.noses = new InstancedMesh(new BoxGeometry(0.16, 0.09, 0.12).translate(0, 0.01, 0.22), lambert(), cap);
    this.arms = new InstancedMesh(new BoxGeometry(0.98, 0.045, 0.07), lambert(), cap * 2);
    this.rotors = new InstancedMesh(new BoxGeometry(0.42, 0.016, 0.06), lambert(), cap * 4);
    this.tanks = new InstancedMesh(new BoxGeometry(0.2, 0.12, 0.2).translate(0, -0.06, 0), lambert(), cap);
    for (const [mesh, per] of [[this.bodies, 1], [this.noses, 1], [this.arms, 2], [this.rotors, 4], [this.tanks, 1]] as const) {
      mesh.count = n * per;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }

    this.screenX = new Float32Array(n);
    this.screenY = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevY = new Float32Array(n);
    this.curX = new Float32Array(n);
    this.curY = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.dock = new Float32Array(n);
    this.lastDropped = new Int32Array(n);
    this.deadAt = new Float64Array(n).fill(-1);
    this.fallFrom = new Float32Array(n);
    this.nextPuff = new Float64Array(n);
    this.shown = new Int16Array(n * 3).fill(-1);

    for (const d of world.drones) {
      const k = d.id;
      this.prevX[k] = this.curX[k] = d.x;
      this.prevY[k] = this.curY[k] = d.y;
      this.lastDropped[k] = d.waterDropped;
      this.pos.push(new Vector3(d.x, this.altitude(d.x, d.y), d.y));
      this.noses.setColorAt(k, NOSE);
      this.tanks.setColorAt(k, TANK);
      for (let a = 0; a < 2; a++) this.arms.setColorAt(k * 2 + a, ARM);
      for (let r = 0; r < 4; r++) this.rotors.setColorAt(k * 4 + r, ROTOR);

      const el = document.createElement("div");
      el.className = "dlabel";
      el.innerHTML =
        `<span class="id">${d.id}</span>` +
        `<span class="bars"><i class="w" title="water"><b></b></i><i class="b" title="battery"><b></b></i><i class="d" title="damage"><b></b></i></span>`;
      labelLayer.appendChild(el);
      this.labels.push(el);
      this.bars.push({
        w: el.querySelector(".w b") as HTMLElement,
        b: el.querySelector(".b b") as HTMLElement,
        d: el.querySelector(".d b") as HTMLElement,
      });
      this.lastState.push("");
    }
  }

  /** The sim's flying altitude at a fractional position, in world units. */
  private altitude(x: number, y: number) {
    return (terrainHeightAt(this.world.terrain, x, y) + this.world.cfg.droneAltitude) * V_SCALE;
  }

  /**
   * Call once after every world.step(): snapshots positions for interpolation and
   * turns state changes into effects (water drops, steam, crashes).
   * @param fireBefore the true fire array as it was before this tick
   */
  onTick(time: number, fireBefore: Uint8Array) {
    const world = this.world;
    const w = world.terrain.w;
    const h = world.terrain.h;
    for (const d of world.drones) {
      const k = d.id;
      this.prevX[k] = this.curX[k];
      this.prevY[k] = this.curY[k];
      this.curX[k] = d.x;
      this.curY[k] = d.y;

      if (d.waterDropped > this.lastDropped[k]) {
        this.lastDropped[k] = d.waterDropped;
        const tx = Math.max(0, Math.min(w - 1, Math.round(d.x)));
        const ty = Math.max(0, Math.min(h - 1, Math.round(d.y)));
        const tile = ty * w + tx;
        const ground = this.terrain.topY[tile];
        this.particles.waterDrop(d.x, this.altitude(d.x, d.y), d.y, ground, world.tick * 31 + k);
        if (fireBefore[tile] === Fire.Burning) this.particles.steam(tx, ground, ty, world.tick * 17 + k);
      }

      if (!d.alive && this.deadAt[k] < 0) {
        this.deadAt[k] = time;
        this.fallFrom[k] = this.pos[k].y;
        this.prevX[k] = this.curX[k]; // no more interpolation: it falls where it died
        this.prevY[k] = this.curY[k];
        this.particles.sparks(this.pos[k].x, this.pos[k].y, this.pos[k].z, world.tick * 13 + k);
      }
    }
  }

  /**
   * Per animation frame.
   * @param alpha 0..1 progress from the previous tick to the current one
   */
  update(alpha: number, time: number, dt: number, cam: IsoCamera, viewW: number, viewH: number, selected: number | null) {
    const world = this.world;
    const cfg = world.cfg;
    const n = this.n;
    const ease = 1 - Math.exp(-dt * 9);

    for (const d of world.drones) {
      const k = d.id;
      const sx = this.prevX[k] + (this.curX[k] - this.prevX[k]) * alpha;
      const sy = this.prevY[k] + (this.curY[k] - this.prevY[k]) * alpha;
      const dead = this.deadAt[k] >= 0;

      // Park on the pad while charging.
      const wantDock = d.state === "charging" ? 1 : 0;
      this.dock[k] += (wantDock - this.dock[k]) * (1 - Math.exp(-dt * 4));
      const dock = this.dock[k];
      const ringA = (k / Math.max(1, n)) * Math.PI * 2;
      const goldA = k * 2.399963;
      const offR = SEPARATION * (1 - dock) + PAD_SLOT_RADIUS * dock;
      const offA = goldA * (1 - dock) + ringA * dock;
      const x = sx + Math.cos(offA) * offR;
      const z = sy + Math.sin(offA) * offR;

      let y = this.altitude(sx, sy);
      y += (this.padTopY + 0.1 * SCALE - y) * dock;
      let pitch = 0;
      let roll = 0;

      if (dead) {
        const t = time - this.deadAt[k];
        const ground = this.terrain.topAt(x, z) + 0.08 * SCALE;
        y = this.fallFrom[k] - 2.6 * t * t;
        if (y <= ground) {
          y = ground;
          pitch = -0.32;
          roll = 0.5;
          if (time >= this.nextPuff[k]) {
            this.particles.wreckSmoke(x, y, z, Math.floor(time * 50) + k * 977); // a smoking wreck
            this.nextPuff[k] = time + 0.34;
          }
        } else {
          pitch = t * 7;
          roll = t * 5;
        }
      } else {
        const vx = this.curX[k] - this.prevX[k];
        const vy = this.curY[k] - this.prevY[k];
        const speed = Math.hypot(vx, vy);
        if (speed > 1e-3) {
          const want = Math.atan2(vx, vy); // local +Z is the nose
          let dh = want - this.heading[k];
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          this.heading[k] += dh * ease;
        }
        pitch = Math.min(0.3, (speed / cfg.droneSpeed) * 0.24) * (1 - dock); // lean into the flight
        y += 0.03 * Math.sin(time * 3.1 + k * 1.7) * (1 - dock);
      }

      this.pos[k].set(x, y, z);
      this.e.set(pitch, this.heading[k], roll);
      this.q.setFromEuler(this.e);
      this.m.compose(this.pos[k], this.q, this.s);

      this.bodies.setMatrixAt(k, this.m);
      this.noses.setMatrixAt(k, this.m);
      this.colour.set(STATE_COLOUR[d.state] ?? "#ffffff");
      this.bodies.setColorAt(k, dead ? WRECK : this.colour);

      for (let a = 0; a < 2; a++) this.arms.setMatrixAt(k * 2 + a, this.out.multiplyMatrices(this.m, this.armLocal[a]));

      // Rotors: full speed in flight, idling on the pad, stopped when wrecked.
      const spin = dead ? 0.4 + k : time * (5 + 25 * (1 - dock)) + k;
      for (let r = 0; r < 4; r++) {
        const ex = r < 2 ? ARM_END : -ARM_END;
        const ez = r % 2 === 0 ? ARM_END : -ARM_END;
        this.local.makeRotationY(spin * (r % 2 === 0 ? 1 : -1) + r).setPosition(ex, ROTOR_Y, ez);
        this.rotors.setMatrixAt(k * 4 + r, this.out.multiplyMatrices(this.m, this.local));
      }

      // Water tank under the body: you can see the load shrink with each drop.
      const load = Math.max(0, d.water / cfg.waterCapacity);
      this.local.makeScale(1, Math.max(0.001, load), 1).setPosition(0, -0.065, 0);
      this.tanks.setMatrixAt(k, this.out.multiplyMatrices(this.m, this.local));

      // Label and bars.
      cam.project(this.p.set(x, y, z), viewW, viewH, this.screen);
      this.screenX[k] = this.screen.x;
      this.screenY[k] = this.screen.y;
      const el = this.labels[k];
      el.style.transform = `translate(${this.screen.x.toFixed(1)}px, ${(this.screen.y - 18).toFixed(1)}px) translate(-50%, -100%)`;
      // Climbing (and, if enabled, descending) costs extra battery: mark it on the label.
      let vertical = "";
      if (!dead && d.state !== "charging") {
        const dh =
          terrainHeightAt(world.terrain, this.curX[k], this.curY[k]) - terrainHeightAt(world.terrain, this.prevX[k], this.prevY[k]);
        if (dh > 0.25 && cfg.climbDrain > 0) vertical = " climb";
        else if (dh < -0.25 && cfg.descentDrain > 0) vertical = " descend";
      }
      const state = (dead ? "dead" : d.state) + vertical + (k === selected ? " sel" : "");
      if (state !== this.lastState[k]) {
        this.lastState[k] = state;
        el.className = "dlabel " + state;
      }
      this.setBar(k, 0, this.bars[k].w, load);
      this.setBar(k, 1, this.bars[k].b, d.battery);
      this.setBar(k, 2, this.bars[k].d, d.damage);
    }

    for (const mesh of [this.bodies, this.noses, this.arms, this.rotors, this.tanks]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
  }

  private setBar(k: number, slot: number, el: HTMLElement, value: number) {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 50) * 2; // 2% steps: few DOM writes
    if (this.shown[k * 3 + slot] === pct) return;
    this.shown[k * 3 + slot] = pct;
    el.style.transform = `scaleX(${pct / 100})`;
  }

  dispose() {
    for (const el of this.labels) el.remove();
  }
}
