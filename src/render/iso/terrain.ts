// Terrain: every tile is a box column at its sim height, with a coloured top cap over
// earthy sides. Two InstancedMeshes (columns + caps); instanceId == tile index, which is
// what picking relies on.
import { BoxGeometry, Color, Group, InstancedMesh, MeshLambertMaterial } from "three";
import { Tile } from "../../sim/terrain";
import { World } from "../../sim/world";
import { SLAB_DEPTH, V_SCALE, hash01, mixColor, rgb, setInstance } from "./util";

/** What a tile looks like. Derived from fire state + wetness (or from a drone's belief). */
export enum TileVis {
  Unburnt = 0,
  Burning = 1,
  BurntOut = 2, // burned through on its own: charcoal, the odd ember
  Extinguished = 3, // put out by a drone: wet and dark (the sim marks these Burnt with wetness 1)
}

const CAP_THICKNESS = 0.18;
const WATER_INSET = 0.14; // water surface sits a little below its banks

const CAP_COLOUR: Record<number, Color> = {
  [Tile.Grass]: rgb(0x8edb4c),
  [Tile.Forest]: rgb(0x3d9a3b),
  [Tile.Sand]: rgb(0xf3df9f),
  [Tile.Rock]: rgb(0x9da4ae),
  [Tile.Water]: rgb(0x2b97ee),
};
const SIDE_COLOUR: Record<number, Color> = {
  [Tile.Grass]: rgb(0x8f5f37),
  [Tile.Forest]: rgb(0x7f5330),
  [Tile.Sand]: rgb(0xc7a567),
  [Tile.Rock]: rgb(0x6d737d),
  [Tile.Water]: rgb(0x1c66ab),
};
const WATER_LIGHT = rgb(0x66c4ff);
const SCORCHED = rgb(0x6a2e12); // ground under live flames
const BURNT = rgb(0x2a2422);
const BURNT_ALT = rgb(0x3a302b);
const EXTINGUISHED = rgb(0x20384f); // wet + dark: clearly not the same as burnt-out ground
const WET_TINT = rgb(0x4fb0ff);
const REGROWTH = rgb(0xc4f56a); // fresh growth on ground that burned earlier

export class TerrainLayer {
  readonly group = new Group();
  readonly columns: InstancedMesh;
  readonly caps: InstancedMesh;
  /** Scaled world-space Y of each tile's top surface. Other layers stand things on this. */
  readonly topY: Float32Array;
  readonly maxY: number;
  readonly floorY: number;
  readonly w: number;
  readonly h: number;

  private readonly base: Float32Array; // untouched cap colour per tile (linear rgb)
  private readonly fog: Float32Array; // 0..1 darkening per tile (belief staleness)
  private readonly vis: Uint8Array;
  private readonly waterTiles: number[] = [];
  private readonly tmp = new Color();
  private readonly tmp2 = new Color();
  private lastShimmer = -1;

  constructor(world: World) {
    const { w, h, height, type } = world.terrain;
    const n = w * h;
    this.w = w;
    this.h = h;
    this.topY = new Float32Array(n);
    this.base = new Float32Array(n * 3);
    this.fog = new Float32Array(n);
    this.vis = new Uint8Array(n);

    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < n; i++) {
      minH = Math.min(minH, height[i]);
      maxH = Math.max(maxH, height[i]);
    }
    this.floorY = minH * V_SCALE - SLAB_DEPTH;
    this.maxY = maxH * V_SCALE;
    const span = Math.max(1e-6, maxH - minH);

    const box = new BoxGeometry(1, 1, 1);
    this.columns = new InstancedMesh(box, new MeshLambertMaterial({ flatShading: true }), n);
    this.caps = new InstancedMesh(box, new MeshLambertMaterial({ flatShading: true }), n);
    for (const m of [this.columns, this.caps]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const c = new Color();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = type[i] as Tile;
        const isWater = t === Tile.Water;
        const top = height[i] * V_SCALE - (isWater ? WATER_INSET : 0);
        this.topY[i] = top;
        if (isWater) this.waterTiles.push(i);

        const colTop = top - CAP_THICKNESS;
        const colH = colTop - this.floorY;
        setInstance(this.columns, i, x, this.floorY + colH / 2, y, 1, colH, 1);
        setInstance(this.caps, i, x, top - CAP_THICKNESS / 2, y, 1, CAP_THICKNESS, 1);

        // Cap colour: saturated base, brighter with altitude so the relief reads at a
        // glance, plus a little per-tile jitter so flats don't look like one slab.
        const lift = 0.86 + 0.26 * ((height[i] - minH) / span);
        const jitter = 0.94 + 0.12 * hash01(i, 11);
        c.copy(CAP_COLOUR[t]).multiplyScalar(isWater ? 1 : lift * jitter);
        c.toArray(this.base, i * 3);
        this.caps.setColorAt(i, c);

        c.copy(SIDE_COLOUR[t]).multiplyScalar(0.9 + 0.2 * hash01(i, 12));
        this.columns.setColorAt(i, c);
      }
    }
    this.columns.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.columns.computeBoundingSphere();
    this.caps.computeBoundingSphere();
    this.group.add(this.columns, this.caps);
  }

  /** Top surface height under a fractional sim position (nearest tile). */
  topAt(x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.w - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(this.h - 1, Math.round(y)));
    return this.topY[iy * this.w + ix];
  }

  /** Recolour one tile's cap. Called only for tiles whose visual state changed. */
  applyTile(i: number, vis: TileVis, wet: number, fog: number, young = 0) {
    this.vis[i] = vis;
    this.fog[i] = fog;
    const c = this.tmp;
    if (vis === TileVis.Burning) c.copy(SCORCHED);
    else if (vis === TileVis.BurntOut) mixColor(c, BURNT, BURNT_ALT, hash01(i, 13));
    else if (vis === TileVis.Extinguished) c.copy(EXTINGUISHED);
    else {
      c.fromArray(this.base, i * 3);
      if (young > 0) mixColor(c, c, REGROWTH, 0.7 * young);
      if (wet > 0) mixColor(c, c, WET_TINT, 0.5 * wet); // faint blue: a wetted firebreak
    }
    c.multiplyScalar(1 - 0.78 * fog);
    this.caps.setColorAt(i, c);
    this.caps.instanceColor!.needsUpdate = true;
  }

  /** Gentle water shimmer (about 12 updates a second is plenty). */
  update(time: number) {
    const step = Math.floor(time * 12);
    if (step === this.lastShimmer || this.waterTiles.length === 0) return;
    this.lastShimmer = step;
    const c = this.tmp;
    const base = this.tmp2;
    const w = this.w;
    for (const i of this.waterTiles) {
      const x = i % w;
      const y = (i - x) / w;
      const wave = 0.5 + 0.5 * Math.sin(time * 1.7 + x * 0.55 + y * 0.35 + hash01(i, 14) * 6.283);
      const sparkle = wave * wave * wave; // mostly calm, occasional glint
      base.fromArray(this.base, i * 3);
      mixColor(c, base, WATER_LIGHT, 0.55 * sparkle).multiplyScalar(1 - 0.78 * this.fog[i]);
      this.caps.setColorAt(i, c);
    }
    this.caps.instanceColor!.needsUpdate = true;
  }
}
