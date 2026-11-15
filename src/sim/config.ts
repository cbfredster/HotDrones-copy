// All tunable numbers live here so the team can tweak behaviour in one place.

export type Mode = "swarm" | "central" | "greedy" | "cbba" | "unified";

export interface Config {
  seed: number;
  mode: Mode;
  width: number;
  height: number;
  maxTicks: number;

  // Terrain
  heightScale: number; // max terrain height in "units" (1 tile = 1 unit wide)

  // Fire
  spreadBase: number; // base chance per tick of spreading to a neighbour
  windStrength: number; // how strongly wind biases spread
  slopeStrength: number; // how strongly uphill speeds spread
  severityGrowth: number; // severity gained per tick while burning
  maxSeverity: number;
  waterPerSeverity: number; // water units needed per severity level to extinguish
  wetDecay: number; // how fast wetted ground dries out
  embers: boolean; // embers occasionally jump ahead of the front
  ignitions: number; // number of starting fires
  preburnTicks: number; // fire burns this long before the drones are called out

  // Smoke
  smokeEmission: number;
  smokeDecay: number;
  thickSmoke: number; // density above which smoke counts as thick
  smokeBlocksComms: boolean; // thick smoke between two radios cuts the link (the spec: "treat as infinite distance")
  smokeBlocksSensing: boolean; // thick smoke shrinks a drone's sensor radius
  // "massed": a burning tile only smokes heavily when the tiles around it are burning too, so
  // one isolated tile can never make thick smoke. "legacy": every burning tile emits in full.
  smokeModel: "legacy" | "massed";
  smokeMassTiles: number; // burning tiles (in a tile's 3x3 block, itself included) needed for full emission

  // Wind
  windDrift: boolean; // wind slowly changes direction and speed

  // Drones
  droneCount: number;
  droneSpeed: number; // tiles per tick
  droneAltitude: number; // height above terrain, used for line-of-sight
  sensorRadius: number;
  waterCapacity: number;
  commsRange: number;
  baseCommsRange: number;
  batteryDrain: number;
  climbDrain: number; // extra battery per unit of height gained
  descentDrain: number; // extra battery per unit of height lost (0 = descending is free)
  spawnInLine: boolean; // drones start lined up on the pad instead of scattered around it
  fireDamage: number; // damage per tick flying over burning tiles
  smokeDamage: number; // damage per tick per unit of smoke
  decisionInterval: number; // ticks between re-planning

  // Base
  satellitePeriod: number; // base gets a fresh true map every N ticks (0 = never)
  baseOutageAt: number; // tick at which base comms fail (-1 = never)

  // Relay towers: fixed radio masts on high ground that relay between whoever can see them.
  // They hold no map and make no decisions, and are lost for good if their tile burns.
  towers: number;
  towerRange: number;
  towerHeight: number; // antenna height above the terrain

  // Regrowth: burnt ground comes back after a while, but only next to healthy vegetation.
  regrowth: boolean;
  regrowAfter: number; // ticks a tile must stay burnt before it can regrow
  regrowChance: number; // chance per tick after that, while it has a healthy neighbour

  // Coordination
  zoneSize: number; // task zones are zoneSize x zoneSize blocks
  stickiness: number; // bonus multiplier for keeping your current zone
  trackerParticles: number;
  trackerTimescale: number; // ticks after which a lost teammate's plan is mostly distrusted

  // CBBA mode (src/sim/cbba.ts). Only read when mode is "cbba".
  cbbaBundleSize: number; // zones a drone plans ahead: this load, then the next refills
  cbbaHorizon: number; // ticks: a zone reached this much later is worth 1/e as much
  cbbaRounds: number; // most build + consensus rounds per planning step

  // Unified mode (src/sim/unified.ts): CBBA + DTN + IB/event triggers + CI fusion + GAT/MARL + DMPC.
  // Only read when mode is "unified". CBBA settings above are shared with it.
  unifiedLinkBytes: number; // DTN: bytes each node may receive per tick from its group
  unifiedBundleTtl: number; // DTN: ticks a bundle is carried before it is dropped
  unifiedBitBudget: number; // IB: target bits a node originates per tick (lambda adapts to it)
  unifiedBeta: number; // IB: relevance-vs-rate trade-off (an entry's utility must beat beta * bits)
  unifiedProcessNoise: number; // CI: variance added per tick of age to an estimate
  unifiedLearningRate: number; // MARL: policy-gradient step size
}

export const defaultConfig: Config = {
  seed: 1,
  mode: "swarm",
  width: 64,
  height: 64,
  maxTicks: 2000,

  heightScale: 24,

  spreadBase: 0.018,
  windStrength: 1.4,
  slopeStrength: 0.25,
  severityGrowth: 0.01,
  maxSeverity: 3,
  waterPerSeverity: 0.6,
  wetDecay: 0.002,
  embers: true,
  ignitions: 3,
  preburnTicks: 60,

  smokeEmission: 0.12,
  smokeDecay: 0.9,
  thickSmoke: 0.8,
  smokeBlocksComms: true,
  smokeBlocksSensing: true,
  smokeModel: "massed",
  smokeMassTiles: 5,

  windDrift: true,

  droneCount: 10,
  droneSpeed: 0.7,
  droneAltitude: 2,
  sensorRadius: 7,
  waterCapacity: 5,
  commsRange: 14,
  baseCommsRange: 20,
  batteryDrain: 0.0009,
  climbDrain: 0.0006,
  descentDrain: 0.0003,
  spawnInLine: true,
  fireDamage: 0.006,
  smokeDamage: 0.0015,
  decisionInterval: 3,

  satellitePeriod: 0,
  baseOutageAt: -1,

  towers: 0,
  towerRange: 20,
  towerHeight: 8,

  regrowth: true,
  regrowAfter: 400,
  regrowChance: 0.004,

  zoneSize: 6,
  stickiness: 1.25,
  trackerParticles: 40,
  trackerTimescale: 120,

  cbbaBundleSize: 3,
  cbbaHorizon: 90,
  cbbaRounds: 6,

  unifiedLinkBytes: 400,
  unifiedBundleTtl: 400,
  unifiedBitBudget: 300,
  unifiedBeta: 0.02,
  unifiedProcessNoise: 0.05,
  unifiedLearningRate: 0.1,
};

// Everything added since the original 2D version, switched off. With these overrides the
// sim is bit-for-bit the one in BASIC/ (`npm run experiment -- --legacy` proves it against
// the committed BASIC/results/summary.csv). New behaviours must add their "off" value here.
export const legacyConfig: Partial<Config> = {
  smokeBlocksComms: false,
  smokeModel: "legacy",
  descentDrain: 0,
  spawnInLine: false,
  towers: 0,
  regrowth: false,
};
