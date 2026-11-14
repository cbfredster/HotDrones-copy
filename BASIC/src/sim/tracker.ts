import { Claim } from "./planner";
import { Rng } from "./rng";

// Particle filter guessing where an out-of-contact teammate probably is.
// Each particle is one guess. They all start at the teammate's last known
// position and fly towards its last known target with random variation, so the
// cloud spreads the longer we go without hearing from it.
export class TeammateTracker {
  xs: Float32Array;
  ys: Float32Array;
  private basedOn = -1; // stamp of the claim the cloud was started from

  constructor(readonly n: number) {
    this.xs = new Float32Array(n);
    this.ys = new Float32Array(n);
  }

  reset(c: Claim) {
    this.xs.fill(c.x);
    this.ys.fill(c.y);
    this.basedOn = c.stamp;
  }

  // Advance one tick. `claim` is the last thing we heard from the teammate.
  update(c: Claim, speed: number, rng: Rng) {
    if (this.basedOn !== c.stamp) this.reset(c);
    for (let k = 0; k < this.n; k++) {
      const dx = c.tx - this.xs[k];
      const dy = c.ty - this.ys[k];
      const d = Math.hypot(dx, dy);
      const s = speed * rng.range(0.5, 1.05);
      if (d > s) {
        this.xs[k] += (dx / d) * s + rng.normal() * 0.25;
        this.ys[k] += (dy / d) * s + rng.normal() * 0.25;
      } else {
        // Arrived (maybe): wander around the target as it works the fire / refills.
        this.xs[k] += rng.normal() * 0.6;
        this.ys[k] += rng.normal() * 0.6;
      }
    }
  }

  // Fraction of guesses within `r` tiles of (x, y).
  fractionNear(x: number, y: number, r: number) {
    let c = 0;
    const r2 = r * r;
    for (let k = 0; k < this.n; k++) if ((this.xs[k] - x) ** 2 + (this.ys[k] - y) ** 2 <= r2) c++;
    return c / this.n;
  }

  spread() {
    let mx = 0;
    let my = 0;
    for (let k = 0; k < this.n; k++) {
      mx += this.xs[k];
      my += this.ys[k];
    }
    mx /= this.n;
    my /= this.n;
    let v = 0;
    for (let k = 0; k < this.n; k++) v += (this.xs[k] - mx) ** 2 + (this.ys[k] - my) ** 2;
    return Math.sqrt(v / this.n);
  }
}
