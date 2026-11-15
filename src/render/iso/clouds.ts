// The opening sky: big, soft cartoon clouds in a blue sky, hiding the map until the run
// starts, then parting from the middle outwards to reveal it.
// Purely cosmetic: it never reads or writes the sim (all shapes come from hash01).
//
// Each cloud is a classic cartoon cumulus: a flat underside with round billows heaped on
// top, the biggest in the middle. Cel shading (MeshToonMaterial) gives the clean two-tone
// white and soft-blue look. The map itself is hidden while covered (see IsoRenderer), so
// the gaps between clouds show open sky.
import {
  Color,
  DataTexture,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshToonMaterial,
  NearestFilter,
  Quaternion,
  RedFormat,
  SphereGeometry,
  Vector3,
} from "three";
import { TerrainLayer } from "./terrain";
import { addInstanceAlpha, clamp01, hash01, withInstanceAlpha } from "./util";

const MARGIN = 22; // clouds reach this far beyond the map
const SPACING = 11; // between cloud centres (jittered)
const DRIFT = 50; // how far a billow travels while clearing
const SPREAD = 0.8; // seconds between the centre clearing and the edges starting to
const SKY_DRIFT = 0.35; // units per second the clouds idle sideways while waiting

export type CloudState = "covered" | "clearing" | "clear";

interface Billow {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rot: Quaternion;
  dx: number; // outward direction
  dz: number;
  rise: number;
  delay: number; // 0..1: share of SPREAD before this billow starts to move
  phase: number;
}

