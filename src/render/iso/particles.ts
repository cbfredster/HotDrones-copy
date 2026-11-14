// A small pool of voxel particles for one-off effects: falling water, steam, wreck
// smoke, sparks. Purely cosmetic and driven by its own hash-seeded generator.
import { BoxGeometry, Color, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial } from "three";
import { CosmeticRng, addInstanceAlpha, rgb, setInstance, uploadUsed, withInstanceAlpha } from "./util";

const CAPACITY = 2400;
const WATER = [rgb(0x4cc9f0), rgb(0x2f9df2), rgb(0x9be4ff)];
const STEAM = rgb(0xf2f6fa);
const SOOT = rgb(0x2b2b30);
const SPARK = [rgb(0xffd23f), rgb(0xff7a1a), rgb(0xff3b1f)];

export class ParticleLayer {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly alphaAttr: InstancedBufferAttribute;
  private n = 0;
  private readonly px = new Float32Array(CAPACITY);
  private readonly py = new Float32Array(CAPACITY);
  private readonly pz = new Float32Array(CAPACITY);
  private readonly vx = new Float32Array(CAPACITY);
  private readonly vy = new Float32Array(CAPACITY);
  private readonly vz = new Float32Array(CAPACITY);
  private readonly age = new Float32Array(CAPACITY);
  private readonly life = new Float32Array(CAPACITY);
  private readonly size = new Float32Array(CAPACITY);
  private readonly grow = new Float32Array(CAPACITY); // size multiplier gained over the lifetime
  private readonly gravity = new Float32Array(CAPACITY);
  private readonly floor = new Float32Array(CAPACITY); // particle dies when it falls below this
  private readonly opacity = new Float32Array(CAPACITY);
  private readonly col = new Float32Array(CAPACITY * 3);
  private readonly tmp = new Color();

  constructor() {
    const mat = withInstanceAlpha(new MeshBasicMaterial({ toneMapped: false, depthWrite: false }));
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.setColorAt(0, this.tmp.set(0xffffff));
    this.alphaAttr = addInstanceAlpha(this.mesh, CAPACITY);
    this.group.add(this.mesh);
  }

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, colour: Color,
    gravity = 0, grow = 0, opacity = 1, floor = -1e9,
  ) {
    if (this.n >= CAPACITY) return;
    const k = this.n++;
    this.px[k] = x; this.py[k] = y; this.pz[k] = z;
    this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    this.age[k] = 0; this.life[k] = life; this.size[k] = size;
    this.grow[k] = grow; this.gravity[k] = gravity; this.floor[k] = floor; this.opacity[k] = opacity;
    colour.toArray(this.col, k * 3);
  }

  /** A load of water falling from a drone onto the ground. */
  waterDrop(x: number, y: number, z: number, groundY: number, seed: number) {
    const r = new CosmeticRng(seed);
    for (let k = 0; k < 16; k++) {
      this.spawn(
        x + r.range(-0.18, 0.18), y - 0.08 - r.range(0, 0.12), z + r.range(-0.18, 0.18),
        r.range(-0.35, 0.35), r.range(-0.4, 0.3), r.range(-0.35, 0.35),
        1.6, r.range(0.07, 0.13), WATER[k % WATER.length],
        7, 0, 0.95, groundY,
      );
    }
  }

  /** White puffs boiling off a tile that was on fire when the water landed. */
  steam(x: number, groundY: number, z: number, seed: number) {
    const r = new CosmeticRng(seed);
    for (let k = 0; k < 9; k++) {
      this.spawn(
        x + r.range(-0.3, 0.3), groundY + r.range(0.05, 0.25), z + r.range(-0.3, 0.3),
        r.range(-0.15, 0.15), r.range(0.5, 1.0), r.range(-0.15, 0.15),
        r.range(0.9, 1.5), r.range(0.11, 0.18), STEAM,
        -0.15, 1.5, 0.75,
      );
    }
  }

  /** One dark puff rising from a wreck. */
  wreckSmoke(x: number, y: number, z: number, seed: number) {
    const r = new CosmeticRng(seed);
    this.spawn(
      x + r.range(-0.08, 0.08), y + 0.1, z + r.range(-0.08, 0.08),
      r.range(-0.06, 0.06), r.range(0.35, 0.6), r.range(-0.06, 0.06),
      r.range(1.4, 2.2), r.range(0.1, 0.16), SOOT,
      0, 1.8, 0.7,
    );
  }

  /** Sparks and debris when a drone is destroyed, or a judge starts a fire. */
  sparks(x: number, y: number, z: number, seed: number, count = 14) {
    const r = new CosmeticRng(seed);
    for (let k = 0; k < count; k++) {
      const a = r.range(0, Math.PI * 2);
      const s = r.range(0.6, 1.8);
      this.spawn(
        x, y, z,
        Math.cos(a) * s, r.range(0.8, 2.2), Math.sin(a) * s,
        r.range(0.4, 0.9), r.range(0.05, 0.1), SPARK[k % SPARK.length],
        6, 0, 1,
      );
    }
  }

  update(dt: number) {
    let k = 0;
    while (k < this.n) {
      this.age[k] += dt;
      this.vy[k] -= this.gravity[k] * dt;
      this.px[k] += this.vx[k] * dt;
      this.py[k] += this.vy[k] * dt;
      this.pz[k] += this.vz[k] * dt;
      if (this.age[k] >= this.life[k] || this.py[k] < this.floor[k]) {
        this.kill(k); // swap-remove: re-check slot k
        continue;
      }
      k++;
    }
    const alpha = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const t = this.age[i] / this.life[i];
      const s = this.size[i] * (1 + this.grow[i] * t);
      setInstance(this.mesh, i, this.px[i], this.py[i], this.pz[i], s, s, s);
      this.mesh.setColorAt(i, this.tmp.fromArray(this.col, i * 3));
      alpha[i] = this.opacity[i] * (1 - t * t); // hold, then fade
    }
    this.mesh.count = this.n;
    uploadUsed(this.mesh.instanceMatrix, this.n);
    uploadUsed(this.mesh.instanceColor, this.n);
    uploadUsed(this.alphaAttr, this.n);
  }

  private kill(k: number) {
    const last = --this.n;
    if (k === last) return;
    this.px[k] = this.px[last]; this.py[k] = this.py[last]; this.pz[k] = this.pz[last];
    this.vx[k] = this.vx[last]; this.vy[k] = this.vy[last]; this.vz[k] = this.vz[last];
    this.age[k] = this.age[last]; this.life[k] = this.life[last]; this.size[k] = this.size[last];
    this.grow[k] = this.grow[last]; this.gravity[k] = this.gravity[last];
    this.floor[k] = this.floor[last]; this.opacity[k] = this.opacity[last];
    this.col.copyWithin(k * 3, last * 3, last * 3 + 3);
  }
}
