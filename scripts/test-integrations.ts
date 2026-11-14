// End-to-end check of the integration layer with no API keys: starts the server on a spare
// port, drives a headless run through the same event stream the browser uses, and checks the
// telemetry, dashboard, command parsing, scenario and challenge-board paths.
//
//   npm run test:integrations
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/hotdrones npm run test:integrations
//
// With TEST_DATABASE_URL it also checks the SQL (schema, bulk inserts, aggregate queries)
// against a real Postgres. Without TimescaleDB the aggregates are plain views of the same shape.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BaseKnowledge, localSitrep } from "../src/integrations/baseKnowledge";
import { parseCommandLocally, toolCallToAction } from "../src/integrations/commands";
import { EventDeriver, sampleTelemetry, type RunInfo, type SimEvent, type TelemetrySample } from "../src/integrations/events";
import { applyJudgeAction, runScenario } from "../src/sim/judge";
import { World } from "../src/sim/world";

const PORT = 18787;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const post = (path: string, body: unknown) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = process.env.TEST_DATABASE_URL ?? "";
const server = spawn("node_modules/.bin/tsx", ["server/index.ts"], {
  env: { ...process.env, PORT: String(PORT), TIGER_DATABASE_URL: db, DATABASE_URL: "", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "" },
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  for (let i = 0; i < 50; i++) {
    try {
      await get("/api/status");
      break;
    } catch {
      await sleep(200);
    }
  }
  if (db) await sleep(1500); // let the schema migration finish
  const status = await get("/api/status");
  check("server is up; integrations without keys are off", !status.gemini.on && !status.elevenlabs.on && !status.mongo.on);
  if (db) check("database connected and migrated", status.tiger.on, status.tiger.detail);

  // ---- 1. a headless run through the event stream, with judge actions
  const world = new World({ seed: 15 });
  const deriver = new EventDeriver();
  const knowledge = new BaseKnowledge();
  const run: RunInfo = { runId: randomUUID(), startedAt: Date.now(), source: "live", seed: 15, mode: "swarm", commsRange: world.cfg.commsRange, drones: world.drones.length };
  const all: SimEvent[] = [];
  let samples: TelemetrySample[] = [];
  let events: SimEvent[] = [];
  let staleSeen = 0;
  while (!world.finished && world.tick < 600) {
    if (world.tick === 150) applyJudgeAction(world, { type: "baseComms", online: false });
    if (world.tick === 200) applyJudgeAction(world, { type: "crash", id: 2 });
    if (world.tick === 300) applyJudgeAction(world, { type: "baseComms", online: true });
    world.step();
    const ev = deriver.poll(world);
    knowledge.update(world, ev);
    all.push(...ev);
    events.push(...ev);
    if (world.tick % 5 === 0) samples.push(sampleTelemetry(world, true));
    if (world.tick === 250) staleSeen = knowledge.snapshot(world).staleTicks;
    if (world.tick % 100 === 0) {
      const r = await post("/api/telemetry", { run, samples, events });
      if (r.status !== 202) check("telemetry accepted", false, String(r.status));
      samples = [];
      events = [];
    }
  }
  const m = world.metrics();
  await post("/api/telemetry", { run, samples, events, result: { ticks: m.tick, burnt: m.burnt, villageLost: m.villageLost, dronesLost: m.dronesLost, waterDropped: m.waterDropped, extinguishedAt: m.extinguishedAt } });

  const types = new Set(all.map((e) => e.type));
  check("event stream: run start, drone states, water drops", types.has("runStarted") && types.has("droneState") && types.has("waterDrop"));
  check("event stream: base offline/online and the judge actions", types.has("baseOffline") && types.has("baseOnline") && all.filter((e) => e.type === "judgeAction").length === 3);
  check("event stream: the crashed drone", all.some((e) => e.type === "droneCrashed" && e.id === 2 && e.cause === "judge"));
  check("commander's picture goes stale while base comms are cut", staleSeen >= 99, `${staleSeen} ticks stale at t=250`);
  const snap = knowledge.snapshot(world);
  check("commander's picture is live again after comms return", snap.staleTicks === 0 && snap.dronesInContact.length + snap.dronesSilent.length + snap.dronesKnownLost.length === world.drones.length);
  check("built-in sitrep reads sensibly", /burning|No fire/.test(localSitrep(snap)), localSitrep(snap).slice(0, 70) + "…");

  // ---- 2. the dashboard reads it back
  await sleep(db ? 1500 : 100);
  const dash = await get("/api/dashboard/live");
  check("dashboard: live run comes back in 10-tick buckets", dash.run?.run_id === run.runId && dash.fire.length >= 20 && dash.swarm.length >= 20, `${dash.fire.length} buckets from ${dash.source}`);
  check("dashboard: battery spread is sane", dash.swarm.every((s: any) => s.battery_min <= s.battery_avg + 1e-9 && s.battery_avg <= s.battery_max + 1e-9 && s.battery_max <= 1.001));
  if (db) {
    const sweep = "test-" + Date.now();
    for (const mode of ["swarm", "central"]) {
      for (let seed = 1; seed <= 3; seed++) {
        const r: RunInfo = { runId: randomUUID(), startedAt: Date.now(), source: "experiment", experiment: "range", sweepId: sweep, seed, mode, commsRange: 14, drones: 10 };
        await post("/api/telemetry", { run: r, samples: [], events: [], result: { ticks: 100, burnt: mode === "swarm" ? 100 + seed : 300 + seed, villageLost: mode !== "swarm", dronesLost: 0, waterDropped: 5, extinguishedAt: 100 } });
      }
    }
    await sleep(1200);
    const exp = await get("/api/dashboard/experiments?sweep=" + sweep);
    const sw = exp.rows.find((r: any) => r.mode === "swarm");
    check("dashboard: experiment comparison aggregates per mode", exp.rows.length === 2 && sw?.n === 3 && Math.abs(sw.burnt_mean - 102) < 1e-6 && Math.abs(sw.burnt_se - 1 / Math.sqrt(3)) < 1e-6, JSON.stringify(sw));
  }

  // ---- 3. commands
  const offline = parseCommandLocally("cut base comms and crash drone 3, wind south 80", snap, 10);
  check("offline command parser", offline.length === 3 && offline.some((a) => a.action.type === "wind" && Math.abs(a.action.angle - Math.PI / 2) < 1e-9 && a.action.speed === 0.8), offline.map((a) => a.label).join(" | "));
  check("tool calls are validated", toolCallToAction("crash_drone", { id: 99 }, { width: 64, height: 64, drones: 10 }) === null && toolCallToAction("start_fire", { x: 70, y: 2 }, { width: 64, height: 64, drones: 10 }) === null);
  const cmd = await post("/api/commander/command", { text: "hello", snapshot: snap, drones: 10 });
  check("commander endpoint reports 'not configured' without a key", cmd.status === 503);
  const tts = await post("/api/tts", { text: "Base to all drones", voice: "dispatcher" });
  check("voice endpoint reports 'not configured' without a key", tts.status === 503);

  // ---- 4. scenarios: save, replay exactly, challenge in every mode
  const saved = await (await post("/api/scenarios", { name: "Base cut + crash", author: "test", cfg: { ...world.initialCfg, maxTicks: 600, width: 9999 }, actions: world.judgeLog })).json();
  check("scenario saved with a short id", typeof saved.id === "string" && saved.id.length >= 4, saved.id);
  let sc: any = null;
  for (let i = 0; i < 100; i++) {
    sc = await get("/api/scenarios/" + saved.id);
    if (sc.status === "done" || sc.status === "failed") break;
    await sleep(200);
  }
  check("challenge ran the scenario in every mode", sc.status === "done" && ["swarm", "central", "greedy"].every((k) => sc.outcomes?.[k]?.ticks > 0), JSON.stringify(Object.fromEntries(Object.entries(sc.outcomes ?? {}).map(([k, v]: any) => [k, v.burnt]))));
  check("config was sanitised (map size cannot be changed)", sc.cfg.width === undefined);
  const replay = runScenario({ ...world.initialCfg, maxTicks: 600 }, world.judgeLog);
  check("the stored scenario replays the original run exactly", sc.outcomes.swarm.burnt === replay.burnt && replay.burnt === m.burnt && sc.outcomes.swarm.dronesLost === m.dronesLost, `burnt ${m.burnt}`);
  const board = await get("/api/board");
  check("board lists it with a hurt score", board.scenarios.some((s: any) => s._id === saved.id && typeof s.hurt === "number"));
} catch (e: any) {
  check("test run completed", false, e.stack ?? e.message);
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
