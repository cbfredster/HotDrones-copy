// The opening cloud cover: a thick, lumpy layer of low-poly clouds hiding the whole map
// until the run starts, then parting from the middle outwards to reveal it.
// Purely cosmetic: it never reads or writes the sim (all shapes come from hash01).
//
// Irregularity comes from four places:
//   - two lumpy puff shapes (icosahedra with their vertices pushed in and out);
//   - every puff stretched differently on each axis and tumbled to its own angle;
//   - clumps of different kinds: low flat banks, rounded heaps, and tall towers;
//   - clumps scattered with uneven gaps, over a low base deck that keeps the map hidden.
//
// The clouds are laid out over exactly what the camera can see (fit()), not just over
// the map, so the corners of the screen are covered too.
import { BufferGeometry, Color, Euler, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from "three";
import { TerrainLayer } from "./terrain";
import { addInstanceAlpha, clamp01, hash01, withInstanceAlpha } from "./util";

const MARGIN = 20; // fallback only: how far beyond the map the clouds reach when the view is unknown
const SCREEN_PAD = 0.14; // extra beyond each screen edge, as a share of the view, so taller clouds don't leave gaps
const DECK_SPACING = 4.2; // the low base deck
const CLUMP_SPACING = 7.5; // the lumpy clouds on top of it
const DRIFT = 46; // how far a puff travels while clearing
const SPREAD = 0.75; // seconds between the centre clearing and the edges starting to

export type CloudState = "covered" | "clearing" | "clear";

interface Puff {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rot: Quaternion;
  dx: number; // outward direction
  dz: number;
  rise: number; // how far it lifts while clearing
  delay: number; // 0..1: share of SPREAD before this puff starts to move
  phase: number; // for the idle bob
  shade: number;
  mesh: number; // which lumpy shape
  slot: number; // instance index within that mesh
}

/** An icosahedron with every vertex pushed in or out a little: one lumpy cloud puff. */
function lumpyPuff(seed: number): BufferGeometry {
  const geo = new IcosahedronGeometry(1, 1);
  const pos = geo.getAttribute("position");
  const v = new Vector3();
  // The geometry is non-indexed, so a corner shared by several faces appears several times:
  // key each corner by its rounded position so all copies move together and the shape stays closed.
  const bump = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let k = bump.get(key);
    if (k === undefined) {
      k = 0.86 + hash01(seed, bump.size) * 0.26;
      if (v.y < -0.35) k *= 0.85; // flatter underside, like a real cumulus
      bump.set(key, k);
    }
    v.multiplyScalar(k);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export class CloudLayer {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  private readonly alphas: InstancedBufferAttribute[] = [];
  private readonly puffs: Puff[] = [];
  private stateNow: CloudState = "clear";
  private t = 0; // seconds since clearing began
  private startedAt = -1; // wall-clock start of clearing: slow frames must not slow the reveal down
  private duration = 2.6;
  private onDone: (() => void) | null = null;
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly s = new Vector3();

  private readonly cx: number;
  private readonly cz: number;
  readonly deckY: number;

  constructor(private readonly terrain: TerrainLayer) {
    this.cx = (terrain.w - 1) / 2;
    this.cz = (terrain.h - 1) / 2;
    this.deckY = terrain.maxY + 3.0; // above the tallest hill, mast and drone
    this.group.visible = false;
  }

  /**
   * Lay the clouds out over the parallelogram of ground the camera sees at the cloud deck's
   * height. `corners` are the screen's top-left, top-right, bottom-left and bottom-right
   * corners projected onto that height (IsoCamera.screenCornersAt). Without corners, cover
   * the map plus a margin.
   */
  fit(corners?: Vector3[]) {
    const { w, h } = this.terrain;
    let o: { x: number; z: number };
    let e1: { x: number; z: number };
    let e2: { x: number; z: number };
    if (corners && corners.length === 4) {
      const [tl, tr, bl] = corners;
      e1 = { x: tr.x - tl.x, z: tr.z - tl.z }; // across the screen
      e2 = { x: bl.x - tl.x, z: bl.z - tl.z }; // down the screen
      // Grow the area by SCREEN_PAD on every side.
      o = { x: tl.x - (e1.x + e2.x) * SCREEN_PAD, z: tl.z - (e1.z + e2.z) * SCREEN_PAD };
      const g = 1 + 2 * SCREEN_PAD;
      e1 = { x: e1.x * g, z: e1.z * g };
      e2 = { x: e2.x * g, z: e2.z * g };
    } else {
      o = { x: -MARGIN, z: -MARGIN };
      e1 = { x: w + 2 * MARGIN, z: 0 };
      e2 = { x: 0, z: h + 2 * MARGIN };
    }
    // Rebuild from scratch.
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as MeshLambertMaterial).dispose();
    }
    this.meshes.length = 0;
    this.alphas.length = 0;
    this.puffs.length = 0;

    const { cx, cz, deckY } = this;
    const far = [
      [o.x, o.z],
      [o.x + e1.x, o.z + e1.z],
      [o.x + e2.x, o.z + e2.z],
      [o.x + e1.x + e2.x, o.z + e1.z + e2.z],
    ];
    const maxD = Math.max(...far.map(([x, z]) => Math.hypot(x - cx, z - cz)));
    const euler = new Euler();
    let seed = 0;
    // Visit points `spacing` apart across the area: cb(x, z).
    const scatter = (spacing: number, cb: (x: number, z: number) => void) => {
      const n1 = Math.max(1, Math.ceil(Math.hypot(e1.x, e1.z) / spacing));
      const n2 = Math.max(1, Math.ceil(Math.hypot(e2.x, e2.z) / spacing));
      for (let j = 0; j <= n2; j++) {
        for (let i = 0; i <= n1; i++) {
          const a = i / n1;
          const b = j / n2;
          cb(o.x + e1.x * a + e2.x * b, o.z + e1.z * a + e2.z * b);
        }
      }
    };

    const add = (x: number, y: number, z: number, sx: number, sy: number, sz: number, key: number) => {
      let dx = x - cx;
      let dz = z - cz;
      const d = Math.hypot(dx, dz) || 1;
      const swirl = (hash01(key, 1) - 0.5) * 0.7; // so the parting doesn't look mechanical
      const ux = dx / d;
      const uz = dz / d;
      dx = ux * Math.cos(swirl) - uz * Math.sin(swirl);
      dz = ux * Math.sin(swirl) + uz * Math.cos(swirl);
      euler.set((hash01(key, 2) - 0.5) * 0.3, hash01(key, 3) * Math.PI * 2, (hash01(key, 4) - 0.5) * 0.3);
      this.puffs.push({
        x,
        y,
        z,
        sx,
        sy,
        sz,
        rot: new Quaternion().setFromEuler(euler),
        dx,
        dz,
        rise: 3 + hash01(key, 5) * 5,
        delay: clamp01(d / maxD + (hash01(key, 6) - 0.5) * 0.18),
        phase: hash01(key, 7) * Math.PI * 2,
        shade: 0.86 + hash01(key, 8) * 0.14,
        mesh: hash01(key, 9) < 0.5 ? 0 : 1,
        slot: 0,
      });
    };

    // 1. A low, flat, overlapping deck: nothing below it can be seen.
    scatter(DECK_SPACING, (gx, gz) => {
      {
        const k = 1000 + seed++;
        const x = gx + (hash01(k, 11) - 0.5) * DECK_SPACING * 0.9;
        const z = gz + (hash01(k, 12) - 0.5) * DECK_SPACING * 0.9;
        const r = 2.6 + hash01(k, 13) * 1.4;
        add(x, deckY - 0.6 + hash01(k, 14) * 0.4, z, r * (0.9 + hash01(k, 15) * 0.6), r * (0.24 + hash01(k, 16) * 0.12), r * (0.9 + hash01(k, 17) * 0.6), k);
      }
    });

    // 2. Lumpy clouds scattered over the deck, of three kinds, with uneven gaps between them.
    scatter(CLUMP_SPACING, (gx, gz) => {
      {
        const c = 5000 + seed++;
        if (hash01(c, 20) < 0.18) return; // a gap: just the flat deck here
        const ox = gx + (hash01(c, 21) - 0.5) * CLUMP_SPACING;
        const oz = gz + (hash01(c, 22) - 0.5) * CLUMP_SPACING;
        const kind = hash01(c, 23);
        const tower = kind > 0.82; // tall cumulus
        const bank = kind < 0.35; // long, low and flat
        const n = tower ? 9 + Math.floor(hash01(c, 24) * 5) : bank ? 5 + Math.floor(hash01(c, 24) * 3) : 6 + Math.floor(hash01(c, 24) * 5);
        const size = (tower ? 2.5 : bank ? 2.0 : 2.0) + hash01(c, 25) * 1.6;
        const stretch = hash01(c, 26) * Math.PI * 2; // banks run along this direction
        for (let p = 0; p < n; p++) {
          const k = c * 16 + p;
          let x: number;
          let z: number;
          let y: number;
          let r = size * (0.6 + hash01(k, 30) * 0.6);
          if (bank) {
            const along = (p / Math.max(1, n - 1) - 0.5) * size * 4.2 + (hash01(k, 31) - 0.5);
            const across = (hash01(k, 32) - 0.5) * size * 1.2;
            x = ox + Math.cos(stretch) * along - Math.sin(stretch) * across;
            z = oz + Math.sin(stretch) * along + Math.cos(stretch) * across;
            y = deckY + 0.6 + hash01(k, 33) * 0.7;
          } else {
            // Heaped: the first puffs form a base, later ones pile up on it (much higher in towers).
            const level = p / n;
            const spread = size * (1.6 - level) * (0.5 + hash01(k, 34) * 0.7);
            const a = hash01(k, 35) * Math.PI * 2;
            x = ox + Math.cos(a) * spread;
            z = oz + Math.sin(a) * spread;
            y = deckY + 0.8 + level * (tower ? size * 3.2 : size * 1.3) + hash01(k, 36) * 0.5;
            if (tower) r *= 1.15 - level * 0.35; // narrower towards the top
          }
          const flat = bank ? 0.42 + hash01(k, 37) * 0.2 : 0.62 + hash01(k, 37) * 0.35;
          add(x, y, z, r * (0.8 + hash01(k, 38) * 0.6), r * flat, r * (0.8 + hash01(k, 39) * 0.6), k);
        }
      }
    });

    // Two lumpy shapes, so neighbouring puffs never look alike.
    const counts = [0, 0];
    for (const p of this.puffs) p.slot = counts[p.mesh]++;
    const col = new Color();
    for (let k = 0; k < 2; k++) {
      const mat = withInstanceAlpha(new MeshLambertMaterial({ flatShading: true, emissive: new Color(0x9aa6b8), emissiveIntensity: 0.3 }));
      const mesh = new InstancedMesh(lumpyPuff(17 + k * 31), mat, Math.max(1, counts[k]));
      mesh.frustumCulled = false;
      mesh.renderOrder = 20; // after the smoke
      mesh.castShadow = true; // their shadows sweep off the map as they part
      this.alphas.push(addInstanceAlpha(mesh, Math.max(1, counts[k])));
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    for (const p of this.puffs) this.meshes[p.mesh].setColorAt(p.slot, col.setRGB(p.shade, p.shade, Math.min(1, p.shade + 0.04)));
    if (this.stateNow !== "clear") this.place(performance.now() / 1000);
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
    if (this.puffs.length === 0) this.fit();
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
    for (const p of this.puffs) {
      const bob = Math.sin(now * 0.6 + p.phase) * 0.12;
      const k = clearing ? clamp01((this.t - p.delay * SPREAD) / moveTime) : 0;
      const ease = k * k * (3 - 2 * k); // smoothstep: eases in and out
      const grow = 1 + 0.35 * ease;
      this.p.set(p.x + p.dx * DRIFT * ease, p.y + bob + p.rise * ease, p.z + p.dz * DRIFT * ease);
      this.s.set(p.sx * grow, p.sy * grow, p.sz * grow);
      this.m.compose(this.p, p.rot, this.s);
      this.meshes[p.mesh].setMatrixAt(p.slot, this.m);
      (this.alphas[p.mesh].array as Float32Array)[p.slot] = 1 - clamp01((k - 0.35) / 0.55);
    }
    for (let k = 0; k < this.meshes.length; k++) {
      this.meshes[k].instanceMatrix.needsUpdate = true;
      this.alphas[k].needsUpdate = true;
    }
  }
}
