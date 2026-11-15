// Secrets and settings. Only the server (and Node scripts) read these; nothing here is ever
// bundled into the browser. Every integration is OFF when its key is missing.
import { config } from "dotenv";

config({ quiet: true } as any); // loads .env from the working directory if it exists

const get = (k: string) => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};
const droneVoices = (get("ELEVENLABS_DRONE_VOICES") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const env = {
  port: Number(get("PORT")) || 8787,
  /** Tiger Cloud (Postgres + TimescaleDB) connection string. */
  tigerUrl: get("TIGER_DATABASE_URL") ?? get("DATABASE_URL"),
  geminiKey: get("GEMINI_API_KEY"),
  /** `gemini-flash-latest` is Google's alias for the newest Flash model; pin one with GEMINI_MODEL if you prefer. */
  geminiModel: get("GEMINI_MODEL") ?? "gemini-flash-latest",
  elevenKey: get("ELEVENLABS_API_KEY"),
  elevenTtsModel: get("ELEVENLABS_TTS_MODEL") ?? "eleven_flash_v2_5",
  elevenSttModel: get("ELEVENLABS_STT_MODEL") ?? "scribe_v1",
  /** Empty selects a stable cast from voices included in the account. */
  elevenDispatcherVoice: get("ELEVENLABS_DISPATCHER_VOICE"),
  elevenDroneVoices: droneVoices,
  mongoUrl: get("MONGODB_URI"),
  mongoDb: get("MONGODB_DB") ?? "hotdrones",
};

export type IntegrationName = "tiger" | "gemini" | "elevenlabs" | "mongo";
export interface IntegrationStatus {
  on: boolean;
  detail: string;
}
