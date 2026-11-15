// Regression checks for cache identity, priority/cancellation races and audio mixing.
// No API key, external service or physical audio device is used.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Eleven } from "../server/eleven";
import { api } from "../src/integrations/api";
import { AudioEngine } from "../src/integrations/audio/engine";
import { accountCast, speechDelivery } from "../src/integrations/audio/profiles";
import { RadioVoice, type Line, type RadioState } from "../src/integrations/audio/voice";
import type { Ambience } from "../src/integrations/audio/ambience";
import { Integrations } from "../src/integrations/index";

const config = { model: "eleven_flash_v2_5", dispatcher: "dispatcher-a", drones: ["drone-a", "drone-b"] };
const bytes = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

test("changing cast, model or delivery cannot replay the previous cached voice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hotdrones-voice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Eleven("test-key", dir, config);
  const second = new Eleven("test-key", dir, { ...config, dispatcher: "dispatcher-b" });
  const a = t.mock.method(first.client!.textToSpeech, "convert", (() => Promise.resolve(bytes("voice-a"))) as any);
  const b = t.mock.method(second.client!.textToSpeech, "convert", (() => Promise.resolve(bytes("voice-b"))) as any);
  assert.equal((await first.speak("Base reporting", "dispatcher")).toString(), "voice-a");
  assert.equal((await first.speak("Base reporting", "dispatcher")).toString(), "voice-a");
  assert.equal(a.mock.callCount(), 1);
  assert.equal((await second.speak("Base reporting", "dispatcher")).toString(), "voice-b");
  assert.equal(b.mock.callCount(), 1);
  assert.notEqual(await first.speechKey("Mayday", "drone:0"), await first.speechKey("Mayday", "drone:0", "urgent"));
  assert.notEqual(await first.speechKey("Report", "drone:0"), await first.speechKey("Report", "drone:1"));
  assert.equal(await first.speechKey("Report", "drone:0"), await first.speechKey("Report", "drone:2"));
  const changedModel = new Eleven(undefined, dir, { ...config, model: "eleven_v3" });
  assert.notEqual(await first.speechKey("Report", "dispatcher"), await changedModel.speechKey("Report", "dispatcher"));
  // Cached audio remains available to server callers without credentials.
  const offline = new Eleven(undefined, dir, config);
  assert.equal((await offline.speak("Base reporting", "dispatcher")).toString(), "voice-a");
});

test("concurrent identical speech requests share one generation; a failure can be retried", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hotdrones-voice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eleven = new Eleven("test-key", dir, config);
  const gate = deferred<void>();
  let fail = false;
  const convert = t.mock.method(eleven.client!.textToSpeech, "convert", (async () => {
    await gate.promise;
    if (fail) throw new Error("network down");
    return bytes("shared");
  }) as any);
  const one = eleven.speak("Same report", "dispatcher");
  const two = eleven.speak("Same report", "dispatcher");
  await eventually(() => convert.mock.callCount() === 1);
  gate.resolve();
  assert.deepEqual(await one, await two);
  fail = true;
  await assert.rejects(eleven.speak("New report", "dispatcher"), /network down/);
  fail = false;
  assert.equal((await eleven.speak("New report", "dispatcher")).toString(), "shared");
});

test("automatic casting is stable across account ordering and avoids paid library voices", () => {
  const voices = [
    { voiceId: "paid", name: "Alicia - Anchor", category: "professional" },
    { voiceId: "a", name: "Alice - Clear", category: "premade" },
    { voiceId: "c", name: "Charlie - Deep", category: "premade" },
    { voiceId: "j", name: "Jessica - Warm", category: "premade" },
    { voiceId: "g", name: "George - Baritone", category: "premade" },
  ];
  const expected = { dispatcher: "a", drones: ["c", "j", "g"] };
  assert.deepEqual(accountCast(voices), expected);
  assert.deepEqual(accountCast([...voices].reverse()), expected);
});

