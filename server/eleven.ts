// ElevenLabs: voices (text to speech), speech to text for push-to-talk, and the generators
// used by `npm run audio:generate` (sound effects and music).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { env, type IntegrationStatus } from "./env";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export class Eleven {
  readonly client: ElevenLabsClient | null;
  private voices: { dispatcher: string; drones: string[] } | null = null;
  private lastError = "";
  private active = 0;
  private spoken = 0;
  private cacheHits = 0;

  /** `cacheDir`: generated speech is kept on disk, so a repeated line costs nothing and works offline. */
  constructor(key: string | undefined, private cacheDir: string) {
    this.client = key ? new ElevenLabsClient({ apiKey: key }) : null;
    mkdirSync(cacheDir, { recursive: true });
  }

  get on() {
    return this.client !== null;
  }

  status(): IntegrationStatus {
    if (!this.client) return { on: false, detail: "no ELEVENLABS_API_KEY: pre-generated clips, the browser's own voice and synthesised effects are used instead" };
    return { on: true, detail: this.lastError ? `last error: ${this.lastError}` : `${this.spoken} lines generated, ${this.cacheHits} from cache` };
  }

  /** Dispatcher voice first, then the drone voices: from .env, else the first voices in the account. */
  async voiceIds() {
    if (this.voices) return this.voices;
    let pool: string[] = [];
    if (!env.elevenDispatcherVoice || env.elevenDroneVoices.length === 0) {
      const res = await this.client!.voices.search({ pageSize: 12 });
      pool = (res.voices ?? []).map((v) => v.voiceId).filter(Boolean);
      if (!pool.length) throw new Error("the ElevenLabs account has no voices; set ELEVENLABS_DISPATCHER_VOICE and ELEVENLABS_DRONE_VOICES");
    }
    const dispatcher = env.elevenDispatcherVoice ?? pool[0];
    const drones = env.elevenDroneVoices.length ? env.elevenDroneVoices : pool.slice(1, 5).length ? pool.slice(1, 5) : [pool[0]];
    this.voices = { dispatcher, drones };
    return this.voices;
  }

  /** `voice`: "dispatcher", or "drone:<n>" (drone n uses voice n mod the number of drone voices). */
  async speak(text: string, voice: string): Promise<Buffer> {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!clean) throw new Error("nothing to say");
    const file = join(this.cacheDir, createHash("sha1").update(`${voice}|${env.elevenTtsModel}|${clean}`).digest("hex") + ".mp3");
    if (existsSync(file)) {
      this.cacheHits++;
      return readFileSync(file);
    }
    if (!this.client) throw new Error("ElevenLabs is not configured");
    if (this.active >= 3) throw new Error("busy"); // never queue up behind a slow network
    this.active++;
    try {
      const ids = await this.voiceIds();
      const n = /^drone:(\d+)$/.exec(voice);
      const voiceId = n ? ids.drones[Number(n[1]) % ids.drones.length] : ids.dispatcher;
      const stream = await this.client.textToSpeech.convert(voiceId, { text: clean, modelId: env.elevenTtsModel, outputFormat: "mp3_44100_128" });
      const audio = await collect(stream);
      writeFileSync(file, audio);
      this.spoken++;
      this.lastError = "";
      return audio;
    } catch (e: any) {
      this.lastError = String(e.message ?? e).slice(0, 120);
      throw e;
    } finally {
      this.active--;
    }
  }

  /** Push-to-talk: a short recording in, text out. */
  async transcribe(audio: Buffer, mime: string): Promise<string> {
    if (!this.client) throw new Error("ElevenLabs is not configured");
    try {
      const res: any = await this.client.speechToText.convert({ modelId: env.elevenSttModel, file: new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), languageCode: "en" });
      this.lastError = "";
      return String(res?.text ?? "").trim();
    } catch (e: any) {
      this.lastError = String(e.message ?? e).slice(0, 120);
      throw e;
    }
  }

  // ---- generators for scripts/audio-generate.ts
  async soundEffect(prompt: string, seconds: number, loop: boolean): Promise<Buffer> {
    return collect(await this.client!.textToSoundEffects.convert({ text: prompt, durationSeconds: seconds, loop, promptInfluence: 0.5, outputFormat: "mp3_44100_128" }));
  }

  async music(prompt: string, seconds: number): Promise<Buffer> {
    return collect(await this.client!.music.compose({ prompt, musicLengthMs: Math.round(seconds * 1000), forceInstrumental: true, outputFormat: "mp3_44100_128" }));
  }
}
