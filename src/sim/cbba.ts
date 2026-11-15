// CBBA: the Consensus-Based Bundle Algorithm (Choi, Brunet & How, 2009), as a fourth
// coordination mode next to the simpler "swarm" auction (which is unchanged).
//
// The tasks are zone SLOTS: a zone worth 3 drones is three tasks, "z#0", "z#1", "z#2".
// Each drone plans a BUNDLE of up to `cbbaBundleSize` tasks: the zone it will fight with its
// current load of water, then the zones after its next refills.
//
//   Phase 1, bundle building. A drone repeatedly adds the task with the biggest MARGINAL
//   gain: how much its whole plan improves when that task is inserted at the best point in
//   its path. Plans are scored with time discounting (a zone reached later is worth less:
//   value * e^(-t / cbbaHorizon)), so later additions bid less. That "diminishing marginal
//   gain" is what lets CBBA converge. A drone may only take a task if its gain beats the
//   current winning bid (ties go to the lower id).
//
//   Phase 2, consensus. Drones that can reach each other (directly or relayed) agree on one
//   winner per task: a drone's own claims on its bundle are authoritative; anything it heard
//   about drones out of contact is passed on, newest first. A drone that has been outbid on
//   a task drops that task AND every task it added after it, because those bids assumed it
//   would do the earlier one. Phases repeat until nothing changes (or a round limit).
//
// Out of contact, a drone keeps the last winners it heard. Like swarm mode, it does not
// trust them for ever: a lost teammate's winning bid is scaled by how confident the particle
// filter is that the teammate is still near that zone (TeammateTracker), and by how long ago
// it was heard from. So a crashed or wandering teammate's tasks get picked up.
//
// Pure TypeScript, deterministic, no random numbers.
import { Config } from "./config";
import type { Drone } from "./drone";
import { Zone } from "./planner";

export interface CbbaEntry {
  bid: number;
  winner: number;
  stamp: number; // tick this was last confirmed by the winner itself
}

export interface CbbaTask {
  id: string;
  zone: Zone;
  slot: number;
  value: number;
}

/** One drone's CBBA state. */
export class CbbaState {
  bundle: string[] = []; // tasks in the order they were added (bids decrease along it)
  path: string[] = []; // the same tasks in the order they will be flown
  table = new Map<string, CbbaEntry>(); // who this drone thinks has won each task
}

export const taskId = (zone: number, slot: number) => `${zone}#${slot}`;

/** Everything CBBA needs from the world, kept narrow so the algorithm can be tested on its own. */
export interface CbbaWorld {
  cfg: Config;
  tick: number;
  zonesOf(d: Drone): Zone[];
  /** Distance from (x, y) to (tx, ty) via the best water source to refill at. */
  viaWater(x: number, y: number, tx: number, ty: number): number;
}

/** The tasks a drone can see on its own map: one per slot of each zone. */
export function tasksFor(zones: Zone[]): Map<string, CbbaTask> {
  const tasks = new Map<string, CbbaTask>();
  for (const z of zones) {
    for (let k = 0; k < z.slots; k++) {
      // Later slots of the same zone are worth a little less: the first drone does the most good.
      const value = (z.value / z.slots) * (1 - 0.1 * k);
      tasks.set(taskId(z.id, k), { id: taskId(z.id, k), zone: z, slot: k, value });
    }
  }
  return tasks;
}

/**
 * Time-discounted value of flying `path` in order, from where the drone is now. One load of
 * water per zone: after the first zone, every later one needs a refill detour first.
 */
export function pathScore(w: CbbaWorld, d: Drone, path: CbbaTask[]): number {
  const c = w.cfg;
  const refill = c.waterCapacity / 0.5; // ticks to refill from empty (0.5 per tick)
  const work = c.waterCapacity * 2; // rough ticks spent dropping one load
  let t = 0;
  let x = d.x;
  let y = d.y;
  let water = d.water;
  let score = 0;
  for (const task of path) {
    const tx = task.zone.tx;
    const ty = task.zone.ty;
    if (water <= 0) {
      t += w.viaWater(x, y, tx, ty) / c.droneSpeed + refill;
    } else {
      t += Math.hypot(tx - x, ty - y) / c.droneSpeed;
    }
    score += task.value * Math.exp(-t / c.cbbaHorizon);
    t += work;
    x = tx;
    y = ty;
    water = 0;
  }
  return score;
}

/**
 * The winning bid a drone has to beat for a task. A teammate in contact is taken at its
 * word. One that is out of contact is discounted by how long ago it was heard from and by
 * how likely the particle filter thinks it still is near the zone.
 */
export function bidToBeat(w: CbbaWorld, d: Drone, e: CbbaEntry | undefined, task: CbbaTask, inContact: Set<number>): number {
  if (!e || e.winner === d.id) return 0;
  if (inContact.has(e.winner)) return e.bid;
  const age = w.tick - e.stamp;
  const tr = d.trackers.get(e.winner);
  const near = tr ? tr.fractionNear(task.zone.tx, task.zone.ty, w.cfg.zoneSize * 1.2) : 1;
  return e.bid * Math.exp(-age / w.cfg.trackerTimescale) * near;
}

