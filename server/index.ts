// HotDrones server: HTTP API + WebSocket. In dev, Vite proxies /api and /ws here; in
// production (`npm run build && npm start`) it also serves the built app from dist/.
//
// Every integration is optional. With no .env at all the server still runs: status dots show
// what is off, and the browser falls back to its offline behaviour.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { BaseSnapshot } from "../src/integrations/baseKnowledge";
import type { RunInfo, RunResult, SimEvent, TelemetrySample } from "../src/integrations/events";
import { MODES, digestEvents, hurtScore, runScenarioAsync, sanitizeActions, sanitizeConfig } from "./challenge";
import { Eleven } from "./eleven";
import { isDelivery, isVoiceRole } from "../src/integrations/audio/profiles";
import { env } from "./env";
import { Gemini } from "./gemini";
import { FileStore, MongoStore, newScenarioId, type Outcome, type Scenario, type ScenarioStore } from "./store";
import { Tiger } from "./tiger";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const DATA = join(ROOT, "data");

// ---------------------------------------------------------------- integrations
const gemini = new Gemini(env.geminiKey, env.geminiModel);
const eleven = new Eleven(env.elevenKey, join(DATA, "tts-cache"));
let tiger: Tiger | null = null;
let store: ScenarioStore = new FileStore(join(DATA, "scenarios.json"), env.mongoUrl ? "connecting to MongoDB" : "no MONGODB_URI");

Tiger.connect(env.tigerUrl).then((t) => {
  tiger = t;
  if (t) console.log(`tigerdb - ${t.ready ? "connected: " : ""}${t.status().detail}`);
});
if (env.mongoUrl) {
  MongoStore.connect(env.mongoUrl, env.mongoDb)
    .then((s) => {
      store = s;
      console.log("[mongo] connected");
    })
    .catch((e) => {
      store = new FileStore(join(DATA, "scenarios.json"), `MongoDB unreachable (${String(e.message).slice(0, 60)})`);
      console.warn("[mongo] could not connect, using the local file store:", e.message);
    });
}

function status() {
  return {
    tiger: tiger ? tiger.status() : { on: false, detail: env.tigerUrl ? "connecting" : "no TIGER_DATABASE_URL: telemetry is only kept in memory for the dashboard" },
    gemini: gemini.status(),
    elevenlabs: eleven.status(),
    mongo: store.status(),
  };
}

// ---------------------------------------------------------------- live state (works with no database)
interface LiveRun {
  run: RunInfo;
  samples: TelemetrySample[];
  result?: RunResult;
}
const live = new Map<string, LiveRun>(); // the last few runs, newest last
const sockets = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const text = JSON.stringify(msg);
  for (const s of sockets) if (s.readyState === 1) s.send(text);
};

// Database writes are queued so a slow network never holds up an HTTP response (let alone a tick).
let dbQueue: Promise<void> = Promise.resolve();
let dbPending = 0;
function dbWrite(job: (t: Tiger) => Promise<void>) {
  const t = tiger;
  if (!t || !t.ready || dbPending > 60) return; // overloaded or offline: drop, never block
  dbPending++;
  dbQueue = dbQueue
    .then(() => job(t))
    .catch((e) => console.warn("[tiger] write failed:", e.message))
    .finally(() => void dbPending--);
}

function ingest(body: { run: RunInfo; samples?: TelemetrySample[]; events?: SimEvent[]; result?: RunResult }) {
  const run = body.run;
  if (!run || typeof run.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(run.runId) || !Number.isFinite(run.startedAt)) throw httpError(400, "bad run");
  let lr = live.get(run.runId);
  if (!lr) {
    lr = { run, samples: [] };
    live.set(run.runId, lr);
    while (live.size > 8) live.delete(live.keys().next().value!);
    dbWrite((t) => t.startRun(run));
    broadcast({ type: "run", run });
  }
  const samples = (body.samples ?? []).slice(0, 400);
  const events = (body.events ?? []).slice(0, 400);
  if (samples.length) {
    lr.samples.push(...samples.map(({ drones, ...rest }) => ({ ...rest, drones: drones?.map((d) => ({ ...d })) })));
    if (lr.samples.length > 4000) lr.samples.splice(0, lr.samples.length - 4000);
    dbWrite((t) => t.insertSamples(run.runId, run.startedAt, samples));
    broadcast({ type: "telemetry", runId: run.runId, samples });
  }
  if (events.length) {
    dbWrite((t) => t.insertEvents(run.runId, run.startedAt, events));
    broadcast({ type: "events", runId: run.runId, events });
  }
  if (body.result && !lr.result) {
    lr.result = body.result;
    const result = body.result;
    dbWrite((t) => t.finishRun(run, result));
    broadcast({ type: "finished", runId: run.runId, result });
  }
}

