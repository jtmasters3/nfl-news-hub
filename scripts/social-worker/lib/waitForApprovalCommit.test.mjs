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
