import { BeliefMap, mergeGroup } from "./belief";
import { cbbaGroup, taskId } from "./cbba";
import { BASE_ID, BASE_MAST_HEIGHT, Blackout, CommsNode, Network, buildNetwork, terrainHeightAt, towerNodeId } from "./comms";
import { Config, defaultConfig } from "./config";
import { Drone } from "./drone";
import { Environment, Fire } from "./environment";
import type { RecordedAction } from "./judge";
import { Claim, Zone, computeZones } from "./planner";
import { Rng } from "./rng";
import { Terrain, Tile, generateTerrain, pickTowerSites } from "./terrain";
import { TeammateTracker } from "./tracker";
import { UnifiedStack } from "./unified";

export interface Metrics {
  tick: number;
  finished: boolean;
  burnt: number; // tiles that burned (incl. extinguished)
  burning: number;
  villageLost: boolean;
  villageLostAt: number;
  dronesLost: number;
  waterDropped: number;
  extinguishedAt: number; // tick the last fire went out, -1 if not yet
}

export interface Tower {
  id: number; // comms node id (towerNodeId)
  x: number;
  y: number;
  alive: boolean; // false once its tile has burned
  lostAt: number;
}

export class World {
  cfg: Config;
  rng: Rng; // fire / wind randomness
  agentRng: Rng; // drone randomness (kept separate so modes see identical fires)
  terrain: Terrain;
  env: Environment;
  drones: Drone[] = [];
  base: { x: number; y: number; belief: BeliefMap; manualOutage: boolean };
  blackouts: Blackout[] = [];
  network: Network = { links: [], componentOf: new Map(), components: [] };
  /** The nodes (positions, altitudes, ranges) the current network was built from. */
  networkNodes: CommsNode[] = [];
  towers: Tower[] = [];
  tick = 0;
  waterTiles: number[] = [];
  history: { tick: number; burning: number; burnt: number }[] = [];
  extinguishedAt = -1;
  /** Every judge action applied to this run, with its tick (see judge.ts). Seed + config + this log replays the run. */
  judgeLog: RecordedAction[] = [];
  /** The config exactly as the run started, before any judge action changed it. */
  readonly initialCfg: Config;
  private zoneCache = new Map<number, Zone[]>();
  /** The layered CBBA + DTN + IB + CI + MARL + DMPC stack; only built in "unified" mode. */
  unified: UnifiedStack | null = null;

  constructor(cfg: Partial<Config> = {}) {
    this.cfg = { ...defaultConfig, ...cfg };
    this.initialCfg = { ...this.cfg };
    const c = this.cfg;
    this.rng = new Rng(c.seed);
    this.agentRng = new Rng(c.seed * 7919 + 13);
    this.terrain = generateTerrain(this.rng, c.width, c.height, c.heightScale);
    // Regrowth draws from its own stream so that turning it on cannot change the fire's own dice.
    this.env = new Environment(this.terrain, c, this.rng, new Rng(c.seed * 104729 + 71));
    this.env.seedIgnitions(c.ignitions);
    for (let t = 0; t < c.preburnTicks; t++) this.env.step(0); // fire takes hold before it's reported
    for (let i = 0; i < this.terrain.type.length; i++) if (this.terrain.type[i] === Tile.Water) this.waterTiles.push(i);

    const b = this.terrain.base;
    this.base = { x: b.x, y: b.y, belief: new BeliefMap(c.width, c.height), manualOutage: false };
    this.base.belief.observeAll(this.env, 0); // initial briefing (satellite / spotter plane)
    for (let k = 0; k < c.droneCount; k++) {
      let x: number;
      let y: number;
      if (c.spawnInLine) {
        // Lined up across the pad, centred on the base (the spec: "start with ... in a line").
        x = b.x + (k - (c.droneCount - 1) / 2) * 0.8;
        y = b.y;
      } else {
        x = b.x + this.agentRng.range(-1, 1);
        y = b.y + this.agentRng.range(-1, 1);
      }
      const d = new Drone(k, Math.max(0, Math.min(c.width - 1, x)), Math.max(0, Math.min(c.height - 1, y)), c, c.width, c.height);
      d.belief.copyFrom(this.base.belief);
      this.drones.push(d);
    }
    if (c.mode === "unified") this.unified = new UnifiedStack(this);
    this.towers = pickTowerSites(this.terrain, c.towers).map((s, k) => ({ id: towerNodeId(k), x: s.x, y: s.y, alive: true, lostAt: -1 }));
  }

