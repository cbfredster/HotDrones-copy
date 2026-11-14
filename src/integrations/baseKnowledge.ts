// What the BASE knows, and nothing more. The AI incident commander sits at the base: it sees
// the base's own fire map, the drones in the base's comms group right now, and the last status
// heard from everyone else. When base comms are cut, this picture freezes and goes stale.
//
// Pure and read-only (no DOM, no network, no RNG), so the server can build the same picture
// for headless challenge runs.
import { BASE_ID } from "../sim/comms";
import { Fire } from "../sim/environment";
import { computeZones } from "../sim/planner";
import type { World } from "../sim/world";
import type { SimEvent } from "./events";

export interface BaseSnapshot {
  tick: number; // now
  infoTick: number; // tick the information below dates from
  staleTicks: number; // tick - infoTick: 0 while the base radio is up
  baseOnline: boolean;
  mode: string;
  map: { width: number; height: number; village: { x: number; y: number }; base: { x: number; y: number }; note: string };
  wind: { blowingTowards: string; speedPercent: number };
  fire: { knownBurningTiles: number; knownBurntTiles: number; nearestToVillage: number | null };
  zones: { x: number; y: number; frontTiles: number; threat: number; infoAgeTicks: number }[];
  dronesInContact: { id: number; state: string; battery: number; water: number; x: number; y: number }[];
  dronesSilent: { id: number; lastHeardTick: number; silentFor: number; lastState: string; x: number; y: number }[];
  dronesKnownLost: number[];
  recent: string[]; // recent things the base heard, oldest first
}

