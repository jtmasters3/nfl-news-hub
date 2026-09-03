#!/usr/bin/env node
// Tests the pure Feed+Story recovery-route decision — no network, no real
// story. Run with: node scripts/social-worker/lib/routeRecovery.test.mjs
import assert from "node:assert/strict";
import { determineRecoveryAction } from "./routeRecovery.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function readyStoryArtwork() {
  return { status: "created", validation: { status: "passed", passed: true, issues: [] } };
}
function notReadyStoryArtwork(status = "not_created") {
  return { status, validation: { status: "not_run", passed: null, issues: [] } };
}

test("a legacy record (no content_package_version field) at artwork_ready routes to caption_only — matches the real Josh Allen/Puka Nacua/Jets shape", () => {
  const record = { status: "artwork_ready" };
  assert.equal(determineRecoveryAction(record), "caption_only");
});

test("an explicit content_package_version 1 record routes to caption_only regardless of story_artwork", () => {
  const record = { status: "artwork_ready", content_package_version: 1, story_artwork: notReadyStoryArtwork() };
  assert.equal(determineRecoveryAction(record), "caption_only");
});

test("a v2 record whose Story artwork was never attempted routes to story_only", () => {
  const record = { status: "artwork_ready", content_package_version: 2, story_artwork: notReadyStoryArtwork("not_created") };
  assert.equal(determineRecoveryAction(record), "story_only");
});

test("a v2 record whose Story artwork failed validation routes to story_only", () => {
  const record = { status: "artwork_ready", content_package_version: 2, story_artwork: notReadyStoryArtwork("failed") };
  assert.equal(determineRecoveryAction(record), "story_only");
});

test("a v2 record whose Story artwork is created but validation hasn't passed routes to story_only", () => {
  const record = { status: "artwork_ready", content_package_version: 2, story_artwork: { status: "created", validation: { status: "failed", passed: false, issues: ["aspect_ratio_out_of_range:1.100"] } } };
  assert.equal(determineRecoveryAction(record), "story_only");
});

test("a v2 record whose Story artwork is created AND validation passed routes to caption_only", () => {
  const record = { status: "artwork_ready", content_package_version: 2, story_artwork: readyStoryArtwork() };
  assert.equal(determineRecoveryAction(record), "caption_only");
});

test("a record not at artwork_ready (e.g. still validating) routes to none — recovery logic doesn't apply", () => {
  assert.equal(determineRecoveryAction({ status: "validating", content_package_version: 2 }), "none");
  assert.equal(determineRecoveryAction({ status: "awaiting_approval", content_package_version: 2 }), "none");
  assert.equal(determineRecoveryAction({ status: "failed", content_package_version: 2 }), "none");
});

test("a null/missing record routes to none", () => {
  assert.equal(determineRecoveryAction(null), "none");
  assert.equal(determineRecoveryAction(undefined), "none");
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
