#!/usr/bin/env node
// Tests the generalized durable-commit polling policy in isolation — no
// real network, no real story, no real waits. Directly mirrors
// waitForApprovalCommit.test.mjs's own harness style. Run with:
// node scripts/social-worker/lib/waitForDurableCommit.test.mjs
import assert from "node:assert/strict";
import { waitForDurableCommit, DURABLE_COMMIT_POLL_INTERVAL_MS } from "./waitForDurableCommit.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function fakeSleep(log) {
  return async (ms) => {
    log.push(ms);
  };
}

function stateWith(storyId, record) {
  return { stories: { [storyId]: record } };
}

test("stops polling the instant the predicate becomes true", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await waitForDurableCommit(
    async () => {
      calls++;
      return calls < 3 ? stateWith("S1", { publishing: { claim: { claim_id: "old" } } }) : stateWith("S1", { publishing: { claim: { claim_id: "claim-1" } } });
    },
    "S1",
    (record) => record?.publishing?.claim?.claim_id === "claim-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.committed, true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, Array(2).fill(DURABLE_COMMIT_POLL_INTERVAL_MS));
});

test("an immediate match on the first read returns without any sleep", async () => {
  const sleeps = [];
  const result = await waitForDurableCommit(
    async () => stateWith("S1", { publishing: { claim: { claim_id: "claim-1" } } }),
    "S1",
    (record) => record?.publishing?.claim?.claim_id === "claim-1",
    { sleep: fakeSleep(sleeps) }
  );
  assert.equal(result.committed, true);
  assert.deepEqual(sleeps, []);
});

test("times out after the configured number of attempts if the predicate never becomes true", async () => {
  let calls = 0;
  const result = await waitForDurableCommit(
    async () => {
      calls++;
      return stateWith("S1", { publishing: { claim: { claim_id: "never-matches" } } });
    },
    "S1",
    (record) => record?.publishing?.claim?.claim_id === "claim-1",
    { attempts: 3, sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "timeout");
  assert.equal(calls, 3);
});

test("a missing record for the story is never treated as a match, even if the predicate would otherwise tolerate undefined", async () => {
  const result = await waitForDurableCommit(
    async () => ({ stories: {} }),
    "S1",
    () => true,
    { attempts: 1, sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "timeout");
});

test("a read error on every attempt is reported as read_error, never folded into timeout", async () => {
  const result = await waitForDurableCommit(
    async () => {
      throw new Error("GitHub API blip");
    },
    "S1",
    () => true,
    { attempts: 2, sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "read_error");
  assert.equal(result.error, "GitHub API blip");
});

test("a rate-limited read error stops polling immediately rather than exhausting the attempt budget", async () => {
  let calls = 0;
  const result = await waitForDurableCommit(
    async () => {
      calls++;
      const err = new Error("rate limited");
      err.rateLimited = true;
      throw err;
    },
    "S1",
    () => true,
    { attempts: 20, sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, false);
  assert.equal(result.status, "read_error");
  assert.equal(result.rateLimited, true);
  assert.equal(calls, 1);
});

test("a transient read error followed by a genuine match still succeeds", async () => {
  let calls = 0;
  const result = await waitForDurableCommit(
    async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return stateWith("S1", { publishing: { claim: { claim_id: "claim-1" } } });
    },
    "S1",
    (record) => record?.publishing?.claim?.claim_id === "claim-1",
    { sleep: fakeSleep([]) }
  );
  assert.equal(result.committed, true);
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
