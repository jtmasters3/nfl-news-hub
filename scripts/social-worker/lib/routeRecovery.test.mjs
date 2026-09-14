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
// Stage 3B: destination-aware recovery routing
// ---------------------------------------------------------------------------

test("Stage 3B: a Feed-selected v2 record at artwork_ready with no story_artwork routes to caption_only, NOT story_only — Story was never supposed to be attempted", () => {
  const record = {
    status: "artwork_ready",
    content_package_version: 2,
    selection: { destination: "feed", slot_id: "feed:2026-09-09T22:00:00-04:00" },
  };
  assert.equal(determineRecoveryAction(record), "caption_only");
});

test("Stage 3B: a Feed-selected v2 record at artwork_ready with a stale/failed story_artwork STILL routes to caption_only — never resurrected into a Story claim", () => {
  const record = {
    status: "artwork_ready",
    content_package_version: 2,
    selection: { destination: "feed", slot_id: "feed:2026-09-09T22:00:00-04:00" },
    story_artwork: notReadyStoryArtwork("failed"),
  };
  assert.equal(determineRecoveryAction(record), "caption_only");
});

test("Stage 3B: a Story-selected record at artwork_ready (its Story succeeded, which is what drove artwork_ready) routes to caption_only", () => {
  const record = {
    status: "artwork_ready",
    content_package_version: 2,
    selection: { destination: "story", slot_id: "story:2026-09-09T20:00:00-04:00" },
    story_artwork: readyStoryArtwork(),
  };
  assert.equal(determineRecoveryAction(record), "caption_only");
});

// ---------------------------------------------------------------------------
// 2026-09-14 fix: a REAL Stage 3A Story-primary completion never populates
// story_artwork.validation at all (applyCompleteEvent writes the actual
// pass/fail outcome into the record's TOP-LEVEL `validation` field for
// EVERY primary completion, Feed or Story alike) — the test above used an
// unrealistic fixture that happened to also set story_artwork.validation,
// masking a latent bug where this function fell through to the legacy
// paired-assets check (which DOES read story_artwork.validation) and
// would have incorrectly returned "story_only" for an already-successful
// Story-primary record, reclaiming and regenerating artwork that was
// already valid. Proven against story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd.
// ---------------------------------------------------------------------------

test("2026-09-14: a Story-selected record at artwork_ready with the EXACT REAL shape a Story-primary completion actually produces (story_artwork.validation never populated; the real outcome lives in the top-level validation field) still routes to caption_only, never story_only", () => {
  const record = {
    status: "artwork_ready",
    content_package_version: 2,
    selection: { destination: "story", slot_id: "story:2026-09-09T20:00:00-04:00" },
    validation: { status: "passed", passed: true, issues: [] },
    story_artwork: {
      status: "created",
      image_url: "https://example.test/x.png",
      width: 1080,
      height: 1920,
      // The real applyCompleteEvent() shape — validation stays at its
      // pristine default here; it is NOT where the pass/fail outcome lives
      // for a Story-primary record.
      validation: { status: "not_run", passed: null, issues: [] },
    },
  };
  assert.equal(determineRecoveryAction(record), "caption_only", "must never reclaim/regenerate an already-successful Story-primary asset");
});

test("2026-09-14: a Story-selected record at artwork_ready with NO story_artwork object at all (e.g. a stripped-down fixture) still routes to caption_only — destination alone is authoritative, no field on story_artwork is ever consulted", () => {
  const record = {
    status: "artwork_ready",
    content_package_version: 2,
    selection: { destination: "story", slot_id: "story:test" },
  };
  assert.equal(determineRecoveryAction(record), "caption_only");
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
