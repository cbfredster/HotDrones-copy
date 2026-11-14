// Judge actions: the ONLY way anything outside the simulation is allowed to change a
// running world. Every UI control, AI command and replay goes through applyJudgeAction,
// which also records the action with the tick it was applied at. Because the sim is
// deterministic, seed + config + this log reproduces a run exactly.
import type { Config } from "./config";
import { World, type Metrics } from "./world";

export type JudgeAction =
  | { type: "ignite"; x: number; y: number }
  | { type: "blackout"; x: number; y: number; r: number }
  | { type: "clearBlackouts" }
  | { type: "crash"; id: number }
  | { type: "wind"; angle: number; speed: number } // angle: radians, direction the wind blows TOWARDS; speed 0..1
  | { type: "baseComms"; online: boolean }
  | { type: "commsRange"; range: number }
  | { type: "smokeBlocksComms"; on: boolean };

export interface RecordedAction {
  /** world.tick when the action was applied (i.e. it took effect before that tick was simulated). */
  tick: number;
  action: JudgeAction;
}

// Dragging a slider fires many events between two ticks; only the last one matters.
const COALESCE = new Set<JudgeAction["type"]>(["wind", "commsRange", "smokeBlocksComms", "baseComms"]);

const finite = (...v: number[]) => v.every((x) => typeof x === "number" && Number.isFinite(x));

/**
 * Apply one judge action to the world and record it. Returns false (and records
 * nothing) if the action is malformed or out of bounds; returns true if it was
 * accepted, even when it had no effect (e.g. igniting water).
 */
export function applyJudgeAction(world: World, action: JudgeAction): boolean {
  const { w, h } = world.terrain;
  switch (action.type) {
    case "ignite": {
      if (!finite(action.x, action.y)) return false;
      const x = Math.round(action.x);
      const y = Math.round(action.y);
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      world.igniteAt(x, y);
      break;
    }
    case "blackout": {
      if (!finite(action.x, action.y, action.r) || action.r <= 0) return false;
      if (action.x < -action.r || action.y < -action.r || action.x > w + action.r || action.y > h + action.r) return false;
      world.addBlackout(action.x, action.y, action.r);
      break;
    }
    case "clearBlackouts":
      world.clearBlackouts();
      break;
    case "crash": {
      if (!Number.isInteger(action.id) || action.id < 0 || action.id >= world.drones.length) return false;
      world.crashDrone(action.id);
      break;
    }
    case "wind": {
      if (!finite(action.angle, action.speed)) return false;
      world.setWind(action.angle, Math.max(0, Math.min(1, action.speed)));
      break;
    }
    case "baseComms":
      world.base.manualOutage = !action.online;
      break;
    case "commsRange": {
      if (!finite(action.range) || action.range <= 0) return false;
      world.cfg.commsRange = action.range;
      break;
    }
    case "smokeBlocksComms":
      world.cfg.smokeBlocksComms = !!action.on;
      break;
    default:
      return false;
  }

  const log = world.judgeLog;
  const last = log[log.length - 1];
  if (last && last.tick === world.tick && last.action.type === action.type && COALESCE.has(action.type)) {
    last.action = action;
  } else {
    log.push({ tick: world.tick, action });
  }
  return true;
}

/** Feeds a recorded action log back into a fresh world, tick by tick. */
export class ReplayCursor {
  private next = 0;
  constructor(private readonly actions: readonly RecordedAction[]) {}

  /** Apply every action due at (or before) the world's current tick. Call before each world.step(). */
  applyDue(world: World): number {
    let applied = 0;
    while (this.next < this.actions.length && this.actions[this.next].tick <= world.tick) {
      applyJudgeAction(world, this.actions[this.next].action);
      this.next++;
      applied++;
    }
    return applied;
  }

  get done() {
    return this.next >= this.actions.length;
  }
  get remaining() {
    return this.actions.length - this.next;
  }
}

/** Run a scenario (config + recorded judge actions) headless to the end. Used for replays and the challenge board. */
export function runScenario(cfg: Partial<Config>, actions: readonly RecordedAction[] = []): Metrics {
  const world = new World(cfg);
  const cursor = new ReplayCursor(actions);
  while (!world.finished) {
    cursor.applyDue(world);
    world.step();
  }
  return world.metrics();
}