  get baseOnline() {
    const c = this.cfg;
    if (this.base.manualOutage) return false;
    return !(c.baseOutageAt >= 0 && this.tick >= c.baseOutageAt);
  }

  // ---------------------------------------------------------------- main loop
  step() {
    if (this.finished) return;
    const c = this.cfg;
    this.env.step(this.tick);

    if (c.satellitePeriod > 0 && this.tick > 0 && this.tick % c.satellitePeriod === 0 && this.baseOnline) {
      const prevFire = this.unified ? this.base.belief.fire.slice() : null;
      const prevSev = this.unified ? this.base.belief.severity.slice() : null;
      this.base.belief.observeAll(this.env, this.tick);
      if (this.unified) this.unified.baseObservedAll(prevFire!, prevSev!);
    }

    for (const d of this.drones) if (d.alive) this.senseDrone(d);

    // A relay tower is destroyed when the fire reaches it.
    for (const t of this.towers) {
      if (t.alive && this.env.fire[t.y * c.width + t.x] === Fire.Burning) {
        t.alive = false;
        t.lostAt = this.tick;
      }
    }

    this.networkNodes = this.commsNodes();
    this.network = buildNetwork(this.networkNodes, this.terrain, this.env, this.blackouts, c);
    this.shareInformation();
    if (this.usesClaims) this.updateTrackers();
    if (c.mode === "central" && this.tick % c.decisionInterval === 0) this.centralAssign();
    if ((c.mode === "cbba" || c.mode === "unified") && this.tick % c.decisionInterval === 0) this.cbbaPlan();

    this.zoneCache.clear();
    for (const d of this.drones) if (d.alive) this.act(d);

    this.tick++;
    if (this.tick % 5 === 0) this.history.push({ tick: this.tick, burning: this.env.burningCount(), burnt: this.env.burntCount() });
    if (this.extinguishedAt < 0 && this.env.burningCount() === 0) this.extinguishedAt = this.tick;
  }

  get finished() {
    return this.extinguishedAt >= 0 || this.tick >= this.cfg.maxTicks;
  }

  runToEnd() {
    while (!this.finished) this.step();
    return this.metrics();
  }

  metrics(): Metrics {
    return {
      tick: this.tick,
      finished: this.finished,
      burnt: this.env.burntCount(),
      burning: this.env.burningCount(),
      villageLost: this.env.villageLost,
      villageLostAt: this.env.villageLostAt,
      dronesLost: this.drones.filter((d) => !d.alive).length,
      waterDropped: this.drones.reduce((s, d) => s + d.waterDropped, 0),
      extinguishedAt: this.extinguishedAt,
    };
  }

  // ---------------------------------------------------------------- comms
  /** Every radio currently on the air: live drones, the base (if online) and standing towers. */
  commsNodes(): CommsNode[] {
    const c = this.cfg;
    const nodes: CommsNode[] = [];
    for (const d of this.drones) {
      if (d.alive) nodes.push({ id: d.id, x: d.x, y: d.y, z: d.altitude(this.terrain, c), range: c.commsRange });
    }
    if (this.baseOnline) {
      nodes.push({
        id: BASE_ID,
        x: this.base.x,
        y: this.base.y,
        z: terrainHeightAt(this.terrain, this.base.x, this.base.y) + BASE_MAST_HEIGHT, // base has a mast
        range: c.baseCommsRange,
      });
    }
    for (const t of this.towers) {
      if (t.alive) nodes.push({ id: t.id, x: t.x, y: t.y, z: terrainHeightAt(this.terrain, t.x, t.y) + c.towerHeight, range: c.towerRange });
    }
    return nodes;
  }

  /** Modes where drones share plans ("claims") and track lost teammates. */
  get usesClaims() {
    const m = this.cfg.mode;
    return m === "swarm" || m === "cbba" || m === "unified";
  }

  private senseDrone(d: Drone) {
    if (this.unified) this.unified.senseDrone(d);
    else d.sense(this.env, this.cfg, this.tick);
  }

