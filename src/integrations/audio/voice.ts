// Radio voices. One transmission at a time, played through a radio filter (band-pass, a
// little grit, static and a squelch click at each end).
//
// Where a line's audio comes from, in order:
//   1. a pre-generated clip in public/audio/radio (drone calls: made once by
//      `npm run audio:generate`, committed, so they need no network at the demo);
//   2. ElevenLabs text-to-speech through the server (Gemini's sitreps; cached on the server);
//   3. the browser's own speech synthesis, if neither is available.
import { api } from "../api";
import type { Ambience } from "./ambience";
import type { AudioEngine } from "./engine";

export interface Line {
  voice: "dispatcher" | `drone:${number}`;
  text: string;
  /** Key of a pre-generated clip, e.g. "d3-lowBattery". */
  clip?: string;
  /** Higher plays first. Sitreps and alerts outrank routine drone calls. */
  priority: number;
}

interface Queued extends Line {
  queuedAt: number;
}

const MAX_WAIT_MS = 7000; // a routine call that has waited this long is old news: drop it

export class RadioVoice {
  private queue: Queued[] = [];
  private busy = false;
  private chain: AudioNode | null = null;

  constructor(private eng: AudioEngine, private ambience: Ambience) {}

  say(line: Line) {
    if (!this.eng.on || !this.eng.busOn("voices")) return;
    if (this.queue.length >= 4 && line.priority < 2) return; // never build a backlog of chatter
    this.queue.push({ ...line, queuedAt: performance.now() });
    this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    void this.pump();
  }

  clear() {
    this.queue = [];
  }

  /** source -> band-pass -> soft clipping -> voices bus. Built once. */
  private radioChain(): AudioNode {
    if (this.chain) return this.chain;
    const ctx = this.eng.ctx!;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 420;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2900;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = (i - 128) / 128;
      curve[i] = Math.tanh(2.6 * x);
    }
    shaper.curve = curve;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    hp.connect(lp).connect(shaper).connect(out).connect(this.eng.buses.voices);
    this.chain = hp;
    return hp;
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const line = this.queue.shift();
        if (!line) break;
        if (line.priority < 2 && performance.now() - line.queuedAt > MAX_WAIT_MS) continue;
        if (!this.eng.on || !this.eng.busOn("voices")) continue;
        const buf = await this.fetchAudio(line);
        if (buf) await this.playBuffer(buf);
        else await this.speakWithBrowser(line);
      }
    } finally {
      this.busy = false;
    }
  }

  private async fetchAudio(line: Line): Promise<AudioBuffer | null> {
    const file = line.clip ? this.eng.manifest.radio[line.clip] : undefined;
    if (file) {
      const buf = await this.eng.load(file);
      if (buf) return buf;
    }
    if (!api.on("elevenlabs")) return null;
    const r = await api.post("/api/tts", { text: line.text, voice: line.voice }, 9000);
    if (!r) return null;
    try {
      return await this.eng.decode(await r.arrayBuffer());
    } catch {
      return null;
    }
  }

  private playBuffer(buf: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const ctx = this.eng.ctx!;
      const t = ctx.currentTime + 0.1;
      this.ambience.squelch(this.eng.buses.voices, t - 0.09);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.radioChain());
      // Static under the voice.
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.eng.noise;
      hiss.loop = true;
      const hf = ctx.createBiquadFilter();
      hf.type = "bandpass";
      hf.frequency.value = 1800;
      const hg = ctx.createGain();
      hg.gain.value = 0.025;
      hiss.connect(hf).connect(hg).connect(this.eng.buses.voices);
      src.start(t);
      hiss.start(t);
      hiss.stop(t + buf.duration);
      this.ambience.squelch(this.eng.buses.voices, t + buf.duration);
      src.onended = () => setTimeout(resolve, 220);
      setTimeout(resolve, (buf.duration + 1.5) * 1000); // in case onended never fires
    });
  }

  /** Last resort: the browser's built-in voice (no radio filter is possible on it). */
  private speakWithBrowser(line: Line): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      this.ambience.squelch();
      const u = new SpeechSynthesisUtterance(line.text);
      const n = /^drone:(\d+)$/.exec(line.voice);
      u.rate = 1.15;
      u.pitch = n ? 0.7 + (Number(n[1]) % 5) * 0.2 : 0.9;
      u.volume = 0.9;
      const done = () => {
        this.ambience.squelch();
        resolve();
      };
      u.onend = done;
      u.onerror = () => resolve();
      setTimeout(resolve, 12000);
      speechSynthesis.speak(u);
    });
  }
}
