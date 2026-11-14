// Overlays: everything drawn on top of the world to explain what the swarm is doing.
//   - comms links: glowing beams between nodes, at the altitudes the sim uses for line of sight
//   - blackout zones: translucent purple domes
//   - for the selected drone: sensor ring, target line, guesses about lost teammates
//   - the tile under the cursor
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Vector2,
  Vector3,
} from "three";
import { World } from "../../sim/world";
import { STATE_COLOUR, TEAM_COLOURS, ViewOptions } from "../renderer";
import { TerrainLayer } from "./terrain";
import { V_SCALE, rgb, setBeam, setInstance, uploadUsed } from "./util";

const LINK = rgb(0x8ff3ff);
const MAX_LINKS = 1024;
const MAX_DASHES = 3000;
const RING_DOTS = 72;
const BLACKOUT = 0xc77dff;

export interface HoverState {
  tile: number | null;
  /** Radius (tiles) of a preview circle around the hovered tile, 0 for none (blackout tool). */
  radius: number;
}

export class OverlayLayer {
  readonly group = new Group();
  private readonly beams: InstancedMesh;
  private readonly glow: InstancedMesh;
  private readonly dashes: InstancedMesh;
  private readonly dots: InstancedMesh;
  private readonly domes = new Group();
  private domesBuiltFor: unknown = null;
  private domeCount = 0;
  private readonly marker: Mesh;
  private readonly selRing: Mesh;
  private readonly hover: Mesh;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly d0 = new Vector3(); // scratch for addDashes only (callers may pass a / b)
  private readonly d1 = new Vector3();
  private readonly colour = new Color();
  private dashCount = 0;
  private dotCount = 0;

