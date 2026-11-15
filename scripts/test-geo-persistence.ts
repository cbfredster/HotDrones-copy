import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenarioAsync, sanitizeActions, sanitizeConfig, MODES } from "../server/challenge";
import { FileStore, MongoStore, type Scenario } from "../server/store";
import { validateGeoScenario } from "../src/sim/geography";
import { applyJudgeAction, runScenario } from "../src/sim/judge";
import { World } from "../src/sim/world";
import { syntheticGeography } from "./geo-fixture";

const geography = syntheticGeography();
const cfg = { seed: 19, maxTicks: 100, droneCount: 2, windDrift: false, regrowth: false };
const world = new World(cfg, geography);
while (!world.finished) {
  if (world.tick === 8) applyJudgeAction(world, { type: "wind", angle: 0.2, speed: 0.7 });
  world.step();
}
const original = world.metrics();
const doc: Scenario = { _id: "geotest", name: "Synthetic persistence test", author: "test", createdAt: "2026-11-15T00:00:00Z",
  cfg, actions: world.judgeLog, geography: world.initialGeo, status: "queued" };
const workDir = mkdtempSync(join(tmpdir(), "hotdrones-geo-persistence-"));

try {
  const path = join(workDir, "scenarios.json");
  const file = new FileStore(path, "test");
  await file.save(doc);
  await file.save({ ...doc, _id: "oldtest", geography: undefined });
  const restored = await new FileStore(path, "test restart").get("geotest");
  assert.ok(restored?.geography);
  assert.deepEqual(restored.geography, geography);
  assert.deepEqual(runScenario(restored.cfg, restored.actions, restored.geography), original);
  assert.equal((await file.get("oldtest"))?.geography, undefined, "old procedural documents still load");
  assert.ok((await file.board(10)).every((s) => !("geography" in s)), "board avoids sending terrain arrays");
  const returned = await file.get("geotest");
  returned!.cfg.seed = 999;
  assert.equal((await file.get("geotest"))!.cfg.seed, 19, "store owns documents across callers");
  await assert.rejects(() => file.save({ ...doc, geography: { ...geography, elevationM: [1] } }));

  // Exercise Mongo's BSON-facing document boundary without depending on a live Mongo account.
  let bsonDocument: any;
  const mongo: MongoStore = Object.create(MongoStore.prototype);
  (mongo as any).col = {
    insertOne: async (s: Scenario) => { bsonDocument = structuredClone(s); },
    findOne: async () => structuredClone(bsonDocument),
    updateOne: async (_: unknown, update: { $set: Partial<Scenario> }) => { Object.assign(bsonDocument, structuredClone(update.$set)); },
  };
  await mongo.save(doc);
  assert.ok(Array.isArray(bsonDocument.geography.elevationM));
  const fromMongo = await mongo.get("geotest");
  assert.deepEqual(fromMongo?.geography, geography);
  assert.deepEqual(runScenario(fromMongo!.cfg, fromMongo!.actions, fromMongo!.geography), original);
  await mongo.update("geotest", { status: "done" });
  assert.equal((await mongo.get("geotest"))!.status, "done");
  bsonDocument.geography.landCover[0] = 255;
  await assert.rejects(() => mongo.get("geotest"));

  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Replay must never access providers"); };
  try {
    for (const mode of MODES) {
      const expected = runScenario({ ...cfg, mode }, doc.actions, geography);
      const challenged = await runScenarioAsync({ ...cfg, mode }, doc.actions, geography);
      assert.equal(challenged.outcome.burnt, expected.burnt);
      assert.equal(challenged.outcome.dronesLost, expected.dronesLost);
    }
    assert.equal((await runScenarioAsync(cfg, doc.actions, geography)).outcome.burnt, original.burnt);
  } finally { globalThis.fetch = savedFetch; }
  assert.deepEqual(geography, syntheticGeography(), "runs must not mutate shared initial inputs");
  for (const mode of ["cbba", "unified"] as const) {
    assert.equal(sanitizeConfig({ mode }).mode, mode);
    assert.deepEqual(new World({ ...cfg, mode }, geography).initialGeo, geography);
    const modeResult = runScenario({ ...cfg, mode }, [], geography);
    assert.ok(modeResult.tick > 0 && modeResult.tick <= 100);
  }
  assert.equal(sanitizeConfig({ cbbaRounds: 1e100 }).cbbaRounds, 12);
  assert.deepEqual(sanitizeActions([{ tick: 2, action: { type: "wind", angle: 0, speed: 0.5, huge: new Array(1000).fill("x") } }, { tick: 4, action: { type: "bad" } }]),
    [{ tick: 2, action: { type: "wind", angle: 0, speed: 0.5 } }]);

  // Local HTTP only: provider access is never needed for saving or challenging these snapshots.
  const port = 18889;
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(port), HOTDRONES_DATA_DIR: join(workDir, "http-data"), TIGER_DATABASE_URL: "", DATABASE_URL: "", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${base}/api/status`)).ok; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error(`Test server exited: ${errors}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, `HTTP test server available: ${errors}`);
    const post = (body: unknown) => fetch(`${base}/api/scenarios`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    assert.equal((await post({ cfg, geography: { ...geography, elevationM: [1] } })).status, 400);
    assert.equal((await post({ cfg, geography: { ...geography, landCover: new Array(4097).fill(10) } })).status, 400);
    assert.equal((await post({ cfg, geography: { ...geography, landCover: geography.landCover.map(() => 0) } })).status, 400);
    assert.equal((await post({ name: "x".repeat(2_100_000), cfg, geography })).status, 413);
    const response = await post({ name: "Synthetic geo API test", cfg, actions: doc.actions, geography });
    assert.equal(response.status, 201);
    const saved = await response.json() as { id: string };
    let fromApi: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      fromApi = await (await fetch(`${base}/api/scenarios/${saved.id}`)).json();
      if (["done", "failed"].includes(fromApi.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fromApi.status, "done");
    assert.deepEqual(validateGeoScenario(fromApi.geography), geography);
    assert.equal(fromApi.outcomes.swarm.burnt, original.burnt);
    assert.ok(MODES.every((mode) => fromApi.outcomes[mode].ticks === runScenario({ ...cfg, mode }, doc.actions, geography).tick));
    assert.equal((await (await post({ name: "Old procedural API document", cfg, actions: [] })).json() as any).id.length >= 4, true);
  } finally { server.kill(); }
  console.log("Geographic persistence checks passed: file, Mongo boundary, exact offline replay, modes, bounded HTTP validation and challenge.");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
