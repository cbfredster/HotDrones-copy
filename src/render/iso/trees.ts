// Low-poly conifers: 1-3 per forest tile, placed by a hash of the tile index.
// Burning trees lose their foliage, burnt ones are left as charcoal snags.
import { BoxGeometry, Color, ConeGeometry, DodecahedronGeometry, Group, InstancedMesh, MeshLambertMaterial } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Tile } from "../../sim/terrain";
import { World } from "../../sim/world";
import { TerrainLayer, TileVis } from "./terrain";
import { hash01, mixColor, rgb, setInstance } from "./util";

// Tree dimensions are in world units and deliberately squat: drones fly only
// droneAltitude * V_SCALE (0.8) above the ground, and should clear the treetops.
const TRUNK_H = 0.16;
const TRUNK_W = 0.1;
const FOLIAGE = [rgb(0x1f7f3b), rgb(0x2b9347), rgb(0x176b33), rgb(0x248a3f)];
const TRUNK = rgb(0x6b4226);
const CHARCOAL = rgb(0x1b1615);
const SCORCH = rgb(0x8a3b12); // foliage colour as it burns away
const SINGED = rgb(0x2f3b29); // what is left when a drone puts the tile out in time
const BOULDER = rgb(0x8b929c);
const SAPLING = rgb(0x7fdc55);

// Up to three slots per tile, jittered, so trees on one tile never sit on top of each other.
const SLOTS: [number, number][][] = [
  [[0, 0]],
  [[-0.2, -0.16], [0.2, 0.17]],
  [[-0.22, -0.2], [0.23, -0.06], [-0.04, 0.24]],
];

export class TreeLayer {
  readonly group = new Group();
  private readonly trunks: InstancedMesh;
  private readonly foliage: InstancedMesh;
  private readonly start: Int32Array; // first tree index per tile (-1 = no trees)
  private readonly count: Uint8Array;
  private readonly tx: Float32Array;
  private readonly ty: Float32Array;
  private readonly tz: Float32Array;
  private readonly ts: Float32Array;
  private readonly tr: Float32Array;
  private readonly tc: Uint8Array;
  private readonly tmp = new Color();
  readonly total: number;