/** The dashboard's live view from memory, in the same shape Tiger.liveRun() returns, for when no database is connected. */
function liveFromMemory(runId?: string) {
  const lr = runId ? live.get(runId) : [...live.values()].filter((l) => l.run.source === "live").pop();
  if (!lr) return null;
  const buckets = new Map<number, TelemetrySample[]>();
  for (const s of lr.samples) {
    const b = Math.floor(s.tick / 10);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(s);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const fire = [];
  const swarm = [];
  for (const [, ss] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const tick = Math.max(...ss.map((s) => s.tick));
    fire.push({
      tick,
      burning: avg(ss.map((s) => s.burning)),
      burnt: Math.max(...ss.map((s) => s.burnt)),
      thick_smoke: avg(ss.map((s) => s.thickSmoke)),
      comms_groups: avg(ss.map((s) => s.groups)),
      links: avg(ss.map((s) => s.links)),
      base_online: avg(ss.map((s) => (s.baseOnline ? 1 : 0))),
      drones_alive: Math.min(...ss.map((s) => s.dronesAlive)),
    });
    const ds = ss.flatMap((s) => s.drones ?? []);
    if (ds.length) {
      swarm.push({
        tick,
        battery_min: Math.min(...ds.map((d) => d.battery)),
        battery_avg: avg(ds.map((d) => d.battery)),
        battery_max: Math.max(...ds.map((d) => d.battery)),
        damage_max: Math.max(...ds.map((d) => d.damage)),
        damage_avg: avg(ds.map((d) => d.damage)),
        water_avg: avg(ds.map((d) => d.water)),
      });
    }
  }
  const r = lr.run;
  return {
    run: { run_id: r.runId, started_at: new Date(r.startedAt).toISOString(), source: r.source, seed: r.seed, mode: r.mode, comms_range: r.commsRange, drones: r.drones, finished: !!lr.result, ...(lr.result ? { burnt: lr.result.burnt, village_lost: lr.result.villageLost } : {}) },
    fire,
    swarm,
  };
}

// ---------------------------------------------------------------- challenge board
const challengeQueue: string[] = [];
let challengeBusy = false;
async function drainChallenges() {
  if (challengeBusy) return;
  challengeBusy = true;
  try {
    for (let id = challengeQueue.shift(); id; id = challengeQueue.shift()) {
      const s = await store.get(id).catch(() => null);
      if (!s) continue;
      try {
        await store.update(id, { status: "running" });
        const outcomes: Record<string, Outcome> = {};
        let swarmEvents: SimEvent[] = [];
        for (const mode of MODES) {
          const r = await runScenarioAsync({ ...s.cfg, mode }, s.actions);
          outcomes[mode] = r.outcome;
          if (mode === "swarm") swarmEvents = r.events;
        }
        const patch: Partial<Scenario> = { outcomes, hurt: hurtScore(outcomes.swarm), status: "done" };
        if (gemini.on) {
          patch.report = await gemini
            .afterAction({ scenario: { name: s.name, seed: s.cfg.seed, judgeActions: s.actions.length }, swarmRun: outcomes.swarm, sameScenarioOtherModes: { central: outcomes.central, greedy: outcomes.greedy }, keyEvents: digestEvents(swarmEvents) })
            .catch(() => undefined);
        }
        await store.update(id, patch);
        broadcast({ type: "board", id });
      } catch (e: any) {
        console.warn("[challenge] failed:", e.message);
        await store.update(id, { status: "failed" }).catch(() => {});
      }
    }
  } finally {
    challengeBusy = false;
  }
}

// ---------------------------------------------------------------- http plumbing
const httpError = (code: number, message: string) => Object.assign(new Error(message), { code });

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        rej(httpError(413, "too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}
async function readJson(req: IncomingMessage, limit = 2_000_000): Promise<any> {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString("utf8") || "{}");
  } catch {
    throw httpError(400, "bad JSON");
  }
}
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json", ".woff2": "font/woff2",
};
function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("HotDrones API server. The app is not built: run `npm run dev` for development, or `npm run build` first.");
  }
  let file = normalize(join(DIST, decodeURIComponent(path)));
  if (!file.startsWith(DIST)) return json(res, 403, { error: "forbidden" });
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    if (extname(file)) return json(res, 404, { error: "not found" });
    file = join(DIST, "index.html");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": /\/assets\//.test(file) ? "public, max-age=31536000, immutable" : "no-cache" });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- routes
