// The isometric renderer. It only ever READS world state: no world.rng / world.agentRng,
// no writes. Judge actions triggered by clicks are applied by the app, not in here.
//
// Layers (one file each, so several people can work in parallel):
//   scene.ts       WebGL renderer, lights          camera.ts   orthographic iso camera + input
//   terrain.ts     tile columns + caps             trees.ts    conifers
//   structures.ts  village, helipad, mast          fire.ts     flames + embers
//   smoke.ts       smoke puffs                     drones.ts   quadcopters + labels
//   particles.ts   water, steam, sparks            overlays.ts links, domes, selection
//   picking.ts     pointer -> tile / drone      clouds.ts   opening cloud cover
import { Group, Vector3 } from "three";
import { BeliefMap } from "../../sim/belief";
import { BASE_ID } from "../../sim/comms";
import { Fire } from "../../sim/environment";
import { FUEL, Tile } from "../../sim/terrain";
import { World } from "../../sim/world";
import { ViewOptions } from "../renderer";
import { IsoCamera } from "./camera";
import { CloudLayer, CloudState } from "./clouds";
import { DroneLayer } from "./drones";
import { FireLayer } from "./fire";
import { HoverState, OverlayLayer } from "./overlays";
import { ParticleLayer } from "./particles";
import { Picker } from "./picking";
import { IsoScene } from "./scene";
import { SmokeLayer } from "./smoke";
import { StructureLayer } from "./structures";
import { TerrainLayer, TileVis } from "./terrain";
import { TreeLayer } from "./trees";
import { disposeTree } from "./util";

export { V_SCALE } from "./util";

/** `showBlocked` (from ViewOptions) draws in-range pairs that are cut off, dashed and coloured by cause. */
export interface IsoViewOptions extends ViewOptions {
  /** Radius (tiles) of a preview circle around the hovered tile; 0 or undefined for none. */
  hoverRadius?: number;
}

export interface PickResult {
  /** Tile under the pointer (null if the pointer is off the map). */
  tile: number | null;
  x: number;
  y: number;
  /** Drone drawn under the pointer, if any. */
  drone: number | null;
}

const FOG_LEVELS = 7;
const REGROW_STAGE_TICKS = 120; // regrown ground looks young for three stages of this length
const FOG_TICKS = 300; // a tile this long unseen is as dark as it gets (same scale as the 2D view)

export class IsoRenderer {
  readonly cam = new IsoCamera();
  /** Called for a click (press and release without dragging) on the map. */
  onClick: (hit: PickResult, ev: PointerEvent) => void = () => {};

  private readonly stage: IsoScene;
  private readonly labelLayer: HTMLDivElement;
  private readonly picker: Picker;
  private readonly detach: (() => void)[] = [];
  private world!: World;
  private root = new Group();
  private terrain!: TerrainLayer;
  private trees!: TreeLayer;
  private structures!: StructureLayer;
  private fire!: FireLayer;
  private smoke!: SmokeLayer;
  private particles!: ParticleLayer;
  private drones!: DroneLayer;
  private overlays!: OverlayLayer;
  private clouds!: CloudLayer;

  private keys = new Uint16Array(0); // last visual key applied per tile
  private truthFire = new Uint8Array(0); // true fire state before the most recent tick
  private syncedTick = -1;
  private syncedSource: BeliefMap | null | undefined = undefined;
  private lastTime = performance.now() / 1000;
  private readonly pointer = { x: 0, y: 0, inside: false, dirty: false };
  private readonly hover: HoverState = { tile: null, radius: 0 };
  private frameMs = 0;
  private cloudsWanted = false;

  constructor(container: HTMLElement, world: World) {
    this.stage = new IsoScene(container);
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "iso-labels";
    container.appendChild(this.labelLayer);
    this.picker = new Picker(this.stage.canvas, this.cam);

    const canvas = this.stage.canvas;
    this.detach.push(this.cam.attach(canvas, (cx, cy, ev) => this.onClick(this.pick(cx, cy), ev)));
    const move = (e: PointerEvent) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      this.pointer.dirty = true;
    };
    const leave = () => {
      this.pointer.inside = false;
      this.pointer.dirty = true;
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    this.detach.push(() => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    });