/** Phase 1: add tasks to the bundle while one has a gain that beats its current winner. */
function buildBundle(w: CbbaWorld, d: Drone, tasks: Map<string, CbbaTask>, inContact: Set<number>): boolean {
  const st = d.cbba;
  let changed = false;
  const pathTasks = () => st.path.map((id) => tasks.get(id)!);
  while (st.bundle.length < w.cfg.cbbaBundleSize) {
    const current = pathTasks();
    const base = pathScore(w, d, current);
    let bestId: string | null = null;
    let bestGain = 0;
    let bestPos = 0;
    for (const task of tasks.values()) {
      if (st.bundle.includes(task.id)) continue;
      // Best place to insert it in the path, and how much that adds.
      let gain = -Infinity;
      let pos = 0;
      for (let p = 0; p <= current.length; p++) {
        const trial = current.slice(0, p).concat(task, current.slice(p));
        const g = pathScore(w, d, trial) - base;
        if (g > gain) {
          gain = g;
          pos = p;
        }
      }
      if (gain <= 1e-9) continue;
      const e = st.table.get(task.id);
      const rival = bidToBeat(w, d, e, task, inContact);
      const wins = gain > rival + 1e-9 || (Math.abs(gain - rival) <= 1e-9 && !!e && d.id < e.winner);
      if (!wins) continue;
      if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && bestId !== null && task.id < bestId)) {
        bestGain = gain;
        bestId = task.id;
        bestPos = pos;
      }
    }
    if (bestId === null) break;
    st.bundle.push(bestId);
    st.path.splice(bestPos, 0, bestId);
    st.table.set(bestId, { bid: bestGain, winner: d.id, stamp: w.tick });
    changed = true;
  }
  return changed;
}

/** Drop task `id` and everything added after it (their bids assumed the earlier tasks). */
function releaseFrom(d: Drone, index: number): string[] {
  const st = d.cbba;
  const dropped = st.bundle.splice(index);
  st.path = st.path.filter((id) => !dropped.includes(id));
  return dropped;
}

/**
 * Phase 2: drones in one connected group agree on a single winner per task.
 * Returns true if any bundle changed.
 */
function consensus(w: CbbaWorld, members: Drone[]): boolean {
  const ids = new Set(members.map((m) => m.id));
  const merged = new Map<string, CbbaEntry>();

  // 1. Every member speaks for itself about the tasks in its own bundle.
  for (const m of members) {
    for (const id of m.cbba.bundle) {
      const own = m.cbba.table.get(id);
      if (!own) continue;
      const e: CbbaEntry = { bid: own.bid, winner: m.id, stamp: w.tick };
      const ex = merged.get(id);
      if (!ex || e.bid > ex.bid + 1e-9 || (Math.abs(e.bid - ex.bid) <= 1e-9 && e.winner < ex.winner)) merged.set(id, e);
    }
  }
  // 2. What anyone heard about drones that are NOT here, newest first. A claim about a member
  //    that the member itself did not repeat is dropped: it has released that task.
  for (const m of members) {
    for (const [id, e] of m.cbba.table) {
      if (ids.has(e.winner)) continue;
      if (w.tick - e.stamp > w.cfg.trackerTimescale * 5) continue; // long gone: forget it
      const ex = merged.get(id);
      if (ex && ids.has(ex.winner)) continue; // a member holds it now
      if (!ex || e.stamp > ex.stamp || (e.stamp === ex.stamp && e.bid > ex.bid)) merged.set(id, { ...e });
    }
  }

  // 3. Outbid drones release that task and everything after it in their bundle.
  let changed = false;
  for (const m of members) {
    const st = m.cbba;
    const lost = st.bundle.findIndex((id) => merged.get(id)?.winner !== m.id);
    if (lost < 0) continue;
    const dropped = releaseFrom(m, lost);
    for (const id of dropped) if (merged.get(id)?.winner === m.id) merged.delete(id);
    changed = true;
  }

  // 4. Everyone in the group now shares the same table.
  for (const m of members) m.cbba.table = new Map([...merged].map(([k, v]) => [k, { ...v }]));
  return changed;
}

/**
 * One CBBA planning step for a group of drones that can reach each other (a single drone
 * on its own is a group of one). `bidding` drones build bundles; the others (going home,
 * charging) hold none, so their tasks are released.
 */
export function cbbaGroup(w: CbbaWorld, members: Drone[], bidding: (d: Drone) => boolean) {
  const inContact = new Set(members.map((m) => m.id));
  const tasks = new Map<number, Map<string, CbbaTask>>();
  for (const m of members) {
    const st = m.cbba;
    if (!bidding(m)) {
      st.bundle = [];
      st.path = [];
      continue;
    }
    const mine = tasksFor(w.zonesOf(m));
    tasks.set(m.id, mine);
    // A zone that has gone from my map (put out, or burnt out) leaves my bundle, and so
    // does everything after it.
    const gone = st.bundle.findIndex((id) => !mine.has(id));
    if (gone >= 0) for (const id of releaseFrom(m, gone)) if (st.table.get(id)?.winner === m.id) st.table.delete(id);
  }
  for (let round = 0; round < w.cfg.cbbaRounds; round++) {
    let changed = false;
    for (const m of members) {
      const mine = tasks.get(m.id);
      if (mine && buildBundle(w, m, mine, inContact)) changed = true;
    }
    if (consensus(w, members)) changed = true;
    if (!changed) break;
  }
}