async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (p === "/api/status" && m === "GET") return json(res, 200, status());

  // ---- telemetry (Tiger Data)
  if (p === "/api/telemetry" && m === "POST") {
    ingest(await readJson(req));
    return json(res, 202, { ok: true });
  }
  if (p === "/api/dashboard/live" && m === "GET") {
    const runId = url.searchParams.get("run") ?? undefined;
    if (tiger?.ready) {
      try {
        return json(res, 200, { source: tiger.timescale ? "Tiger Data continuous aggregates" : "Postgres views", ...(await tiger.liveRun(runId)), recent: await tiger.recentRuns() });
      } catch (e: any) {
        console.warn("[tiger] dashboard query failed:", e.message);
      }
    }
    return json(res, 200, { source: "server memory (no database connected)", ...(liveFromMemory(runId) ?? { run: null, fire: [], swarm: [] }), recent: [] });
  }
  if (p === "/api/dashboard/experiments" && m === "GET") {
    if (!tiger?.ready) return json(res, 200, { source: "none", sweeps: [], sweepId: null, rows: [] });
    return json(res, 200, { source: tiger.timescale ? "Tiger Data continuous aggregate experiment_1h" : "Postgres view experiment_1h", ...(await tiger.experiments(url.searchParams.get("sweep") ?? undefined)) });
  }

  // ---- AI commander (Gemini)
  if (p === "/api/commander/sitrep" && m === "POST") {
    const b = await readJson(req, 200_000);
    if (!gemini.on) return json(res, 503, { error: "Gemini is not configured" });
    return json(res, 200, { text: await gemini.sitrep(b.snapshot as BaseSnapshot, String(b.trigger ?? "routine").slice(0, 80)) });
  }
  if (p === "/api/commander/command" && m === "POST") {
    const b = await readJson(req, 200_000);
    if (!gemini.on) return json(res, 503, { error: "Gemini is not configured" });
    return json(res, 200, await gemini.command(String(b.text ?? ""), b.snapshot as BaseSnapshot, Number(b.drones) || 0));
  }
  if (p === "/api/commander/report" && m === "POST") {
    const b = await readJson(req, 400_000);
    if (!gemini.on) return json(res, 503, { error: "Gemini is not configured" });
    let database: unknown = undefined;
    if (tiger?.ready && typeof b.runId === "string") {
      await dbQueue.catch(() => {}); // let the last telemetry land first
      database = await tiger.runSummary(b.runId).catch(() => undefined);
    }
    const text = await gemini.afterAction({ run: b.run, result: b.result, keyEvents: (b.keyEvents ?? []).slice(0, 60), databaseAggregates: database ?? "not available" });
    return json(res, 200, { text, usedDatabase: !!database });
  }

  // ---- voice (ElevenLabs)
  if (p === "/api/tts" && m === "POST") {
    const b = await readJson(req, 20_000);
    const voice = b.voice ?? "dispatcher";
    const delivery = b.delivery ?? "calm";
    if (typeof b.text !== "string" || !b.text.trim() || !isVoiceRole(voice) || !isDelivery(delivery)) {
      return json(res, 400, { error: "Supply text, a dispatcher or drone:N voice, and calm, urgent or relieved delivery" });
    }
    try {
      const audio = await eleven.speak(b.text, voice, delivery);
      res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
      return res.end(audio);
    } catch (e: any) {
      return json(res, 503, { error: e.message });
    }
  }
  if (p === "/api/stt" && m === "POST") {
    if (!eleven.on) return json(res, 503, { error: "ElevenLabs is not configured" });
    const audio = await readBody(req, 6_000_000);
    return json(res, 200, { text: await eleven.transcribe(audio, String(req.headers["content-type"] ?? "audio/webm")) });
  }

  // ---- scenarios and the challenge board (MongoDB Atlas)
  if (p === "/api/scenarios" && m === "POST") {
    const b = await readJson(req, 400_000);
    const cfg = sanitizeConfig(b.cfg);
    if (!Number.isFinite(cfg.seed)) throw httpError(400, "a scenario needs a seed");
    const s: Scenario = {
      _id: newScenarioId(),
      name: String(b.name ?? "").trim().slice(0, 60) || `Seed ${cfg.seed}`,
      author: String(b.author ?? "").trim().slice(0, 30) || "anonymous",
      createdAt: new Date().toISOString(),
      cfg,
      actions: sanitizeActions(b.actions),
      status: "queued",
    };
    await store.save(s);
    challengeQueue.push(s._id);
    void drainChallenges();
    return json(res, 201, { id: s._id });
  }
  const one = /^\/api\/scenarios\/([a-z0-9]{4,12})$/.exec(p);
  if (one && m === "GET") {
    const s = await store.get(one[1]);
    return s ? json(res, 200, s) : json(res, 404, { error: "no such scenario" });
  }
  if (p === "/api/board" && m === "GET") return json(res, 200, { store: store.kind, scenarios: await store.board(50) });

  return json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
  api(req, res, url).catch((e: any) => {
    const code = typeof e.code === "number" ? e.code : e.message === "rate limited" ? 429 : 500;
    if (code >= 500) console.warn(`[api] ${req.method} ${url.pathname}: ${e.message}`);
    if (!res.headersSent) json(res, code, { error: String(e.message ?? e).slice(0, 200) });
    else res.end();
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: "hello", status: status(), runs: [...live.values()].map((l) => l.run) }));
  ws.on("close", () => sockets.delete(ws));
  ws.on("error", () => sockets.delete(ws));
});

server.listen(env.port, () => {
  console.log(`HotDrones server on http://localhost:${env.port}${existsSync(DIST) ? " (serving dist/)" : " (API only; run the app with `npm run dev`)"}`);
  for (const [name, s] of Object.entries(status())) console.log(`  ${s.on ? "●" : "○"} ${name.padEnd(10)} ${s.detail}`);
});
