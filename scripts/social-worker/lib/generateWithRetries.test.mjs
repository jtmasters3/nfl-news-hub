#!/usr/bin/env node
// Tests the bounded generation-retry policy in isolation — no real codex
// exec, no real story. Run with:
// node scripts/social-worker/lib/generateWithRetries.test.mjs
import assert from "node:assert/strict";
import { generateWithRetries, MAX_GENERATION_ATTEMPTS } from "./generateWithRetries.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("MAX_GENERATION_ATTEMPTS is the documented bound (3): attempt 1 fails, attempt 2 fails, attempt 3 succeeds", async () => {
  let calls = 0;
  const failedAttempts = [];
  const result = await generateWithRetries(
    async (attempt) => {
      calls++;
      if (attempt < 3) throw new Error(`wrong player on attempt ${attempt}`);
      return "ok";
    },
    { onAttemptFailure: (attempt, err) => failedAttempts.push({ attempt, message: err.message }) }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(
    failedAttempts.map((f) => f.attempt),
    [1, 2]
  );
});

test("Succeeding on the very first attempt never retries at all", async () => {
  let calls = 0;
  const result = await generateWithRetries(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("Failing on every attempt stops at MAX_GENERATION_ATTEMPTS — never an infinite loop — and the final error summarizes every attempt", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      generateWithRetries(async (attempt) => {
        calls++;
        throw new Error(`bad generation #${attempt}`);
      }),
    (err) => {
      assert.equal(calls, MAX_GENERATION_ATTEMPTS);
      assert.ok(err.message.includes(`after ${MAX_GENERATION_ATTEMPTS} attempts`));
      assert.ok(err.message.includes("bad generation #1"));
      assert.ok(err.message.includes(`bad generation #${MAX_GENERATION_ATTEMPTS}`), "the final error must reflect the true attempt history, not just the last miss");
      return true;
    }
  );
});

test("A custom maxAttempts overrides the default bound", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      generateWithRetries(
        async () => {
          calls++;
          throw new Error("always fails");
        },
        { maxAttempts: 1 }
      ),
    /after 1 attempts/
  );
  assert.equal(calls, 1, "maxAttempts: 1 must mean exactly one try, no retries");
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