  /** Fly one tick towards (tx, ty); unified mode plans the step with distributed MPC. */
  private fly(d: Drone, tx: number, ty: number) {
    return this.unified ? this.unified.fly(d, tx, ty) : d.moveTowards(tx, ty, this.env, this.cfg);
  }

  inContact(a: number, b: number) {
    const ca = this.network.componentOf.get(a);
    return ca !== undefined && ca === this.network.componentOf.get(b);
  }

  // Everyone who can reach each other (directly or via relays) merges fire maps.
  // In swarm mode they also exchange plans ("claims") and heartbeats.
  private shareInformation() {
    const c = this.cfg;
    if (this.unified) this.unified.exchange();
    for (const comp of this.network.components) {
      const hasBase = comp.includes(BASE_ID);
      if (c.mode === "central" && !hasBase) continue; // central drones only talk via base
      if (!this.unified) {
        const maps: BeliefMap[] = [];
        for (const id of comp) {
          if (id === BASE_ID) maps.push(this.base.belief);
          else if (id >= 0) maps.push(this.drones[id].belief); // towers (id < BASE_ID) only relay
        }
        mergeGroup(maps);
      } else {
        // Unified: no whole-map swap. Maps move as DTN bundles (below); policies are averaged.
        this.unified.shareParameters(comp.filter((id) => id >= 0).map((id) => this.drones[id]).filter((d) => d.alive));
      }

      if (this.usesClaims) {
        const members = comp.filter((id) => id >= 0).map((id) => this.drones[id]);
        // Heartbeat: each member republishes its plan with its current position.
        const merged = new Map<number, Claim>();
        for (const m of members) {
          for (const [id, cl] of m.claims) {
            const ex = merged.get(id);
            if (!ex || cl.stamp > ex.stamp) merged.set(id, cl);
          }
        }
        for (const m of members) {
          const prev = merged.get(m.id);
          merged.set(m.id, m.myClaim(this.tick, prev?.bid ?? 0));
        }
        for (const m of members) m.claims = new Map(merged);
      }
    }
  }

  private publishClaim(d: Drone, claim: Claim) {
    d.claims.set(d.id, claim);
    const comp = this.network.componentOf.get(d.id);
    if (comp === undefined) return;
    for (const id of this.network.components[comp]) {
      if (id >= 0 && id !== d.id) this.drones[id].claims.set(d.id, claim);
    }
  }

  private updateTrackers() {
    const c = this.cfg;
    for (const d of this.drones) {
      if (!d.alive) continue;
      for (const [id, cl] of d.claims) {
        if (id === d.id) continue;
        if (this.tick - cl.stamp <= 1) {
          d.trackers.delete(id); // in contact: no need to guess
          continue;
        }
        let tr = d.trackers.get(id);
        if (!tr) {
          tr = new TeammateTracker(c.trackerParticles);
          tr.reset(cl);
          d.trackers.set(id, tr);
        }
        tr.update(cl, c.droneSpeed, this.agentRng);
      }
    }
  }

