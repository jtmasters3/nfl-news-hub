#!/usr/bin/env node
// Tests the exact wording of the caption-claim readiness-wait/-timeout
// messages.
//   - 2026-09-03 incident: a message that told the operator to "retry
//     Story generation" for a Story that had already generated, uploaded,
//     and validated successfully (only its GitHub commit was delayed).
//   - 2026-09-14 incident: "not_artwork_ready" was always labeled "Feed
//     artwork" regardless of the record's own Stage 3A
//     selection.destination — wrong for a Story-only record (Feed is
//     intentionally never attempted at all), proven against story_id
//     0cba51db-8c38-436f-ae48-a4af46e9f6bd.
// Run with: node scripts/social-worker/lib/readinessMessages.test.mjs
import assert from "node:assert/strict";
import { describeReadinessTimeout, describeArtworkAsset } from "./readinessMessages.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("10. never instructs regenerating a possibly-already-valid Story", () => {
  const msg = describeReadinessTimeout({ lastReason: "story_artwork_not_ready", storyId: "S1", totalSeconds: 60 });
  assert.ok(!/regenerate/i.test(msg), "must never say 'regenerate'");
  assert.ok(!/retry story generation/i.test(msg), "must never say 'retry Story generation' — the old, dangerous 2026-09-03 wording");
  assert.ok(msg.includes("Story artwork"), "must correctly identify Story as the pending asset");
  assert.ok(/may only be a GitHub state-commit delay/.test(msg));
  assert.ok(/may already be valid/.test(msg));
  assert.ok(/preserved and untouched/.test(msg));
});

test("10. never instructs regenerating a possibly-already-valid Feed", () => {
  const msg = describeReadinessTimeout({ lastReason: "not_artwork_ready", storyId: "S1", totalSeconds: 60 });
  assert.ok(!/regenerate/i.test(msg));
  assert.ok(msg.includes("Feed artwork"), "must correctly identify Feed as the pending asset when that was the last reason seen");
});

test("always instructs a plain rerun with the same --story-id, never a manual/alternate recovery step", () => {
  const msg = describeReadinessTimeout({ lastReason: "story_artwork_not_ready", storyId: "6a443992-55a9-4ac5-b57d-ba2993a740e3", totalSeconds: 60 });
  assert.ok(msg.includes("--story-id=6a443992-55a9-4ac5-b57d-ba2993a740e3"));
  assert.ok(/automatically resume/.test(msg));
});

// ---------------------------------------------------------------------------
// 2026-09-14 — destination-aware "not_artwork_ready" labeling
// ---------------------------------------------------------------------------

test("11. describeArtworkAsset labels not_artwork_ready as 'Story artwork' for a Story-selected record — the exact proven production bug (story_id 0cba51db-8c38-436f-ae48-a4af46e9f6bd)", () => {
  assert.equal(describeArtworkAsset({ reason: "not_artwork_ready", destination: "story" }), "Story artwork");
});

test("12. describeArtworkAsset labels not_artwork_ready as 'Feed artwork' for a Feed-selected record", () => {
  assert.equal(describeArtworkAsset({ reason: "not_artwork_ready", destination: "feed" }), "Feed artwork");
});

test("13. describeArtworkAsset labels not_artwork_ready as 'Feed artwork' when destination is unknown — the legacy/paired-assets default, unchanged from before this fix", () => {
  assert.equal(describeArtworkAsset({ reason: "not_artwork_ready" }), "Feed artwork");
  assert.equal(describeArtworkAsset({ reason: "not_artwork_ready", destination: undefined }), "Feed artwork");
});

test("14. describeArtworkAsset labels story_artwork_not_ready as 'Story artwork' regardless of destination — that reason is already unambiguous on its own", () => {
  assert.equal(describeArtworkAsset({ reason: "story_artwork_not_ready", destination: "feed" }), "Story artwork");
  assert.equal(describeArtworkAsset({ reason: "story_artwork_not_ready" }), "Story artwork");
});

test("15. describeReadinessTimeout correctly names Story for a Story-selected record even though the underlying reason was the generic not_artwork_ready", () => {
  const msg = describeReadinessTimeout({ lastReason: "not_artwork_ready", storyId: "0cba51db-8c38-436f-ae48-a4af46e9f6bd", totalSeconds: 60, destination: "story" });
  assert.ok(msg.includes("Story artwork"), "must never say Feed artwork for a Story-only record");
  assert.ok(!msg.includes("Feed artwork"));
});

test("16. describeReadinessTimeout still correctly names Feed for a Feed-selected (or legacy) record with not_artwork_ready", () => {
  const msg = describeReadinessTimeout({ lastReason: "not_artwork_ready", storyId: "S1", totalSeconds: 60, destination: "feed" });
  assert.ok(msg.includes("Feed artwork"));
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
