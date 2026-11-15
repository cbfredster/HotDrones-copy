// One radio channel, with cancellable loading/playback and explicit audio provenance.
import { api } from "../api";
import type { Ambience } from "./ambience";
import type { AudioEngine } from "./engine";
import type { Delivery, VoiceRole } from "./profiles";

export interface Line {
  voice: VoiceRole;
  text: string;
  clip?: string;
  priority: number;
  delivery?: Delivery;
  /** A newer state replaces pending reports for the same topic. */
  key?: string;
}

export type VoiceSource = "ElevenLabs clip" | "ElevenLabs live" | "Browser voice";
export interface RadioState {
  phase: "idle" | "preparing" | "speaking" | "listening";
  line?: Line;
  source?: VoiceSource;
}

interface Queued extends Line {
  queuedAt: number;
}

interface Transmission {
  line: Queued;
  controller: AbortController;
}

/** Stop waiting immediately, even if decoding or a shared clip fetch cannot be cancelled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class RadioVoice {
  private queue: Queued[] = [];
  private busy = false;
  private listening = false;
  private current: Transmission | null = null;
  private chain: AudioNode | null = null;

  constructor(private eng: AudioEngine, private ambience: Ambience, private onState: (state: RadioState) => void = () => {}) {}

  say(line: Line) {
    if (!this.eng.on || !this.eng.busOn("voices")) return;
    const same = (other: Line) => other.voice === line.voice && other.text === line.text;
    if (this.queue.some(same) || (this.current && !this.current.controller.signal.aborted && same(this.current.line))) return;
    if (line.key) this.queue = this.queue.filter((q) => q.key !== line.key);
    if (line.priority >= 3) this.queue = this.queue.filter((q) => q.priority >= 2 && q.key !== "sitrep");
    if (this.queue.length >= 4 && line.priority < 2) return;
    this.queue.push({ ...line, queuedAt: performance.now() });
    this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    this.queue = this.queue.slice(0, 6);
    const current = this.current;
    if (current && ((line.priority >= 3 && line.priority > current.line.priority) || (line.key && line.key === current.line.key))) {
      current.controller.abort();
    }
    void this.pump();
  }

  /** Reset/mute stops both an in-flight request and the currently audible transmission. */
  clear() {
    this.queue = [];
    this.current?.controller.abort();
    this.eng.setVoiceActive(false);
    this.onState({ phase: this.listening ? "listening" : "idle" });
  }

  /** Keep our own audio out of push-to-talk recordings. */
  setListening(on: boolean) {
    this.listening = on;
    if (on) this.current?.controller.abort();
    this.eng.setListening(on);
    this.onState({ phase: on ? "listening" : "idle" });
    if (!on) void this.pump();
  }

  /** A gentle radio colour, preserving more consonants and character than telephone bandwidth. */
  private radioChain(): AudioNode {
    if (this.chain) return this.chain;
    const ctx = this.eng.ctx!;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 180;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5800;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(1.15 * (i - 128) / 128) / Math.tanh(1.15);
    shaper.curve = curve;
    hp.connect(lp).connect(shaper).connect(this.eng.buses.voices);
    this.chain = hp;
    return hp;
  }

  private expired(line: Queued) {
    return performance.now() - line.queuedAt > (line.priority >= 2 ? 20000 : 7000);
  }

  private async pump() {
    if (this.busy || this.listening) return;
    this.busy = true;
    try {
      while (!this.listening) {
        const line = this.queue.shift();
        if (!line) break;
        if (this.expired(line) || !this.eng.on || !this.eng.busOn("voices")) continue;
        const controller = new AbortController();
        const { signal } = controller;
        this.current = { line, controller };
        this.onState({ phase: "preparing", line });
        try {
          const audio = await untilAborted(this.fetchAudio(line, signal), signal);
          // A reset, mute or urgent interruption must never revive this line after loading.
          if (signal.aborted || this.listening || this.expired(line) || !this.eng.on || !this.eng.busOn("voices")) continue;
          this.eng.setVoiceActive(true);
          this.onState({ phase: "speaking", line, source: audio?.source ?? "Browser voice" });
          if (audio) await this.playBuffer(audio.buffer, signal);
          else await this.speakWithBrowser(line, signal);
        } catch {
          // A broken audio device or decode must not wedge the radio channel.
        } finally {
          this.eng.setVoiceActive(false);
          this.current = null;
        }
      }
    } finally {
      this.busy = false;
      this.onState({ phase: this.listening ? "listening" : "idle" });
    }
  }

  private async fetchAudio(line: Line, signal: AbortSignal): Promise<{ buffer: AudioBuffer; source: VoiceSource } | null> {
    const file = line.clip ? this.eng.manifest.radio[line.clip] : undefined;
    if (file) {
      const buffer = await this.eng.load(file);
      if (buffer) return { buffer, source: "ElevenLabs clip" };
    }
    if (signal.aborted || !api.on("elevenlabs")) return null;
    const r = await api.post("/api/tts", { text: line.text, voice: line.voice, delivery: line.delivery ?? "calm" }, 9000, signal);
    if (!r || signal.aborted) return null;
    try {
      const buffer = await this.eng.decode(await r.arrayBuffer());
      return buffer ? { buffer, source: "ElevenLabs live" } : null;
    } catch {
      return null;
    }
  }

  private playBuffer(buf: AudioBuffer, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const ctx = this.eng.ctx!;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.radioChain());
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.eng.noise;
      hiss.loop = true;
      const hf = ctx.createBiquadFilter();
      hf.type = "bandpass";
      hf.frequency.value = 1800;
      const hg = ctx.createGain();
      hg.gain.value = 0.008;
      hiss.connect(hf).connect(hg).connect(this.eng.buses.voices);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        src.onended = null;
        try { src.stop(); } catch { /* already stopped */ }
        try { hiss.stop(); } catch { /* already stopped */ }
        src.disconnect();
        hiss.disconnect();
        hf.disconnect();
        hg.disconnect();
        if (!signal.aborted) this.ambience.squelch();
        resolve();
      };
      const timer = setTimeout(finish, (buf.duration + 1) * 1000);
      signal.addEventListener("abort", finish, { once: true });
      src.onended = finish;
      this.ambience.squelch();
      const t = ctx.currentTime + 0.09;
      src.start(t);
      hiss.start(t);
      hiss.stop(t + buf.duration);
    });
  }

  /** An explicitly labelled fallback; cancellable just like generated audio. */
  private speakWithBrowser(line: Line, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || !("speechSynthesis" in window)) return resolve();
      const synth = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(line.text);
      const n = /^drone:(\d+)$/.exec(line.voice);
      const voices = synth.getVoices().filter((v) => v.lang.startsWith("en"));
      u.voice = voices.length ? voices[n ? (Number(n[1]) + 1) % voices.length : 0] : null;
      u.rate = line.delivery === "urgent" ? 1.12 : 1.02;
      u.pitch = n ? 0.9 + (Number(n[1]) % 3) * 0.12 : 1;
      u.volume = this.eng.voiceVolume;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        u.onend = u.onerror = null;
        synth.cancel();
        if (!signal.aborted) this.ambience.squelch();
        resolve();
      };
      const timer = setTimeout(finish, 20000);
      signal.addEventListener("abort", finish, { once: true });
      u.onend = u.onerror = finish;
      this.ambience.squelch();
      synth.speak(u);
    });
  }
}