  // ---------------------------------------------------------------- per-drone behaviour
  private act(d: Drone) {
    const c = this.cfg;
    const env = this.env;
    d.takeDamage(env, c);
    if (d.damage >= 1 || d.battery <= 0) {
      d.state = "dead";
      d.lostAt = this.tick;
      return;
    }

    if (d.state === "charging") {
      d.battery = Math.min(1, d.battery + 0.03);
      d.damage = Math.max(0, d.damage - 0.03);
      // Docked: swap maps with base by cable, even if base radio is down.
      if (this.unified) this.unified.dock(d);
      else {
        d.belief.mergeFrom(this.base.belief);
        this.base.belief.mergeFrom(d.belief);
      }
      if (d.battery >= 1 && d.damage <= 0) {
        d.state = "idle";
        d.setVisitedBase(!d.belief.anyFire());
      }
      return;
    }

    // Safety first: go home if battery or health is getting low.
    if (d.state !== "toBase" && (d.battery < d.batteryToReturn(this.base.x, this.base.y, c) || d.damage > 0.7)) {
      d.state = "toBase";
    }
    if (d.state === "toBase") {
      if (this.fly(d, this.base.x, this.base.y)) d.state = "charging";
      return;
    }

    if (d.state === "refilling") {
      d.water = Math.min(c.waterCapacity, d.water + 0.5);
      d.hover(env, c);
      if (d.water >= c.waterCapacity) d.state = "idle";
      return;
    }
    if (d.water <= 0 && d.state !== "toWater") {
      const wt = this.bestWaterTile(d.x, d.y, d.targetX, d.targetY);
      d.state = "toWater";
      d.targetTile = wt;
      d.targetX = wt % env.w;
      d.targetY = Math.floor(wt / env.w);
      if (this.usesClaims) this.publishClaim(d, d.myClaim(this.tick, d.claims.get(d.id)?.bid ?? 0));
    }
    if (d.state === "toWater") {
      if (this.fly(d, d.targetX, d.targetY)) d.state = "refilling";
      return;
    }

    // Has water: decide what to fight (periodically, or when the current job is done).
    const targetGone = d.targetTile >= 0 && d.state === "toFire" && d.belief.fire[d.targetTile] !== Fire.Burning;
    if (d.state === "idle" || targetGone || this.tick % c.decisionInterval === d.id % c.decisionInterval) {
      if (d.state !== "scouting" || d.belief.anyFire()) this.decide(d);
    }

    if (d.state === "toFire") {
      if (this.fly(d, d.targetX, d.targetY)) {
        env.dropWater(d.targetTile, 1);
        d.water -= 1;
        d.waterDropped++;
        this.senseDrone(d);
        if (this.unified) this.unified.learn(d, env);
        d.state = "idle";
      }
    } else if (d.state === "scouting") {
      if (this.fly(d, d.targetX, d.targetY)) d.state = "idle";
    } else {
      d.hover(env, c);
    }
  }

  private decide(d: Drone) {
    const mode = this.cfg.mode;
    if (mode === "central") return this.decideCentral(d);
    if (mode === "cbba" || mode === "unified") return this.decideCbba(d);
    const zones = this.zonesFor(d);
    d.lastZones = zones;
    if (zones.length === 0) return this.noKnownFire(d);
    d.setVisitedBase(false);

    const c = this.cfg;
    const scored = zones.map((z) => {
      const raw = z.value / (this.timeToImpact(d, z) + 5);
      return { z, raw, score: raw * (z.id === d.zone ? c.stickiness : 1) };
    });
    scored.sort((a, b) => b.score - a.score);

    let chosen = scored[0];
    d.lastScores = [];
    if (mode === "swarm") {
      // Consensus auction: skip zones that enough teammates (with better bids) already hold.
      // Out-of-contact teammates count as "probably there" in proportion to how
      // confident the particle filter is that they're still working that zone.
      let best: (typeof scored)[number] | null = null;
      let fallback = scored[0];
      let fallbackScore = -1;
      for (const s of scored) {
        let taken = 0;
        for (const [id, cl] of d.claims) {
          if (id === d.id || cl.zone !== s.z.id) continue;
          const age = this.tick - cl.stamp;
          if (age <= 1) {
            if (cl.bid > s.raw || (cl.bid === s.raw && id < d.id)) taken += 1;
          } else {
            const tr = d.trackers.get(id);
            const near = tr ? tr.fractionNear(s.z.tx, s.z.ty, c.zoneSize * 1.2) : 1;
            taken += Math.exp(-age / c.trackerTimescale) * near;
          }
        }
        if (d.lastScores.length < 5) d.lastScores.push({ zone: s.z.id, score: s.raw, taken });
        const adj = s.score / (1 + taken);
        if (adj > fallbackScore) {
          fallbackScore = adj;
          fallback = s;
        }
        if (taken < s.z.slots - 0.5) {
          best = s;
          break;
        }
      }
      chosen = best ?? fallback;
    } else {
      d.lastScores = scored.slice(0, 5).map((s) => ({ zone: s.z.id, score: s.raw, taken: 0 }));
    }

    this.assign(d, chosen.z);
    if (mode === "swarm") this.publishClaim(d, d.myClaim(this.tick, chosen.raw));
  }

  private assign(d: Drone, z: Zone) {
    d.zone = z.id;
    d.targetTile = z.target;
    d.targetX = z.tx;
    d.targetY = z.ty;
    d.state = "toFire";
  }

