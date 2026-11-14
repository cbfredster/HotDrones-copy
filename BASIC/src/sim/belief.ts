import { Environment, Fire } from "./environment";

// A drone's (or the base's) private picture of the fire.
// Every tile stores what was believed AND when it was last seen, so maps from
// different drones can be merged tile-by-tile: the newest observation wins.
export class BeliefMap {
  fire: Uint8Array;
  severity: Float32Array;
  lastSeen: Int32Array; // tick of last observation, -1 = never seen

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.fire = new Uint8Array(n);
    this.severity = new Float32Array(n);
    this.lastSeen = new Int32Array(n).fill(-1);
  }

  observe(i: number, env: Environment, tick: number) {
    this.fire[i] = env.fire[i];
    this.severity[i] = env.severity[i];
    this.lastSeen[i] = tick;
  }

  // A full snapshot of the truth (initial briefing / satellite pass).
  observeAll(env: Environment, tick: number) {
    this.fire.set(env.fire);
    this.severity.set(env.severity);
    this.lastSeen.fill(tick);
  }

  // Merge another map into this one, keeping the newer observation per tile.
  mergeFrom(o: BeliefMap) {
    const ls = this.lastSeen;
    const ols = o.lastSeen;
    for (let i = 0; i < ls.length; i++) {
      if (ols[i] > ls[i]) {
        ls[i] = ols[i];
        this.fire[i] = o.fire[i];
        this.severity[i] = o.severity[i];
      }
    }
  }

  copyFrom(o: BeliefMap) {
    this.fire.set(o.fire);
    this.severity.set(o.severity);
    this.lastSeen.set(o.lastSeen);
  }

  // When we extinguish a tile ourselves we know it is out, even before re-sensing.
  markExtinguished(i: number, tick: number) {
    this.fire[i] = Fire.Burnt;
    this.severity[i] = 0;
    this.lastSeen[i] = tick;
  }

  anyFire(): boolean {
    for (let i = 0; i < this.fire.length; i++) if (this.fire[i] === Fire.Burning) return true;
    return false;
  }
}

// Merge a group of maps so that every member ends up with the combined newest view.
// Used for drones (and the base) that can currently reach each other.
export function mergeGroup(maps: BeliefMap[]) {
  if (maps.length < 2) return;
  const [first, ...rest] = maps;
  for (const m of rest) first.mergeFrom(m);
  for (const m of rest) m.copyFrom(first);
}
