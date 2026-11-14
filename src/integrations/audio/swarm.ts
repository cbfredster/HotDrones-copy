// The swarm as a composition (DurHack's theme). You can HEAR the network.
//
//   - Every drone is one voice: its note comes from its ID (a minor pentatonic scale, so any
//     combination is consonant), its rhythm from an ID-seeded pattern, its place in the stereo
//     field from where it is on the map.
//   - Drones that can reach each other share one clock and play on the same beat.
//   - A group that is cut off from the main group keeps its own clock. It slowly drifts out
//     of time and out of tune: the longer it is cut off, the further it goes.
//   - When it reconnects it snaps back onto the beat, in tune, with a short resolving chime.
//   - The fire is the percussion: the more that is burning, the busier it gets.
//
// Read-only: it looks at world.network and the drones, and schedules notes. No sim RNG.
import { BASE_ID } from "../../sim/comms";
import type { World } from "../../sim/world";
import type { AudioEngine } from "./engine";

const BPM = 104;
const STEPS_PER_SEC = (BPM / 60) * 4; // sixteenth notes
const STEPS = 16;
const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
const ROOT_HZ = 146.83; // D3
const LOOKAHEAD = 0.18; // seconds scheduled ahead of the audio clock
const MAX_DRIFT = 0.085; // a cut-off group's tempo runs up to 8.5% fast or slow
const MAX_DETUNE = 55; // cents

interface Voice {
  phase: number; // position in steps, on this drone's current clock
  cutFor: number; // seconds this drone has been outside the main group
  wasCut: boolean;
}

const hash = (n: number) => {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
};

export class SwarmMusic {
  private world: World | null = null;
  private voices: Voice[] = [];
  private refPhase = 0;
  private scheduledTo = 0;
  private timer: number | null = null;
  private playing = false;
  /** For the UI: how many drones are currently out of time. */
  outOfSync = 0;

  constructor(private eng: AudioEngine) {}

