// All tunable numbers live here so the team can tweak behaviour in one place.

export type Mode = "swarm" | "central" | "greedy";

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
  smokeBlocksComms: boolean; // optional rule; off by default (radio barely notices smoke)
  smokeBlocksSensing: boolean; // thick smoke shrinks a drone's sensor radius

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
  fireDamage: number; // damage per tick flying over burning tiles
  smokeDamage: number; // damage per tick per unit of smoke
  decisionInterval: number; // ticks between re-planning

  // Base
  satellitePeriod: number; // base gets a fresh true map every N ticks (0 = never)
  baseOutageAt: number; // tick at which base comms fail (-1 = never)

  // Coordination
  zoneSize: number; // task zones are zoneSize x zoneSize blocks
  stickiness: number; // bonus multiplier for keeping your current zone
  trackerParticles: number;
  trackerTimescale: number; // ticks after which a lost teammate's plan is mostly distrusted
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
  smokeBlocksComms: false,
  smokeBlocksSensing: true,

  windDrift: true,

  droneCount: 10,
  droneSpeed: 0.7,
  droneAltitude: 2,
  sensorRadius: 7,
  waterCapacity: 5,
  commsRange: 14,
  baseCommsRange: 20,
  batteryDrain: 0.0009,
  fireDamage: 0.006,
  smokeDamage: 0.0015,
  decisionInterval: 3,

  satellitePeriod: 0,
  baseOutageAt: -1,

  zoneSize: 6,
  stickiness: 1.25,
  trackerParticles: 40,
  trackerTimescale: 120,
};