  constructor(private world: World, private terrain: TerrainLayer) {
    const box = new BoxGeometry(1, 1, 1);
    // A crisp core line plus a faint additive halo. (A fully additive core washes out to
    // white wherever a well-connected swarm's links cross.)
    this.beams = new InstancedMesh(
      box,
      new MeshBasicMaterial({ color: LINK, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
      MAX_LINKS,
    );
    this.glow = new InstancedMesh(
      box,
      new MeshBasicMaterial({
        color: LINK,
        transparent: true,
        opacity: 0.07,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      MAX_LINKS,
    );
    this.dashes = new InstancedMesh(box, new MeshBasicMaterial({ toneMapped: false }), MAX_DASHES);
    const dotCapacity = RING_DOTS * 2 + world.drones.length * world.cfg.trackerParticles + 8;
    this.dots = new InstancedMesh(box, new MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.85 }), dotCapacity);
    for (const m of [this.beams, this.glow, this.dashes, this.dots]) {
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 8;
    }
    this.dashes.setColorAt(0, this.colour.set(0xffffff));
    this.dots.setColorAt(0, this.colour);

    const flatRing = (inner: number, outer: number, colour: number, opacity: number) =>
      new Mesh(
        new RingGeometry(inner, outer, 24).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: colour, transparent: true, opacity, side: DoubleSide, depthWrite: false, toneMapped: false }),
      );
    this.marker = flatRing(0.34, 0.5, 0xffffff, 0.9);
    this.selRing = flatRing(0.5, 0.62, 0xffffff, 0.95);
    this.hover = new Mesh(
      new BoxGeometry(1.02, 0.06, 1.02),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }),
    );
    for (const m of [this.marker, this.selRing, this.hover]) {
      m.visible = false;
      m.renderOrder = 9;
    }
    this.group.add(this.domes, this.glow, this.beams, this.dashes, this.dots, this.marker, this.selRing, this.hover);
  }

  /**
   * @param nodePos   world position of a comms node (drone id, or BASE_ID)
   * @param pxToWorld world units per screen pixel, so line widths stay constant on screen
   */
  update(
    view: ViewOptions,
    hover: HoverState,
    time: number,
    pxToWorld: number,
    nodePos: (id: number) => Vector3 | null,
  ) {
    const world = this.world;
    this.dashCount = 0;
    this.dotCount = 0;

    // ------------------------------------------------------------ usable links
    let n = 0;
    if (view.showLinks) {
      const core = 1.5 * pxToWorld;
      const halo = 5 * pxToWorld;
      for (const [ia, ib] of world.network.links) {
        const pa = nodePos(ia);
        const pb = nodePos(ib);
        if (!pa || !pb || n >= MAX_LINKS) continue;
        setBeam(this.beams, n, pa, pb, core);
        setBeam(this.glow, n, pa, pb, halo);
        n++;
      }
    }
    this.beams.count = this.glow.count = n;
    uploadUsed(this.beams.instanceMatrix, n);
    uploadUsed(this.glow.instanceMatrix, n);

    // ------------------------------------------------------------ blackout zones
    this.syncDomes();
    const breathe = 0.16 + 0.04 * Math.sin(time * 1.6);
    for (const dome of this.domes.children) ((dome as Mesh).material as MeshBasicMaterial).opacity = breathe;

    // ------------------------------------------------------------ selected drone
    const sel = view.selected !== null ? world.drones[view.selected] : null;
    const selPos = sel ? nodePos(sel.id) : null;
    this.selRing.visible = !!(sel && selPos);
    this.marker.visible = false;
    if (sel && selPos) {
      this.selRing.position.copy(selPos);
      this.selRing.position.y -= 0.12;
      const pulse = 1 + 0.08 * Math.sin(time * 5);
      this.selRing.scale.set(pulse, 1, pulse);

      if (sel.alive) {
        // A drop line to the ground: in an isometric view height is otherwise ambiguous.
        this.a.copy(selPos);
        this.b.set(selPos.x, this.terrain.topAt(selPos.x, selPos.z), selPos.z);
        this.addDashes(this.a, this.b, 0xffffff, 1.4 * pxToWorld, 0.12, 0.1, 0);

        if (view.showSensors) this.addRing(sel.x, sel.y, this.sensorRadius(sel.x, sel.y), 0xffffff, time * 0.15);

        // Where it is heading, in the colour of what it is doing.
        const moving = sel.state === "toFire" || sel.state === "toWater" || sel.state === "scouting" || sel.state === "toBase";
        if (moving) {
          const tx = sel.state === "toBase" ? world.base.x : sel.targetX;
          const ty = sel.state === "toBase" ? world.base.y : sel.targetY;
          const hex = this.colour.set(STATE_COLOUR[sel.state] ?? "#ffffff").getHex();
          this.b.set(tx, this.terrain.topAt(tx, ty) + 0.12, ty);
          this.addDashes(selPos, this.b, hex, 2 * pxToWorld, 0.4, 0.3, time * 1.6);
          this.marker.visible = true;
          this.marker.position.copy(this.b);
          (this.marker.material as MeshBasicMaterial).color.set(hex);
          const s = 1 + 0.25 * Math.sin(time * 6);
          this.marker.scale.set(s, 1, s);
        }

        // Its guesses about teammates it can no longer hear: one voxel per particle.
        if (view.showClouds) {
          const alt = world.cfg.droneAltitude * V_SCALE;
          for (const [id, tr] of sel.trackers) {
            this.colour.set(TEAM_COLOURS[id % TEAM_COLOURS.length]);
            for (let k = 0; k < tr.n; k++) {
              if (this.dotCount >= this.dots.instanceMatrix.count) break;
              const x = tr.xs[k];
              const z = tr.ys[k];
              setInstance(this.dots, this.dotCount, x, this.terrain.topAt(x, z) + alt, z, 0.17, 0.17, 0.17);
              this.dots.setColorAt(this.dotCount++, this.colour);
            }
          }
        }
      }
    }

    // ------------------------------------------------------------ hover
    this.hover.visible = hover.tile !== null;
    if (hover.tile !== null) {
      const w = world.terrain.w;
      const hx = hover.tile % w;
      const hy = (hover.tile - hx) / w;
      this.hover.position.set(hx, this.terrain.topY[hover.tile] + 0.04, hy);
      if (hover.radius > 0) this.addRing(hx, hy, hover.radius, BLACKOUT, 0);
    }

    this.dashes.count = this.dashCount;
    uploadUsed(this.dashes.instanceMatrix, this.dashCount);
    uploadUsed(this.dashes.instanceColor, this.dashCount);
    this.dots.count = this.dotCount;
    uploadUsed(this.dots.instanceMatrix, this.dotCount);
    uploadUsed(this.dots.instanceColor, this.dotCount);
  }

  /** The radius the selected drone can actually see right now (thick smoke shrinks it, as in Drone.sense). */
  private sensorRadius(x: number, y: number): number {
    const cfg = this.world.cfg;
    let r = cfg.sensorRadius;
    if (cfg.smokeBlocksSensing) r = r / (1 + this.world.env.smokeAt(x, y) / cfg.thickSmoke);
    return Math.max(1.5, r);
  }

  /** A circle of voxels draped over the terrain. */
  private addRing(cx: number, cy: number, radius: number, hex: number, spin: number) {
    this.colour.set(hex);
    for (let k = 0; k < RING_DOTS; k++) {
      if (this.dotCount >= this.dots.instanceMatrix.count) return;
      const ang = (k / RING_DOTS) * Math.PI * 2 + spin;
      const x = cx + Math.cos(ang) * radius;
      const z = cy + Math.sin(ang) * radius;
      const inside = x >= -0.5 && z >= -0.5 && x <= this.terrain.w - 0.5 && z <= this.terrain.h - 0.5;
      if (!inside) continue;
      setInstance(this.dots, this.dotCount, x, this.terrain.topAt(x, z) + 0.1, z, 0.13, 0.13, 0.13);
      this.dots.setColorAt(this.dotCount++, this.colour);
    }
  }

  /**
   * A dashed line from `from` to `to`. `offset` slides the dashes along the line
   * (animate it for a marching effect).
   */
  addDashes(from: Vector3, to: Vector3, hex: number, thickness: number, dash: number, gap: number, offset: number) {
    const len = from.distanceTo(to);
    if (len < 1e-4) return;
    const period = dash + gap;
    this.colour.set(hex);
    let s = -(((offset % period) + period) % period);
    while (s < len && this.dashCount < MAX_DASHES) {
      const s0 = Math.max(0, s);
      const s1 = Math.min(len, s + dash);
      if (s1 > s0) {
        this.d0.copy(from).lerp(to, s0 / len);
        this.d1.copy(from).lerp(to, s1 / len);
        setBeam(this.dashes, this.dashCount, this.d0, this.d1, thickness);
        this.dashes.setColorAt(this.dashCount++, this.colour);
      }
      s += period;
    }
  }

  /** Rebuild the dome meshes when the sim's blackout list changes (judges add or clear them). */
  private syncDomes() {
    const list = this.world.blackouts;
    if (this.domesBuiltFor === list && this.domeCount === list.length) return;
    this.domesBuiltFor = list;
    this.domeCount = list.length;
    for (const child of [...this.domes.children]) {
      this.domes.remove(child);
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as MeshBasicMaterial).dispose();
      for (const edge of child.children) {
        (edge as LineSegments).geometry.dispose();
        ((edge as LineSegments).material as LineBasicMaterial).dispose();
      }
    }
    const { w, h } = this.world.terrain;
    for (const zone of list) {
      // The sim's blackout is a vertical cylinder; a straight-walled dome keeps the visual
      // edge where the rule's edge is, at ground level and at flying height.
      const profile: Vector2[] = [new Vector2(zone.r, 0), new Vector2(zone.r, zone.r * 0.32)];
      for (let k = 1; k <= 5; k++) {
        const t = (k / 5) * (Math.PI / 2);
        profile.push(new Vector2(Math.cos(t) * zone.r, zone.r * 0.32 + Math.sin(t) * zone.r * 0.45));
      }
      const geo = new LatheGeometry(profile, 18);
      const dome = new Mesh(
        geo,
        new MeshBasicMaterial({ color: BLACKOUT, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false, toneMapped: false }),
      );
      // Sit the dome on the lowest ground inside the zone so its wall reaches the terrain everywhere.
      let low = Infinity;
      const r = Math.ceil(zone.r);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.round(zone.x) + dx;
          const y = Math.round(zone.y) + dy;
          if (x < 0 || y < 0 || x >= w || y >= h || dx * dx + dy * dy > zone.r * zone.r) continue;
          low = Math.min(low, this.terrain.topY[y * w + x]);
        }
      }
      dome.position.set(zone.x, (Number.isFinite(low) ? low : 0) - 0.2, zone.y);
      dome.renderOrder = 7;
      const edges = new LineSegments(
        new EdgesGeometry(geo, 20),
        new LineBasicMaterial({ color: 0xe2b8ff, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      edges.renderOrder = 7;
      dome.add(edges);
      this.domes.add(dome);
    }
  }
}
