import { BeliefMap } from "./belief";
import { Config } from "./config";
import { Fire, Wind } from "./environment";
import { FUEL, Terrain, Tile, terrainTarget } from "./terrain";

// A task zone: one chunk of the believed fire front that drones can bid on.
export interface Zone {
  id: number;
  target: number; // tile index to drop water on (most threatening front tile)
  tx: number;
  ty: number;
  value: number; // threat score
  frontier: number; // number of front tiles in the zone
  slots: number; // how many drones the zone is worth
}

// Threat of one burning tile on the front: how bad is it if nobody fights it?
export function tileThreat(
  i: number,
  belief: BeliefMap,
  terrain: Terrain,
  wind: Wind,
  villageX: number,
  villageY: number,
  unburntNeighbours: number,
): number {
  const w = terrain.w;
  const x = i % w;
  const y = Math.floor(i / w);
  const sev = Math.max(1, belief.severity[i]);
  const dx = villageX - x;
  const dy = villageY - y;
  const d = Math.hypot(dx, dy) + 1e-6;
  const proximity = 1 + 8 * Math.exp(-d / 10); // closer to the village = much worse
  const towards = (Math.cos(wind.angle) * dx + Math.sin(wind.angle) * dy) / d; // is the wind pushing it at the village?
  const windF = 1 + 2 * wind.speed * Math.max(0, towards);
  const fuelAhead = unburntNeighbours / 8; // fire with lots of fuel next to it will keep growing
  return sev * proximity * windF * (0.3 + fuelAhead);
}

// Group the believed fire front into zones and score them.
export function computeZones(belief: BeliefMap, terrain: Terrain, wind: Wind, cfg: Config): Zone[] {
  const { w, h, type } = terrain;
  const v = terrainTarget(terrain);
  const vx = v % w;
  const vy = Math.floor(v / w);
  const zs = cfg.zoneSize;
  const nbx = Math.ceil(w / zs);
  const zones = new Map<number, Zone>();
  let bestThreat = new Map<number, number>();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (belief.fire[i] !== Fire.Burning) continue;
      let unburnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (belief.fire[j] === Fire.Unburnt && FUEL[type[j] as Tile].ignite > 0) unburnt++;
        }
      }
      if (unburnt === 0) continue; // interior of the fire: will burn out on its own
      const t = tileThreat(i, belief, terrain, wind, vx, vy, unburnt);
      const zid = Math.floor(y / zs) * nbx + Math.floor(x / zs);
      let z = zones.get(zid);
      if (!z) {
        z = { id: zid, target: i, tx: x, ty: y, value: 0, frontier: 0, slots: 1 };
        zones.set(zid, z);
        bestThreat.set(zid, -1);
      }
      z.value += t;
      z.frontier++;
      if (t > bestThreat.get(zid)!) {
        bestThreat.set(zid, t);
        z.target = i;
        z.tx = x;
        z.ty = y;
      }
    }
  }
  const out = [...zones.values()];
  for (const z of out) {
    z.slots = Math.max(1, Math.min(4, Math.ceil(z.frontier / 5)));
    if (z.frontier <= 3) z.value *= 1.5; // small spot fires can be fully put out: worth jumping on
  }
  return out;
}

export interface Claim {
  droneId: number;
  zone: number; // -1 = no zone
  bid: number;
  stamp: number; // tick the claim was made
  x: number; // claimant's position at stamp time
  y: number;
  tx: number; // claimant's target at stamp time
  ty: number;
  water: number;
}
