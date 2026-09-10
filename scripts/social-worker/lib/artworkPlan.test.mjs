#!/usr/bin/env node
// Stage 3B — destination-routing decision tests. Run with:
// node scripts/social-worker/lib/artworkPlan.test.mjs
import assert from "node:assert/strict";
import { determineArtworkPlan } from "./artworkPlan.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("Story-selected entry: only Story is attempted, never Feed, never legacy Story-after-Feed", () => {
  const plan = determineArtworkPlan({ destination: "story", content_package_version: 2 });
  assert.deepEqual(plan, { attemptFeed: false, attemptPrimaryStory: true, attemptLegacyStoryAfterFeed: false });
});

test("Feed-selected v2 entry: Feed only, legacy Story-after-Feed is skipped", () => {
  const plan = determineArtworkPlan({ destination: "feed", content_package_version: 2 });
  assert.deepEqual(plan, { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: false });
});

test("Feed-selected v1 entry: Feed only (v1 never required Story anyway)", () => {
  const plan = determineArtworkPlan({ destination: "feed", content_package_version: 1 });
  assert.deepEqual(plan, { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: false });
});

test("legacy v2 entry with NO destination at all: existing paired behavior preserved (Feed then Story)", () => {
  const plan = determineArtworkPlan({ content_package_version: 2 });
  assert.deepEqual(plan, { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: true });
});

test("legacy v1 entry with NO destination at all: Feed only, exactly as always", () => {
  const plan = determineArtworkPlan({ content_package_version: 1 });
  assert.deepEqual(plan, { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: false });
});

test("entry with no content_package_version at all defaults to legacy v1 behavior", () => {
  const plan = determineArtworkPlan({});
  assert.deepEqual(plan, { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: false });
});

test("undefined/null target does not throw, defaults to Feed-only", () => {
  assert.deepEqual(determineArtworkPlan(undefined), { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: false });
  assert.deepEqual(determineArtworkPlan(null), { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed: false });
});

test("a Story-selected plan never sets attemptFeed, even if content_package_version is 1 (destination is authoritative over version)", () => {
  const plan = determineArtworkPlan({ destination: "story", content_package_version: 1 });
  assert.equal(plan.attemptFeed, false);
  assert.equal(plan.attemptPrimaryStory, true);
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
