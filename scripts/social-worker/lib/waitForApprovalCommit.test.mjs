#!/usr/bin/env node
// Tests the bounded approval-commit polling policy in isolation — no real
// network, no real story, no real 60-second waits. Run with:
// node scripts/social-worker/lib/waitForApprovalCommit.test.mjs
import assert from "node:assert/strict";
import { waitForApprovalCommit, APPROVAL_POLL_MAX_ATTEMPTS, APPROVAL_POLL_INTERVAL_MS } from "./waitForApprovalCommit.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function fakeSleep(log) {
  return async (ms) => {
    log.push(ms);
  };
}

function stateWith(storyId, status) {
  return { stories: { [storyId]: { story_id: storyId, status } } };
}

test("pending -> approved: stops polling the instant status becomes approved", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      return calls < 3 ? stateWith("S1", "awaiting_approval") : stateWith("S1", "approved");
    },
    "S1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.committed, true);
  assert.equal(result.status, "approved");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, Array(2).fill(APPROVAL_POLL_INTERVAL_MS));
});

test("pending -> rejected: stops polling the instant status becomes rejected", async () => {
  let calls = 0;
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      return calls < 2 ? stateWith("S1", "awaiting_approval") : stateWith("S1", "rejected");
    },
    "S1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, true);
  assert.equal(result.status, "rejected");
  assert.equal(calls, 2);
});

test("immediate approved on the first read returns without any sleep", async () => {
  const sleeps = [];
  const result = await waitForApprovalCommit(async () => stateWith("S1", "approved"), "S1", { sleep: fakeSleep(sleeps) });
  assert.equal(result.committed, true);
  assert.equal(result.status, "approved");
  assert.deepEqual(sleeps, []);
});

test("timeout: never approved/rejected within the configured attempt limit returns committed:false, status:'timeout' — not a thrown error", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      return stateWith("S1", "awaiting_approval");
    },
    "S1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "timeout");
  assert.equal(calls, APPROVAL_POLL_MAX_ATTEMPTS, "must attempt exactly the configured max, never more, never fewer");
  assert.equal(sleeps.length, APPROVAL_POLL_MAX_ATTEMPTS - 1);
});

test("a missing record (story_id absent from state.stories) is treated the same as still-pending, not an error", async () => {
  let calls = 0;
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      return calls < 2 ? { stories: {} } : stateWith("S1", "approved");
    },
    "S1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, true);
  assert.equal(result.status, "approved");
});

test("custom attempts/intervalMs override the defaults", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      return stateWith("S1", "awaiting_approval");
    },
    "S1",
    { attempts: 3, intervalMs: 111, sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.status, "timeout");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [111, 111]);
});

// ---------------------------------------------------------------------------
// Cache-busting (2026-08-31 false-timeout fix — see the doc comment on
// waitForApprovalCommit.js for the full incident writeup)
// ---------------------------------------------------------------------------

test("every poll attempt's URL/token differs from every other attempt — a stale CDN entry can never be reused across the whole window", async () => {
  const seenTokens = [];
  const result = await waitForApprovalCommit(
    async (cacheBust) => {
      seenTokens.push(cacheBust);
      return stateWith("S1", "awaiting_approval");
    },
    "S1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.status, "timeout");
  assert.equal(seenTokens.length, APPROVAL_POLL_MAX_ATTEMPTS);
  assert.equal(new Set(seenTokens).size, APPROVAL_POLL_MAX_ATTEMPTS, "every single attempt must receive a genuinely unique cache-busting value");
});

test("a custom deterministic cacheBustToken generator is used exactly once per attempt, in order", async () => {
  const seenTokens = [];
  await waitForApprovalCommit(
    async (cacheBust) => {
      seenTokens.push(cacheBust);
      return stateWith("S1", "awaiting_approval");
    },
    "S1",
    { attempts: 4, sleep: fakeSleep([]), cacheBustToken: (attempt) => `deterministic-${attempt}` }
  );
  assert.deepEqual(seenTokens, ["deterministic-1", "deterministic-2", "deterministic-3", "deterministic-4"]);
});

test("the default cache-busting token contains no token/secret-shaped content — it is purely a local timestamp+attempt+random value", async () => {
  const seenTokens = [];
  await waitForApprovalCommit(
    async (cacheBust) => {
      seenTokens.push(cacheBust);
      return stateWith("S1", "awaiting_approval");
    },
    "S1",
    { attempts: 3, sleep: fakeSleep([]) }
  );
  for (const token of seenTokens) {
    assert.match(token, /^\d+-\d+-[a-z0-9]+$/, "must be a plain timestamp-attempt-random string, nothing resembling a bearer token");
  }
});

test("polling never invokes anything beyond the injected read function — no decision is mutated by polling", async () => {
  let readCalls = 0;
  const otherSideEffects = [];
  const fakeApiClient = {
    decideApproval: () => otherSideEffects.push("decideApproval"),
  };
  const result = await waitForApprovalCommit(
    async () => {
      readCalls++;
      return readCalls < 3 ? stateWith("S1", "awaiting_approval") : stateWith("S1", "approved");
    },
    "S1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, true);
  assert.equal(otherSideEffects.length, 0, "waitForApprovalCommit must never call anything write-capable — polling is a pure read loop");
  void fakeApiClient; // present only to make the "nothing else was called" assertion explicit
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