  // No fire on my map: go home to fetch the base's map; if that has none either, scout.
  private noKnownFire(d: Drone) {
    d.zone = -1;
    if (!d.visitedBase) {
      d.state = "toBase";
      return;
    }
    // Scout: pick a spot that hasn't been looked at for a long time, not too far away.
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < 40; k++) {
      const i = this.agentRng.int(this.env.w * this.env.h);
      const x = i % this.env.w;
      const y = Math.floor(i / this.env.w);
      const age = this.tick - Math.max(0, d.belief.lastSeen[i]);
      const s = age - 0.7 * Math.hypot(x - d.x, y - d.y);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    d.targetTile = best;
    d.targetX = best % this.env.w;
    d.targetY = Math.floor(best / this.env.w);
    d.state = "scouting";
    if (this.usesClaims) this.publishClaim(d, d.myClaim(this.tick, 0));
  }

  // ---------------------------------------------------------------- central baseline
  // Base assigns every drone it can reach. Drones out of contact keep their last
  // order and, once it's done, fly home for new orders.
  private centralAssign() {
    if (!this.baseOnline) return;
    const comp = this.network.componentOf.get(BASE_ID);
    if (comp === undefined) return;
    const reachable = this.network.components[comp].filter((id) => id >= 0).map((id) => this.drones[id]);
    const zones = computeZones(this.base.belief, this.terrain, this.env.wind, this.cfg);
    const pairs: { d: Drone; z: Zone; s: number }[] = [];
    for (const d of reachable) {
      if (!d.alive || d.water <= 0) continue;
      for (const z of zones) pairs.push({ d, z, s: z.value / (this.timeToImpact(d, z) + 5) });
    }
    pairs.sort((a, b) => b.s - a.s);
    const used = new Map<number, number>();
    const done = new Set<number>();
    // Pass 1: fill each zone up to its slots, best bids first.
    for (const p of pairs) {
      if (done.has(p.d.id)) continue;
      if ((used.get(p.z.id) ?? 0) >= p.z.slots) continue;
      used.set(p.z.id, (used.get(p.z.id) ?? 0) + 1);
      done.add(p.d.id);
      p.d.orders = { zone: p.z.id, tile: p.z.target };
    }
    // Pass 2: spare drones reinforce whichever zone gains most from one more drone.
    for (const d of reachable) {
      if (done.has(d.id) || !d.alive || d.water <= 0) continue;
      let best: Zone | null = null;
      let bs = -1;
      for (const z of zones) {
        const s = z.value / (this.timeToImpact(d, z) + 5) / (1 + (used.get(z.id) ?? 0));
        if (s > bs) {
          bs = s;
          best = z;
        }
      }
      if (best) {
        used.set(best.id, (used.get(best.id) ?? 0) + 1);
        done.add(d.id);
        d.orders = { zone: best.id, tile: best.target };
      }
    }
    for (const d of reachable) if (!done.has(d.id)) d.orders = null;
  }

  private decideCentral(d: Drone) {
    const o = d.orders;
    if (o && d.belief.fire[o.tile] === Fire.Burning) {
      d.zone = o.zone;
      d.targetTile = o.tile;
      d.targetX = o.tile % this.env.w;
      d.targetY = Math.floor(o.tile / this.env.w);
      d.state = "toFire";
      return;
    }
    d.orders = null;
    d.zone = -1;
    // No valid orders: if base is reachable, wait for the next assignment; otherwise go home.
    if (this.inContact(d.id, BASE_ID)) d.state = "idle";
    else d.state = "toBase";
  }

  // ---------------------------------------------------------------- CBBA mode
  // Every decision interval, each group of drones that can reach each other runs CBBA
  // (src/sim/cbba.ts) to completion; a drone on its own plans with what it last heard.
  private cbbaPlan() {
    // Finding the best water source scans every water tile, and CBBA asks the same question
    // many times while scoring plans, so answers are cached for this planning step (keyed on
    // whole tiles, which is plenty for planning).
    const w = this.env.w;
    const water = new Map<number, number>();
    const viaWater = (x: number, y: number, tx: number, ty: number) => {
      const key = ((Math.round(x) * 128 + Math.round(y)) * 128 + Math.round(tx)) * 128 + Math.round(ty);
      let d = water.get(key);
      if (d === undefined) {
        const wt = this.bestWaterTile(x, y, tx, ty);
        const wx = wt % w;
        const wy = Math.floor(wt / w);
        d = Math.hypot(wx - x, wy - y) + Math.hypot(tx - wx, ty - wy);
        water.set(key, d);
      }
      return d;
    };
    const zoneCache = new Map<Drone, Zone[]>();
    const ctx = {
      cfg: this.cfg,
      tick: this.tick,
      zonesOf: (d: Drone) => {
        let z = zoneCache.get(d);
        if (!z) zoneCache.set(d, (z = this.zonesFor(d)));
        return z;
      },
      viaWater,
    };
    const bidding = (d: Drone) => d.alive && d.state !== "toBase" && d.state !== "charging";
    for (const comp of this.network.components) {
      const members = comp.filter((id) => id >= 0).map((id) => this.drones[id]);
      if (members.length) cbbaGroup(ctx, members, bidding);
    }
  }