const COMPASS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]; // sim angle 0 = +x (east), +y is south
export function compassOf(angle: number) {
  const k = Math.round((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8;
  return COMPASS[k];
}
export function angleOfCompass(name: string): number | null {
  const k = COMPASS.indexOf(name.toUpperCase());
  return k < 0 ? null : (k * Math.PI) / 4;
}

interface Heard {
  tick: number;
  state: string;
  battery: number;
  water: number;
  x: number;
  y: number;
}

export class BaseKnowledge {
  private world: World | null = null;
  private heard = new Map<number, Heard>();
  private knownLost = new Set<number>();
  private recent: { tick: number; text: string }[] = [];
  private frozen: BaseSnapshot | null = null;
  private infoTick = 0;

  /** Call every tick with that tick's events. */
  update(world: World, events: readonly SimEvent[]) {
    if (world !== this.world) {
      this.world = world;
      this.heard.clear();
      this.knownLost.clear();
      this.recent = [];
      this.frozen = null;
      this.infoTick = world.tick;
    }
    const online = world.baseOnline;
    if (online) {
      this.infoTick = world.tick;
      for (const d of world.drones) {
        if (!d.alive) continue;
        if (d.state === "charging" || world.inContact(d.id, BASE_ID)) {
          this.heard.set(d.id, { tick: world.tick, state: d.state, battery: d.battery, water: d.water, x: d.x, y: d.y });
        }
      }
    }
    for (const e of events) {
      // The base only hears about things that reach it.
      if (e.type === "baseOffline") this.note(e.tick, "Base radio went down.");
      else if (e.type === "baseOnline") this.note(e.tick, "Base radio restored.");
      else if (e.type === "judgeAction") continue;
      else if (!online) continue;
      else if (e.type === "fireSpotted") this.note(e.tick, `New fire reported near (${e.x}, ${e.y}).`);
      else if (e.type === "linkLost" && e.scope === "base") this.note(e.tick, `Lost contact with drone ${e.id}.`);
      else if (e.type === "linkRegained" && e.scope === "base") this.note(e.tick, `Drone ${e.id} back in contact.`);
      else if (e.type === "droneCrashed") {
        const h = this.heard.get(e.id);
        if (h && e.tick - h.tick <= 2) {
          this.knownLost.add(e.id);
          this.note(e.tick, `Drone ${e.id} went down (${e.cause === "battery" ? "battery" : e.cause === "fire" ? "fire damage" : "cause unknown"}).`);
        }
      } else if (e.type === "villageLost") this.note(e.tick, "Fire has reached the village.");
      else if (e.type === "fireOut") this.note(e.tick, "No fire left on the map.");
    }
    if (online || !this.frozen) this.frozen = null; // rebuilt lazily in snapshot()
  }

  private note(tick: number, text: string) {
    this.recent.push({ tick, text });
    if (this.recent.length > 8) this.recent.shift();
  }

  /** The base's picture right now. While the base is offline this is the last picture it had. */
  snapshot(world: World): BaseSnapshot {
    const online = world.baseOnline;
    if (!online && this.frozen) {
      return { ...this.frozen, tick: world.tick, staleTicks: world.tick - this.frozen.infoTick, baseOnline: false, recent: this.recent.map((r) => `t=${r.tick}: ${r.text}`) };
    }
    const w = world.env.w;
    const belief = world.base.belief;
    const v = world.terrain.village[4];
    const vx = v % w;
    const vy = Math.floor(v / w);
    let burning = 0;
    let burnt = 0;
    let nearest = Infinity;
    for (let i = 0; i < belief.fire.length; i++) {
      if (belief.fire[i] === Fire.Burning) {
        burning++;
        nearest = Math.min(nearest, Math.hypot((i % w) - vx, Math.floor(i / w) - vy));
      } else if (belief.fire[i] === Fire.Burnt) burnt++;
    }
    const zones = computeZones(belief, world.terrain, world.env.wind, world.cfg)
      .sort((a, b) => b.value - a.value)
      .slice(0, 6)
      .map((z) => ({ x: z.tx, y: z.ty, frontTiles: z.frontier, threat: Math.round(z.value * 10) / 10, infoAgeTicks: Math.max(0, this.infoTick - Math.max(0, belief.lastSeen[z.target])) }));
    const inContact: BaseSnapshot["dronesInContact"] = [];
    const silent: BaseSnapshot["dronesSilent"] = [];
    for (const d of world.drones) {
      const h = this.heard.get(d.id);
      if (this.knownLost.has(d.id)) continue;
      if (h && this.infoTick - h.tick <= 1) inContact.push({ id: d.id, state: h.state, battery: Math.round(h.battery * 100), water: Math.round(h.water * 10) / 10, x: Math.round(h.x), y: Math.round(h.y) });
      else if (h) silent.push({ id: d.id, lastHeardTick: h.tick, silentFor: this.infoTick - h.tick, lastState: h.state, x: Math.round(h.x), y: Math.round(h.y) });
      else silent.push({ id: d.id, lastHeardTick: 0, silentFor: this.infoTick, lastState: "launching", x: Math.round(world.base.x), y: Math.round(world.base.y) });
    }
    const snap: BaseSnapshot = {
      tick: world.tick,
      infoTick: this.infoTick,
      staleTicks: world.tick - this.infoTick,
      baseOnline: online,
      mode: world.cfg.mode,
      map: {
        width: world.env.w,
        height: world.env.h,
        village: { x: vx, y: vy },
        base: { x: Math.round(world.base.x), y: Math.round(world.base.y) },
        note: "x grows east, y grows south; (0,0) is the north-west corner",
      },
      wind: { blowingTowards: compassOf(world.env.wind.angle), speedPercent: Math.round(world.env.wind.speed * 100) },
      fire: { knownBurningTiles: burning, knownBurntTiles: burnt, nearestToVillage: Number.isFinite(nearest) ? Math.round(nearest) : null },
      zones,
      dronesInContact: inContact,
      dronesSilent: silent,
      dronesKnownLost: [...this.knownLost],
      recent: this.recent.map((r) => `t=${r.tick}: ${r.text}`),
    };
    if (!online) this.frozen = snap;
    return snap;
  }
}

/** How old the commander's picture is, as a label for the radio log. */
export function stalenessLabel(s: BaseSnapshot) {
  return s.staleTicks <= 0 ? "live" : `${s.staleTicks} ticks stale`;
}

/** A plain rule-based sitrep, used when Gemini is not connected (and as its fallback on errors). */
export function localSitrep(s: BaseSnapshot): string {
  if (!s.baseOnline) {
    return `Base radio is down. Last picture is from tick ${s.infoTick}: ${s.fire.knownBurningTiles} tiles burning in ${s.zones.length} zone${s.zones.length === 1 ? "" : "s"}. No contact with any drone. The swarm is on its own.`;
  }
  const parts: string[] = [];
  if (s.fire.knownBurningTiles === 0) parts.push("No fire on the base map.");
  else {
    const z = s.zones[0];
    parts.push(z ? `${s.fire.knownBurningTiles} tiles burning across ${s.zones.length} zone${s.zones.length === 1 ? "" : "s"}, worst front near (${z.x}, ${z.y}).` : `${s.fire.knownBurningTiles} tiles still burning, no active front.`);
    if (s.fire.nearestToVillage !== null) parts.push(s.fire.nearestToVillage <= 9 ? `Fire is ${s.fire.nearestToVillage} tiles from the village.` : `Nearest fire to the village: ${s.fire.nearestToVillage} tiles.`);
  }
  parts.push(`${s.dronesInContact.length} drone${s.dronesInContact.length === 1 ? "" : "s"} in contact.`);
  if (s.dronesSilent.length) {
    const worst = s.dronesSilent.reduce((a, b) => (b.silentFor > a.silentFor ? b : a));
    parts.push(`${s.dronesSilent.length} silent (${s.dronesSilent.map((d) => d.id).join(", ")}); drone ${worst.id} not heard for ${worst.silentFor} ticks.`);
  }
  if (s.dronesKnownLost.length) parts.push(`Lost: drone ${s.dronesKnownLost.join(", ")}.`);
  parts.push(`Wind towards ${s.wind.blowingTowards} at ${s.wind.speedPercent}%.`);
  return parts.join(" ");
}
