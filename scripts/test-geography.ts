// Deterministic synthetic unit fixture, NOT a sourced real-world example.
import assert from "node:assert/strict";
import { defaultConfig, type Mode } from "../src/sim/config";
import { Environment, Fire } from "../src/sim/environment";
import {
  burntHectares, createTerrainFromGeo, defaultGeoScenario, geoBounds, geoToGrid, gridToGeo,
  landCoverToTile, validateGeoArea, validateGeoScenario, validGeoPlacement,
} from "../src/sim/geography";
import { applyJudgeAction, ReplayCursor, runScenario } from "../src/sim/judge";
import { Rng } from "../src/sim/rng";
import { Tile, terrainTarget } from "../src/sim/terrain";
import { World } from "../src/sim/world";

let checks = 0;
const test = (name: string, fn: () => void) => { fn(); checks++; console.log(`  ok  ${name}`); };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const area = { centre: { lat: 39, lon: -120 }, sizeM: 4000, w: 64 as const, h: 64 as const };
const source = {
  version: 1 as const, ...area,
  elevationM: Array.from({ length: 4096 }, (_, i) => 800 + (i % 64) * 6.25 + Math.floor(i / 64) * 12.5),
  landCover: Array.from({ length: 4096 }, (_, i) => i % 64 < 3 ? 80 : i % 5 === 0 ? 30 : 10),
  metadata: { label: "Synthetic unit fixture (not geographic observations)", retrievedAt: "2026-01-01T00:00:00Z",
    elevation: "Synthetic planar slope", landCover: "Synthetic class stripes", attribution: ["Test authors; synthetic data"] },
};
const geo = defaultGeoScenario(source);

test("coordinate round trips, cell centres, north-up orientation and boundary edges", () => {
  const b = geoBounds(area);
  for (const [x, y] of [[0, 0], [63, 63], [31.5, 31.5], [-0.5, -0.5], [63.5, 63.5]]) {
    const p = gridToGeo(area, x, y);
    const g = geoToGrid(area, p.lat, p.lon);
    near(g.x, x); near(g.y, y);
  }
  const c = gridToGeo(area, 31.5, 31.5);
  near(c.lat, area.centre.lat); near(c.lon, area.centre.lon);
  assert.ok(gridToGeo(area, 0, 0).lat > gridToGeo(area, 0, 1).lat);
  assert.ok(gridToGeo(area, 0, 0).lon < gridToGeo(area, 1, 0).lon);
  near(gridToGeo(area, -0.5, -0.5).lon, b.west);
  near(gridToGeo(area, 63.5, 63.5).lat, b.south);
});

test("bounds reject polar, antimeridian, excessive resolution and unsupported size", () => {
  for (const bad of [
    { ...area, centre: { lat: 80, lon: 0 } }, { ...area, centre: { lat: -61, lon: 0 } },
    { ...area, centre: { lat: 0, lon: 179.999 } }, { ...area, w: 128 }, { ...area, sizeM: 100000 },
    { ...area, centre: { lat: NaN, lon: 0 } },
  ]) assert.throws(() => validateGeoArea(bad));
});

test("elevation metre conversion retains physical slopes and original elevations", () => {
  const t = createTerrainFromGeo(geo);
  near(t.height[65] - t.height[64], 0.1);
  near(t.height[128] - t.height[64], 0.2);
  near(t.elevationOffsetM!, 800);
  near(t.metresPerCell!, 62.5);
  assert.equal(geo.elevationM[65], 818.75);
  near(burntHectares(geo, 1), 0.390625);
});

test("every categorical class is explicit and missing data never becomes water or forest", () => {
  assert.equal(landCoverToTile(10), Tile.Forest); assert.equal(landCoverToTile(95), Tile.Forest);
  for (const n of [20, 30, 40, 90, 100]) assert.equal(landCoverToTile(n), Tile.Grass);
  for (const n of [50, 60]) assert.equal(landCoverToTile(n), Tile.Rock);
  assert.equal(landCoverToTile(70), Tile.Sand); assert.equal(landCoverToTile(80), Tile.Water);
  for (const n of [0, 255, 11, NaN]) assert.throws(() => landCoverToTile(n));
});

test("physical uphill spreads preferentially to downhill under identical wind and RNG", () => {
  const t = createTerrainFromGeo(geo);
  t.type.fill(Tile.Rock);
  const centre = 32 * 64 + 32;
  for (const i of [centre - 1, centre, centre + 1]) t.type[i] = Tile.Grass;
  t.height[centre - 1] = 0; t.height[centre] = 1; t.height[centre + 1] = 2;
  const rng = new Rng(1);
  rng.next = () => 0.5;
  const env = new Environment(t, { ...defaultConfig, spreadBase: 0.5, slopeStrength: 1, windStrength: 0, windDrift: false, embers: false }, rng);
  env.ignite(centre);
  env.step(0);
  assert.equal(env.fire[centre + 1], Fire.Burning);
  assert.equal(env.fire[centre - 1], Fire.Unburnt);
});

