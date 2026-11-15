// The opening cloud cover: a thick layer of chunky low-poly clouds hiding the whole map
// until the run starts, then parting from the middle outwards to reveal it.
// Purely cosmetic: it never reads or writes the sim (positions come from hash01).
import { Color, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, MeshLambertMaterial } from "three";
import { TerrainLayer } from "./terrain";
import { addInstanceAlpha, clamp01, hash01, setInstance, withInstanceAlpha } from "./util";

const MARGIN = 20; // clouds extend this far beyond the map, so the slab's sides and the corners are hidden too
const SPACING = 3.2; // distance between cloud clumps
const PUFFS_PER_CLUMP = 4;
const DRIFT = 46; // how far a puff travels while clearing
const SPREAD = 0.75; // seconds between the centre clearing and the edges starting to

export type CloudState = "covered" | "clearing" | "clear";

interface Puff {
  x: number;
  y: number;
  z: number;
  r: number; // radius
  dx: number; // outward direction
  dz: number;
  delay: number; // 0..1: share of SPREAD before this puff starts to move
  phase: number; // for the idle bob
  shade: number;
}

export class CloudLayer {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly alpha: InstancedBufferAttribute;
  private readonly puffs: Puff[] = [];
  private stateNow: CloudState = "clear";
  private t = 0; // seconds since clearing began
  private startedAt = -1; // wall-clock start of clearing: slow frames must not slow the reveal down
  private duration = 2.6;
  private onDone: (() => void) | null = null;

  constructor(terrain: TerrainLayer) {
    const { w, h, maxY } = terrain;
    const cx = (w - 1) / 2;
    const cz = (h - 1) / 2;
    const maxD = Math.hypot(w / 2 + MARGIN, h / 2 + MARGIN);
    const baseY = maxY + 3.2; // above the tallest hill, mast and drone

    let k = 0;
    for (let gz = -MARGIN; gz <= h + MARGIN; gz += SPACING) {
      for (let gx = -MARGIN; gx <= w + MARGIN; gx += SPACING) {
        const c = k++;
        const jx = gx + (hash01(c, 1) - 0.5) * SPACING * 0.8;
        const jz = gz + (hash01(c, 2) - 0.5) * SPACING * 0.8;
        const clumpY = baseY + hash01(c, 3) * 1.6;
        for (let p = 0; p < PUFFS_PER_CLUMP; p++) {
          const a = hash01(c, 10 + p) * Math.PI * 2;
          const off = p === 0 ? 0 : 0.9 + hash01(c, 20 + p) * 1.1;
          const x = jx + Math.cos(a) * off;
          const z = jz + Math.sin(a) * off;
          let dx = x - cx;
          let dz = z - cz;
          const d = Math.hypot(dx, dz) || 1;
          // Outward, with a little swirl so the parting doesn't look mechanical.
          const swirl = (hash01(c, 30 + p) - 0.5) * 0.6;
          const ux = dx / d;
          const uz = dz / d;
          dx = ux * Math.cos(swirl) - uz * Math.sin(swirl);
          dz = ux * Math.sin(swirl) + uz * Math.cos(swirl);
          this.puffs.push({
            x,
            y: clumpY + (p === 0 ? 0.4 : hash01(c, 40 + p) * 0.6),
            z,
            r: (p === 0 ? 2.1 : 1.3) + hash01(c, 50 + p) * 0.9,
            dx,
            dz,
            delay: clamp01(d / maxD + (hash01(c, 60 + p) - 0.5) * 0.15),
            phase: hash01(c, 70 + p) * Math.PI * 2,
            shade: 0.9 + hash01(c, 80 + p) * 0.1,
          });
        }
      }
    }

    const geo = new IcosahedronGeometry(1, 1);
    const mat = withInstanceAlpha(new MeshLambertMaterial({ flatShading: true, emissive: new Color(0x9aa6b8), emissiveIntensity: 0.35 }));
    this.mesh = new InstancedMesh(geo, mat, this.puffs.length);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20; // after the smoke
    this.mesh.castShadow = true; // their shadows sweep off the map as they part
    const col = new Color();
    this.puffs.forEach((p, i) => this.mesh.setColorAt(i, col.setRGB(p.shade, p.shade, Math.min(1, p.shade + 0.04))));
    this.alpha = addInstanceAlpha(this.mesh, this.puffs.length);
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  get state() {
    return this.stateNow;
  }

  /** Cover the map at once. */
  cover() {
    this.stateNow = "covered";
    this.t = 0;
    this.onDone = null;
    this.group.visible = true;
    this.place(0, 0);
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

  update(dt: number, now: number) {
    if (this.stateNow === "clear") return;
    if (this.stateNow === "clearing") {
      if (this.startedAt < 0) this.startedAt = now;
      this.t = now - this.startedAt;
      if (this.t >= this.duration) return this.hide();
    }
    void dt;
    this.place(this.stateNow === "clearing" ? this.t : 0, now);
  }

  private place(t: number, now: number) {
    const moveTime = Math.max(0.1, this.duration - SPREAD);
    const alpha = this.alpha.array as Float32Array;
    for (let i = 0; i < this.puffs.length; i++) {
      const p = this.puffs[i];
      const bob = Math.sin(now * 0.6 + p.phase) * 0.12;
      let k = 0;
      if (this.stateNow === "clearing") k = clamp01((t - p.delay * SPREAD) / moveTime);
      const ease = k * k * (3 - 2 * k); // smoothstep: eases in and out
      const s = p.r * (1 + 0.35 * ease);
      setInstance(
        this.mesh,
        i,
        p.x + p.dx * DRIFT * ease,
        p.y + bob + 5 * ease,
        p.z + p.dz * DRIFT * ease,
        s,
        s * 0.62,
        s,
        p.phase,
      );
      alpha[i] = 1 - clamp01((k - 0.35) / 0.55);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}
