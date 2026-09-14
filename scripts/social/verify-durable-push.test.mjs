#!/usr/bin/env node
// Tests the pure post-push comparison this durability check relies on — no
// network, no real GitHub API call, no real file I/O. Run with:
// node scripts/social/verify-durable-push.test.mjs
import assert from "node:assert/strict";
import { checkDurableExpectation } from "./verify-durable-push.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("1. the expected value present at the expected path for the expected story_id passes", () => {
  const state = { stories: { s1: { caption: { text: "final caption" } } } };
  assert.equal(checkDurableExpectation(state, { story_id: "s1", path: ["caption", "text"], expected: "final caption" }), true);
});

test("2. a still-stale read (field not yet present) fails — this is the exact race the retry loop around this check exists to survive", () => {
  const state = { stories: { s1: { caption: { text: null } } } };
  assert.equal(checkDurableExpectation(state, { story_id: "s1", path: ["caption", "text"], expected: "final caption" }), false);
});

test("3. a completely missing story_id fails, never throws", () => {
  const state = { stories: {} };
  assert.equal(checkDurableExpectation(state, { story_id: "s1", path: ["caption", "text"], expected: "final caption" }), false);
});

test("4. a missing intermediate object in the path fails, never throws", () => {
  const state = { stories: { s1: {} } };
  assert.equal(checkDurableExpectation(state, { story_id: "s1", path: ["caption", "text"], expected: "final caption" }), false);
});

test("5. a wrong (different, e.g. superseded-claim) value at the expected path fails", () => {
  const state = { stories: { s1: { caption: { text: "a different caption entirely" } } } };
  assert.equal(checkDurableExpectation(state, { story_id: "s1", path: ["caption", "text"], expected: "final caption" }), false);
});

test("6. a null/undefined state never throws", () => {
  assert.equal(checkDurableExpectation(null, { story_id: "s1", path: ["caption", "text"], expected: "x" }), false);
  assert.equal(checkDurableExpectation(undefined, { story_id: "s1", path: ["caption", "text"], expected: "x" }), false);
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
