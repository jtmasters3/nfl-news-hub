#!/usr/bin/env node
// Tests for the 2026-09-11 caption-completion durability fix in
// apply-artwork-event.js — the bounded claim_mismatch retry against fresh,
// SHA-pinned state, and the outcome decision that guarantees a workflow
// never reports semantic success for an unresolved claim_mismatch. Every
// dependency (applyEventByTypeImpl, fetchFreshStateImpl, sleepImpl) is
// injected — this suite makes NO real network call, spawns NO real
// GitHub Actions run, and never touches the real data/social-state.json
// file or timers.
// Run with: node scripts/social/apply-artwork-event.test.mjs
import assert from "node:assert/strict";
import { applyEventWithClaimMismatchRetry, determineApplyOutcome } from "./apply-artwork-event.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function fakeSleep(calls) {
  return async (ms) => {
    calls.push(ms);
  };
}

// ---------------------------------------------------------------------------
// applyEventWithClaimMismatchRetry
// ---------------------------------------------------------------------------

test("1. a first-attempt success never touches fetchFreshStateImpl or sleepImpl at all (the common, non-race path)", async () => {
  let fetchCalled = false;
  const sleeps = [];
  const result = await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async () => ({ ok: true, state: { stories: {} }, record: { status: "artwork_ready" } }),
      fetchFreshStateImpl: async () => { fetchCalled = true; return { local: false }; },
      sleepImpl: fakeSleep(sleeps),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false, "no retry may occur when the first attempt already succeeds");
  assert.equal(sleeps.length, 0);
});

test("2. a first-attempt failure that is NOT claim_mismatch is returned immediately, never retried", async () => {
  let fetchCalled = false;
  const result = await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async () => ({ ok: false, error: "not_found" }),
      fetchFreshStateImpl: async () => { fetchCalled = true; return {}; },
      sleepImpl: async () => {},
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_found");
  assert.equal(fetchCalled, false, "only claim_mismatch triggers a retry — every other error stays an immediate, unmodified result");
});

test("3. an unrecognized event type (null from applyEventByTypeImpl) passes straight through untouched", async () => {
  const result = await applyEventWithClaimMismatchRetry(
    { local: true },
    "some-unknown-event",
    { story_id: "s1" },
    { applyEventByTypeImpl: async () => null, fetchFreshStateImpl: async () => { throw new Error("must not be called"); } }
  );
  assert.equal(result, null);
});

test("4. RACE A/B — claim_mismatch on the frozen local checkout resolves on the very next fresh, SHA-pinned read once the sibling commit is visible", async () => {
  let applyCallCount = 0;
  const sleeps = [];
  const result = await applyEventWithClaimMismatchRetry(
    { local: true, hasClaim: false },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async (state) => {
        applyCallCount++;
        if (!state.hasClaim) return { ok: false, error: "claim_mismatch" };
        return { ok: true, state: { stories: {} }, record: { status: "awaiting_approval" } };
      },
      fetchFreshStateImpl: async () => ({ local: false, hasClaim: true }),
      sleepImpl: fakeSleep(sleeps),
    }
  );
  assert.equal(result.ok, true, "the retry must apply successfully once the fresh read shows the sibling commit");
  assert.equal(applyCallCount, 2, "exactly one initial attempt plus exactly one successful retry — no more");
  assert.equal(sleeps.length, 1, "exactly one bounded wait before the single successful retry");
});

test("5. RACE C — once a retry succeeds, the loop stops immediately and never re-applies the event again", async () => {
  let applyCallCount = 0;
  let fetchCallCount = 0;
  await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async () => {
        applyCallCount++;
        if (applyCallCount === 1) return { ok: false, error: "claim_mismatch" };
        return { ok: true, state: { stories: {} }, record: { status: "awaiting_approval" } };
      },
      fetchFreshStateImpl: async () => { fetchCallCount++; return {}; },
      sleepImpl: async () => {},
    }
  );
  assert.equal(applyCallCount, 2, "the event must be applied exactly once beyond the initial attempt — never re-applied after success");
  assert.equal(fetchCallCount, 1);
});

test("6. duplicate caption-completed delivery (already ok on the very first attempt) is a pure pass-through — idempotency itself is the reducer's own unchanged concern", async () => {
  let fetchCalled = false;
  const result = await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async () => ({ ok: true, state: { stories: {} }, record: { status: "awaiting_approval" }, idempotentReplay: true }),
      fetchFreshStateImpl: async () => { fetchCalled = true; return {}; },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(fetchCalled, false);
});