  // Fly the first zone in my CBBA path. If my bundle is empty (every slot is held by a
  // drone with a better bid), reinforce the zone that gains most from one more drone.
  private decideCbba(d: Drone) {
    const zones = this.zonesFor(d);
    d.lastZones = zones;
    if (zones.length === 0) return this.noKnownFire(d);
    d.setVisitedBase(false);
    const byId = new Map(zones.map((z) => [z.id, z]));
    const st = d.cbba;
    d.lastScores = st.path.map((id) => ({ zone: Number(id.split("#")[0]), score: st.table.get(id)?.bid ?? 0, taken: 0 }));

    let chosen: Zone | undefined;
    for (const id of st.path) {
      chosen = byId.get(Number(id.split("#")[0]));
      if (chosen) break;
    }
    if (!chosen) {
      let best = -1;
      for (const z of zones) {
        let holders = 0;
        for (let k = 0; k < z.slots; k++) if (st.table.has(taskId(z.id, k))) holders++;
        const s = z.value / (this.timeToImpact(d, z) + 5) / (1 + holders);
        if (s > best) {
          best = s;
          chosen = z;
        }
      }
    }
    if (!chosen) return this.noKnownFire(d);
    if (this.unified && (d.state !== "toFire" || d.zone !== chosen.id || d.targetTile !== chosen.target)) this.unified.recordChoice(d, zones, chosen);
    this.assign(d, chosen);
    this.publishClaim(d, d.myClaim(this.tick, st.table.get(st.path[0] ?? "")?.bid ?? 0));
  }

  // ---------------------------------------------------------------- helpers
  private zonesFor(d: Drone): Zone[] {
    // Unified mode: the same zones, with each value scaled by the drone's learned policy.
    if (this.unified) return this.unified.zonesFor(d);
    // Drones that just merged maps share identical beliefs, but we compute per drone
    // anyway: each drone plans from its OWN map.
    return computeZones(d.belief, this.terrain, this.env.wind, this.cfg);
  }

  timeToImpact(d: Drone, z: Zone) {
    const c = this.cfg;
    if (d.water > 0) return Math.hypot(z.tx - d.x, z.ty - d.y) / c.droneSpeed;
    const wt = this.bestWaterTile(d.x, d.y, z.tx, z.ty);
    const wx = wt % this.env.w;
    const wy = Math.floor(wt / this.env.w);
    return (Math.hypot(wx - d.x, wy - d.y) + Math.hypot(z.tx - wx, z.ty - wy)) / c.droneSpeed + c.waterCapacity / 0.5;
  }

  // Water source that minimises the detour from (x, y) to (tx, ty).
  bestWaterTile(x: number, y: number, tx: number, ty: number) {
    let best = this.waterTiles[0];
    let bd = Infinity;
    const w = this.env.w;
    for (const i of this.waterTiles) {
      const wx = i % w;
      const wy = Math.floor(i / w);
      const dd = Math.hypot(wx - x, wy - y) + Math.hypot(tx - wx, ty - wy);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- judge controls
  igniteAt(x: number, y: number) {
    return this.env.ignite(this.env.idx(Math.round(x), Math.round(y)), 1);
  }
  addBlackout(x: number, y: number, r: number) {
    this.blackouts.push({ x, y, r });
  }
  clearBlackouts() {
    this.blackouts = [];
  }
  crashDrone(id: number) {
    const d = this.drones[id];
    if (d && d.alive) {
      d.state = "dead";
      d.lostAt = this.tick;
    }
  }
  setWind(angle: number, speed: number) {
    this.env.wind.angle = angle;
    this.env.wind.speed = speed;
  }
}
