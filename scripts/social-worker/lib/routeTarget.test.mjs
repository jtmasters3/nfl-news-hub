#!/usr/bin/env node
// Tests the pure artwork-skip routing decision used by process-one.js's
// main() — no network, no real queue. Run with:
// node scripts/social-worker/lib/routeTarget.test.mjs
import assert from "node:assert/strict";
import { shouldSkipArtwork } from "./routeTarget.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("A story present in the live queue must run the artwork phase (not skipped)", () => {
  const queue = [{ story_id: "a" }, { story_id: "b" }];
  assert.equal(shouldSkipArtwork(queue, "b"), false);
});

test("A story absent from the live queue (artwork already complete) skips artwork — caption-only recovery, no regeneration", () => {
  const queue = [{ story_id: "a" }, { story_id: "b" }];
  assert.equal(shouldSkipArtwork(queue, "34195a7b-69d8-4225-b58b-757febe23f4d"), true);
});

test("An empty queue always skips artwork for any requested story", () => {
  assert.equal(shouldSkipArtwork([], "any-story"), true);
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
