import { BeliefMap } from "./belief";
import { CbbaState } from "./cbba";
import { terrainHeightAt } from "./comms";
import { Config } from "./config";
import { Environment } from "./environment";
import { Claim, Zone } from "./planner";
import { Terrain } from "./terrain";
import { TeammateTracker } from "./tracker";

export type DroneState =
  | "idle"
  | "toFire" // flying to its zone's target tile
  | "toWater" // flying to a water source to refill
  | "refilling"
  | "toBase" // returning to recharge / repair / get maps
  | "charging"
  | "scouting" // no known fire: checking areas not seen for a while
  | "dead";

export class Drone {
  x: number;
  y: number;
  state: DroneState = "idle";
  water: number;
  battery = 1; // drains over time, faster in headwind / climbing
  damage = 0; // builds up flying over fire and through smoke; 1 = destroyed
  belief: BeliefMap;
  claims = new Map<number, Claim>(); // what I know about every drone's current plan
  trackers = new Map<number, TeammateTracker>();
  zone = -1; // zone currently claimed
  targetX = 0;
  targetY = 0;
  targetTile = -1;
  lastZones: Zone[] = []; // for the UI: what this drone considered last time
  lastScores: { zone: number; score: number; taken: number }[] = [];
  waterDropped = 0;
  orders: { zone: number; tile: number } | null = null; // central mode only
  cbba = new CbbaState(); // cbba mode only
  lostAt = -1;
  private visitedBaseForMaps = false;

  constructor(readonly id: number, x: number, y: number, cfg: Config, w: number, h: number) {
    this.x = x;
    this.y = y;
    this.water = cfg.waterCapacity;
    this.belief = new BeliefMap(w, h);
  }

  get alive() {
    return this.state !== "dead";
  }

  altitude(t: Terrain, cfg: Config) {
    return terrainHeightAt(t, this.x, this.y) + cfg.droneAltitude;
  }

  // Look at the tiles around me. Thick smoke shrinks how far I can see.
  sense(env: Environment, cfg: Config, tick: number) {
    let r = cfg.sensorRadius;
    if (cfg.smokeBlocksSensing) r = r / (1 + env.smokeAt(this.x, this.y) / cfg.thickSmoke);
    r = Math.max(1.5, r);
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(this.x - r));
    const x1 = Math.min(env.w - 1, Math.ceil(this.x + r));
    const y0 = Math.max(0, Math.floor(this.y - r));
    const y1 = Math.min(env.h - 1, Math.ceil(this.y + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - this.x) ** 2 + (y - this.y) ** 2 <= r2) this.belief.observe(y * env.w + x, env, tick);
      }
    }
    return r;
  }

  myClaim(tick: number, bid: number): Claim {
    return {
      droneId: this.id,
      zone: this.zone,
      bid,
      stamp: tick,
      x: this.x,
      y: this.y,
      tx: this.targetX,
      ty: this.targetY,
      water: this.water,
    };
  }

  // Fly one tick towards (tx, ty). Returns true when arrived.
  moveTowards(tx: number, ty: number, env: Environment, cfg: Config): boolean {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    const terrain = env.terrain;
    const hBefore = terrainHeightAt(terrain, this.x, this.y);
    if (d <= cfg.droneSpeed) {
      this.x = tx;
      this.y = ty;
    } else {
      this.x += (dx / d) * cfg.droneSpeed;
      this.y += (dy / d) * cfg.droneSpeed;
    }
    const hAfter = terrainHeightAt(terrain, this.x, this.y);
    // Battery: base drain, more into a headwind, more when climbing (and, optionally, descending).
    let drain = cfg.batteryDrain;
    if (d > 0) {
      const head = -(Math.cos(env.wind.angle) * dx + Math.sin(env.wind.angle) * dy) / d;
      drain *= 1 + 0.8 * env.wind.speed * Math.max(0, head);
    }
    drain += Math.max(0, hAfter - hBefore) * cfg.climbDrain;
    if (cfg.descentDrain > 0) drain += Math.max(0, hBefore - hAfter) * cfg.descentDrain; // braking a descent costs too
    this.battery -= drain;
    return d <= cfg.droneSpeed;
  }

  hover(env: Environment, cfg: Config) {
    this.battery -= cfg.batteryDrain * (1 + 0.4 * env.wind.speed);
  }

  // Fire and smoke wear the drone down.
  takeDamage(env: Environment, cfg: Config) {
    const i = Math.round(this.y) * env.w + Math.round(this.x);
    if (env.fire[i] === 1) this.damage += cfg.fireDamage * Math.max(1, env.severity[i]);
    this.damage += cfg.smokeDamage * env.smokeAt(this.x, this.y);
  }

  // Battery needed to fly back to base from here, with a safety margin.
  batteryToReturn(bx: number, by: number, cfg: Config) {
    const d = Math.hypot(bx - this.x, by - this.y);
    return (d / cfg.droneSpeed) * cfg.batteryDrain * 1.6 + 0.04;
  }

  setVisitedBase(v: boolean) {
    this.visitedBaseForMaps = v;
  }
  get visitedBase() {
    return this.visitedBaseForMaps;
  }
}
