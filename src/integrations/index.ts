// The integration layer. main.ts calls four hooks (onRun, afterTick, afterJudge, frame) and
// everything else hangs off the one event stream derived in events.ts:
//
//   world --diff--> events --> radio log, voices (ElevenLabs), commander (Gemini),
//                              telemetry (Tiger Data), effects + score + swarm music
//
// Ground rules kept here: integrations only READ the world; the only writes are judge
// actions through the `judge` function main.ts hands in (which records them); and no network
// call is ever awaited by the sim loop.
import type { Config } from "../sim/config";
import type { JudgeAction, RecordedAction } from "../sim/judge";
import type { World } from "../sim/world";
import { $, input } from "../ui/dom";
import { api } from "./api";
import { Ambience, type Threat } from "./audio/ambience";
import { AudioEngine } from "./audio/engine";
import { SwarmMusic } from "./audio/swarm";
import { RadioVoice } from "./audio/voice";
import { Commander } from "./commander";
import { EventDeriver, sampleTelemetry, type RunInfo, type RunResult, type SimEvent, type TelemetrySample } from "./events";
import { RadioLog } from "./radio";
import { Scenarios } from "./scenarios";

const SAMPLE_EVERY_TICKS = 5; // telemetry rows are taken every 5 ticks...
const FLUSH_EVERY_MS = 1000; // ...and sent to the server about once a second
const SKIP_EVENTS = new Set<SimEvent["type"]>(["waterDrop"]); // too many to store; the visuals and sounds still use them

export interface Hooks {
  judge: (a: JudgeAction) => boolean;
  startRun: (cfg: Partial<Config>, actions?: RecordedAction[]) => void;
  getWorld: () => World;
}

export class Integrations {
  private deriver = new EventDeriver();
  private audio = new AudioEngine();
  private ambience = new Ambience(this.audio);
  private voice = new RadioVoice(this.audio, this.ambience);
  private swarm = new SwarmMusic(this.audio);
  private radio: RadioLog;
  private commander: Commander;
  private scenarios: Scenarios;
  private run: RunInfo | null = null;
  private samples: TelemetrySample[] = [];
  private events: SimEvent[] = [];
  private lastFlush = 0;
  private finishedSent = false;
  private threatened = false;
  private soundOn = false;

  constructor(private hooks: Hooks) {
    this.radio = new RadioLog($("radioLog"), (l) => this.voice.say(l));
    this.commander = new Commander({
      log: (e) => this.radio.add(e),
      speak: (l) => this.voice.say(l),
      judge: hooks.judge,
      chips: $("chips"),
      tag: $("commanderTag"),
      onReport: (text, source) => {
        const el = $("endReport");
        el.hidden = false;
        el.innerHTML = "";
        const b = document.createElement("b");
        b.textContent = `After-action report · ${source}`;
        el.append(b, text);
      },
    });
    this.scenarios = new Scenarios(hooks);
    api.startStatus($("integrations"));
    this.wireUi();
  }

  /** `?scenario=<id>` in the URL: load and replay it. Returns false if there is none to load. */
  loadScenarioFromUrl() {
    return this.scenarios.loadFromUrl();
  }

  // ---------------------------------------------------------------- hooks from main.ts
  onRun(world: World) {
    this.flush(); // whatever is left of the previous run
    this.run = {
      runId: crypto.randomUUID(),
      startedAt: Date.now(),
      source: "live",
      seed: world.cfg.seed,
      mode: world.cfg.mode,
      commsRange: world.cfg.commsRange,
      drones: world.drones.length,
      config: { ...world.initialCfg },
    };
    this.samples = [];
    this.events = [];
    this.finishedSent = false;
    this.threatened = false;
    this.radio.clear();
    this.voice.clear();
    $("endReport").hidden = true;
    this.commander.onRun(world);
    this.swarm.setWorld(world);
    this.scenarios.onRun();
    this.dispatch(world, this.deriver.poll(world));
  }

  afterTick(world: World) {
    this.dispatch(world, this.deriver.poll(world));
    if (world.tick % SAMPLE_EVERY_TICKS === 0 && this.samples.length < 400) this.samples.push(sampleTelemetry(world, true));
  }

  /** A judge action was applied (possibly while paused): pick up its event straight away. */
  afterJudge(world: World) {
    this.dispatch(world, this.deriver.poll(world));
  }

  frame(world: World, playing: boolean) {
    const now = performance.now();
    if (now - this.lastFlush > FLUSH_EVERY_MS) {
      this.lastFlush = now;
      this.flush();
    }
    this.commander.frame(world, playing);
    this.swarm.setPlaying(playing);
    if (this.soundOn) this.ambience.update(world, playing, this.threat(world));
  }

  // ---------------------------------------------------------------- the stream
  private dispatch(world: World, events: SimEvent[]) {
    this.commander.onTick(world, events);
    for (const e of events) {
      this.radio.onEvent(e);
      this.ambience.onEvent(e);
      if (e.type === "villageThreatened") this.threatened = true;
      if (!SKIP_EVENTS.has(e.type) && this.events.length < 400) this.events.push(e);
      if (e.type === "runFinished" && !this.finishedSent) {
        this.finishedSent = true;
        const m = world.metrics();
        const result: RunResult = { ticks: m.tick, burnt: m.burnt, villageLost: m.villageLost, dronesLost: m.dronesLost, waterDropped: m.waterDropped, extinguishedAt: m.extinguishedAt };
        this.samples.push(sampleTelemetry(world, true));
        this.flush(result);
        void this.commander.report(world, this.run!, result);
      }
    }
  }

