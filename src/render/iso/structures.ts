// Things people built: the village (nine small houses that char if they burn) and the
// home base (a helipad with a radio mast that goes dark when base comms are down).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RingGeometry,
  Vector3,
} from "three";
import { BASE_MAST_HEIGHT, terrainHeightAt } from "../../sim/comms";
import { World } from "../../sim/world";
import { TerrainLayer, TileVis } from "./terrain";
import { V_SCALE, hash01, rgb, setInstance } from "./util";

const WALL = rgb(0xf6e7c6);
const WALL_CHARRED = rgb(0x3a2f2a);
const ROOF_CHARRED = rgb(0x1d1816);
const ROOFS = [rgb(0xe4572e), rgb(0xf2a516), rgb(0x2aa3b3), rgb(0xb5417f), rgb(0x3f6fb5), rgb(0xd94f70)];

const PAD = rgb(0xd3d9df);
const PAD_MARK = rgb(0xffd23f);
const MAST = rgb(0xe9edf2);
const MAST_DARK = rgb(0x4a4f57);
const BEACON_ON = new Color(0x4dff9a);
const BEACON_DIM = new Color(0x1c7a47);
const BEACON_OFF = new Color(0x3a2326);

/** A gable roof: a triangular prism, ridge along Z, base on y = 0. */
function gableRoof(halfW: number, halfL: number, height: number): BufferGeometry {
  const a = [-halfW, 0, -halfL];
  const b = [halfW, 0, -halfL];
  const c = [halfW, 0, halfL];
  const d = [-halfW, 0, halfL];
  const e = [0, height, -halfL];
  const f = [0, height, halfL];
  const faces: number[][][] = [
    [a, e, b], // gable end (-z)
    [c, f, d], // gable end (+z)
    [b, e, f], [b, f, c], // +x slope
    [a, d, f], [a, f, e], // -x slope
    [a, b, c], [a, c, d], // underside
  ];
  const pos = new Float32Array(faces.length * 9);
  faces.forEach((tri, k) => tri.forEach((v, j) => pos.set(v, k * 9 + j * 3)));
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class StructureLayer {
  readonly group = new Group();
  /** Tip of the base's radio mast: the base's comms node sits exactly here. */
  readonly mastTop = new Vector3();
  /** Tiles other layers should keep clear of trees. */
  readonly reserved = new Set<number>();
  /** Height of the helipad's deck, where docked drones park. */
  readonly padTopY: number;

  private readonly walls: InstancedMesh;
  private readonly roofs: InstancedMesh;
  private readonly houseOf = new Map<number, number>(); // tile index -> house instance
  private readonly roofColour: Color[] = [];
  private readonly beacon: Mesh;
  private readonly mast: Mesh;
  private readonly pulses: Mesh[] = [];
  private online = true;
  private readonly tmp = new Color();

  constructor(private world: World, terrain: TerrainLayer) {
    const { w, h } = world.terrain;

    // ---------------------------------------------------------------- village
    const tiles = [...new Set(world.terrain.village)];
    const wallGeo = new BoxGeometry(0.6, 0.34, 0.6).translate(0, 0.17, 0);
    const roofGeo = gableRoof(0.38, 0.36, 0.28).translate(0, 0.34, 0);
    this.walls = new InstancedMesh(wallGeo, new MeshLambertMaterial({ flatShading: true }), tiles.length);
    this.roofs = new InstancedMesh(roofGeo, new MeshLambertMaterial({ flatShading: true }), tiles.length);
    tiles.forEach((tile, k) => {
      const x = tile % w;
      const y = (tile - x) / w;
      const rot = hash01(tile, 31) < 0.5 ? 0 : Math.PI / 2;
      const s = 0.9 + 0.25 * hash01(tile, 32);
      setInstance(this.walls, k, x, terrain.topY[tile], y, s, s, s, rot);
      setInstance(this.roofs, k, x, terrain.topY[tile], y, s, s, s, rot);
      this.houseOf.set(tile, k);
      this.roofColour.push(ROOFS[Math.floor(hash01(tile, 33) * ROOFS.length)]);
      this.reserved.add(tile);
      this.paintHouse(k, TileVis.Unburnt, 0);
    });
    for (const m of [this.walls, this.roofs]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
    this.group.add(this.walls, this.roofs);

    // ---------------------------------------------------------------- home base
    const bx = world.base.x;
    const by = world.base.y;
    // The pad sits just above the highest of the surrounding tiles so it never ends up
    // buried in a slope; a plinth fills the gap down to the lowest one.
    let padY = -Infinity;
    let lowY = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(bx) + dx;
        const y = Math.round(by) + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        this.reserved.add(i);
        padY = Math.max(padY, terrain.topY[i]);
        lowY = Math.min(lowY, terrain.topY[i]);
      }
    }
    padY += 0.04;
    this.padTopY = padY + 0.14;
    const base = new Group();
    base.position.set(bx, padY, by);

    const plinthH = padY - lowY + 0.3;
    const plinth = new Mesh(
      new CylinderGeometry(1.32, 1.42, plinthH, 8).translate(0, -plinthH / 2, 0),
      new MeshLambertMaterial({ color: rgb(0x8d949c), flatShading: true }),
    );
    const pad = new Mesh(
      new CylinderGeometry(1.36, 1.36, 0.14, 8).translate(0, 0.07, 0),
      new MeshLambertMaterial({ color: PAD, flatShading: true }),
    );
    const markMat = new MeshLambertMaterial({ color: PAD_MARK, flatShading: true });
    const hLeft = new Mesh(new BoxGeometry(0.16, 0.03, 0.9), markMat);
    hLeft.position.set(-0.33, 0.155, 0);
    const hRight = hLeft.clone();
    hRight.position.x = 0.33;
    const hBar = new Mesh(new BoxGeometry(0.5, 0.03, 0.16), markMat);
    hBar.position.set(0, 0.155, 0);
    for (const m of [plinth, pad, hLeft, hRight, hBar]) {
      m.castShadow = true;
      m.receiveShadow = true;
      base.add(m);
    }

    // The mast: its tip is exactly where the sim puts the base's comms node
    // (terrain height + BASE_MAST_HEIGHT), so links to the base start in the right place.
    const tipY = (terrainHeightAt(world.terrain, bx, by) + BASE_MAST_HEIGHT) * V_SCALE;
    const mastX = 1.02;
    const mastZ = -1.02;
    const mastLen = Math.max(0.6, tipY - (padY + 0.14));
    this.mast = new Mesh(
      new BoxGeometry(0.09, mastLen, 0.09).translate(0, mastLen / 2, 0),
      new MeshLambertMaterial({ color: MAST.clone(), flatShading: true }),
    );
    this.mast.position.set(mastX, 0.14, mastZ);
    this.mast.castShadow = true;
    const armMat = this.mast.material as MeshLambertMaterial;
    for (const [frac, len] of [[0.62, 0.5], [0.8, 0.36]] as const) {
      const arm = new Mesh(new BoxGeometry(len, 0.05, 0.05), armMat);
      arm.position.set(0, mastLen * frac, 0);
      arm.castShadow = true;
      this.mast.add(arm);
    }
    this.beacon = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial({ color: BEACON_ON.clone() }));
    this.beacon.position.set(0, mastLen, 0);
    this.mast.add(this.beacon);
    base.add(this.mast);
    this.mastTop.set(bx + mastX, padY + 0.14 + mastLen, by + mastZ);

    // Radio pulses: expanding rings from the mast tip while the base is on the air.
    for (let k = 0; k < 2; k++) {
      const ring = new Mesh(
        new RingGeometry(0.82, 1, 20).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: 0x7dffb6, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false }),
      );
      ring.position.copy(this.mastTop);
      this.pulses.push(ring);
      this.group.add(ring);
    }
    this.group.add(base);
  }

  private paintHouse(k: number, vis: TileVis, fog: number) {
    const burnt = vis !== TileVis.Unburnt;
    const dim = 1 - 0.78 * fog;
    this.walls.setColorAt(k, this.tmp.copy(burnt ? WALL_CHARRED : WALL).multiplyScalar(dim));
    this.roofs.setColorAt(k, this.tmp.copy(burnt ? ROOF_CHARRED : this.roofColour[k]).multiplyScalar(dim));
    this.walls.instanceColor!.needsUpdate = true;
    this.roofs.instanceColor!.needsUpdate = true;
  }

  /** Char a house when its tile burns. No-op for tiles without one. */
  applyTile(i: number, vis: TileVis, fog: number) {
    const k = this.houseOf.get(i);
    if (k !== undefined) this.paintHouse(k, vis, fog);
  }

  update(time: number) {
    const online = this.world.baseOnline;
    if (online !== this.online) {
      this.online = online;
      (this.mast.material as MeshLambertMaterial).color.copy(online ? MAST : MAST_DARK);
    }
    const beacon = this.beacon.material as MeshBasicMaterial;
    if (online) {
      // A slow double-blink, like an aviation obstruction light.
      const phase = (time * 0.9) % 1;
      beacon.color.copy(phase < 0.12 || (phase > 0.22 && phase < 0.34) ? BEACON_ON : BEACON_DIM);
    } else {
      beacon.color.copy(BEACON_OFF);
    }
    this.pulses.forEach((ring, k) => {
      const mat = ring.material as MeshBasicMaterial;
      if (!online) {
        mat.opacity = 0;
        return;
      }
      const p = (time * 0.45 + k * 0.5) % 1;
      const s = 0.3 + p * 3.2;
      ring.scale.set(s, 1, s);
      mat.opacity = 0.55 * (1 - p) * (1 - p);
    });
  }
}