test("7. a genuinely WRONG/superseded claim_id never applies, even after exhausting the full retry budget against fresh state", async () => {
  let applyCallCount = 0;
  const sleeps = [];
  const result = await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "stale-claim" },
    {
      applyEventByTypeImpl: async () => { applyCallCount++; return { ok: false, error: "claim_mismatch" }; },
      fetchFreshStateImpl: async () => ({ different: true }),
      sleepImpl: fakeSleep(sleeps),
      attempts: 3,
      intervalMs: 1,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch", "a genuinely superseded claim must still report claim_mismatch, never a different error and never a false success");
  assert.equal(applyCallCount, 4, "one initial attempt plus exactly `attempts` retries, never more");
  assert.equal(sleeps.length, 3);
});

test("8. a fresh-state fetch failure during a retry attempt is tolerated (counted as a used attempt) and does not abort the remaining budget", async () => {
  let applyCallCount = 0;
  let fetchCallCount = 0;
  const onRetryCalls = [];
  const result = await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async (state) => {
        applyCallCount++;
        if (state.local || state.transient) return { ok: false, error: "claim_mismatch" };
        return { ok: true, state: { stories: {} }, record: { status: "awaiting_approval" } };
      },
      fetchFreshStateImpl: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) throw new Error("transient GitHub API error");
        return { local: false, transient: false };
      },
      sleepImpl: async () => {},
      attempts: 5,
      onRetry: (attempt, attempts, err) => onRetryCalls.push({ attempt, attempts, err: err ? err.message : null }),
    }
  );
  assert.equal(result.ok, true, "a transient fetch failure must not sink the whole retry — later attempts still get a chance");
  assert.equal(fetchCallCount, 2);
  assert.equal(onRetryCalls[0].err, "transient GitHub API error");
  assert.equal(onRetryCalls[1].err, null);
});

test("9. onRetry is never invoked when the first attempt already succeeds", async () => {
  const onRetryCalls = [];
  await applyEventWithClaimMismatchRetry(
    { local: true },
    "caption-completed",
    { story_id: "s1", claim_id: "claim-1" },
    {
      applyEventByTypeImpl: async () => ({ ok: true, state: { stories: {} }, record: { status: "awaiting_approval" } }),
      onRetry: (...args) => onRetryCalls.push(args),
    }
  );
  assert.equal(onRetryCalls.length, 0);
});

// ---------------------------------------------------------------------------
// determineApplyOutcome — the "never a false success" guarantee
// ---------------------------------------------------------------------------

test("10. an unresolved claim_mismatch (retry budget exhausted) must FAIL the workflow, never report success", () => {
  const outcome = determineApplyOutcome({ ok: false, error: "claim_mismatch" }, { eventType: "caption-completed", storyId: "s1" });
  assert.equal(outcome.action, "claim_mismatch_unresolved");
  assert.match(outcome.message, /persisted after \d+ retries/);
});

test("11. an unknown event type (null) fails the workflow with a clear message", () => {
  const outcome = determineApplyOutcome(null, { eventType: "some-unknown-event", storyId: "s1" });
  assert.equal(outcome.action, "unknown_event");
  assert.match(outcome.message, /Unknown ARTWORK_EVENT_TYPE/);
});

test("12. a legitimately skippable error (not_found) is a no-op, never a failure", () => {
  const outcome = determineApplyOutcome({ ok: false, error: "not_found" }, { eventType: "caption-completed", storyId: "s1" });
  assert.equal(outcome.action, "skip");
});

test("13. an invalid_state:* error is a no-op, never a failure — unchanged from before this fix", () => {
  const outcome = determineApplyOutcome({ ok: false, error: "invalid_state:posted" }, { eventType: "caption-completed", storyId: "s1" });
  assert.equal(outcome.action, "skip");
});

test("14. a genuine, non-skippable error (e.g. a validation failure) fails the workflow", () => {
  const outcome = determineApplyOutcome({ ok: false, error: "some_other_error" }, { eventType: "caption-completed", storyId: "s1" });
  assert.equal(outcome.action, "fail");
});

test("15. an ok result proceeds to apply (write state + regenerate derived files)", () => {
  const outcome = determineApplyOutcome({ ok: true, state: {}, record: {} }, { eventType: "caption-completed", storyId: "s1" });
  assert.equal(outcome.action, "apply");
  assert.equal(outcome.message, null);
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