    this.setWorld(world);
  }

  /** Swap in a new run. Rebuilds every layer; the WebGL context and camera rig are reused. */
  setWorld(world: World) {
    if (this.world) this.clearWorld();
    this.world = world;
    const { w, h } = world.terrain;
    const n = w * h;

    this.terrain = new TerrainLayer(world);
    this.structures = new StructureLayer(world, this.terrain);
    this.trees = new TreeLayer(world, this.terrain, this.structures.reserved);
    this.fire = new FireLayer(this.terrain, world.cfg.maxSeverity);
    this.smoke = new SmokeLayer(world, this.terrain);
    this.particles = new ParticleLayer();
    this.drones = new DroneLayer(world, this.terrain, this.particles, this.labelLayer, this.structures.padTopY);
    this.overlays = new OverlayLayer(world, this.terrain);
    this.clouds = new CloudLayer(this.terrain);
    if (this.cloudsWanted) this.clouds.cover(); // a new run before the intro was started stays covered

    this.root = new Group();
    this.root.add(
      this.terrain.group,
      this.trees.group,
      this.structures.group,
      this.fire.group,
      this.drones.group,
      this.smoke.group,
      this.particles.group,
      this.overlays.group,
      this.clouds.group,
    );
    this.stage.scene.add(this.root);

    this.keys = new Uint16Array(n).fill(0xffff); // forces every tile through applyTile once
    this.truthFire = Uint8Array.from(world.env.fire);
    this.syncedTick = -1;
    this.syncedSource = undefined;
    this.hover.tile = null;

    this.stage.resize();
    this.stage.fitToMap(w, h, this.terrain.maxY);
    this.cam.frame(w, h, this.terrain.maxY, this.stage.aspect);
  }

  private clearWorld() {
    this.stage.scene.remove(this.root);
    disposeTree(this.root);
    this.drones.dispose();
  }

  /** Call after every world.step(). Cheap: snapshots drone positions and spots one-off events. */
  onTick() {
    this.drones.onTick(performance.now() / 1000, this.truthFire);
    this.truthFire.set(this.world.env.fire);
  }

  /**
   * Draw one frame.
   * @param alpha how far we are between the previous sim tick and the current one (0..1);
   *              pass 1 when the sim is paused so the exact current state is shown.
   */
  draw(view: IsoViewOptions, alpha: number) {
    const t0 = performance.now();
    const now = t0 / 1000;
    const dt = Math.min(0.1, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    const world = this.world;

    if (this.stage.resize()) this.cam.setAspect(this.stage.aspect, this.terrain.maxY);
    this.cam.update(dt);
    const { width, height } = this.stage.size;

    // What the fire layers show: the truth, or one drone's belief about it.
    const viewer = view.beliefOf !== null ? world.drones[view.beliefOf] : undefined;
    const source = viewer ? viewer.belief : null;
    if (world.tick !== this.syncedTick || source !== this.syncedSource) {
      this.syncTiles(source, now);
      this.smoke.sync();
      this.syncedTick = world.tick;
      this.syncedSource = source;
    }

    if (this.pointer.dirty) {
      this.pointer.dirty = false;
      this.hover.tile = this.pointer.inside ? this.picker.tileAt(this.pointer.x, this.pointer.y, this.terrain) : null;
    }
    this.hover.radius = view.hoverRadius ?? 0;

    this.terrain.update(now);
    this.structures.update(now);
    this.fire.update(now, world.tick, source ? source.severity : world.env.severity);
    this.smoke.update(now, view.showSmoke && !source); // smoke is not part of a drone's fire map
    this.drones.update(alpha, now, dt, this.cam, width, height, view.selected);
    this.particles.update(dt);
    this.overlays.update(view, this.hover, now, this.cam.unitsPerPixel(height), this.nodePos);
    this.clouds.update(dt, now);

    this.stage.gl.render(this.stage.scene, this.cam.camera);
    this.frameMs += (performance.now() - t0 - this.frameMs) * 0.1;
  }

  /** World-space position of a comms node: a drone, or the tip of the base mast. */
  private nodePos = (id: number): Vector3 | null => {
    if (id === BASE_ID) return this.structures.mastTop;
    if (id < BASE_ID) return this.structures.towerTop(id) ?? null;
    return this.drones.pos[id] ?? null;
  };

  /**
   * Diff the fire / wetness (or belief) arrays against what is on screen and restyle
   * only the tiles whose look changed. Everything a tile's look depends on is packed
   * into one small integer key.
   */
  private syncTiles(source: BeliefMap | null, now: number) {
    const world = this.world;
    const env = world.env;
    const type = world.terrain.type;
    const fireArr = source ? source.fire : env.fire;
    const n = this.keys.length;
    const tick = world.tick;
    for (let i = 0; i < n; i++) {
      const f = fireArr[i];
      let vis: TileVis;
      let wetQ = 0;
      let fogQ = 0;
      let fuelQ = 3;
      let youngQ = 0; // 3 = just regrown ... 0 = mature
      if (f === Fire.Burning) {
        vis = TileVis.Burning;
        if (!source) {
          const total = FUEL[type[i] as Tile].burnTicks;
          fuelQ = total > 0 ? Math.max(0, Math.min(3, Math.floor((env.burnLeft[i] / total) * 4))) : 0;
        }
      } else if (f === Fire.Burnt) {
        // Extinguished tiles are Burnt with wetness 1 (wetness only decays on unburnt tiles).
        vis = !source && env.wetness[i] >= 0.5 ? TileVis.Extinguished : TileVis.BurntOut;
      } else {
        vis = TileVis.Unburnt;
        if (!source) {
          wetQ = Math.min(7, Math.ceil(env.wetness[i] * 7));
          const regrown = env.regrownAt[i];
          if (regrown >= 0) youngQ = Math.max(0, 3 - Math.floor((tick - regrown) / REGROW_STAGE_TICKS));
        }
      }
      if (source) {
        const seen = source.lastSeen[i];
        fogQ = seen < 0 ? FOG_LEVELS : Math.min(FOG_LEVELS, Math.floor(((tick - seen) / FOG_TICKS) * (FOG_LEVELS + 1)));
      }
      const key = vis | (wetQ << 2) | (fogQ << 5) | (fuelQ << 8) | (youngQ << 10);
      if (key === this.keys[i]) continue;
      this.keys[i] = key;
      const fog = fogQ / FOG_LEVELS;
      this.terrain.applyTile(i, vis, wetQ / 7, fog, youngQ / 3);
      this.trees.applyTile(i, vis, fog, (fuelQ + 1) / 4, youngQ / 3);
      this.structures.applyTile(i, vis, fog);
      this.fire.applyTile(i, vis, now, tick);
    }
    this.trees.finish();
  }

  /** What is under a client-space pointer position. */
  pick(clientX: number, clientY: number): PickResult {
    const tile = this.picker.tileAt(clientX, clientY, this.terrain);
    const w = this.world.terrain.w;
    return {
      tile,
      x: tile === null ? -1 : tile % w,
      y: tile === null ? -1 : Math.floor(tile / w),
      drone: this.picker.droneAt(clientX, clientY, this.drones),
    };
  }

  /** Where the centre of a tile's top surface is on screen (CSS px inside the stage). */
  tileToScreen(tile: number): { x: number; y: number } {
    const w = this.world.terrain.w;
    const { width, height } = this.stage.size;
    const v = new Vector3(tile % w, this.terrain.topY[tile], Math.floor(tile / w));
    return this.cam.project(v, width, height, { x: 0, y: 0 });
  }

  /** Where a drone is drawn on screen (CSS px inside the stage), as of the last frame. */
  droneToScreen(id: number): { x: number; y: number } {
    return { x: this.drones.screenX[id], y: this.drones.screenY[id] };
  }

  /** Hide the whole map under clouds (the opening screen). */
  coverWithClouds() {
    this.cloudsWanted = true;
    this.clouds.cover();
  }

  /** Part the clouds over `seconds`, then call `done`. */
  clearClouds(seconds: number, done?: () => void) {
    this.cloudsWanted = false;
    this.clouds.clear(seconds, done);
  }

  get cloudState(): CloudState {
    return this.clouds.state;
  }

  rotate(dir: 1 | -1) {
    this.cam.rotate(dir);
  }
  resetCamera() {
    this.cam.reset();
  }
  /** Centre the view on a sim position (used by the minimap). */
  focus(x: number, y: number) {
    this.cam.focus(x, y);
  }

  /** On-screen angle of a sim-plane direction, for the wind compass. */
  screenAngle(dx: number, dy: number) {
    return this.cam.screenAngle(dx, dy);
  }

  /** Numbers for the performance readout. */
  stats() {
    const info = this.stage.gl.info;
    return { frameMs: this.frameMs, calls: info.render.calls, triangles: info.render.triangles, trees: this.trees.total };
  }

  dispose() {
    for (const off of this.detach) off();
    this.clearWorld();
    this.labelLayer.remove();
    this.stage.dispose();
  }
}