  /** `exclude` lists tiles that must stay clear (the helipad, tower sites...). */
  constructor(world: World, terrain: TerrainLayer, exclude: Set<number>) {
    const { w, h, type } = world.terrain;
    const n = w * h;
    this.start = new Int32Array(n).fill(-1);
    this.count = new Uint8Array(n);

    let total = 0;
    for (let i = 0; i < n; i++) {
      if (type[i] !== Tile.Forest || exclude.has(i)) continue;
      const r = hash01(i, 1);
      this.count[i] = r < 0.25 ? 1 : r < 0.7 ? 2 : 3;
      this.start[i] = total;
      total += this.count[i];
    }
    this.total = total;
    this.tx = new Float32Array(total);
    this.ty = new Float32Array(total);
    this.tz = new Float32Array(total);
    this.ts = new Float32Array(total);
    this.tr = new Float32Array(total);
    this.tc = new Uint8Array(total);

    // A conifer is two stacked five-sided cones on a stubby trunk.
    // Open-ended: the undersides can never be seen from an isometric camera, and leaving
    // them out saves ten triangles a tree (twice, counting the shadow pass).
    const lower = new ConeGeometry(0.3, 0.36, 5, 1, true).translate(0, TRUNK_H + 0.14, 0);
    const upper = new ConeGeometry(0.2, 0.32, 5, 1, true).rotateY(0.6).translate(0, TRUNK_H + 0.4, 0);
    const foliageGeo = mergeGeometries([lower, upper])!;
    const trunkGeo = new BoxGeometry(TRUNK_W, TRUNK_H + 0.06, TRUNK_W).translate(0, (TRUNK_H + 0.06) / 2, 0);
    lower.dispose();
    upper.dispose();

    const cap = Math.max(1, total);
    this.foliage = new InstancedMesh(foliageGeo, new MeshLambertMaterial({ flatShading: true }), cap);
    this.trunks = new InstancedMesh(trunkGeo, new MeshLambertMaterial({ flatShading: true }), cap);
    this.foliage.count = total;
    this.trunks.count = total;
    for (const m of [this.foliage, this.trunks]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    for (let i = 0; i < n; i++) {
      const s0 = this.start[i];
      if (s0 < 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      const slots = SLOTS[this.count[i] - 1];
      for (let k = 0; k < this.count[i]; k++) {
        const t = s0 + k;
        this.tx[t] = x + slots[k][0] + (hash01(i, 2 + k) - 0.5) * 0.14;
        this.tz[t] = y + slots[k][1] + (hash01(i, 5 + k) - 0.5) * 0.14;
        this.ty[t] = terrain.topY[i];
        this.ts[t] = 0.78 + 0.34 * hash01(i, 8 + k);
        this.tr[t] = hash01(i, 14 + k) * Math.PI * 2;
        this.tc[t] = Math.floor(hash01(i, 17 + k) * FOLIAGE.length);
      }
      this.applyTile(i, TileVis.Unburnt, 0, 1);
    }
    this.finish();
    this.foliage.computeBoundingSphere();
    this.trunks.computeBoundingSphere();
    this.group.add(this.trunks, this.foliage);

    // Rock tiles each get a chunky boulder (static: rock never burns).
    const rocks: number[] = [];
    for (let i = 0; i < n; i++) if (type[i] === Tile.Rock && !exclude.has(i)) rocks.push(i);
    if (rocks.length > 0) {
      const boulders = new InstancedMesh(
        new DodecahedronGeometry(0.3, 0),
        new MeshLambertMaterial({ flatShading: true }),
        rocks.length,
      );
      const grey = new Color();
      rocks.forEach((i, k) => {
        const x = i % w;
        const y = (i - x) / w;
        const s = 0.7 + 0.7 * hash01(i, 51);
        setInstance(
          boulders,
          k,
          x + (hash01(i, 52) - 0.5) * 0.4,
          terrain.topY[i] + 0.12 * s,
          y + (hash01(i, 53) - 0.5) * 0.4,
          s,
          s * (0.6 + 0.3 * hash01(i, 54)),
          s * (0.8 + 0.4 * hash01(i, 55)),
          hash01(i, 56) * Math.PI * 2,
        );
        boulders.setColorAt(k, grey.copy(BOULDER).multiplyScalar(0.8 + 0.35 * hash01(i, 57)));
      });
      boulders.castShadow = true;
      boulders.receiveShadow = true;
      boulders.instanceMatrix.needsUpdate = true;
      boulders.computeBoundingSphere();
      this.group.add(boulders);
    }
  }

  hasTrees(i: number) {
    return this.start[i] >= 0;
  }

  /**
   * Restyle the trees on one tile.
   * @param fuelLeft 1 = just caught fire, 0 = about to burn out (only used while Burning).
   */
  applyTile(i: number, vis: TileVis, fog: number, fuelLeft: number, young = 0) {
    const s0 = this.start[i];
    if (s0 < 0) return;
    const dim = 1 - 0.92 * fog;
    const c = this.tmp;
    for (let k = 0; k < this.count[i]; k++) {
      const t = s0 + k;
      const s = this.ts[t];
      let crown = 1; // foliage scale
      let trunkStretch = 1;
      if (vis === TileVis.Unburnt) {
        c.copy(FOLIAGE[this.tc[t]]);
        if (young > 0) {
          crown = 1 - 0.62 * young; // saplings on regrown ground, filling out over time
          mixColor(c, c, SAPLING, 0.6 * young);
        }
      } else if (vis === TileVis.Burning) {
        crown = 0.3 + 0.7 * fuelLeft;
        mixColor(c, SCORCH, FOLIAGE[this.tc[t]], fuelLeft * fuelLeft);
      } else if (vis === TileVis.Extinguished) {
        crown = 0.5;
        c.copy(SINGED);
      } else {
        crown = 0; // burnt out: nothing left but the snag
        trunkStretch = 1.9;
      }
      setInstance(this.foliage, t, this.tx[t], this.ty[t], this.tz[t], s * crown, s * crown, s * crown, this.tr[t]);
      this.foliage.setColorAt(t, c.multiplyScalar(dim));
      setInstance(this.trunks, t, this.tx[t], this.ty[t], this.tz[t], s, s * trunkStretch, s, this.tr[t]);
      c.copy(vis === TileVis.Unburnt ? TRUNK : CHARCOAL).multiplyScalar(dim);
      this.trunks.setColorAt(t, c);
    }
    this.dirty = true;
  }

  private dirty = false;

  /** Push pending instance edits to the GPU (once per frame, not once per tile). */
  finish() {
    if (!this.dirty) return;
    this.dirty = false;
    this.foliage.instanceMatrix.needsUpdate = true;
    this.trunks.instanceMatrix.needsUpdate = true;
    if (this.foliage.instanceColor) this.foliage.instanceColor.needsUpdate = true;
    if (this.trunks.instanceColor) this.trunks.instanceColor.needsUpdate = true;
  }
}
