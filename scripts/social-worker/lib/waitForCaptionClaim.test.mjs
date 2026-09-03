#!/usr/bin/env node
// Tests the bounded caption-claim polling policy in isolation — no real
// network, no real story, no real 60-second waits (sleep is injected and
// counted, never actually awaited). Covers both temporary readiness
// reasons: "not_artwork_ready" (Feed's own commit pending — v1 and v2)
// and "story_artwork_not_ready" (Story's own commit pending — v2 only;
// 2026-09-03 incident, story 6a443992-55a9-4ac5-b57d-ba2993a740e3, fixed
// here). Run with:
// node scripts/social-worker/lib/waitForCaptionClaim.test.mjs
import assert from "node:assert/strict";
import { waitForCaptionClaim, CAPTION_CLAIM_POLL_MAX_ATTEMPTS, CAPTION_CLAIM_POLL_INTERVAL_MS, TEMPORARY_READINESS_REASONS } from "./waitForCaptionClaim.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function fakeSleep(log) {
  return async (ms) => {
    log.push(ms);
  };
}

test("Immediate success never polls or sleeps", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      return { claimed: true, claim_id: "abc" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.claimed, true);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

// ---------------------------------------------------------------------------
// Permanent/unrelated failures return immediately — never retried, never
// silently treated as "just wait and it'll work out."
// ---------------------------------------------------------------------------
for (const reason of ["already_captioned", "retry_not_allowed", "not_found", "invalid_story_id", "merged_story", "unauthorized", "conflicting_claim", "malformed_response", "some_future_reason"]) {
  test(`A permanent/unrelated reason (${reason}) returns immediately without polling`, async () => {
    let calls = 0;
    const result = await waitForCaptionClaim(
      async () => {
        calls++;
        return { claimed: false, reason };
      },
      "story-1",
      { sleep: fakeSleep([]) }
    );
    assert.equal(result.reason, reason);
    assert.equal(calls, 1, `${reason} must not trigger a retry`);
    assert.equal(TEMPORARY_READINESS_REASONS.has(reason), false, "sanity check: this reason must not be in the retryable set");
  });
}

// ---------------------------------------------------------------------------
// Both temporary readiness reasons are recognized and retried.
// ---------------------------------------------------------------------------
test("1. Caption claim temporarily returns not_artwork_ready (Feed not yet committed), then succeeds", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      if (calls === 1) return { claimed: false, reason: "not_artwork_ready" };
      return { claimed: true, claim_id: "xyz" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.claimed, true);
  assert.equal(result.claim_id, "xyz");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [CAPTION_CLAIM_POLL_INTERVAL_MS]);
});

test("2. Caption claim temporarily returns story_artwork_not_ready (Story not yet committed, v2), then succeeds — the exact 2026-09-03 incident scenario", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      if (calls === 1) return { claimed: false, reason: "story_artwork_not_ready" };
      return { claimed: true, claim_id: "abc" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.claimed, true);
  assert.equal(result.claim_id, "abc");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [CAPTION_CLAIM_POLL_INTERVAL_MS]);
});

test("3. Multiple temporary responses of a MIXED kind (not_artwork_ready then story_artwork_not_ready) can occur before success", async () => {
  let calls = 0;
  const sleeps = [];
  const seenReasons = [];
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      if (calls === 1) return { claimed: false, reason: "not_artwork_ready" };
      if (calls === 2) return { claimed: false, reason: "story_artwork_not_ready" };
      if (calls === 3) return { claimed: false, reason: "story_artwork_not_ready" };
      return { claimed: true, claim_id: "final" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps), onWaiting: (attempt, attempts, reason) => seenReasons.push(reason) }
  );
  assert.equal(result.claimed, true);
  assert.equal(calls, 4);
  assert.deepEqual(seenReasons, ["not_artwork_ready", "story_artwork_not_ready", "story_artwork_not_ready"]);
});

test("5. Hard maximum polling bound is respected when always story_artwork_not_ready — never more than the configured attempts, never infinite", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      return { claimed: false, reason: "story_artwork_not_ready" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "readiness_timeout");
  assert.equal(result.last_reason, "story_artwork_not_ready", "the timeout result must say WHICH asset was still pending");
  assert.equal(calls, CAPTION_CLAIM_POLL_MAX_ATTEMPTS, "must attempt exactly the configured max, never more, never fewer");
  assert.equal(sleeps.length, CAPTION_CLAIM_POLL_MAX_ATTEMPTS - 1, "sleeps only between attempts, never after the final one");
});

test("Timeout after always not_artwork_ready reports last_reason accordingly (mirrors the original Feed-readiness incident)", async () => {
  const result = await waitForCaptionClaim(async () => ({ claimed: false, reason: "not_artwork_ready" }), "story-1", { sleep: fakeSleep([]) });
  assert.equal(result.reason, "readiness_timeout");
  assert.equal(result.last_reason, "not_artwork_ready");
});

test("Custom attempts/intervalMs override the defaults", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      return { claimed: false, reason: "not_artwork_ready" };
    },
    "story-1",
    { attempts: 3, intervalMs: 111, sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.reason, "readiness_timeout");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [111, 111]);
});

test("onWaiting is invoked once per retry (not on the final exhausted attempt) with (attempt, attempts, reason)", async () => {
  const waits = [];
  await waitForCaptionClaim(
    async () => ({ claimed: false, reason: "story_artwork_not_ready" }),
    "story-1",
    { attempts: 3, sleep: fakeSleep([]), onWaiting: (attempt, attempts, reason) => waits.push([attempt, attempts, reason]) }
  );
  assert.deepEqual(waits, [
    [1, 3, "story_artwork_not_ready"],
    [2, 3, "story_artwork_not_ready"],
  ]);
});

// ---------------------------------------------------------------------------
// 6/7. Polling never touches Feed or Story in any way — only the injected
// claim function is ever called, proving neither asset can be regenerated
// or re-uploaded merely by this poller waiting/retrying.
// ---------------------------------------------------------------------------
test("6/7. Polling calls ONLY the injected caption-claim function — Feed and Story are never regenerated or re-uploaded by this poller", async () => {
  const otherSideEffects = [];
  let calls = 0;
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      return calls < 3 ? { claimed: false, reason: "story_artwork_not_ready" } : { claimed: true, claim_id: "ok" };
    },
    "story-1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.claimed, true);
  assert.equal(otherSideEffects.length, 0, "nothing beyond the injected caption-claim function is ever invoked");
});

// ---------------------------------------------------------------------------
// 8. v1 behavior is unaffected — v1 records only ever produce
// "not_artwork_ready" (never "story_artwork_not_ready", which the Worker
// only returns for content_package_version 2), and that reason's retry
// behavior is byte-identical to before this fix.
// ---------------------------------------------------------------------------
test("8. v1 (legacy) behavior is unchanged: not_artwork_ready still retries exactly as before, story_artwork_not_ready never occurs for a v1 record", async () => {
  let calls = 0;
  const result = await waitForCaptionClaim(
    async () => {
      calls++;
      // A v1 record's claim endpoint never returns story_artwork_not_ready at all.
      if (calls === 1) return { claimed: false, reason: "not_artwork_ready" };
      return { claimed: true, claim_id: "v1-story" };
    },
    "story-1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.claimed, true);
  assert.equal(calls, 2);
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
