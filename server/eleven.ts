// ElevenLabs: voices (text to speech), speech to text for push-to-talk, and the generators
// used by `npm run audio:generate` (sound effects and music).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { env, type IntegrationStatus } from "./env";
import { DEFAULT_CAST, accountCast, isDelivery, isVoiceRole, speechDelivery, type Delivery } from "../src/integrations/audio/profiles";

interface Cast { dispatcher: string; drones: string[] }
interface SpeechConfig { model: string; dispatcher?: string; drones: string[] }

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
  private pending = new Map<string, Promise<Buffer>>();
  private cast: Cast | null = null;
  private casting: Promise<Cast> | null = null;
  private lastError = "";
  private active = 0;
  private spoken = 0;
  private cacheHits = 0;

  /** `cacheDir`: generated speech is kept on disk, so a repeated line costs nothing and works offline. */
  constructor(key: string | undefined, private cacheDir: string, private speech: SpeechConfig = {
    model: env.elevenTtsModel,
    dispatcher: env.elevenDispatcherVoice,
    drones: [...env.elevenDroneVoices],
  }) {
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

  /** Prefer a stable cast of included voices; explicit .env overrides always win. */
  async voiceIds() {
    if (this.cast) return this.cast;
    if (this.casting) return this.casting;
    this.casting = this.resolveCast();
    try {
      return this.cast = await this.casting;
    } finally {
      this.casting = null;
    }
  }

  private async resolveCast(): Promise<Cast> {
    if (this.speech.dispatcher && this.speech.drones.length) return { dispatcher: this.speech.dispatcher, drones: [...this.speech.drones] };
    let selected: Cast = { dispatcher: DEFAULT_CAST.dispatcher.id, drones: DEFAULT_CAST.drones.map((v) => v.id) };
    if (this.client) {
      const res = await this.client.voices.search({ pageSize: 100 }, { timeoutInSeconds: 5, maxRetries: 0 });
      selected = accountCast(res.voices ?? []);
    }
    return { dispatcher: this.speech.dispatcher ?? selected.dispatcher, drones: this.speech.drones.length ? [...this.speech.drones] : selected.drones };
  }

  private async request(text: string, voice: string, delivery: Delivery) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!clean) throw new Error("nothing to say");
    if (!isVoiceRole(voice) || !isDelivery(delivery)) throw new Error("invalid voice or delivery");
    const cast = await this.voiceIds();
    const n = /^drone:(\d+)$/.exec(voice);
    const voiceId = n ? cast.drones[Number(n[1]) % cast.drones.length] : cast.dispatcher;
    if (!voiceId) throw new Error("no voice configured");
    return { voiceId, body: { ...speechDelivery(clean, delivery, this.speech.model), modelId: this.speech.model, outputFormat: "mp3_44100_128" as const } };
  }

  /** Also used in generated filenames: changing voice, delivery or model invalidates old audio. */
  async speechKey(text: string, voice: string, delivery: Delivery = "calm") {
    return createHash("sha256").update(JSON.stringify(await this.request(text, voice, delivery))).digest("hex").slice(0, 24);
  }

  async speak(text: string, voice: string, delivery: Delivery = "calm"): Promise<Buffer> {
    const key = await this.speechKey(text, voice, delivery);
    const file = join(this.cacheDir, key + ".mp3");
    if (existsSync(file)) {
      this.cacheHits++;
      return readFileSync(file);
    }
    const pending = this.pending.get(key);
    if (pending) return pending; // identical requests share one generation and one credit charge
    if (!this.client) throw new Error("ElevenLabs is not configured");
    if (this.active >= 3) throw new Error("busy"); // never queue up behind a slow network
    const job = this.generate(text, voice, delivery, file);
    this.pending.set(key, job);
    try {
      return await job;
    } finally {
      this.pending.delete(key);
    }
  }

  private async generate(text: string, voice: string, delivery: Delivery, file: string) {
    this.active++;
    try {
      const { voiceId, body } = await this.request(text, voice, delivery);
      const stream = await this.client!.textToSpeech.convert(voiceId, body, { timeoutInSeconds: 8, maxRetries: 0, abortSignal: AbortSignal.timeout(8000) });
      const audio = await collect(stream);
      if (!audio.length) throw new Error("empty speech response");
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
      const res: any = await this.client.speechToText.convert({ modelId: env.elevenSttModel, file: new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), languageCode: "en" }, { timeoutInSeconds: 18, maxRetries: 0 });
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