test("delivery directions are model aware and invalid roles cannot consume a generation", async (t) => {
  assert.equal(speechDelivery("Mayday", "urgent", "eleven_flash_v2_5").text, "Mayday");
  assert.equal(speechDelivery("Mayday", "urgent", "eleven_v3").text, "[urgent] Mayday");
  const dir = mkdtempSync(join(tmpdir(), "hotdrones-voice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eleven = new Eleven("test-key", dir, config);
  const convert = t.mock.method(eleven.client!.textToSpeech, "convert", (() => Promise.resolve(bytes("unused"))) as any);
  await assert.rejects(eleven.speak("Report", "drone:-1"), /invalid voice/);
  await assert.rejects(eleven.speak("Report", "dispatcher", "shout" as any), /invalid voice/);
  assert.equal(convert.mock.callCount(), 0);
});

class NodeStub {
  gain = { value: 0 };
  frequency = { value: 0 };
  connect(node: unknown) { return node; }
  disconnect() {}
}

class SourceStub extends NodeStub {
  buffer: any;
  onended: (() => void) | null = null;
  stopped = false;
  constructor(private started: SourceStub[]) { super(); }
  start() { this.started.push(this); }
  stop() { this.stopped = true; }
}

function harness(load?: (path: string) => Promise<any>) {
  const started: SourceStub[] = [];
  const states: RadioState[] = [];
  const active: boolean[] = [];
  const engine = {
    on: true,
    voiceVolume: 0.7,
    busOn: () => true,
    ctx: {
      currentTime: 0,
      createBufferSource: () => new SourceStub(started),
      createBiquadFilter: () => new NodeStub(),
      createWaveShaper: () => new NodeStub(),
      createGain: () => new NodeStub(),
    },
    noise: { label: "noise" },
    buses: { voices: new NodeStub() },
    manifest: { radio: { routine: "routine.mp3", urgent: "urgent.mp3", latest: "latest.mp3" } },
    load: load ?? (async (label: string) => ({ duration: 0.1, label })),
    setVoiceActive: (on: boolean) => active.push(on),
    setListening: () => {},
  };
  const radio = new RadioVoice(engine as unknown as AudioEngine, { squelch() {} } as Ambience, (s) => states.push(s));
  return { radio, engine, started, states, active, speech: () => started.filter((s) => s.buffer?.label !== "noise") };
}

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Radio did not reach the expected state");
}

const routine: Line = { voice: "drone:0", text: "Refilling", clip: "routine", priority: 0 };
const urgent: Line = { voice: "dispatcher", text: "Village threatened", clip: "urgent", priority: 3, delivery: "urgent" };

test("an emergency interrupts audible routine speech and releases the mix after clear", async (t) => {
  const h = harness();
  t.after(() => h.radio.clear());
  h.radio.say(routine);
  await eventually(() => h.speech().length === 1);
  const old = h.speech()[0];
  h.radio.say(urgent);
  await eventually(() => h.speech().length === 2);
  assert.equal(old.stopped, true);
  assert.equal(h.speech()[1].buffer.label, "urgent.mp3");
  assert.equal([...h.states].reverse().find((s) => s.phase === "speaking")?.source, "ElevenLabs clip");
  h.radio.clear();
  await eventually(() => h.states.at(-1)?.phase === "idle");
  assert.equal(h.speech()[1].stopped, true);
  assert.equal(h.active.at(-1), false);
});

test("clear during a slow fetch cannot revive an old run or block the next alert", async (t) => {
  const slow = deferred<any>();
  const h = harness((path) => path === "routine.mp3" ? slow.promise : Promise.resolve({ duration: 0.1, label: path }));
  t.after(() => h.radio.clear());
  h.radio.say(routine);
  await eventually(() => h.states.some((s) => s.phase === "preparing"));
  h.radio.clear();
  h.radio.say(urgent);
  await eventually(() => h.speech().length === 1);
  slow.resolve({ duration: 0.1, label: "old-run" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.speech().map((s) => s.buffer.label), ["urgent.mp3"]);
});

test("microphone listening pauses the queue, coalesces stale updates and resumes only the latest", async (t) => {
  const h = harness();
  t.after(() => h.radio.clear());
  h.radio.setListening(true);
  h.radio.say({ ...routine, priority: 2, key: "sitrep" });
  h.radio.say({ ...routine, text: "Updated report", clip: "latest", priority: 2, key: "sitrep" });
  assert.equal(h.speech().length, 0);
  h.radio.setListening(false);
  await eventually(() => h.speech().length === 1);
  assert.equal(h.speech()[0].buffer.label, "latest.mp3");
  h.engine.on = false;
  h.radio.clear();
  h.speech()[0].onended?.();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.speech().length, 1);
});

test("emergencies abort a pending live request before starting their offline clip", async (t) => {
  const savedStatus = api.status;
  const savedUp = api.serverUp;
  api.serverUp = true;
  api.status = { elevenlabs: { on: true, detail: "test" } } as any;
  t.after(() => { api.status = savedStatus; api.serverUp = savedUp; });
  let aborted = false;
  t.mock.method(api, "post", async (_path: string, _body: unknown, _timeout?: number, signal?: AbortSignal) => new Promise<Response | null>((resolve) => {
    signal!.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true });
  }));
  const h = harness();
  t.after(() => h.radio.clear());
  h.radio.say({ ...routine, clip: undefined });
  await eventually(() => h.states.some((s) => s.phase === "preparing"));
  h.radio.say(urgent);
  await eventually(() => h.speech().length === 1);
  assert.equal(aborted, true);
  assert.equal(h.speech()[0].buffer.label, "urgent.mp3");
});

