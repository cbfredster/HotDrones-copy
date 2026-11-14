// One typed event stream, derived by diffing world state after each tick.
// The radio log, voices, AI commander, databases and music all consume this stream.
//
// This file only READS the world (never world.rng / world.agentRng, never a write), and
// has no DOM or network imports, so the server and the experiment runner can use it too.
import { BASE_ID } from "../sim/comms";
import type { DroneState } from "../sim/drone";
import { Fire } from "../sim/environment";
import type { JudgeAction } from "../sim/judge";
import type { World } from "../sim/world";

export type SimEvent = { tick: number } & (
  | { type: "runStarted"; seed: number; mode: string; drones: number }
  | { type: "fireSpotted"; zone: number; x: number; y: number } // a new part of the fire appears on the BASE's map
  | { type: "droneState"; id: number; from: DroneState; to: DroneState; battery: number; damage: number; water: number }
  | { type: "droneCrashed"; id: number; cause: "fire" | "battery" | "judge"; x: number; y: number }
  | { type: "waterDrop"; id: number; x: number; y: number; hitFire: boolean }
  | { type: "linkLost"; id: number; scope: "base" | "all" } // "base": left the base's group; "all": can reach nobody
  | { type: "linkRegained"; id: number; scope: "base" | "all" }
  | { type: "networkSplit"; groups: number }
  | { type: "networkHealed"; groups: number }
  | { type: "baseOffline" }
  | { type: "baseOnline" }
  | { type: "towerLost"; id: number; x: number; y: number }
  | { type: "villageThreatened"; distance: number }
  | { type: "villageLost" }
  | { type: "fireOut" }
  | { type: "runFinished"; burnt: number; villageLost: boolean; dronesLost: number }
  | { type: "judgeAction"; action: JudgeAction }
);
export type SimEventType = SimEvent["type"];

const LINK_HOLD = 6; // a link change must hold this many ticks before it is reported (links flap at range)
const THREAT_DISTANCE = 9; // burning tile this close to the village = "threatened"

interface LinkTrack {
  reported: boolean; // the state last reported
  pending: number; // ticks the opposite state has held
}

export class EventDeriver {
  private world: World | null = null;
  private states: DroneState[] = [];
  private water: number[] = [];
  private baseOn = true;
  private baseLink: LinkTrack[] = [];
  private anyLink: LinkTrack[] = [];
  private groups = 1;
  private groupsPending = 0;
  private knownZones = new Set<number>();
  private towers: boolean[] = [];
  private threatened = false;
  private villageLost = false;
  private out = false;
  private finished = false;
  private judgeSeen = 0;
  private started = false;

