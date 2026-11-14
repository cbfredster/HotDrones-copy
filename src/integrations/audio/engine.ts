// Web Audio plumbing shared by the voices, effects, score and the swarm's own music.
// Browsers only allow sound after a user gesture, so nothing exists until unlock() is called
// from the Sound button.

export interface Manifest {
  /** key -> path under /audio/, written by `npm run audio:generate`. */
  sfx: Record<string, string>;
  music: Record<string, string>;
  radio: Record<string, string>;
}
const EMPTY: Manifest = { sfx: {}, music: {}, radio: {} };

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  buses!: { voices: GainNode; effects: GainNode; swarm: GainNode; score: GainNode };
  manifest: Manifest = EMPTY;
  noise!: AudioBuffer;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private volume = 0.7;
  private enabled = { voices: true, effects: true, swarm: true, score: true };

  get on() {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Must be called from a click / key handler. Safe to call again. */
  async unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      const limiter = ctx.createDynamicsCompressor(); // keeps a busy moment from clipping
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(limiter).connect(ctx.destination);
      const bus = (v: number) => {
        const g = ctx.createGain();
        g.gain.value = v;
        g.connect(this.master);
        return g;
      };
      this.buses = { voices: bus(1), effects: bus(0.8), swarm: bus(0.55), score: bus(0.5) };
      for (const k of Object.keys(this.enabled) as (keyof typeof this.enabled)[]) this.setBus(k, this.enabled[k]);
      // Two seconds of white noise: the raw material for fire, wind, splashes and radio static.
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1; // cosmetic only: not the sim's RNG
      try {
        const r = await fetch("/audio/manifest.json");
        if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) this.manifest = { ...EMPTY, ...(await r.json()) };
      } catch {
        /* no generated audio: everything is synthesised */
      }
    }
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
  }

  suspend() {
    void this.ctx?.suspend();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setBus(name: keyof AudioEngine["buses"], on: boolean) {
    this.enabled[name] = on;
    if (!this.ctx) return;
    const level = { voices: 1, effects: 0.8, swarm: 0.55, score: 0.5 }[name];
    this.buses[name].gain.setTargetAtTime(on ? level : 0, this.ctx.currentTime, 0.08);
  }
  busOn(name: keyof AudioEngine["buses"]) {
    return this.enabled[name];
  }

  /** Load and decode a file under /audio/ once; null if it is missing or broken. */
  load(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      p = (async () => {
        try {
          const r = await fetch("/audio/" + path);
          if (!r.ok) return null;
          return await this.ctx!.decodeAudioData(await r.arrayBuffer());
        } catch {
          return null;
        }
      })();
      this.buffers.set(path, p);
    }
    return p;
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer | null> {
    try {
      return await this.ctx!.decodeAudioData(data);
    } catch {
      return null;
    }
  }

  /** A burst of filtered noise with an envelope: the building block of the synthesised effects. */
  noiseBurst(dest: AudioNode, opts: { at?: number; dur: number; type: BiquadFilterType; freq: number; freqEnd?: number; q?: number; gain: number; attack?: number }) {
    const ctx = this.ctx!;
    const t = opts.at ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random() * 1.5;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, src.loopStart);
    src.stop(t + opts.dur + 0.05);
  }
}