/** Three hard steps of light: lit white, a soft blue mid-tone, and a slightly deeper shade. */
function toonRamp(): DataTexture {
  const tex = new DataTexture(new Uint8Array([95, 175, 255]), 3, 1, RedFormat);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class CloudLayer {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly alpha: InstancedBufferAttribute;
  private readonly billows: Billow[] = [];
  private stateNow: CloudState = "clear";
  private t = 0;
  private startedAt = -1; // wall-clock start of clearing: slow frames must not slow the reveal down
  private duration = 2.6;
  private onDone: (() => void) | null = null;
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly span: number;

  constructor(terrain: TerrainLayer) {
    const { w, h, maxY } = terrain;
    const cx = (w - 1) / 2;
    const cz = (h - 1) / 2;
    const maxD = Math.hypot(w / 2 + MARGIN, h / 2 + MARGIN);
    this.span = w + 2 * MARGIN;
    const euler = new Euler();
    let c = 0;

    for (let gz = -MARGIN; gz <= h + MARGIN; gz += SPACING) {
      for (let gx = -MARGIN; gx <= w + MARGIN; gx += SPACING) {
        c++;
        if (hash01(c, 1) < 0.12) continue; // a patch of open sky
        const ox = gx + (hash01(c, 2) - 0.5) * SPACING * 0.9;
        const oz = gz + (hash01(c, 3) - 0.5) * SPACING * 0.9;
        const size = 2.6 + hash01(c, 4) * 2.4; // radius of the biggest billow
        const baseY = maxY + 4 + hash01(c, 5) * 6; // clouds float at different heights
        const heading = hash01(c, 6) * Math.PI; // clouds are longer one way than the other
        const long = 1.6 + hash01(c, 7) * 0.9;
        const n = 5 + Math.floor(hash01(c, 8) * 5);
        for (let b = 0; b < n; b++) {
          const k = c * 32 + b;
          // Billows along the cloud's long axis: big in the middle, smaller at the ends.
          const along = b === 0 ? 0 : (hash01(k, 10) - 0.5) * 2 * size * long;
          const across = (hash01(k, 11) - 0.5) * size * 0.9;
          const fromMid = Math.abs(along) / (size * long);
          const r = size * (b === 0 ? 1 : 0.55 + (1 - fromMid) * 0.4 + hash01(k, 12) * 0.15);
          const x = ox + Math.cos(heading) * along - Math.sin(heading) * across;
          const z = oz + Math.sin(heading) * along + Math.cos(heading) * across;
          // Sit each billow on the shared flat base, so the cloud has a flat underside.
          const y = baseY + r * 0.35;
          this.addBillow(x, y, z, r * (1 + hash01(k, 13) * 0.25), r * 0.8, r, k, cx, cz, maxD, euler);
        }
        // The flat base that ties the billows together.
        const k = c * 32 + 31;
        this.addBillow(ox, baseY + size * 0.15, oz, size * long * 1.25, size * 0.32, size * 1.05, k, cx, cz, maxD, euler, heading);
      }
    }

    const mat = withInstanceAlpha(
      new MeshToonMaterial({ color: new Color(0xffffff), gradientMap: toonRamp(), emissive: new Color(0x7fb0e6), emissiveIntensity: 0.2 }),
    );
    this.mesh = new InstancedMesh(new SphereGeometry(1, 18, 12), mat, this.billows.length);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.castShadow = true;
    this.alpha = addInstanceAlpha(this.mesh, this.billows.length);
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  private addBillow(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    key: number,
    cx: number,
    cz: number,
    maxD: number,
    euler: Euler,
    heading?: number,
  ) {
    let dx = x - cx;
    let dz = z - cz;
    const d = Math.hypot(dx, dz) || 1;
    const swirl = (hash01(key, 20) - 0.5) * 0.5;
    const ux = dx / d;
    const uz = dz / d;
    dx = ux * Math.cos(swirl) - uz * Math.sin(swirl);
    dz = ux * Math.sin(swirl) + uz * Math.cos(swirl);
    euler.set(0, heading !== undefined ? -heading : hash01(key, 21) * Math.PI * 2, 0);
    this.billows.push({
      x,
      y,
      z,
      sx,
      sy,
      sz,
      rot: new Quaternion().setFromEuler(euler),
      dx,
      dz,
      rise: 2 + hash01(key, 22) * 4,
      delay: clamp01(d / maxD + (hash01(key, 23) - 0.5) * 0.12),
      phase: hash01(key, 24) * Math.PI * 2,
    });
  }

  get state() {
    return this.stateNow;
  }

  /** 0 while covered, rising to 1 as the clouds finish clearing. */
  get progress() {
    if (this.stateNow === "covered") return 0;
    if (this.stateNow === "clear") return 1;
    return clamp01(this.t / this.duration);
  }

  /** Cover the map at once. */
  cover() {
    this.stateNow = "covered";
    this.t = 0;
    this.onDone = null;
    this.group.visible = true;
    this.place(0);
  }

  /** Remove the clouds at once. */
  hide() {
    this.stateNow = "clear";
    this.group.visible = false;
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /** Part the clouds from the middle outwards over `seconds`, then call `done`. */
  clear(seconds: number, done?: () => void) {
    if (this.stateNow === "clear") {
      done?.();
      return;
    }
    this.stateNow = "clearing";
    this.duration = Math.max(0.2, seconds);
    this.t = 0;
    this.startedAt = -1;
    this.onDone = done ?? null;
  }

  update(_dt: number, now: number) {
    if (this.stateNow === "clear") return;
    if (this.stateNow === "clearing") {
      if (this.startedAt < 0) this.startedAt = now;
      this.t = now - this.startedAt;
      if (this.t >= this.duration) return this.hide();
    }
    this.place(now);
  }

  private place(now: number) {
    const moveTime = Math.max(0.1, this.duration - SPREAD);
    const clearing = this.stateNow === "clearing";
    // A slow sideways drift while waiting, wrapped so the sky never empties.
    const drift = (now * SKY_DRIFT) % this.span;
    for (let i = 0; i < this.billows.length; i++) {
      const b = this.billows[i];
      const bob = Math.sin(now * 0.5 + b.phase) * 0.1;
      const k = clearing ? clamp01((this.t - b.delay * SPREAD) / moveTime) : 0;
      const ease = k * k * (3 - 2 * k);
      const grow = 1 + 0.3 * ease;
      let x = b.x + drift * 0.4;
      if (x > this.span - MARGIN) x -= this.span;
      this.p.set(x + b.dx * DRIFT * ease, b.y + bob + b.rise * ease, b.z + b.dz * DRIFT * ease);
      this.s.set(b.sx * grow, b.sy * grow, b.sz * grow);
      this.m.compose(this.p, b.rot, this.s);
      this.mesh.setMatrixAt(i, this.m);
      (this.alpha.array as Float32Array)[i] = 1 - clamp01((k - 0.35) / 0.55);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}
