import assert from "node:assert/strict";
import { LatestRequest } from "../src/ui/latest-request";

// Simulate responses arriving out of order, including transports ignoring cancellation.
const selection = new LatestRequest();
const first = selection.begin();
const second = selection.begin();
assert.equal(first.signal.aborted, true);
assert.equal(first.current(), false);
assert.equal(second.current(), true);
let terrain = "current usable scenario";
if (second.current()) terrain = "newer selection";
if (first.current()) terrain = "stale selection";
assert.equal(terrain, "newer selection");
selection.cancel();
assert.equal(second.signal.aborted, true);
assert.equal(second.current(), false);
if (second.current()) terrain = "cancelled response";
assert.equal(terrain, "newer selection");
const third = selection.begin();
assert.equal(third.current(), true);
assert.equal(third.signal.aborted, false);
console.log("PASS geographic UI stale response ordering, cancellation and retry");