  /** Send what has accumulated. Fire-and-forget: a lost batch is fine, a blocked tick is not. */
  private flush(result?: RunResult) {
    if (!this.run || (!this.samples.length && !this.events.length && !result)) return;
    api.send("/api/telemetry", { run: this.run, samples: this.samples, events: this.events, result });
    this.samples = [];
    this.events = [];
  }

  private threat(world: World): Threat {
    if (world.env.villageLost) return "defeat";
    if (world.extinguishedAt >= 0) return "victory";
    if (this.threatened) return "critical";
    const burning = world.history.length ? world.history[world.history.length - 1].burning : 0;
    return burning > 60 || !world.baseOnline ? "tense" : "calm";
  }

  // ---------------------------------------------------------------- UI
  private wireUi() {
    const toggle = $("soundToggle");
    const setSound = async (on: boolean) => {
      this.soundOn = on;
      if (on) {
        await this.audio.unlock();
        await this.ambience.start();
        this.swarm.start();
        this.swarm.setWorld(this.hooks.getWorld());
        $("soundHint").textContent = this.ambience.hasScore
          ? "Each drone is a note; a group that loses contact drifts out of time until it reconnects."
          : "Each drone is a note; a group that loses contact drifts out of time until it reconnects. (No generated score in public/audio yet, so effects are synthesised.)";
      } else {
        this.audio.suspend();
        if ("speechSynthesis" in window) speechSynthesis.cancel();
        this.voice.clear();
        $("soundHint").innerHTML = "Sound is off. Press <kbd>M</kbd> or the button in the header.";
      }
      toggle.textContent = on ? "Sound on" : "Sound off";
      toggle.classList.toggle("on", on);
    };
    toggle.onclick = () => void setSound(!this.soundOn);
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) void setSound(!this.soundOn);
    });
    for (const [id, bus] of [["sndVoices", "voices"], ["sndSwarm", "swarm"], ["sndEffects", "effects"], ["sndStems", "score"]] as const) {
      input(id).onchange = () => {
        this.audio.setBus(bus, input(id).checked);
        if (bus === "voices" && !input(id).checked) {
          this.voice.clear();
          if ("speechSynthesis" in window) speechSynthesis.cancel();
        }
      };
    }
    input("sndVolume").oninput = () => this.audio.setVolume(Number(input("sndVolume").value) / 100);

    // Commander: typed commands...
    $<HTMLFormElement>("commandForm").onsubmit = (e) => {
      e.preventDefault();
      const box = input("commandText");
      const text = box.value;
      box.value = "";
      void this.commander.command(text);
    };
    // ...and push-to-talk.
    this.wireMic($<HTMLButtonElement>("micButton"));
  }

  /** Hold the Mic button to talk. ElevenLabs speech-to-text if connected, else the browser's recogniser. */
  private wireMic(btn: HTMLButtonElement) {
    const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    let recorder: MediaRecorder | null = null;
    let recognition: any = null;
    const heard = (text: string) => {
      if (text.trim()) void this.commander.command(text.trim());
    };
    const note = (text: string) => this.radio.add({ tick: this.hooks.getWorld().tick, who: "SYS", kind: "sys", text });

    let held = false;
    const start = async () => {
      if (recorder || recognition) return;
      held = true;
      btn.classList.add("rec");
      if (api.on("elevenlabs") && navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks: Blob[] = [];
          const rec = new MediaRecorder(stream);
          recorder = rec;
          rec.ondataavailable = (e) => chunks.push(e.data);
          rec.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
            if (blob.size < 1500) return;
            try {
              const r = await fetch("/api/stt", { method: "POST", headers: { "content-type": blob.type }, body: blob, signal: AbortSignal.timeout(20000) });
              if (r.ok) heard((await r.json()).text ?? "");
              else note("Could not transcribe that.");
            } catch {
              note("Could not transcribe that.");
            }
          };
          rec.start();
          if (!held) stop(); // released before the microphone was ready
          return;
        } catch {
          recorder = null;
          note("Microphone not available.");
        }
      } else if (SR) {
        try {
          recognition = new SR();
          recognition.lang = "en-GB";
          recognition.onresult = (e: any) => heard(e.results[0][0].transcript);
          recognition.onend = () => {
            recognition = null;
            btn.classList.remove("rec");
          };
          recognition.onerror = () => note("Could not hear that.");
          recognition.start();
          return;
        } catch {
          recognition = null;
        }
      } else note("Voice commands need ElevenLabs connected, or a browser with speech recognition. Type the command instead.");
      btn.classList.remove("rec");
    };
    const stop = () => {
      held = false;
      btn.classList.remove("rec");
      if (recorder) {
        if (recorder.state !== "inactive") recorder.stop();
        recorder = null;
      }
      recognition?.stop();
    };
    btn.addEventListener("pointerdown", () => void start());
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
  }
}
