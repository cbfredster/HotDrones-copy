// UNIFIED: one coordination mode that stacks six answers to six problems, each one a layer
// the drones run every tick. Selected with mode "unified" (the "Unified stack" entry in the
// Coordination dropdown).
//
//   PROBLEM                         LAYER                                   WHERE
//   1 centralised task allocation   CBBA (decentralised bundle auction)     cbba.ts, run from world.ts
//   2 communication loss            DTN: store-carry-forward bundles        exchange(), Node.store
//   3 bandwidth waste               Information Bottleneck + event trigger  senseDrone(), pack()
//   4 conflicting fire estimates    Covariance Intersection map fusion      fuseTile()
//   5 static behaviour              graph attention + online MARL           attention(), zonesFor(), learn()
//   6 uncoordinated movement        distributed MPC                         fly()
//
// How the layers feed each other, per tick:
//
//   sense ──► event trigger ──► IB packing ──► DTN bundle store ──► (contact) ──► CI fusion into map
//                                                                                      │
//   fly ◄── distributed MPC ◄── CBBA path ◄── CBBA bundles ◄── zones scaled by MARL policy (GAT)
//                                                                     ▲
//                                                    reward after every water drop
//
// Layer notes (honest about what each one is in this sim):
//
// * DTN. Drones no longer swap whole maps. What a drone sees is wrapped in BUNDLES (origin,
//   sequence number, creation tick, entries). Every node (drone or base) keeps the bundles it
//   holds in a store until they expire, and on every contact hands its group the bundles they
//   are missing ("epidemic" routing with a summary-vector check), within a per-tick byte budget.
//   So an observation crosses a gap in the network by riding along with a drone that flies
//   from one group to the other: store, carry, forward.
//
// * Information Bottleneck + event trigger. A tile only goes into a bundle when what the drone
//   now sees DIFFERS from what its fused map already said (the event trigger), and the change
//   is worth its bits: utility(i) - (beta + lambda) * bits(i) > 0, where utility is the change
//   weighted by how relevant the tile is to the task variable (front tiles, near the village),
//   beta is the IB trade-off between relevance and rate, and lambda is the price of a hard
//   per-node bit budget, found by dual ascent (it stays 0 while the node is under budget). Severity is quantised to 2 bits, variance
//   to 4 bits: that is the compression; the quantisation error is added to the variance the
//   receiver uses, so nothing is claimed more precisely than it was sent.
//
// * Covariance Intersection. Every tile carries a variance as well as a value. It starts at the
//   sensor's variance (worse when far from the drone or in smoke) and grows with age (process
//   noise). Two estimates that agree on the tile's state are fused with fast CI:
//       w = Pb / (Pa + Pb),   P^-1 = w Pa^-1 + (1-w) Pb^-1,   x = P (w Pa^-1 xa + (1-w) Pb^-1 xb)
//   which is never over-confident even if the two estimates share information (they usually
//   do, since bundles are relayed). Two estimates that DISAGREE on the state (burning vs out)
//   are not averaged: the one with the smaller variance after ageing wins.
//
// * Graph attention + MARL. Each drone attends over its teammates (the graph is "who I know
//   about"): attention logits come from a GAT-style score of the pair's features (distance,
//   freshness of contact, water), softmaxed. The attention-weighted message tells the drone
//   how covered each zone already is. A linear policy over zone features (village proximity,
//   distance, smoke, attention coverage, frontier size) scales each zone's value before CBBA
//   bids on it. The weights theta are learned ONLINE with a REINFORCE (softmax policy
//   gradient) update after every water drop, against a running-mean baseline, and teammates
//   in contact average their weights (decentralised parameter sharing). No pretraining: theta
//   starts at a mild hand-set prior and adapts within the run.
//
// * Distributed MPC. Instead of flying straight at its target, a drone picks, every tick, the
//   heading that minimises a cost over a short horizon: time still to go, energy (climbing,
//   headwind), hazard (smoke, burning tiles on its own map) and separation from the predicted
//   paths its teammates in contact published. Drones plan in id order, each against the plans
//   already published that tick (a Gauss-Seidel sweep), then fly the first step.
//
// Deterministic: no random numbers are drawn here.
import { BeliefMap } from "./belief";
import { BASE_ID, terrainHeightAt } from "./comms";
import type { Drone } from "./drone";
import { Environment, Fire } from "./environment";
import { Zone, computeZones } from "./planner";
import type { World } from "./world";

