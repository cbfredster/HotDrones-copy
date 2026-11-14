// Fire: flickering emissive voxel flames on burning tiles (sized by severity) and the
// odd glowing ember on ground that burned out. Only tiles on the `burning` list are
// touched each frame.
import { BoxGeometry, Color, Group, InstancedMesh, MeshBasicMaterial } from "three";
import { TerrainLayer, TileVis } from "./terrain";
import { clamp01, hash01, mixColor, rgb, setInstance, uploadUsed } from "./util";

const VOXELS = 3; // outer, mid, core
const WIDTH = [0.66, 0.44, 0.24];
const HEIGHT = [0.5, 0.78, 1.0];
const MID = rgb(0xff9a1f);
const CORE = rgb(0xffec6e);
const OUTER_COOL = rgb(0xffb428); // severity 1: orange-yellow (matches the 2D palette)
const OUTER_HOT = rgb(0xff2a0a); // severity 3: deep red
const EMBER_DIM = rgb(0x4a1208);
const EMBER_HOT = rgb(0xff7a1a);

const EMBER_CHANCE = 0.22; // share of burnt-out tiles that keep an ember
const EMBER_TICKS = 500; // how long an ember keeps glowing
const MAX_EMBERS = 800;

export class FireLayer {
  readonly group = new Group();
  private readonly flames: InstancedMesh;
  private readonly embers: InstancedMesh;
  private readonly burning: number[] = [];
  private readonly burningAt: Int32Array; // position of a tile in `burning`, -1 if not burning
  private readonly igniteTime: Float32Array;
  private readonly emberTiles: number[] = [];
  private readonly emberAt: Int32Array;
  private readonly burntTick: Int32Array;
  private readonly tmp = new Color();

  constructor(private terrain: TerrainLayer, private maxSeverity: number) {
    const n = terrain.w * terrain.h;
    this.burningAt = new Int32Array(n).fill(-1);
    this.emberAt = new Int32Array(n).fill(-1);
    this.igniteTime = new Float32Array(n).fill(-1e6);
    this.burntTick = new Int32Array(n);

    const voxel = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0); // pivot at the base so flames grow upwards
    // Unlit and not tone-mapped: flames are the brightest thing on screen at any time of "day".
    this.flames = new InstancedMesh(voxel, new MeshBasicMaterial({ toneMapped: false }), n * VOXELS);
    this.flames.count = 0;
    this.flames.frustumCulled = false; // instances move every frame; a stale bounding sphere would cull them
    this.embers = new InstancedMesh(voxel, new MeshBasicMaterial({ toneMapped: false }), MAX_EMBERS);
    this.embers.count = 0;
    this.embers.frustumCulled = false;
    // Touch the colour buffers so they exist before the first upload.
    this.flames.setColorAt(0, this.tmp.set(0xffffff));
    this.embers.setColorAt(0, this.tmp);
    this.group.add(this.flames, this.embers);
  }

  get burningCount() {
    return this.burning.length;
  }

  applyTile(i: number, vis: TileVis, time: number, tick: number) {
    const wasBurning = this.burningAt[i] >= 0;
    if (vis === TileVis.Burning) {
      if (!wasBurning) {
        this.burningAt[i] = this.burning.length;
        this.burning.push(i);
        this.igniteTime[i] = time;
      }
    } else if (wasBurning) {
      this.remove(this.burning, this.burningAt, i);
      if (vis === TileVis.BurntOut) this.burntTick[i] = tick;
    }

    if (vis === TileVis.BurntOut) {
      if (this.emberAt[i] < 0 && this.emberTiles.length < MAX_EMBERS && hash01(i, 21) < EMBER_CHANCE) {
        this.emberAt[i] = this.emberTiles.length;
        this.emberTiles.push(i);
      }
    } else if (this.emberAt[i] >= 0) {
      this.remove(this.emberTiles, this.emberAt, i);
    }
  }

  private remove(list: number[], at: Int32Array, i: number) {
    const k = at[i];
    const last = list.pop()!;
    if (last !== i) {
      list[k] = last;
      at[last] = k;
    }
    at[i] = -1;
  }

  /** @param severity per-tile severity array (the truth, or a drone's belief) */
  update(time: number, tick: number, severity: Float32Array) {
    const { w, topY } = this.terrain;
    const c = this.tmp;

    // Flicker: random targets at 8 Hz, blended, so it is lively but not strobing.
    const t8 = time * 8;
    const s0 = Math.floor(t8);
    const f = t8 - s0;
    let k = 0;
    for (const i of this.burning) {
      const x = i % w;
      const y = (i - x) / w;
      const sev = Math.max(0.6, Math.min(this.maxSeverity, severity[i] || 1));
      const pop = Math.min(1, (time - this.igniteTime[i]) / 0.35); // new fires flare up rather than appear
      const tall = (0.3 + 0.34 * sev) * pop;
      const heat = clamp01((sev - 1) / Math.max(1e-6, this.maxSeverity - 1));
      for (let v = 0; v < VOXELS; v++) {
        const id = i * VOXELS + v;
        const a = hash01(id, s0);
        const b = hash01(id, s0 + 1);
        const flick = 0.72 + 0.56 * (a + (b - a) * f);
        const sway = 0.07 * (1 + v);
        const ox = (hash01(id, s0 + 7919) - 0.5) * sway;
        const oz = (hash01(id, s0 + 104729) - 0.5) * sway;
        const width = WIDTH[v] * pop * (0.9 + 0.1 * sev);
        setInstance(this.flames, k, x + ox, topY[i], y + oz, width, tall * HEIGHT[v] * flick, width);
        if (v === 0) mixColor(c, OUTER_COOL, OUTER_HOT, heat);
        else c.copy(v === 1 ? MID : CORE);
        this.flames.setColorAt(k, c);
        k++;
      }
    }
    this.flames.count = k;
    uploadUsed(this.flames.instanceMatrix, k);
    uploadUsed(this.flames.instanceColor, k);

    // Embers: fade out over EMBER_TICKS, with a slow pulse.
    let e = 0;
    for (let j = this.emberTiles.length - 1; j >= 0; j--) {
      const i = this.emberTiles[j];
      const fade = 1 - (tick - this.burntTick[i]) / EMBER_TICKS;
      if (fade <= 0) {
        this.remove(this.emberTiles, this.emberAt, i);
        continue;
      }
      const x = i % w;
      const y = (i - x) / w;
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4 + hash01(i, 22) * 6.283);
      const size = 0.09 + 0.05 * hash01(i, 23);
      setInstance(
        this.embers,
        e,
        x + (hash01(i, 24) - 0.5) * 0.6,
        topY[i],
        y + (hash01(i, 25) - 0.5) * 0.6,
        size,
        size,
        size,
      );
      this.embers.setColorAt(e, mixColor(c, EMBER_DIM, EMBER_HOT, pulse * fade));
      e++;
    }
    this.embers.count = e;
    uploadUsed(this.embers.instanceMatrix, e);
    uploadUsed(this.embers.instanceColor, e);
  }
}