  /** Call once after every world.step() (and after a judge action while paused). Returns the new events. */
  poll(world: World): SimEvent[] {
    const ev: SimEvent[] = [];
    const tick = world.tick;
    if (world !== this.world) this.reset(world);
    if (!this.started) {
      this.started = true;
      ev.push({ tick, type: "runStarted", seed: world.cfg.seed, mode: world.cfg.mode, drones: world.drones.length });
    }

    // Judge actions (also covers replays, which re-apply recorded actions).
    const log = world.judgeLog;
    for (; this.judgeSeen < log.length; this.judgeSeen++) {
      ev.push({ tick: log[this.judgeSeen].tick, type: "judgeAction", action: log[this.judgeSeen].action });
    }

    // Base radio.
    const baseOn = world.baseOnline;
    if (baseOn !== this.baseOn) {
      this.baseOn = baseOn;
      ev.push({ tick, type: baseOn ? "baseOnline" : "baseOffline" });
      for (const t of this.baseLink) t.pending = 0; // every base link changed at once: one event is enough
      for (let i = 0; i < this.baseLink.length; i++) this.baseLink[i].reported = baseOn && world.inContact(i, BASE_ID);
    }

    // Drones.
    const w = world.env.w;
    for (const d of world.drones) {
      const prev = this.states[d.id];
      if (d.state !== prev) {
        this.states[d.id] = d.state;
        if (d.state === "dead") {
          const cause = d.damage >= 1 ? "fire" : d.battery <= 0 ? "battery" : "judge";
          ev.push({ tick, type: "droneCrashed", id: d.id, cause, x: d.x, y: d.y });
        } else {
          ev.push({ tick, type: "droneState", id: d.id, from: prev, to: d.state, battery: d.battery, damage: d.damage, water: d.water });
        }
      }
      if (d.waterDropped !== this.water[d.id]) {
        this.water[d.id] = d.waterDropped;
        const i = Math.round(d.y) * w + Math.round(d.x);
        // A tile that was put out is Burnt and soaking wet; one that is still alight took the hit too.
        const hitFire = world.env.fire[i] === Fire.Burning || (world.env.fire[i] === Fire.Burnt && world.env.wetness[i] >= 0.5);
        ev.push({ tick, type: "waterDrop", id: d.id, x: d.x, y: d.y, hitFire });
      }
      if (!d.alive) continue;
      const docked = d.state === "charging";
      const comp = world.network.componentOf.get(d.id);
      const mates = comp === undefined ? 0 : world.network.components[comp].length - 1;
      this.track(this.baseLink[d.id], baseOn && (docked || world.inContact(d.id, BASE_ID)), baseOn && tick > 3, (on) =>
        ev.push({ tick, type: on ? "linkRegained" : "linkLost", id: d.id, scope: "base" }),
      );
      this.track(this.anyLink[d.id], docked || mates > 0, tick > 3, (on) => ev.push({ tick, type: on ? "linkRegained" : "linkLost", id: d.id, scope: "all" }));
    }

    // Network shape: how many separate groups of drones are there?
    let groups = 0;
    for (const c of world.network.components) if (c.some((id) => id >= 0)) groups++;
    if (groups !== this.groups) {
      if (++this.groupsPending >= LINK_HOLD) {
        ev.push({ tick, type: groups > this.groups ? "networkSplit" : "networkHealed", groups });
        this.groups = groups;
        this.groupsPending = 0;
      }
    } else this.groupsPending = 0;

    // Towers.
    world.towers.forEach((t, k) => {
      if (this.towers[k] && !t.alive) {
        this.towers[k] = false;
        ev.push({ tick, type: "towerLost", id: k, x: t.x, y: t.y });
      }
    });

    // What the base has just learned about the fire (every few ticks: it's a 4096-tile scan).
    if (tick % 5 === 0) {
      const zs = world.cfg.zoneSize;
      const nbx = Math.ceil(w / zs);
      const fire = world.base.belief.fire;
      const now = new Set<number>();
      const where = new Map<number, number>();
      for (let i = 0; i < fire.length; i++) {
        if (fire[i] !== Fire.Burning) continue;
        const z = Math.floor(Math.floor(i / w) / zs) * nbx + Math.floor((i % w) / zs);
        if (!now.has(z)) {
          now.add(z);
          where.set(z, i);
        }
      }
      for (const z of now) {
        if (!this.knownZones.has(z)) {
          const i = where.get(z)!;
          ev.push({ tick, type: "fireSpotted", zone: z, x: i % w, y: Math.floor(i / w) });
        }
      }
      this.knownZones = now;

      // Village threat (ground truth: this one is for the audience, not for any drone).
      if (!this.threatened && !world.env.villageLost) {
        const d = this.villageFireDistance(world);
        if (d <= THREAT_DISTANCE) {
          this.threatened = true;
          ev.push({ tick, type: "villageThreatened", distance: Math.round(d) });
        }
      }
    }

    if (world.env.villageLost && !this.villageLost) {
      this.villageLost = true;
      ev.push({ tick, type: "villageLost" });
    }
    if (world.extinguishedAt >= 0 && !this.out) {
      this.out = true;
      ev.push({ tick, type: "fireOut" });
    }
    if (world.finished && !this.finished) {
      this.finished = true;
      const m = world.metrics();
      ev.push({ tick, type: "runFinished", burnt: m.burnt, villageLost: m.villageLost, dronesLost: m.dronesLost });
    }
    return ev;
  }

  /** Distance (tiles) from the village centre to the nearest burning tile; Infinity if nothing burns. */
  villageFireDistance(world: World): number {
    const w = world.env.w;
    const v = world.terrain.village[4];
    const vx = v % w;
    const vy = Math.floor(v / w);
    const fire = world.env.fire;
    let best = Infinity;
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] !== Fire.Burning) continue;
      const d = Math.hypot((i % w) - vx, Math.floor(i / w) - vy);
      if (d < best) best = d;
    }
    return best;
  }

  private track(t: LinkTrack, now: boolean, report: boolean, emit: (on: boolean) => void) {
    if (now === t.reported) {
      t.pending = 0;
    } else if (++t.pending >= LINK_HOLD) {
      t.reported = now;
      t.pending = 0;
      if (report) emit(now);
    }
  }

  private reset(world: World) {
    this.world = world;
    this.states = world.drones.map((d) => d.state);
    this.water = world.drones.map((d) => d.waterDropped);
    this.baseOn = world.baseOnline;
    this.baseLink = world.drones.map(() => ({ reported: true, pending: 0 }));
    this.anyLink = world.drones.map(() => ({ reported: true, pending: 0 }));
    this.groups = 1;
    this.groupsPending = 0;
    this.knownZones = new Set();
    // The initial briefing is not "spotted": seed with what the base knows at the start.
    const w = world.env.w;
    const zs = world.cfg.zoneSize;
    const nbx = Math.ceil(w / zs);
    const fire = world.base.belief.fire;
    for (let i = 0; i < fire.length; i++) {
      if (fire[i] === Fire.Burning) this.knownZones.add(Math.floor(Math.floor(i / w) / zs) * nbx + Math.floor((i % w) / zs));
    }
    this.towers = world.towers.map((t) => t.alive);
    this.threatened = false;
    this.villageLost = world.env.villageLost;
    this.out = false;
    this.finished = false;
    this.judgeSeen = 0;
    this.started = false;
  }
}