// ------------------------------------------------------------------ data types
export interface BundleEntry {
  i: number; // tile index
  fire: number;
  sev: number; // quantised severity
  v: number; // variance at creation (after quantisation)
}
export interface Bundle {
  id: string; // `${origin}:${seq}`
  origin: number;
  created: number;
  entries: BundleEntry[];
  utility: number; // summed IB utility, used to rank bundles under a byte budget
  bytes: number;
}

/** Everything a radio node (drone or base) holds for the info layers. */
export class UnifiedNode {
  variance: Float32Array; // per tile, at the tick in belief.lastSeen
  store = new Map<string, Bundle>(); // bundles held for forwarding (DTN custody)
  seen = new Map<string, number>(); // bundle id -> created, for every bundle already applied
  seq = 0;
  lambda = 0; // rate-constraint price (dual variable); the IB threshold is beta + lambda
  bitsThisTick = 0;
  bytesSent = 0;
  bytesReceived = 0;
  entriesSuppressed = 0; // changes the IB test decided were not worth sending
  entriesSent = 0;
  conflicts = 0; // CI: disagreements resolved by variance
  fusions = 0; // CI: agreeing estimates fused
  constructor(n: number) {
    this.variance = new Float32Array(n).fill(INIT_VAR);
  }
}

/** Per-drone learning and motion state. */
export class UnifiedAgent {
  theta = THETA0.slice();
  baseline = 0;
  updates = 0;
  lastReward = 0;
  attention: { id: number; a: number }[] = []; // for the UI
  pending: { tile: number; zone: number; phi: number[][]; chosen: number; probs: number[]; damage: number; value: number } | null = null;
  plan: { x: number; y: number }[] = []; // MPC predicted path, published to teammates
}

// ------------------------------------------------------------------ constants
const INIT_VAR = 0.05; // the initial briefing is a good map
const MIN_VAR = 0.01;
const BITS_PER_ENTRY = 12 + 2 + 2 + 4; // tile index, fire state, severity (2 bits), variance (4 bits)
const BUNDLE_HEADER_BYTES = 10;
const STORE_LIMIT = 300;
const QUANT_VAR = 1 / 12; // variance of rounding to whole severity levels
// Policy features: [village proximity, distance, smoke, attention coverage, frontier size]
export const FEATURE_NAMES = ["village", "distance", "smoke", "covered", "frontier"];
const THETA0 = [0.2, -0.2, -0.3, -0.4, 0.1];
const THETA_CLIP = 2;
// MPC
const MPC_HEADINGS = [0, 0.35, -0.35, 0.8, -0.8, 1.3, -1.3];
const MPC_HORIZON = 6;
const SAFE_DIST = 1.6;

const quantVar = (v: number) => {
  // 4 bits, log scale between MIN_VAR and ~8
  const k = Math.max(0, Math.min(15, Math.round(Math.log2(v / MIN_VAR) * 1.5)));
  return MIN_VAR * 2 ** (k / 1.5);
};
const bundleBytes = (n: number) => BUNDLE_HEADER_BYTES + Math.ceil((n * BITS_PER_ENTRY) / 8);

export class UnifiedStack {
  nodes = new Map<number, UnifiedNode>(); // drone id or BASE_ID
  agents = new Map<number, UnifiedAgent>();
  /** What swapping whole maps every tick would have cost (the swarm/cbba modes), for comparison. */
  fullSyncBytes = 0;
  bytesSent = 0;
  private relevance: Float32Array;

  constructor(private w: World) {
    const n = w.cfg.width * w.cfg.height;
    this.nodes.set(BASE_ID, new UnifiedNode(n));
    for (const d of w.drones) {
      this.nodes.set(d.id, new UnifiedNode(n));
      this.agents.set(d.id, new UnifiedAgent());
    }
    // Static part of each tile's task relevance: how close it is to the village.
    const { w: W, village } = w.terrain;
    const vx = village[4] % W;
    const vy = Math.floor(village[4] / W);
    this.relevance = new Float32Array(n);
    for (let i = 0; i < n; i++) this.relevance[i] = 1 + 4 * Math.exp(-Math.hypot((i % W) - vx, Math.floor(i / W) - vy) / 10);
  }

