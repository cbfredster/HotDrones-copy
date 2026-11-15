// Generates the demo's audio with ElevenLabs and writes it to public/audio/, to be COMMITTED
// so the demo needs no network:
//   sfx/    rotor, fire, wind (loops); splash, steam, crash, squelch   (Sound Effects API)
//   music/  calm, tense, critical, victory, defeat stems               (Music API)
//   radio/  every drone's radio calls and the dispatcher's alerts      (Text to Speech)
//   manifest.json   what exists; the browser reads this and synthesises anything missing
//
// Usage: npm run audio:generate -- [--only sfx|music|radio] [--drones 10] [--force]
// Needs ELEVENLABS_API_KEY in .env. Existing files are kept unless --force is given, so it
// is safe to re-run after a failure or to add more drones.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Eleven } from "../server/eleven";
import { env } from "../server/env";
import { ALERTS, ALERT_DELIVERY, DRONE_CALLS, RADIO_CHECK, alertClip, droneClip, droneDelivery, droneLine, type Alert } from "../src/integrations/lines";
import type { Delivery, VoiceRole } from "../src/integrations/audio/profiles";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ONLY = option("--only");
const DRONES = Math.max(1, Math.min(16, Number(option("--drones")) || 10));
const FORCE = args.includes("--force");
const OUT = "public/audio";
const radio: Record<string, string> = {};
try {
  const previous = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
  for (const [key, path] of Object.entries(previous.radio ?? {})) {
    if (typeof path === "string" && existsSync(join(OUT, path))) radio[key] = path;
  }
} catch { /* first generation */ }

const SFX: Record<string, { prompt: string; seconds: number; loop: boolean }> = {
  rotor: { prompt: "Steady buzzing hum of several small quadcopter drones hovering, continuous, no voices", seconds: 8, loop: true },
  fire: { prompt: "Forest wildfire burning, roaring flames and crackling wood, continuous", seconds: 10, loop: true },
  wind: { prompt: "Steady wind blowing across open hills, continuous, no birds", seconds: 10, loop: true },
  splash: { prompt: "A bucket of water dumped from the air splashing onto the ground, short", seconds: 1.5, loop: false },
  steam: { prompt: "Water hitting hot embers, loud hiss of steam, short", seconds: 2, loop: false },
  crash: { prompt: "Small drone crashing into the ground, plastic and metal impact with electrical fizz", seconds: 2, loop: false },
  squelch: { prompt: "Two-way radio squelch click and short burst of static", seconds: 0.5, loop: false },
};
const MUSIC: Record<string, { prompt: string; seconds: number }> = {
  calm: { prompt: "Calm, watchful ambient electronic underscore, soft pads and a slow pulse, minimal, loopable, D minor, 104 bpm", seconds: 30 },
  tense: { prompt: "Tense electronic underscore, pulsing synth bass and ticking percussion, building unease, loopable, D minor, 104 bpm", seconds: 30 },
  critical: { prompt: "Urgent, driving electronic action underscore, heavy drums, alarm-like synth stabs, high stakes, loopable, D minor, 104 bpm", seconds: 30 },
  victory: { prompt: "Short triumphant, relieved orchestral-electronic resolution, warm major chords, hopeful ending", seconds: 12 },
  defeat: { prompt: "Short sombre, mournful ending, low strings and a fading piano, loss", seconds: 12 },
};

if (!env.elevenKey) {
  console.error("Set ELEVENLABS_API_KEY in .env first (see .env.example).");
  process.exit(1);
}
const eleven = new Eleven(env.elevenKey, "data/tts-cache");
for (const d of ["sfx", "music", "radio"]) mkdirSync(join(OUT, d), { recursive: true });

let made = 0;
let failed = 0;
async function make(path: string, generate: () => Promise<Buffer>) {
  const file = join(OUT, path);
  if (existsSync(file) && !FORCE) return;
  try {
    const audio = await generate();
    if (audio.length < 500) throw new Error("empty audio");
    writeFileSync(file, audio);
    made++;
    console.log(`  made ${path} (${(audio.length / 1024).toFixed(0)} kB)`);
  } catch (e: any) {
    failed++;
    console.warn(`  FAILED ${path}: ${String(e.message ?? e).slice(0, 160)}`);
  }
}

async function makeRadio(key: string, text: string, voice: VoiceRole, delivery: Delivery) {
  // Fingerprinted filenames refresh the browser cache and never silently reuse an old cast.
  const path = `radio/${key}-${await eleven.speechKey(text, voice, delivery)}.mp3`;
  delete radio[key];
  await make(path, () => eleven.speak(text, voice, delivery));
  if (existsSync(join(OUT, path))) radio[key] = path;
}

if (!ONLY || ONLY === "sfx") {
  console.log("Sound effects");
  for (const [name, s] of Object.entries(SFX)) await make(`sfx/${name}.mp3`, () => eleven.soundEffect(s.prompt, s.seconds, s.loop));
}
if (!ONLY || ONLY === "music") {
  console.log("Music stems");
  for (const [name, m] of Object.entries(MUSIC)) await make(`music/${name}.mp3`, () => eleven.music(m.prompt, m.seconds));
}
if (!ONLY || ONLY === "radio") {
  console.log(`Radio calls for ${DRONES} drones, and the dispatcher's alerts`);
  const voices = await eleven.voiceIds();
  console.log(`  dispatcher voice ${voices.dispatcher}; drone voices ${voices.drones.join(", ")}`);
  for (let id = 0; id < DRONES; id++) {
    for (const call of DRONE_CALLS) await makeRadio(droneClip(id, call), droneLine(id, call), `drone:${id}`, droneDelivery(call));
  }
  for (const a of Object.keys(ALERTS) as Alert[]) await makeRadio(alertClip(a), ALERTS[a], "dispatcher", ALERT_DELIVERY[a]);
  for (const line of RADIO_CHECK) await makeRadio(line.clip, line.text, line.voice, line.delivery);
}

// The manifest lists what is actually on disk, so a partial run is still usable.
const list = (dir: string) =>
  Object.fromEntries(
    readdirSync(join(OUT, dir))
      .filter((f) => f.endsWith(".mp3"))
      .sort()
      .map((f) => [f.replace(/\.mp3$/, ""), `${dir}/${f}`]),
  );
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ sfx: list("sfx"), music: list("music"), radio }, null, 1) + "\n");
console.log(`\n${made} file(s) generated, ${failed} failed. Wrote ${OUT}/manifest.json.`);
console.log("Commit public/audio so the demo plays without a network:  git add public/audio && git commit -m \"Generated audio\"");
process.exit(failed ? 1 : 0);