// ---------------------------------------------------------------- telemetry (also pure)
export interface DroneSample {
  id: number;
  x: number;
  y: number;
  alt: number;
  state: DroneState;
  battery: number;
  damage: number;
  water: number;
}
export interface TelemetrySample {
  tick: number;
  burning: number;
  burnt: number;
  thickSmoke: number; // tiles under thick smoke
  groups: number; // separate groups of drones
  links: number;
  baseOnline: boolean;
  dronesAlive: number;
  drones?: DroneSample[];
}

/** One row of fire/network metrics, optionally with every live drone's telemetry. */
export function sampleTelemetry(world: World, withDrones: boolean): TelemetrySample {
  const env = world.env;
  let thick = 0;
  const lim = world.cfg.thickSmoke;
  for (let i = 0; i < env.smoke.length; i++) if (env.smoke[i] > lim) thick++;
  let groups = 0;
  for (const c of world.network.components) if (c.some((id) => id >= 0)) groups++;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const s: TelemetrySample = {
    tick: world.tick,
    burning: env.burningCount(),
    burnt: env.burntCount(),
    thickSmoke: thick,
    groups,
    links: world.network.links.length,
    baseOnline: world.baseOnline,
    dronesAlive: world.drones.filter((d) => d.alive).length,
  };
  if (withDrones) {
    s.drones = world.drones
      .filter((d) => d.alive)
      .map((d) => ({ id: d.id, x: r3(d.x), y: r3(d.y), alt: r3(d.altitude(world.terrain, world.cfg)), state: d.state, battery: r3(d.battery), damage: r3(d.damage), water: r3(d.water) }));
  }
  return s;
}

export interface RunInfo {
  runId: string;
  startedAt: number; // ms since epoch; a sample's time is startedAt + tick seconds
  source: "live" | "experiment" | "challenge";
  seed: number;
  mode: string;
  commsRange: number;
  drones: number;
  experiment?: string; // experiment name ("range", "baseOutage", ...)
  sweepId?: string; // groups the runs of one `npm run experiment`
  config?: Record<string, unknown>;
}
export interface RunResult {
  ticks: number;
  burnt: number;
  villageLost: boolean;
  dronesLost: number;
  waterDropped: number;
  extinguishedAt: number;
}

/** A short, model-friendly digest of an event log for the after-action report. */
export function digestEvents(events: readonly SimEvent[], max = 40): string[] {
  const lines: string[] = [];
  for (const e of events) {
    let s = "";
    if (e.type === "judgeAction") s = `judge: ${JSON.stringify(e.action)}`;
    else if (e.type === "droneCrashed") s = `drone ${e.id} lost (${e.cause})`;
    else if (e.type === "linkLost" && e.scope === "all") s = `drone ${e.id} cut off from everyone`;
    else if (e.type === "networkSplit") s = `network split into ${e.groups} groups`;
    else if (e.type === "networkHealed") s = `network back to ${e.groups} group${e.groups === 1 ? "" : "s"}`;
    else if (e.type === "fireSpotted") s = `base learns of fire near (${e.x}, ${e.y})`;
    else if (e.type === "villageThreatened") s = `fire ${e.distance} tiles from the village`;
    else if (e.type === "baseOffline" || e.type === "baseOnline" || e.type === "villageLost" || e.type === "fireOut") s = e.type;
    else if (e.type === "towerLost") s = `relay tower ${e.id} burnt down`;
    else continue;
    lines.push(`t=${e.tick}: ${s}`);
  }
  if (lines.length <= max) return lines;
  const step = lines.length / max;
  return Array.from({ length: max }, (_, i) => lines[Math.floor(i * step)]);
}
