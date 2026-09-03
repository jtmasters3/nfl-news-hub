#!/usr/bin/env node
// Tests the bounded story-artwork-claim polling policy in isolation — no
// real network, no real story, no real 60-second waits (sleep is injected
// and counted, never actually awaited). Run with:
// node scripts/social-worker/lib/waitForStoryArtworkClaim.test.mjs
import assert from "node:assert/strict";
import { waitForStoryArtworkClaim, STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS, STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS } from "./waitForStoryArtworkClaim.js";

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
  const result = await waitForStoryArtworkClaim(
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

for (const reason of ["already_captioned", "retry_not_allowed", "not_found", "invalid_story_id", "merged_story", "some_future_reason"]) {
  test(`An immediate non-retryable reason (${reason}) returns without polling — unrelated claim failures are never polled`, async () => {
    let calls = 0;
    const result = await waitForStoryArtworkClaim(
      async () => {
        calls++;
        return { claimed: false, reason };
      },
      "story-1",
      { sleep: fakeSleep([]) }
    );
    assert.equal(result.reason, reason);
    assert.equal(calls, 1, `${reason} must not trigger a retry`);
  });
}

test("First claim returns not_artwork_ready, a later claim succeeds once Feed's commit catches up — polling continues until success", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForStoryArtworkClaim(
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
  assert.deepEqual(sleeps, [STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS]);
});

test("Multiple not_artwork_ready responses then success — polls exactly as many times as needed, at the fixed interval", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForStoryArtworkClaim(
    async () => {
      calls++;
      if (calls < 5) return { claimed: false, reason: "not_artwork_ready" };
      return { claimed: true, claim_id: "final" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.claimed, true);
  assert.equal(calls, 5);
  assert.deepEqual(sleeps, Array(4).fill(STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS));
});

test(`Always not_artwork_ready exhausts exactly at the configured attempt limit (${STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS}, hard upper bound — never infinite) and returns the synthetic timeout reason`, async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForStoryArtworkClaim(
    async () => {
      calls++;
      return { claimed: false, reason: "not_artwork_ready" };
    },
    "story-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "not_artwork_ready_timeout");
  assert.equal(calls, STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS, "must attempt exactly the configured max, never more, never fewer");
  assert.equal(sleeps.length, STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS - 1);
});

test("Custom attempts/intervalMs override the defaults", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForStoryArtworkClaim(
    async () => {
      calls++;
      return { claimed: false, reason: "not_artwork_ready" };
    },
    "story-1",
    { attempts: 3, intervalMs: 111, sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.reason, "not_artwork_ready_timeout");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [111, 111]);
});

test("onWaiting is invoked once per retry (not on the final exhausted attempt)", async () => {
  const waits = [];
  await waitForStoryArtworkClaim(
    async () => ({ claimed: false, reason: "not_artwork_ready" }),
    "story-1",
    { attempts: 3, sleep: fakeSleep([]), onWaiting: (attempt, attempts) => waits.push([attempt, attempts]) }
  );
  assert.deepEqual(waits, [
    [1, 3],
    [2, 3],
  ]);
});

test("polling calls ONLY the injected claim function — never a Feed claim/complete function, so Feed can never be re-generated or re-uploaded while waiting", async () => {
  const otherCalls = [];
  let claimCalls = 0;
  await waitForStoryArtworkClaim(
    async () => {
      claimCalls++;
      return claimCalls < 3 ? { claimed: false, reason: "not_artwork_ready" } : { claimed: true, claim_id: "ok" };
    },
    "story-1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(otherCalls.length, 0, "nothing beyond the injected Story claim function is ever invoked by the poll loop");
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
