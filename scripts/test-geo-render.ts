import assert from "node:assert/strict";
import { Vector3 } from "three";
import { IsoCamera } from "../src/render/iso/camera";
import { StructureLayer } from "../src/render/iso/structures";
import { TerrainLayer } from "../src/render/iso/terrain";
import { V_SCALE } from "../src/render/iso/util";
import { BASE_MAST_HEIGHT } from "../src/sim/comms";
import { validateGeoScenario } from "../src/sim/geography";
import { World } from "../src/sim/world";
import { syntheticGeography } from "./geo-fixture";

const snapshot = syntheticGeography();
const elevationM = Array(4096).fill(-500);
elevationM[snapshot.base + 1] = 9000;
const world = new World({ droneCount: 0 }, validateGeoScenario({ ...snapshot, sizeM: 2000, elevationM }));
const terrain = new TerrainLayer(world);
const structures = new StructureLayer(world, terrain);
assert.ok(Math.abs(structures.mastTop.y - BASE_MAST_HEIGHT * V_SCALE) < 1e-6,
  "a steep neighbour must not displace the base's radio endpoint above its physical altitude");
assert.ok(structures.padTopY < 0.2, "hypothetical pad is anchored to its own cell, never neighbouring relief");
for (const aspect of [0.5, 1, 2]) {
  const rig = new IsoCamera();
  rig.frame(64,64,terrain.maxY,aspect,true);
  for (const x of [-0.5,63.5]) for (const z of [-0.5,63.5]) for (const y of [0,terrain.maxY]) {
    const p = new Vector3(x,y,z).project(rig.camera);
    assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1,
      `extreme valid terrain corner must fit: ${p.toArray()}`);
  }
}
console.log("PASS geographic extreme-relief camera bounds and physical base mast alignment");
