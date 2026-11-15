// "Challenge the swarm": when someone saves a scenario, run it headless in every coordination
// mode (the sim is plain TypeScript, so it runs in Node exactly as in the browser), store the
// outcomes, and rank the scenarios that hurt the swarm most.
import { EventDeriver, digestEvents, type SimEvent } from "../src/integrations/events";

export { digestEvents };
import { defaultConfig, type Config, type Mode } from "../src/sim/config";
import { ReplayCursor, type RecordedAction } from "../src/sim/judge";
import { World } from "../src/sim/world";
import type { GeoScenario } from "../src/sim/geography";
import type { Outcome } from "./store";

export const MODES: Mode[] = ["swarm", "central", "greedy"];
const SIM_MODES: Mode[] = [...MODES, "cbba", "unified"];

const LIMITS: Partial<Record<keyof Config, [number, number]>> = {
  seed: [-Number.MAX_VALUE, Number.MAX_VALUE],
  maxTicks: [100, 2000],
  droneCount: [0, 30],
  towers: [0, 4],
  ignitions: [0, 8],
  preburnTicks: [0, 200],
  trackerParticles: [1, 80],
  commsRange: [1, 400],
  baseCommsRange: [1, 400],
  towerRange: [1, 400],
  zoneSize: [2, 16],
  decisionInterval: [1, 20],
  cbbaBundleSize: [1, 8],
  cbbaRounds: [1, 12],
  cbbaHorizon: [1, 2000],
  unifiedLinkBytes: [0, 65536],
  unifiedBundleTtl: [1, 2000],
  unifiedBitBudget: [0, 1e6],
  sensorRadius: [1, 128],
  droneSpeed: [0.01, 4],
  droneAltitude: [0, 64],
  towerHeight: [0, 64],
  waterCapacity: [1, 100],
  trackerTimescale: [1, 2000],
  smokeMassTiles: [1, 64],
};
const INTEGER_CONFIG = new Set<keyof Config>(["maxTicks", "droneCount", "towers", "ignitions", "preburnTicks", "trackerParticles", "zoneSize", "decisionInterval", "cbbaBundleSize", "cbbaRounds", "unifiedLinkBytes", "unifiedBundleTtl", "unifiedBitBudget"]);

/** Accept only known config keys of the right type, with the expensive ones clamped. The map size is fixed. */
export function sanitizeConfig(input: unknown): Partial<Config> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(k in defaultConfig) || k === "width" || k === "height") continue;
    const def = (defaultConfig as any)[k];
    if (typeof v !== typeof def) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      const lim = LIMITS[k as keyof Config];
      const bounded = lim ? Math.max(lim[0], Math.min(lim[1], v)) : Math.max(-1e6, Math.min(1e6, v));
      out[k] = INTEGER_CONFIG.has(k as keyof Config) ? Math.floor(bounded) : bounded;
    } else if (k === "mode") {
      if (SIM_MODES.includes(v as Mode)) out[k] = v;
    } else if (k === "smokeModel") {
      if (v === "legacy" || v === "massed") out[k] = v;
    } else out[k] = v;
  }
  return out as Partial<Config>;
}

export function sanitizeActions(input: unknown): RecordedAction[] {
  if (!Array.isArray(input)) return [];
  const out: RecordedAction[] = [];
  for (const a of input.slice(0, 500)) {
    if (!a || !Number.isInteger(a.tick) || a.tick < 0 || a.tick > 2000 || !a.action || typeof a.action !== "object") continue;
    const v = a.action;
    const finite = (...xs: unknown[]) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
    let action: RecordedAction["action"] | undefined;
    switch (v.type) {
      case "ignite":
        if (finite(v.x, v.y) && v.x >= 0 && v.x < 64 && v.y >= 0 && v.y < 64) action = { type: v.type, x: v.x, y: v.y };
        break;
      case "blackout":
        if (finite(v.x, v.y, v.r) && v.r > 0 && v.r <= 128 && v.x >= -128 && v.x <= 192 && v.y >= -128 && v.y <= 192) action = { type: v.type, x: v.x, y: v.y, r: v.r };
        break;
      case "clearBlackouts": action = { type: v.type }; break;
      case "crash":
        if (Number.isInteger(v.id) && v.id >= 0 && v.id < 30) action = { type: v.type, id: v.id };
        break;
      case "wind":
        if (finite(v.angle, v.speed) && Math.abs(v.angle) <= 1e6 && v.speed >= 0 && v.speed <= 1) action = { type: v.type, angle: v.angle, speed: v.speed };
        break;
      case "baseComms":
        if (typeof v.online === "boolean") action = { type: v.type, online: v.online };
        break;
      case "commsRange":
        if (finite(v.range) && v.range > 0 && v.range <= 400) action = { type: v.type, range: v.range };
        break;
      case "smokeBlocksComms":
        if (typeof v.on === "boolean") action = { type: v.type, on: v.on };
        break;
    }
    if (action) out.push({ tick: a.tick, action });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

export interface ModeRun {
  outcome: Outcome;
  events: SimEvent[];
}

/** Run one scenario to the end without blocking the server: it yields to the event loop every few ticks. */
export async function runScenarioAsync(cfg: Partial<Config>, actions: readonly RecordedAction[], geography?: GeoScenario): Promise<ModeRun> {
  const world = new World(cfg, geography);
  const cursor = new ReplayCursor(actions);
  const deriver = new EventDeriver();
  const events: SimEvent[] = [];
  const KEEP = new Set(["fireSpotted", "droneCrashed", "linkLost", "networkSplit", "networkHealed", "baseOffline", "baseOnline", "towerLost", "villageThreatened", "villageLost", "fireOut", "runFinished", "judgeAction"]);
  let n = 0;
  while (!world.finished) {
    cursor.applyDue(world); // malformed actions are rejected by applyJudgeAction itself
    world.step();
    for (const e of deriver.poll(world)) if (KEEP.has(e.type) && events.length < 400) events.push(e);
    if (++n % 40 === 0) await yieldToEventLoop();
  }
  const m = world.metrics();
  return {
    outcome: { ticks: m.tick, burnt: m.burnt, villageLost: m.villageLost, villageLostAt: m.villageLostAt, dronesLost: m.dronesLost, waterDropped: m.waterDropped, extinguishedAt: m.extinguishedAt },
    events,
  };
}

/** Higher = worse for the swarm. Losing the village dominates; then area burnt; then drones lost. */
export function hurtScore(swarm: Outcome) {
  return (swarm.villageLost ? 10000 : 0) + swarm.burnt + 25 * swarm.dronesLost;
}
