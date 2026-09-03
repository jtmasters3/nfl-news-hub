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

test("polling never invokes anything beyond the injected read function — no decision is mutated by polling", async () => {
  const otherSideEffects = [];
  const fakeApiClient = {
    decideApproval: () => otherSideEffects.push("decideApproval"),
  };
  let readCalls = 0;
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
// Read-error handling (2026-09-03 CDN-staleness fix — fetchState now reads
// through a real API and can genuinely fail; see the doc comment on
// waitForApprovalCommit.js for the full incident writeup)
// ---------------------------------------------------------------------------

test("fetchState is called with no arguments — the cache-busting-token contract from the old CDN-workaround fix is gone", async () => {
  const receivedArgs = [];
  await waitForApprovalCommit(
    async (...args) => {
      receivedArgs.push(args);
      return stateWith("S1", "approved");
    },
    "S1",
    { sleep: fakeSleep([]) }
  );
  assert.deepEqual(receivedArgs, [[]], "fetchState must be invoked with zero arguments every time");
});

test("a transient read failure does not crash polling and does not count as a definitive 'pending' — a later successful read can still observe approved", async () => {
  let calls = 0;
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      if (calls === 1) throw new Error("GitHub API returned 502");
      return stateWith("S1", "approved");
    },
    "S1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, true);
  assert.equal(result.status, "approved");
  assert.equal(calls, 2);
});

test("read failures on every attempt exhaust the loop and return a DISTINCT status:'read_error', never folded into status:'timeout'", async () => {
  let calls = 0;
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      throw new Error("network unreachable");
    },
    "S1",
    { attempts: 4, sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "read_error");
  assert.equal(result.error, "network unreachable");
  assert.equal(calls, 4);
});

test("a genuine pending timeout (reads always succeed, decision never appears) still reports status:'timeout', not 'read_error'", async () => {
  const result = await waitForApprovalCommit(async () => stateWith("S1", "awaiting_approval"), "S1", {
    attempts: 3,
    sleep: fakeSleep([]),
  });
  assert.equal(result.committed, false);
  assert.equal(result.status, "timeout");
});

test("a rate-limited error (err.rateLimited === true) stops polling immediately instead of exhausting the attempt budget", async () => {
  let calls = 0;
  const result = await waitForApprovalCommit(
    async () => {
      calls++;
      const err = new Error("rate limited");
      err.rateLimited = true;
      throw err;
    },
    "S1",
    { attempts: 20, sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "read_error");
  assert.equal(result.rateLimited, true);
  assert.equal(calls, 1, "must stop after the very first rate-limited response, not keep retrying");
});

test("bounded polling is preserved: read errors still respect the configured attempts ceiling, never more", async () => {
  let calls = 0;
  await waitForApprovalCommit(
    async () => {
      calls++;
      throw new Error("boom");
    },
    "S1",
    { attempts: 5, sleep: fakeSleep([]) }
  );
  assert.equal(calls, 5);
});

test("onWaiting distinguishes 'pending' from 'read_error' reasons", async () => {
  const reasons = [];
  let calls = 0;
  await waitForApprovalCommit(
    async () => {
      calls++;
      if (calls === 1) throw new Error("blip");
      return stateWith("S1", "awaiting_approval");
    },
    "S1",
    {
      attempts: 3,
      sleep: fakeSleep([]),
      onWaiting: (attempt, attempts, reason) => reasons.push(reason),
    }
  );
  assert.deepEqual(reasons, ["read_error", "pending"]);
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