  node(id: number) {
    return this.nodes.get(id)!;
  }
  agent(id: number) {
    return this.agents.get(id)!;
  }

  // ================================================================ PROBLEM 3 + 4: sensing
  /** Sense like Drone.sense, but record variances and raise events for changes worth sending. */
  senseDrone(d: Drone) {
    const w = this.w;
    const c = w.cfg;
    const env = w.env;
    const nd = this.node(d.id);
    const b = d.belief;
    const changed: number[] = [];
    const prior = new Map<number, [number, number]>();
    // Snapshot what my map said for every tile in sensor range, then sense.
    const R = c.sensorRadius + 1;
    const x0 = Math.max(0, Math.floor(d.x - R));
    const x1 = Math.min(env.w - 1, Math.ceil(d.x + R));
    const y0 = Math.max(0, Math.floor(d.y - R));
    const y1 = Math.min(env.h - 1, Math.ceil(d.y + R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * env.w + x;
      prior.set(i, [b.fire[i], b.severity[i]]);
    }
    const r = d.sense(env, c, w.tick);
    const smoke = Math.min(1, env.smokeAt(d.x, d.y) / c.thickSmoke);
    for (const [i, [pf, ps]] of prior) {
      if (b.lastSeen[i] !== w.tick) continue; // not sensed this tick
      const dist = Math.hypot((i % env.w) - d.x, Math.floor(i / env.w) - d.y);
      nd.variance[i] = this.sensorVar(dist, r, smoke);
      if (b.fire[i] !== pf || Math.abs(b.severity[i] - ps) >= 0.5) changed.push(i);
    }
    this.originate(d.id, b, changed, (i) => prior.get(i)![0], (i) => prior.get(i)![1]);
  }

  /** Satellite pass: the base saw everything; raise events for what changed on its map. */
  baseObservedAll(prevFire: Uint8Array, prevSev: Float32Array) {
    const b = this.w.base.belief;
    const nd = this.node(BASE_ID);
    nd.variance.fill(INIT_VAR);
    const changed: number[] = [];
    for (let i = 0; i < b.fire.length; i++) if (b.fire[i] !== prevFire[i] || Math.abs(b.severity[i] - prevSev[i]) >= 0.5) changed.push(i);
    this.originate(BASE_ID, b, changed, (i) => prevFire[i], (i) => prevSev[i]);
  }

  private sensorVar(dist: number, r: number, smoke: number) {
    return 0.03 + 0.25 * (dist / Math.max(1, r)) ** 2 + 0.4 * smoke;
  }

  /** IB packing: keep the changes whose task-relevant information beats their bit cost. */
  private originate(id: number, b: BeliefMap, changed: number[], prevFire: (i: number) => number, prevSev: (i: number) => number) {
    const nd = this.node(id);
    if (!changed.length) return this.adaptLambda(nd);
    const maxSev = this.w.cfg.maxSeverity;
    // Utility of an entry = how much it changes the receiver's picture x how relevant that
    // tile is to the task. A tile catching fire or going out is a full change (1); a severity
    // drift counts in proportion.
    const scored = changed.map((i) => {
      const flip = b.fire[i] !== prevFire(i);
      const touchesFire = b.fire[i] === Fire.Burning || prevFire(i) === Fire.Burning;
      const delta = flip ? 1 : Math.abs(b.severity[i] - prevSev(i)) / maxSev;
      return { i, u: this.relevanceOf(b, i, touchesFire) * delta };
    });
    scored.sort((a, z) => z.u - a.u || a.i - z.i);
    const entries: BundleEntry[] = [];
    let utility = 0;
    for (const s of scored) {
      const bits = BITS_PER_ENTRY;
      if (s.u - (this.w.cfg.unifiedBeta + nd.lambda) * bits <= 0) {
        nd.entriesSuppressed++;
        continue;
      }
      const sev = b.fire[s.i] === Fire.Burning ? Math.max(1, Math.min(3, Math.round(b.severity[s.i]))) : 0;
      entries.push({ i: s.i, fire: b.fire[s.i], sev, v: quantVar(nd.variance[s.i]) + QUANT_VAR });
      utility += s.u;
      nd.bitsThisTick += bits;
    }
    if (entries.length) {
      const bundle: Bundle = { id: `${id}:${nd.seq++}`, origin: id, created: this.w.tick, entries, utility, bytes: bundleBytes(entries.length) };
      nd.entriesSent += entries.length;
      this.keep(nd, bundle);
      nd.seen.set(bundle.id, bundle.created);
    }
    this.adaptLambda(nd);
  }

  private relevanceOf(b: BeliefMap, i: number, touchesFire: boolean) {
    // Front tiles (burning with fuel next to them) and tiles that just went out carry the
    // information the planner needs; deep interior or far-away unburnt ground much less.
    const W = b.w;
    const x = i % W;
    const y = Math.floor(i / W);
    let front = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < b.h && b.fire[ny * W + nx] === Fire.Burning) front++;
    }
    return this.relevance[i] * (0.3 + (touchesFire ? 1 : 0) + 0.25 * front);
  }

  /** Dual ascent on the rate constraint bits <= budget: lambda rises when over, decays to 0 when under. */
  private adaptLambda(nd: UnifiedNode) {
    const budget = this.w.cfg.unifiedBitBudget;
    nd.lambda = Math.max(0, Math.min(1, nd.lambda + 0.002 * ((nd.bitsThisTick - budget) / budget)));
    nd.bitsThisTick = 0;
  }

  private keep(nd: UnifiedNode, bundle: Bundle) {
    nd.store.set(bundle.id, bundle);
    if (nd.store.size > STORE_LIMIT) {
      // Evict the bundle with the least utility left (older bundles are worth less).
      let worst: string | null = null;
      let ws = Infinity;
      for (const bd of nd.store.values()) {
        const s = bd.utility * Math.exp(-(this.w.tick - bd.created) / this.w.cfg.unifiedBundleTtl);
        if (s < ws) {
          ws = s;
          worst = bd.id;
        }
      }
      if (worst) nd.store.delete(worst);
    }
  }

  // ================================================================ PROBLEM 2: DTN exchange
  /** One tick of store-and-forward inside every connected group. */
  exchange() {
    const w = this.w;
    const c = w.cfg;
    const mapBytes = c.width * c.height * 9; // fire + severity + lastSeen per tile
    for (const comp of w.network.components) {
      const ids = comp.filter((id) => id >= 0 || id === BASE_ID);
      if (ids.length < 2) continue;
      this.fullSyncBytes += (ids.length - 1) * 2 * mapBytes;
      // Expire old bundles, then gather what the group holds.
      const pool = new Map<string, Bundle>();
      for (const id of ids) {
        const nd = this.node(id);
        for (const [bid, bd] of nd.store) {
          if (w.tick - bd.created > c.unifiedBundleTtl) nd.store.delete(bid);
          else pool.set(bid, bd);
        }
      }
      if (!pool.size) continue;
      const ranked = [...pool.values()].sort((a, b) => b.utility / b.bytes - a.utility / a.bytes || b.created - a.created || (a.id < b.id ? -1 : 1));
      // Summary vector check: each node pulls the bundles it has not seen, best first, within budget.
      for (const id of ids) {
        const nd = this.node(id);
        let budget = c.unifiedLinkBytes;
        for (const bd of ranked) {
          if (nd.seen.has(bd.id)) continue;
          if (bd.bytes > budget) continue;
          budget -= bd.bytes;
          nd.bytesReceived += bd.bytes;
          this.bytesSent += bd.bytes;
          const sender = this.node(this.holder(ids, bd.id));
          sender.bytesSent += bd.bytes;
          this.apply(id, bd);
          nd.seen.set(bd.id, bd.created);
          this.keep(nd, bd); // take custody: carry it on to whoever I meet next
        }
      }
      // Forget seen-ids far older than any live bundle.
      if (w.tick % 50 === 0) for (const id of ids) {
        const nd = this.node(id);
        for (const [bid, t] of nd.seen) if (w.tick - t > c.unifiedBundleTtl * 2) nd.seen.delete(bid);
      }
    }
  }

  private holder(ids: number[], bid: string) {
    for (const id of ids) if (this.node(id).store.has(bid)) return id;
    return ids[0];
  }

  /** Docked at base: cable link, no budget. Both sides take every bundle the other holds. */
  dock(d: Drone) {
    const a = this.node(d.id);
    const b = this.node(BASE_ID);
    for (const [x, y, yid] of [[a, b, BASE_ID], [b, a, d.id]] as const) {
      for (const bd of x.store.values()) {
        if (y.seen.has(bd.id)) continue;
        this.apply(yid, bd);
        y.seen.set(bd.id, bd.created);
        this.keep(y, bd);
      }
    }
  }

  private beliefOf(id: number) {
    return id === BASE_ID ? this.w.base.belief : this.w.drones[id].belief;
  }

  // ================================================================ PROBLEM 4: CI fusion
  private apply(id: number, bd: Bundle) {
    const b = this.beliefOf(id);
    const nd = this.node(id);
    for (const e of bd.entries) this.fuseTile(b, nd, e.i, e.fire, e.sev, e.v, bd.created);
  }

  /** Fuse one estimate (fire, sev, variance v at tick t) into a map tile. */
  fuseTile(b: BeliefMap, nd: UnifiedNode, i: number, fire: number, sev: number, v: number, t: number) {
    const now = this.w.tick;
    const q = this.w.cfg.unifiedProcessNoise;
    const pb = v + q * Math.max(0, now - t);
    const la = b.lastSeen[i];
    const pa = la < 0 ? Infinity : nd.variance[i] + q * Math.max(0, now - la);
    const newest = Math.max(la, t);
    if (b.fire[i] !== fire) {
      // Conflict: the states disagree. Keep the one with less uncertainty; do not average.
      nd.conflicts++;
      if (pb < pa) {
        b.fire[i] = fire;
        b.severity[i] = sev;
        b.lastSeen[i] = newest;
        nd.variance[i] = Math.max(MIN_VAR, pb - q * (now - newest));
      }
      return;
    }
    if (!isFinite(pa)) {
      b.severity[i] = sev;
      b.lastSeen[i] = newest;
      nd.variance[i] = Math.max(MIN_VAR, pb - q * (now - newest));
      return;
    }
    // Agreement: fast Covariance Intersection.
    nd.fusions++;
    const wa = pb / (pa + pb);
    const info = wa / pa + (1 - wa) / pb;
    const p = 1 / info;
    b.severity[i] = p * ((wa * b.severity[i]) / pa + ((1 - wa) * sev) / pb);
    b.lastSeen[i] = newest;
    nd.variance[i] = Math.max(MIN_VAR, p - q * (now - newest));
  }

  // ================================================================ PROBLEM 5: GAT + MARL
  /** GAT-style attention of drone d over the teammates it knows about. */
  attention(d: Drone) {
    const w = this.w;
    const c = w.cfg;
    const out: { id: number; a: number; tx: number; ty: number }[] = [];
    const logits: number[] = [];
    for (const [id, cl] of d.claims) {
      if (id === d.id || !w.drones[id]?.alive) continue;
      const age = w.tick - cl.stamp;
      const tr = d.trackers.get(id);
      const fresh = age <= 1 ? 1 : Math.exp(-age / c.trackerTimescale) * (tr ? tr.fractionNear(cl.tx, cl.ty, c.zoneSize * 1.2) : 1);
      // e_ij = LeakyReLU(a . [W h_i || W h_j]) with a hand-set a: close, fresh, water-carrying
      // teammates matter most to what I should do.
      const dist = Math.hypot(cl.x - d.x, cl.y - d.y) / c.commsRange;
      const raw = 1.5 * fresh + 0.6 * (cl.water / c.waterCapacity) - 1.2 * dist + (cl.zone >= 0 ? 0.4 : -0.4);
      logits.push(raw > 0 ? raw : 0.2 * raw);
      out.push({ id, a: 0, tx: cl.tx, ty: cl.ty });
    }
    if (!out.length) return out;
    const m = Math.max(...logits);
    let s = 0;
    for (let k = 0; k < out.length; k++) s += out[k].a = Math.exp(logits[k] - m);
    for (const o of out) o.a /= s;
    return out;
  }

  private features(d: Drone, z: Zone, att: ReturnType<UnifiedStack["attention"]>) {
    const w = this.w;
    const c = w.cfg;
    const W = w.terrain.w;
    const v = w.terrain.village[4];
    const village = Math.exp(-Math.hypot(z.tx - (v % W), z.ty - Math.floor(v / W)) / 10);
    const distance = Math.hypot(z.tx - d.x, z.ty - d.y) / c.width;
    const smoke = Math.min(1, w.env.smokeAt(z.tx, z.ty) / c.thickSmoke);
    let covered = 0;
    for (const o of att) covered += o.a * Math.exp(-Math.hypot(o.tx - z.tx, o.ty - z.ty) / c.zoneSize);
    const frontier = Math.min(1, z.frontier / (c.zoneSize * c.zoneSize));
    return [village, distance, smoke, covered, frontier];
  }

  /** Zones from the drone's own map, with values scaled by its learned policy. */
  zonesFor(d: Drone): Zone[] {
    const w = this.w;
    const ag = this.agent(d.id);
    const zones = computeZones(d.belief, w.terrain, w.env.wind, w.cfg);
    const att = this.attention(d);
    ag.attention = att.map((o) => ({ id: o.id, a: o.a })).sort((a, b) => b.a - a.a);
    return zones.map((z) => {
      const f = this.features(d, z, att);
      let s = 0;
      for (let k = 0; k < f.length; k++) s += ag.theta[k] * f[k];
      return { ...z, value: z.value * Math.exp(s) };
    });
  }

  /** Remember the choice so the policy can be updated when the drop lands. */
  recordChoice(d: Drone, zones: Zone[], chosen: Zone) {
    const ag = this.agent(d.id);
    const att = this.attention(d);
    const phi = zones.map((z) => this.features(d, z, att));
    // Policy pi(z) = softmax(log value_z) where value already includes exp(theta . phi).
    const logits = zones.map((z) => Math.log(Math.max(1e-9, z.value)));
    const m = Math.max(...logits);
    const ex = logits.map((l) => Math.exp(l - m));
    const s = ex.reduce((a, b) => a + b, 0);
    ag.pending = {
      tile: chosen.target,
      zone: chosen.id,
      phi,
      chosen: zones.indexOf(chosen),
      probs: ex.map((e) => e / s),
      damage: d.damage,
      value: chosen.value,
    };
  }

  /** REINFORCE after a water drop: reward = fire knocked down near what matters, minus damage. */
  learn(d: Drone, env: Environment) {
    const ag = this.agent(d.id);
    const p = ag.pending;
    if (!p || p.chosen < 0 || p.tile !== d.targetTile) return;
    ag.pending = null;
    const out = env.fire[p.tile] !== Fire.Burning ? 1 : 0;
    const reward = this.relevance[p.tile] * (0.3 + out) - 8 * Math.max(0, d.damage - p.damage);
    const adv = reward - ag.baseline;
    ag.baseline = ag.updates === 0 ? reward : 0.9 * ag.baseline + 0.1 * reward;
    ag.updates++;
    ag.lastReward = reward;
    const lr = this.w.cfg.unifiedLearningRate;
    for (let k = 0; k < ag.theta.length; k++) {
      let expect = 0;
      for (let j = 0; j < p.phi.length; j++) expect += p.probs[j] * p.phi[j][k];
      const grad = p.phi[p.chosen][k] - expect; // d/dtheta log pi(chosen)
      ag.theta[k] = Math.max(-THETA_CLIP, Math.min(THETA_CLIP, ag.theta[k] + lr * adv * grad));
    }
  }

  /** Teammates in contact average their policy weights (decentralised parameter sharing). */
  shareParameters(members: Drone[]) {
    if (members.length < 2) return;
    const mean = new Array(THETA0.length).fill(0);
    for (const m of members) this.agent(m.id).theta.forEach((t, k) => (mean[k] += t / members.length));
    for (const m of members) {
      const ag = this.agent(m.id);
      for (let k = 0; k < mean.length; k++) ag.theta[k] = 0.5 * ag.theta[k] + 0.5 * mean[k];
    }
    this.bytesSent += members.length * THETA0.length * 4;
  }

  // ================================================================ PROBLEM 6: distributed MPC
  /** Fly one tick towards (tx, ty) along the heading that minimises the horizon cost. Returns true on arrival. */
  fly(d: Drone, tx: number, ty: number): boolean {
    const w = this.w;
    const c = w.cfg;
    const env = w.env;
    const ag = this.agent(d.id);
    const dist = Math.hypot(tx - d.x, ty - d.y);
    if (dist <= c.droneSpeed) {
      ag.plan = [{ x: tx, y: ty }];
      return d.moveTowards(tx, ty, env, c);
    }
    // Teammates whose plans I can hear this tick.
    const comp = w.network.componentOf.get(d.id);
    const mates: { x: number; y: number }[][] = [];
    if (comp !== undefined) {
      for (const id of w.network.components[comp]) {
        if (id < 0 || id === d.id || !w.drones[id].alive) continue;
        const p = this.agent(id).plan;
        mates.push(p.length ? p : [{ x: w.drones[id].x, y: w.drones[id].y }]);
      }
    }
    const goal = Math.atan2(ty - d.y, tx - d.x);
    let bestCost = Infinity;
    let bestPlan: { x: number; y: number }[] = [];
    for (const dh of MPC_HEADINGS) {
      const plan = this.rollout(d.x, d.y, goal + dh, tx, ty);
      const cost = this.cost(d, plan, tx, ty, mates);
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestPlan = plan;
      }
    }
    ag.plan = bestPlan;
    const step = bestPlan[0];
    d.moveTowards(step.x, step.y, env, c);
    return false;
  }

  /** First step along the heading, then straight at the goal: a two-segment shooting rollout. */
  private rollout(x: number, y: number, heading: number, tx: number, ty: number) {
    const c = this.w.cfg;
    const s = c.droneSpeed;
    const plan: { x: number; y: number }[] = [];
    x = Math.max(0, Math.min(c.width - 1, x + Math.cos(heading) * s));
    y = Math.max(0, Math.min(c.height - 1, y + Math.sin(heading) * s));
    plan.push({ x, y });
    for (let k = 1; k < MPC_HORIZON; k++) {
      const dd = Math.hypot(tx - x, ty - y);
      if (dd <= s) {
        x = tx;
        y = ty;
      } else {
        x += ((tx - x) / dd) * s;
        y += ((ty - y) / dd) * s;
      }
      plan.push({ x, y });
    }
    return plan;
  }

  /** Cost in tick-equivalents: time to go + energy + hazard + separation. */
  private cost(d: Drone, plan: { x: number; y: number }[], tx: number, ty: number, mates: { x: number; y: number }[][]) {
    const w = this.w;
    const c = w.cfg;
    const env = w.env;
    const last = plan[plan.length - 1];
    let J = Math.hypot(tx - last.x, ty - last.y) / c.droneSpeed;
    let px = d.x;
    let py = d.y;
    let ph = terrainHeightAt(w.terrain, px, py);
    for (let k = 0; k < plan.length; k++) {
      const p = plan[k];
      const h = terrainHeightAt(w.terrain, p.x, p.y);
      // Energy: climbing and headwind, converted to ticks of normal flight.
      J += (Math.max(0, h - ph) * c.climbDrain) / c.batteryDrain;
      const mx = p.x - px;
      const my = p.y - py;
      const ml = Math.hypot(mx, my) || 1;
      const head = -(Math.cos(env.wind.angle) * mx + Math.sin(env.wind.angle) * my) / ml;
      J += 0.8 * env.wind.speed * Math.max(0, head);
      // Hazard, from what I can see: smoke here, and fire on my map (except at the target).
      const nearGoal = Math.hypot(tx - p.x, ty - p.y) < 1.5;
      if (!nearGoal) {
        J += ((c.smokeDamage * env.smokeAt(p.x, p.y)) / c.batteryDrain) * 0.5;
        const i = Math.round(p.y) * env.w + Math.round(p.x);
        if (d.belief.fire[i] === Fire.Burning) J += ((c.fireDamage * Math.max(1, d.belief.severity[i])) / c.batteryDrain) * 0.5;
      }
      // Separation from teammates' published plans.
      for (const m of mates) {
        const q = m[Math.min(k, m.length - 1)];
        const sep = Math.hypot(q.x - p.x, q.y - p.y);
        if (sep < SAFE_DIST && !nearGoal) J += 6 * (SAFE_DIST - sep) ** 2;
      }
      px = p.x;
      py = p.y;
      ph = h;
    }
    return J;
  }

  // ================================================================ summary for the UI
  stats() {
    let suppressed = 0;
    let sent = 0;
    let conflicts = 0;
    let fusions = 0;
    let stored = 0;
    for (const nd of this.nodes.values()) {
      suppressed += nd.entriesSuppressed;
      sent += nd.entriesSent;
      conflicts += nd.conflicts;
      fusions += nd.fusions;
      stored += nd.store.size;
    }
    return { suppressed, sent, conflicts, fusions, stored, bytesSent: this.bytesSent, fullSyncBytes: this.fullSyncBytes };
  }
}
