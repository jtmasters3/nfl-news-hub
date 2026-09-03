#!/usr/bin/env node
// Tests the exact wording of the caption-claim readiness-timeout message —
// the 2026-09-03 incident this fixes was caused by a message that told the
// operator to "retry Story generation" for a Story that had already
// generated, uploaded, and validated successfully (only its GitHub commit
// was delayed). Run with:
// node scripts/social-worker/lib/readinessMessages.test.mjs
import assert from "node:assert/strict";
import { describeReadinessTimeout } from "./readinessMessages.js";

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
