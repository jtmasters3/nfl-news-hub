#!/usr/bin/env node
// Reproduces the exact 2026-08-28 f4328222-15b2-4086-b9fb-04f7f5ec9e6f
// failure mode at the unit level: an explicit --story-id used to bypass
// the queue lookup entirely, producing a target with no post_headline/
// base_image_url — Codex correctly refused to fabricate, but only after a
// real claim/lease had already been burned. Run with:
// node scripts/social-worker/lib/selectTarget.test.mjs
import assert from "node:assert/strict";
import { selectTarget, missingFixtureFields } from "./selectTarget.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const FULL_QUEUE = [
  {
    story_id: "f4328222-15b2-4086-b9fb-04f7f5ec9e6f",
    post_headline: "BILL BELICHICK CONTINUES TO SAY HE'S FOCUSED ON UNC",
    base_image_url: "https://example.test/belichick.jpg",
    source_name: "Pro Football Talk",
    source_url: "https://example.test/story",
  },
  { story_id: "OTHER-STORY", post_headline: "X", base_image_url: "https://example.test/x.jpg" },
];

test("selectTarget with an explicit --story-id present in the queue returns the FULL entry, not a bare id", () => {
  const target = selectTarget(FULL_QUEUE, "f4328222-15b2-4086-b9fb-04f7f5ec9e6f");
  assert.equal(target.post_headline, "BILL BELICHICK CONTINUES TO SAY HE'S FOCUSED ON UNC");
  assert.equal(target.base_image_url, "https://example.test/belichick.jpg");
  assert.equal(missingFixtureFields(target).length, 0, "a queue-matched target must always be immediately usable");
});

test("selectTarget with no --story-id takes the front of the queue", () => {
  const target = selectTarget(FULL_QUEUE, null);
  assert.equal(target.story_id, "f4328222-15b2-4086-b9fb-04f7f5ec9e6f");
});

test("selectTarget with no --story-id and an empty queue returns null", () => {
  assert.equal(selectTarget([], null), null);
});

test("selectTarget with a --story-id NOT in the queue falls back to a bare object (recovery case) — and missingFixtureFields catches it", () => {
  const target = selectTarget(FULL_QUEUE, "NOT-IN-QUEUE");
  assert.deepEqual(target, { story_id: "NOT-IN-QUEUE" });
  assert.deepEqual(missingFixtureFields(target), ["post_headline", "base_image_url"]);
});

test("missingFixtureFields reports exactly which fields are absent", () => {
  assert.deepEqual(missingFixtureFields({ story_id: "X" }), ["post_headline", "base_image_url"]);
  assert.deepEqual(missingFixtureFields({ story_id: "X", post_headline: "H" }), ["base_image_url"]);
  assert.deepEqual(missingFixtureFields({ story_id: "X", post_headline: "H", base_image_url: "U" }), []);
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