test("ducking and microphone release preserve the user's muted buses", () => {
  const engine = new AudioEngine();
  const levels: Record<string, number> = {};
  engine.ctx = { currentTime: 0 } as AudioContext;
  engine.buses = Object.fromEntries(["voices", "effects", "swarm", "score"].map((key) => [key, {
    gain: { setTargetAtTime: (value: number) => { levels[key] = value; } },
  }])) as any;
  engine.setBus("score", false);
  engine.setVoiceActive(true);
  assert.equal(levels.voices, 1);
  assert.ok(levels.effects < 0.8);
  assert.equal(levels.score, 0);
  engine.setListening(true);
  assert.ok(Object.values(levels).every((value) => value === 0));
  engine.setVoiceActive(false);
  engine.setListening(false);
  assert.equal(levels.effects, 0.8);
  assert.equal(levels.score, 0);
});

function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test("browser fallback is labelled, respects volume and stops when the radio is cleared", async (t) => {
  const savedStatus = api.status;
  api.status = null;
  t.after(() => { api.status = savedStatus; });
  let utterance: any;
  let cancellations = 0;
  replaceGlobal(t, "window", { speechSynthesis: {
    getVoices: () => [{ lang: "en-GB" }],
    speak: (u: unknown) => { utterance = u; },
    cancel: () => { cancellations++; },
  } });
  replaceGlobal(t, "SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  const h = harness();
  t.after(() => h.radio.clear());
  h.radio.say({ ...routine, clip: undefined });
  await eventually(() => !!utterance);
  assert.equal(h.states.at(-1)?.source, "Browser voice");
  assert.equal(utterance.volume, 0.7);
  h.radio.clear();
  await eventually(() => h.states.at(-1)?.phase === "idle");
  assert.equal(cancellations, 1);
});

class ButtonStub extends EventTarget {
  classList = { add() {}, remove() {} };
  textContent = "Mic";
  disabled = false;
  setAttribute() {}
  setPointerCapture() {}
}

function key(button: ButtonStub, type: string) {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, { code: { value: "Space" }, repeat: { value: false } });
  button.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
}

function micHarness(t: TestContext, getUserMedia: () => Promise<unknown>) {
  const button = new ButtonStub();
  const status = { textContent: "" };
  const listening: boolean[] = [];
  const commands: string[] = [];
  replaceGlobal(t, "window", new EventTarget());
  replaceGlobal(t, "document", { getElementById: () => status });
  replaceGlobal(t, "navigator", { mediaDevices: { getUserMedia } });
  const savedStatus = api.status;
  api.status = { elevenlabs: { on: true, detail: "test" } } as any;
  t.after(() => { api.status = savedStatus; });
  const owner = {
    voice: { setListening: (on: boolean) => listening.push(on) },
    commander: { command: async (text: string) => { commands.push(text); } },
    cancelMic: () => {},
  };
  (Integrations.prototype as any).wireMic.call(owner, button);
  t.after(() => owner.cancelMic());
  return { button, status, listening, commands, owner };
}

test("keyboard push-to-talk releases the mic and submits the transcript with app audio restored", async (t) => {
  let stopped = 0;
  const h = micHarness(t, async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }));
  replaceGlobal(t, "MediaRecorder", class {
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: any;
    onstop: any;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob([new Uint8Array(2000)]) });
        void this.onstop();
      });
    }
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ text: "Cut base comms" }));
  key(h.button, "keydown");
  await eventually(() => h.status.textContent.startsWith("Listening with ElevenLabs"));
  assert.equal(h.listening.at(-1), true);
  key(h.button, "keyup");
  await eventually(() => h.commands.length === 1 && !h.button.disabled);
  assert.equal(stopped, 1);
  assert.equal(h.listening.at(-1), false);
  assert.deepEqual(h.commands, ["Cut base comms"]);
});

test("releasing push-to-talk before permission arrives closes the stream without recording", async (t) => {
  const permission = deferred<any>();
  let stopped = 0;
  let recorded = false;
  const h = micHarness(t, () => permission.promise);
  replaceGlobal(t, "MediaRecorder", class { constructor() { recorded = true; } });
  key(h.button, "keydown");
  key(h.button, "keyup");
  permission.resolve({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await eventually(() => stopped === 1);
  assert.equal(recorded, false);
  assert.equal(h.listening.at(-1), false);
  assert.deepEqual(h.commands, []);
});

test("a recorder startup failure releases the microphone and restores app audio", async (t) => {
  let stopped = 0;
  const h = micHarness(t, async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }));
  replaceGlobal(t, "MediaRecorder", class { start() { throw new Error("encoder unavailable"); } });
  key(h.button, "keydown");
  await eventually(() => stopped === 1);
  assert.equal(h.listening.at(-1), false);
  assert.match(h.status.textContent, /Microphone unavailable/);
  assert.deepEqual(h.commands, []);
});