  start() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.schedule(), 45);
  }

  setWorld(world: World) {
    this.world = world;
    this.voices = world.drones.map(() => ({ phase: this.refPhase, cutFor: 0, wasCut: false }));
  }

  setPlaying(p: boolean) {
    this.playing = p;
  }

  /** The main group: the one the base is in, else the largest group of drones (lowest ID breaks ties). */
  private mainGroup(world: World): Set<number> {
    const net = world.network;
    const baseComp = world.baseOnline ? net.componentOf.get(BASE_ID) : undefined;
    let best: number[] = [];
    if (baseComp !== undefined) best = net.components[baseComp].filter((id) => id >= 0);
    if (best.length === 0) {
      for (const c of net.components) {
        const drones = c.filter((id) => id >= 0);
        if (drones.length > best.length || (drones.length === best.length && drones.length > 0 && Math.min(...drones) < Math.min(...best))) best = drones;
      }
    }
    return new Set(best);
  }

  private schedule() {
    const ctx = this.eng.ctx;
    const world = this.world;
    if (!ctx || !world || !this.eng.on) return;
    const now = ctx.currentTime;
    if (this.scheduledTo < now) this.scheduledTo = now;
    const until = now + LOOKAHEAD;
    const dt = until - this.scheduledTo;
    if (dt <= 0) return;
    const t0 = this.scheduledTo;
    this.scheduledTo = until;
    const audible = this.playing && !world.finished && this.eng.busOn("swarm");

    // Reference clock (always advances, so everything stays in time across pauses).
    const ref0 = this.refPhase;
    this.refPhase += dt * STEPS_PER_SEC;
    if (audible) this.percussion(world, ref0, this.refPhase, t0);

    const main = this.mainGroup(world);
    const net = world.network;
    let outOfSync = 0;
    // Leaders of cut-off groups first, so their members can copy the leader's clock.
    const leaderPhase = new Map<number, number>();
    const order = world.drones.map((d) => d.id).sort((a, b) => a - b);
    for (const id of order) {
      const d = world.drones[id];
      const v = this.voices[id];
      if (!v) continue;
      if (!d.alive) continue;
      const docked = d.state === "charging";
      const inMain = main.has(id) || docked;
      const before = v.phase;
      let detune = 0;
      if (inMain) {
        if (v.wasCut && audible && v.cutFor > 1.5) this.chime(id, t0 + 0.02); // snapped back onto the beat
        v.cutFor = 0;
        v.wasCut = false;
        v.phase = this.refPhase;
        this.notes(d.id, world, ref0, this.refPhase, t0, STEPS_PER_SEC, 0, audible && !docked);
        continue;
      }
      // Cut off: follow the lowest-ID drone of my own group.
      v.cutFor += dt;
      v.wasCut = true;
      outOfSync++;
      const comp = net.componentOf.get(id);
      const leader = comp === undefined ? id : Math.min(...net.components[comp].filter((x) => x >= 0));
      const sign = hash(leader + 17) < 0.5 ? -1 : 1;
      const amount = Math.min(1, this.voices[leader].cutFor / 10); // drift grows over ten seconds
      const rate = STEPS_PER_SEC * (1 + sign * MAX_DRIFT * amount);
      detune = sign * (8 + MAX_DETUNE * amount);
      let from = before;
      if (leader !== id && leaderPhase.has(leader)) {
        // Joined (or still in) another drone's group: take its clock.
        const lp = leaderPhase.get(leader)!;
        from = lp - dt * rate;
        v.phase = lp;
      } else {
        v.phase = before + dt * rate;
        leaderPhase.set(id, v.phase);
      }
      this.notes(d.id, world, from, v.phase, t0, rate, detune, audible);
    }
    this.outOfSync = outOfSync;
  }

  /** Schedule this drone's notes for every step boundary its clock crosses between two phases. */
  private notes(id: number, world: World, from: number, to: number, t0: number, rate: number, detune: number, audible: boolean) {
    if (!audible) return;
    const pulses = 3 + (id % 3); // 3-5 hits per bar
    const rot = (id * 5) % STEPS;
    for (let s = Math.ceil(from); s < to; s++) {
      const step = ((s % STEPS) + STEPS) % STEPS;
      if ((((step + rot) % STEPS) * pulses) % STEPS >= pulses) continue; // Euclidean-style rhythm
      this.pluck(id, world, t0 + (s - from) / rate, detune);
    }
  }

  private pluck(id: number, world: World, at: number, detuneCents: number) {
    const ctx = this.eng.ctx!;
    const d = world.drones[id];
    const semis = SCALE[id % SCALE.length] + 12 * (Math.floor(id / SCALE.length) % 3);
    const o = ctx.createOscillator();
    // What the drone is doing colours its voice.
    o.type = d.state === "toFire" ? "triangle" : d.state === "toBase" ? "sawtooth" : "sine";
    o.frequency.value = ROOT_HZ * Math.pow(2, semis / 12);
    o.detune.value = detuneCents;
    const g = ctx.createGain();
    const peak = d.state === "toFire" ? 0.2 : 0.13;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = d.state === "toBase" ? 900 : 2600;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, (d.x / world.env.w) * 1.6 - 0.8));
    o.connect(lp).connect(g).connect(pan).connect(this.eng.buses.swarm);
    o.start(at);
    o.stop(at + 0.36);
  }

  /** A drone rejoining the main group: a quick rising fifth on its own note. */
  private chime(id: number, at: number) {
    const ctx = this.eng.ctx!;
    const semis = SCALE[id % SCALE.length] + 12 * (Math.floor(id / SCALE.length) % 3) + 12;
    [0, 7].forEach((add, k) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = ROOT_HZ * Math.pow(2, (semis + add) / 12);
      const g = ctx.createGain();
      const t = at + k * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(this.eng.buses.swarm);
      o.start(t);
      o.stop(t + 0.75);
    });
  }

  /** The fire drives the percussion, on the main clock. */
  private percussion(world: World, from: number, to: number, t0: number) {
    const ctx = this.eng.ctx!;
    const burning = world.history.length ? world.history[world.history.length - 1].burning : 0;
    if (burning <= 0) return;
    const intensity = Math.min(1, burning / 160);
    const bus = this.eng.buses.swarm;
    for (let s = Math.ceil(from); s < to; s++) {
      const step = s % STEPS;
      const at = t0 + (s - from) / STEPS_PER_SEC;
      if (step % 8 === 0 || (intensity > 0.6 && step === 10)) {
        const o = ctx.createOscillator(); // kick
        const g = ctx.createGain();
        o.frequency.setValueAtTime(120, at);
        o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
        g.gain.setValueAtTime(0.3 + 0.25 * intensity, at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
        o.connect(g).connect(bus);
        o.start(at);
        o.stop(at + 0.22);
      }
      if (hash(s * 31 + 7) < 0.15 + 0.75 * intensity) {
        this.eng.noiseBurst(bus, { at, dur: 0.04, type: "highpass", freq: 6500, gain: 0.04 + 0.07 * intensity }); // hat
      }
      if (intensity > 0.35 && step % 8 === 4) {
        this.eng.noiseBurst(bus, { at, dur: 0.13, type: "bandpass", freq: 1700, q: 0.6, gain: 0.12 + 0.12 * intensity }); // snare
      }
    }
  }
}
