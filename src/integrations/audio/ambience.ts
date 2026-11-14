// Sound effects and the score.
//
// Every sound has two sources. If `npm run audio:generate` has been run, the ElevenLabs
// Sound Effects and Music files in public/audio are used. If not (or a file is missing),
// the same sound is synthesised in Web Audio, so the demo is never silent offline.
import type { World } from "../../sim/world";
import type { SimEvent } from "../events";
import type { AudioEngine } from "./engine";

export type Threat = "calm" | "tense" | "critical" | "victory" | "defeat";
const STEMS: Threat[] = ["calm", "tense", "critical", "victory", "defeat"];

interface Loop {
  gain: GainNode;
  target: number;
}

export class Ambience {
  private loops = new Map<string, Loop>();
  private stems = new Map<Threat, GainNode>();
  private stemsReady = false;
  private started = false;
  private threat: Threat = "calm";
  private lastSplash = 0;

  constructor(private eng: AudioEngine) {}

  get hasScore() {
    return this.stemsReady;
  }

  /** Build the loops once the audio context exists. */
  async start() {
    if (this.started || !this.eng.ctx) return;
    this.started = true;
    const ctx = this.eng.ctx;
    const fx = this.eng.buses.effects;
    for (const name of ["rotor", "fire", "wind"]) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(fx);
      this.loops.set(name, { gain, target: 0 });
      const file = this.eng.manifest.sfx[name];
      const buf = file ? await this.eng.load(file) : null;
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(gain);
        src.start();
      } else this.synthLoop(name, gain);
    }
    // Score: five looping stems, only one audible at a time.
    const loaded = await Promise.all(STEMS.map(async (s) => [s, this.eng.manifest.music[s] ? await this.eng.load(this.eng.manifest.music[s]) : null] as const));
    for (const [name, buf] of loaded) {
      if (!buf) continue;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.eng.buses.score);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = name !== "victory" && name !== "defeat";
      src.connect(g);
      src.start();
      this.stems.set(name, g);
    }
    this.stemsReady = this.stems.size > 0;
  }

  private synthLoop(name: string, out: GainNode) {
    const ctx = this.eng.ctx!;
    if (name === "rotor") {
      // Two detuned saws through a low-pass with a fast tremolo: a small quadcopter's buzz.
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 520;
      const trem = ctx.createGain();
      trem.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 23;
      const depth = ctx.createGain();
      depth.gain.value = 0.25;
      lfo.connect(depth).connect(trem.gain);
      lfo.start();
      for (const f of [92, 139, 185.5]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = 0.05;
        o.connect(g).connect(lp);
        o.start();
      }
      lp.connect(trem).connect(out);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = this.eng.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      if (name === "fire") {
        f.type = "bandpass";
        f.frequency.value = 700;
        f.Q.value = 0.4;
        g.gain.value = 0.5;
        lfo.frequency.value = 7.3;
        depth.gain.value = 0.25;
      } else {
        f.type = "lowpass";
        f.frequency.value = 380;
        g.gain.value = 0.5;
        lfo.frequency.value = 0.17;
        depth.gain.value = 0.3;
      }
      lfo.connect(depth).connect(g.gain);
      lfo.start();
      src.connect(f).connect(g).connect(out);
      src.start();
    }
  }

  /** Called every frame: follow the world with the loop levels and the score. */
  update(world: World, playing: boolean, threat: Threat) {
    if (!this.started || !this.eng.ctx) return;
    const now = this.eng.ctx.currentTime;
    const alive = world.drones.filter((d) => d.alive && d.state !== "charging").length;
    const burning = world.history.length ? world.history[world.history.length - 1].burning : world.env.burningCount();
    const live = playing && !world.finished ? 1 : 0;
    const set = (name: string, v: number) => {
      const l = this.loops.get(name)!;
      if (Math.abs(l.target - v) > 0.004) {
        l.target = v;
        l.gain.gain.setTargetAtTime(v, now, 0.25);
      }
    };
    set("rotor", live * Math.min(0.5, 0.1 + alive * 0.035));
    set("fire", live * Math.min(0.9, Math.sqrt(burning) / 16));
    set("wind", live * world.env.wind.speed * 0.35);

    // Fire crackle: random pops whose rate follows the size of the fire.
    if (live && burning > 0 && Math.random() < Math.min(0.5, burning / 400)) {
      this.eng.noiseBurst(this.eng.buses.effects, { dur: 0.03 + Math.random() * 0.05, type: "highpass", freq: 1800 + Math.random() * 3000, gain: 0.05 + Math.random() * 0.12 });
    }

    if (threat !== this.threat) {
      this.threat = threat;
      for (const [name, g] of this.stems) g.gain.setTargetAtTime(name === threat ? 1 : 0, now, 0.9); // crossfade
    }
  }

  /** One-shots driven by the event stream. */
  onEvent(e: SimEvent) {
    if (!this.started || !this.eng.on || !this.eng.busOn("effects")) return;
    const ctx = this.eng.ctx!;
    if (e.type === "waterDrop") {
      if (ctx.currentTime - this.lastSplash < 0.12) return; // at high speed many drops land per frame
      this.lastSplash = ctx.currentTime;
      this.oneShot("splash", () => this.eng.noiseBurst(this.eng.buses.effects, { dur: 0.35, type: "bandpass", freq: 2400, freqEnd: 500, q: 0.7, gain: 0.5 }));
      if (e.hitFire) this.oneShot("steam", () => this.eng.noiseBurst(this.eng.buses.effects, { at: ctx.currentTime + 0.08, dur: 0.9, type: "highpass", freq: 3500, gain: 0.25, attack: 0.05 }));
    } else if (e.type === "droneCrashed") {
      this.oneShot("crash", () => {
        this.eng.noiseBurst(this.eng.buses.effects, { dur: 0.8, type: "lowpass", freq: 3000, freqEnd: 120, gain: 0.9 });
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(110, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + 0.5);
        g.gain.setValueAtTime(0.7, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
        o.connect(g).connect(this.eng.buses.effects);
        o.start();
        o.stop(ctx.currentTime + 0.65);
      });
    }
  }

  /** Radio squelch (also used by the voice layer before and after a transmission). */
  squelch(dest: AudioNode = this.eng.buses.voices, at?: number) {
    if (!this.eng.on) return;
    this.eng.noiseBurst(dest, { at, dur: 0.09, type: "highpass", freq: 2200, gain: 0.18 });
  }

  private oneShot(name: string, synth: () => void) {
    const file = this.eng.manifest.sfx[name];
    if (!file) return synth();
    void this.eng.load(file).then((buf) => {
      if (!buf || !this.eng.on) return synth();
      const src = this.eng.ctx!.createBufferSource();
      src.buffer = buf;
      src.connect(this.eng.buses.effects);
      src.start();
    });
  }
}
