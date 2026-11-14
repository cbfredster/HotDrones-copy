// "Challenge the swarm": when someone saves a scenario, run it headless in every coordination
// mode (the sim is plain TypeScript, so it runs in Node exactly as in the browser), store the
// outcomes, and rank the scenarios that hurt the swarm most.
import { EventDeriver, digestEvents, type SimEvent } from "../src/integrations/events";

export { digestEvents };
import { defaultConfig, type Config, type Mode } from "../src/sim/config";
import { ReplayCursor, type RecordedAction } from "../src/sim/judge";
import { World } from "../src/sim/world";
import type { Outcome } from "./store";

export const MODES: Mode[] = ["swarm", "central", "greedy"];

const LIMITS: Partial<Record<keyof Config, [number, number]>> = {
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
};

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
      out[k] = lim ? Math.max(lim[0], Math.min(lim[1], v)) : v;
    } else if (k === "mode") {
      if (MODES.includes(v as Mode)) out[k] = v;
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
    if (a && Number.isInteger(a.tick) && a.tick >= 0 && a.action && typeof a.action.type === "string") out.push({ tick: a.tick, action: a.action });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

export interface ModeRun {
  outcome: Outcome;
  events: SimEvent[];
}

/** Run one scenario to the end without blocking the server: it yields to the event loop every few ticks. */
export async function runScenarioAsync(cfg: Partial<Config>, actions: readonly RecordedAction[]): Promise<ModeRun> {
  const world = new World(cfg);
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