test("placements validate combustible ignition/target and dry interior base without changing cover", () => {
  assert.ok(validGeoPlacement(geo, geo.base, "base"));
  assert.ok(validGeoPlacement(geo, geo.target, "target"));
  assert.ok(validGeoPlacement(geo, geo.ignition[0], "ignition"));
  assert.equal(validGeoPlacement(geo, 0, "ignition"), false);
  assert.equal(validGeoPlacement(geo, 0, "base"), false);
  assert.throws(() => validateGeoScenario({ ...geo, ignition: [0] }));
  assert.throws(() => validateGeoScenario({ ...geo, base: 0 }));
  assert.throws(() => validateGeoScenario({ ...geo, target: geo.base }));
  assert.throws(() => validateGeoScenario({ ...geo, ignition: [geo.target] }));
  assert.equal(terrainTarget(createTerrainFromGeo(geo)), geo.target);
  assert.deepEqual(createTerrainFromGeo(geo).type, Uint8Array.from(geo.landCover, landCoverToTile));
});

test("no-water area uses hypothetical base refill and all-inert area reports unsupported", () => {
  const dry = defaultGeoScenario({ ...source, landCover: new Array(4096).fill(30) });
  const w = new World({ maxTicks: 80, droneCount: 2 }, dry);
  assert.ok(w.baseRefillStation);
  assert.deepEqual(w.waterTiles, [dry.base]);
  assert.equal(Array.from(w.terrain.type).includes(Tile.Water), false);
  w.drones[0].water = 0;
  while (!w.finished) w.step();
  assert.ok(w.drones.every((d) => Number.isFinite(d.x) && Number.isFinite(d.y)));
  assert.throws(() => defaultGeoScenario({ ...source, landCover: new Array(4096).fill(60) }), /No suitable/);
});

test("initial supplied ignitions/wind alone apply at tick zero; explicit preburn reproduces", () => {
  const w = new World({ ignitions: 12, preburnTicks: 100, windDrift: false }, geo);
  assert.equal(w.tick, 0);
  assert.equal(w.env.burningCount(), 1);
  assert.equal(w.env.fire[geo.ignition[0]], Fire.Burning);
  assert.deepEqual(w.env.wind, geo.wind);
  assert.equal(w.cfg.preburnTicks, 0);
  const preburn = validateGeoScenario({ ...geo, preburnTicks: 15 });
  const a = new World({ seed: 7 }, preburn);
  const b = new World({ seed: 7 }, preburn);
  assert.deepEqual(a.env.fire, b.env.fire);
  assert.deepEqual(a.env.smoke, b.env.smoke);
});

test("deserialized inputs are bounded, finite, complete, copied and immutable", () => {
  const restored = validateGeoScenario(JSON.parse(JSON.stringify(geo)));
  assert.deepEqual(restored, geo);
  assert.notEqual(restored.elevationM, geo.elevationM);
  assert.ok(Object.isFrozen(restored) && Object.isFrozen(restored.elevationM) && Object.isFrozen(restored.metadata.attribution));
  for (const bad of [
    { ...geo, elevationM: [] }, { ...geo, elevationM: [...geo.elevationM, 0] }, { ...geo, version: 2 },
    { ...geo, elevationM: new Array(4096).fill(Infinity) }, { ...geo, landCover: new Array(4096).fill(0) },
    { ...geo, ignition: new Array(17).fill(geo.ignition[0]) }, { ...geo, preburnTicks: 121 },
    { ...geo, metadata: { ...geo.metadata, label: "x".repeat(161) } },
  ]) assert.throws(() => validateGeoScenario(bad));
});

test("same snapshot + seed + judge log reproduce terrain, fire arrays and final metrics", () => {
  const cfg = { seed: 9, maxTicks: 180, droneCount: 3 };
  const a = new World(cfg, geo);
  const actions = [
    { tick: 5, action: { type: "wind" as const, angle: 0.2, speed: 0.8 } },
    { tick: 20, action: { type: "baseComms" as const, online: false } },
    { tick: 35, action: { type: "crash" as const, id: 1 } },
  ];
  const cursor = new ReplayCursor(actions);
  while (!a.finished) { cursor.applyDue(a); a.step(); }
  const b = new World(a.initialCfg, a.initialGeo);
  const replay = new ReplayCursor(a.judgeLog);
  while (!b.finished) { replay.applyDue(b); b.step(); }
  assert.deepEqual(a.terrain.height, b.terrain.height);
  assert.deepEqual(a.terrain.type, b.terrain.type);
  for (const field of ["fire", "severity", "burnLeft", "wetness", "smoke"] as const) assert.deepEqual(a.env[field], b.env[field]);
  assert.deepEqual(a.metrics(), b.metrics());
  assert.deepEqual(a.metrics(), runScenario(a.initialCfg, a.judgeLog, a.initialGeo));
});

test("all modes retain the exact immutable inputs and own independent typed arrays", () => {
  const before = JSON.stringify(geo);
  for (const mode of ["swarm", "central", "greedy", "cbba", "unified"] as Mode[]) {
    const a = new World({ mode, maxTicks: 35, droneCount: 2 }, geo);
    assert.deepEqual(a.initialGeo, geo);
    assert.notEqual(a.terrain.height, createTerrainFromGeo(geo).height);
    a.terrain.height[0] = 999;
    a.terrain.type[0] = Tile.Rock;
    applyJudgeAction(a, { type: "wind", angle: 2, speed: 0.1 });
    a.runToEnd();
    assert.equal(JSON.stringify(geo), before);
    assert.equal(a.initialGeo!.elevationM[0], source.elevationM[0]);
    assert.ok(a.drones.every((d) => d.lastZones.every((z) => Number.isFinite(z.value))));
    if (a.unified) {
      for (const d of a.drones) assert.ok(a.unified.agent(d.id).theta.every(Number.isFinite));
    }
  }
});

console.log(`Geographic simulation: ${checks} tests passed`);
