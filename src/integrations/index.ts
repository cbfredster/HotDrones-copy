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
import { RadioVoice, type RadioState } from "./audio/voice";
import { RADIO_CHECK } from "./lines";
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
  private voice = new RadioVoice(this.audio, this.ambience, (state) => this.drawRadio(state));
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
  private soundRequest = 0;
  private cancelMic = () => {};

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
    this.cancelMic();
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
  private drawRadio(state: RadioState) {
    $("radioNow").dataset.phase = state.phase;
    const n = state.line ? /^drone:(\d+)$/.exec(state.line.voice) : null;
    $("radioSpeaker").textContent = state.phase === "listening" ? "Listening to you" : state.line ? n ? `Drone ${n[1]}` : "Dispatcher" : "Channel ready";
    $("radioSource").textContent = state.source ?? (state.phase === "preparing" ? "Preparing audio…" : "");
    $("radioCaption").textContent = state.phase === "listening"
      ? "Release Mic to send your command."
      : state.line?.text ?? (this.soundOn ? "Standing by for incident reports." : "Enable sound or run a radio check to hear the crew.");
  }

  private wireUi() {
    const toggle = $("soundToggle");
    const setSound = async (on: boolean) => {
      const request = ++this.soundRequest;
      this.soundOn = on;
      if (on) {
        try {
          await this.audio.unlock();
          if (!this.audio.on) throw new Error("audio context did not resume");
          if (request !== this.soundRequest) {
            if (!this.soundOn) this.audio.suspend();
            return;
          }
          await this.ambience.start();
        } catch {
          if (request !== this.soundRequest) return;
          this.soundOn = false;
          on = false;
          this.audio.suspend();
          $("soundHint").textContent = "Audio could not start. Press Sound to retry.";
        }
        if (request !== this.soundRequest) return;
        if (on) {
          this.swarm.start();
          this.swarm.setWorld(this.hooks.getWorld());
          $("soundHint").textContent = "Radio voices lower the background automatically. Each drone is a note; isolated groups drift out of time until they reconnect.";
        }
      } else {
        this.audio.suspend();
        this.voice.clear();
        $("soundHint").innerHTML = "Sound is off. Press <kbd>M</kbd> or the button in the header.";
      }
      toggle.textContent = on ? "Sound on" : "Sound off";
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-pressed", String(on));
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
        }
      };
    }
    input("sndVolume").oninput = () => this.audio.setVolume(Number(input("sndVolume").value) / 100);
    const check = $<HTMLButtonElement>("radioCheck");
    check.onclick = async () => {
      check.disabled = true;
      try {
        await setSound(true);
        if (!this.soundOn) return;
        input("sndVoices").checked = true;
        this.audio.setBus("voices", true);
        this.voice.clear();
        for (const line of RADIO_CHECK) this.voice.say(line);
      } finally {
        check.disabled = false;
      }
    };

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

  /** Push-to-talk with pointer capture, keyboard support and bounded recordings. */
  private wireMic(btn: HTMLButtonElement) {
    const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    let recorder: MediaRecorder | null = null;
    let recognition: any = null;
    let held = false;
    let opening = false;
    let transcribing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    let session = 0;
    const status = $("micStatus");
    const release = () => {
      held = false;
      clearTimeout(timer);
      this.voice.setListening(false);
      btn.classList.remove("rec");
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = "Mic";
    };
    const heard = (text: string, token: number) => {
      if (token !== session) return;
      if (text.trim()) {
        status.textContent = `Heard: “${text.trim()}”`;
        void this.commander.command(text.trim());
      } else status.textContent = "No speech heard. Hold Mic and try again, or type your command.";
    };
    const stop = () => {
      held = false;
      if (recorder?.state === "recording") recorder.stop();
      recognition?.stop();
      release();
    };
    this.cancelMic = () => {
      session++;
      request?.abort();
      stop();
      status.textContent = "Hold Mic to speak; release to send. Proposed actions still need confirmation.";
    };
    const start = async () => {
      if (held || opening || recorder || recognition || transcribing) return;
      const token = ++session;
      held = true;
      opening = true;
      this.voice.setListening(true);
      btn.classList.add("rec");
      btn.setAttribute("aria-pressed", "true");
      btn.textContent = "Listening";
      status.textContent = "Opening microphone…";
      try {
        if (api.on("elevenlabs") && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined") {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          if (!held || token !== session) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          const chunks: Blob[] = [];
          let rec: MediaRecorder;
          try {
            rec = new MediaRecorder(stream);
          } catch (e) {
            stream.getTracks().forEach((track) => track.stop());
            throw e;
          }
          recorder = rec;
          rec.ondataavailable = (e) => chunks.push(e.data);
          rec.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop());
            if (recorder === rec) {
              recorder = null;
              release();
            }
            if (token !== session) return;
            const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
            if (blob.size < 1500) {
              status.textContent = "Recording too short. Hold Mic while you speak.";
              return;
            }
            transcribing = true;
            btn.disabled = true;
            status.textContent = "Transcribing with ElevenLabs…";
            const controller = new AbortController();
            request = controller;
            try {
              const r = await fetch("/api/stt", {
                method: "POST", headers: { "content-type": blob.type }, body: blob,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
              });
              if (!r.ok) throw new Error("transcription failed");
              heard((await r.json()).text ?? "", token);
            } catch {
              if (token === session) status.textContent = "Could not transcribe that. Try again or type your command.";
            } finally {
              request = null;
              transcribing = false;
              btn.disabled = false;
            }
          };
          rec.onerror = () => {
            status.textContent = "Microphone recording failed. Try again or type your command.";
            // Discard a failed recording rather than send partial audio as a command.
            session++;
            stop();
            stream.getTracks().forEach((track) => track.stop());
            recorder = null;
          };
          try {
            rec.start();
          } catch (e) {
            stream.getTracks().forEach((track) => track.stop());
            throw e;
          }
          status.textContent = "Listening with ElevenLabs. Release to send (10 second limit).";
        } else if (SR) {
          const rec = new SR();
          recognition = rec;
          rec.lang = "en-GB";
          rec.onresult = (e: any) => heard(e.results[0][0].transcript, token);
          rec.onend = () => { recognition = null; release(); };
          rec.onerror = () => { status.textContent = "Could not hear that. Try again or type your command."; };
          rec.start();
          status.textContent = "Listening with browser recognition. Release to send.";
        } else status.textContent = "Voice input is unavailable. Type your command below the radio log.";
        if (recorder || recognition) timer = setTimeout(stop, 10000);
      } catch {
        recognition = null;
        recorder = null;
        status.textContent = "Microphone unavailable. Check browser permissions or type your command.";
      } finally {
        opening = false;
        if (!recorder && !recognition) release();
      }
    };
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      btn.setPointerCapture(e.pointerId);
      void start();
    });
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("lostpointercapture", stop);
    btn.addEventListener("keydown", (e) => {
      if (e.code !== "Space" && e.code !== "Enter") return;
      e.preventDefault();
      if (!e.repeat) void start();
    });
    btn.addEventListener("keyup", (e) => {
      if (e.code !== "Space" && e.code !== "Enter") return;
      e.preventDefault();
      stop();
    });
    btn.addEventListener("blur", stop);
    window.addEventListener("blur", stop);
  }
}
