#!/usr/bin/env node
// Regression suite for automatic Buffer completion reconciliation — the
// async-completion gap identified after the Myles Garrett live test.
// Fully offline/deterministic — every dependency (the reconcile call, the
// result call) is injected; no network call is possible from this file, no
// production data is touched, and this module never references Buffer's
// createPost mutation or Meta at all. Run with:
// node scripts/social-worker/lib/bufferCompletionReconciler.test.mjs
import assert from "node:assert/strict";
import { isEligibleForCompletionReconciliation, decideReconciliationAction, runBufferCompletionReconciliation } from "./bufferCompletionReconciler.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const STORY_ID = "s1";
const POST_ID = "6aa41879a323b4086d724a4e";
const CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";
const CLAIM_ID = "19191db4-75dd-42e2-a713-15810e0828b6";
const CAPTION = "Myles Garrett made no impact.\n\nSource: Pro Football Talk\n\n#NFL #Rams";

function bufferPostCreatedRecord(overrides = {}) {
  return {
    story_id: STORY_ID,
    publishing: {
      status: "posting",
      claim: { claim_id: CLAIM_ID, processor_id: "unknown-processor", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" },
      instagram: {
        feed: {
          status: "buffer_post_created",
          provider: "buffer",
          caption_used: CAPTION,
          buffer: { post_id: POST_ID, channel_id: CHANNEL_ID, status: "sending", due_at: "2026-01-01T00:01:00Z", sent_at: null },
        },
      },
    },
    ...overrides,
  };
}

function stateWith(records) {
  return { stories: records };
}

// ---------------------------------------------------------------------------
// Eligibility (6, 7, 8 — posted/no-post-id/wrong-provider ignored)
// ---------------------------------------------------------------------------

test("eligible: the exact required combination (posting + buffer_post_created + buffer + post_id present) is eligible", () => {
  assert.equal(isEligibleForCompletionReconciliation(bufferPostCreatedRecord()), true);
});

test("6. a posted record is ignored", () => {
  const record = bufferPostCreatedRecord();
  record.publishing.status = "posted";
  record.publishing.instagram.feed.status = "posted";
  assert.equal(isEligibleForCompletionReconciliation(record), false);
});

test("7. a record with no buffer_post_id is ignored", () => {
  const record = bufferPostCreatedRecord();
  record.publishing.instagram.feed.buffer.post_id = null;
  assert.equal(isEligibleForCompletionReconciliation(record), false);
});

test("8. a wrong-provider (meta) record is ignored, even if feed.status happens to read buffer_post_created", () => {
  const record = bufferPostCreatedRecord();
  record.publishing.instagram.feed.provider = "meta";
  assert.equal(isEligibleForCompletionReconciliation(record), false);
});

test("every other status (not_posted, approved, claimed, publish_attempted, ambiguous, failed) is ignored", () => {
  for (const feedStatus of ["not_posted", "claimed", "publish_attempted", "ambiguous", "failed"]) {
    const record = bufferPostCreatedRecord();
    record.publishing.instagram.feed.status = feedStatus;
    assert.equal(isEligibleForCompletionReconciliation(record), false, `feed.status=${feedStatus} must be ignored`);
  }
  const record = bufferPostCreatedRecord();
  record.publishing.status = "not_posted";
  assert.equal(isEligibleForCompletionReconciliation(record), false, "publishing.status=not_posted must be ignored");
});

// ---------------------------------------------------------------------------
// 1, 2. sent -> complete, with the real sentAt persisted
// ---------------------------------------------------------------------------

test("1. Buffer status=sent decides action=complete", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "complete");
});

test("2. the real Buffer sentAt is persisted verbatim as published_at — never fabricated, never today's date", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.published_at, "2026-09-11T15:05:23.177Z");
  assert.equal(decision.buffer.sent_at, "2026-09-11T15:05:23.177Z");
  assert.equal(decision.buffer.post_id, POST_ID);
  assert.equal(decision.buffer.status, "sent");
  assert.equal(decision.media_id, POST_ID);
});

test("an invalid/unparseable sentAt on an otherwise-sent post is rejected, not fabricated", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "not-a-date" };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "invalid_sent_at");
});

// ---------------------------------------------------------------------------
// 3. sending -> no mutation
// ---------------------------------------------------------------------------

test("3. Buffer status=sending decides no action — left for a later pass", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sending", sentAt: null };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "still_processing");
});

test("3b. every other nonterminal Buffer status (draft, needs_approval, scheduled) also decides no action", () => {
  for (const status of ["draft", "needs_approval", "scheduled"]) {
    const record = bufferPostCreatedRecord();
    const matchedPost = { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status, sentAt: null };
    const decision = decideReconciliationAction(record, matchedPost);
    assert.equal(decision.action, "none", `status=${status} must not act`);
  }
});

// ---------------------------------------------------------------------------
// 4. Buffer error -> existing failure behavior
// ---------------------------------------------------------------------------

test("4. Buffer status=error decides action=fail, mapping to the existing posting-failed event", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "error", sentAt: null };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "fail");
  assert.equal(decision.http_outcome_category, "buffer_post_error");
  assert.ok(decision.message.length > 0);
});

// ---------------------------------------------------------------------------
// Defense-in-depth validation (mismatches never silently completed)
// ---------------------------------------------------------------------------

test("a post_id mismatch (should be structurally impossible via the real reconcile lookup, but never trusted blindly) decides no action", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: "some-other-post-id", text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "post_id_mismatch");
});

test("a channel mismatch decides no action", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: CAPTION, channelId: "wrong-channel", status: "sent", sentAt: "2026-09-11T15:05:23.177Z" };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "channel_mismatch");
});

test("a caption mismatch decides no action", () => {
  const record = bufferPostCreatedRecord();
  const matchedPost = { id: POST_ID, text: "completely different text", channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" };
  const decision = decideReconciliationAction(record, matchedPost);
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "caption_mismatch");
});

test("no matchedPost at all (not found in Buffer's current listing) decides no action — absence is never proof of failure", () => {
  const record = bufferPostCreatedRecord();
  const decision = decideReconciliationAction(record, null);
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "not_found_in_listing");
});

// ---------------------------------------------------------------------------
// runBufferCompletionReconciliation — orchestration over a full state object
// ---------------------------------------------------------------------------

test("the orchestration function calls applyResult with posting-completed for a sent post, using the record's own claim_id", async () => {
  const state = stateWith({ [STORY_ID]: bufferPostCreatedRecord() });
  let capturedApply;
  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: async () => ({ ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" } }),
    applyResult: async (args) => {
      capturedApply = args;
      return { ok: true };
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "complete");
  assert.equal(results[0].applied, true);
  assert.equal(capturedApply.event_type, "posting-completed");
  assert.equal(capturedApply.claim_id, CLAIM_ID);
  assert.equal(capturedApply.story_id, STORY_ID);
  assert.equal(capturedApply.payload.media_id, POST_ID);
  assert.equal(capturedApply.payload.published_at, "2026-09-11T15:05:23.177Z");
});

test("the orchestration function calls applyResult with posting-failed for a Buffer error status", async () => {
  const state = stateWith({ [STORY_ID]: bufferPostCreatedRecord() });
  let capturedApply;
  await runBufferCompletionReconciliation(state, {
    reconcileStory: async () => ({ ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "error", sentAt: null } }),
    applyResult: async (args) => {
      capturedApply = args;
      return { ok: true };
    },
  });
  assert.equal(capturedApply.event_type, "posting-failed");
  assert.equal(capturedApply.payload.http_outcome_category, "buffer_post_error");
});

test("3-orchestration. a still-sending post never calls applyResult at all", async () => {
  const state = stateWith({ [STORY_ID]: bufferPostCreatedRecord() });
  let applyCalled = false;
  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: async () => ({ ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sending", sentAt: null } }),
    applyResult: async () => {
      applyCalled = true;
      return { ok: true };
    },
  });
  assert.equal(applyCalled, false);
  assert.equal(results[0].action, "none");
});

// ---------------------------------------------------------------------------
// 5. Buffer read error -> no mutation
// ---------------------------------------------------------------------------

test("5. a reconcile-read failure (ok:false) results in no mutation for that story", async () => {
  const state = stateWith({ [STORY_ID]: bufferPostCreatedRecord() });
  let applyCalled = false;
  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: async () => ({ ok: false, error: "missing_credential" }),
    applyResult: async () => {
      applyCalled = true;
      return { ok: true };
    },
  });
  assert.equal(applyCalled, false);
  assert.match(results[0].detail, /reconcile_read_error/);
});

test("5b. a reconcile call that THROWS (network error) also results in no mutation, never an unhandled rejection", async () => {
  const state = stateWith({ [STORY_ID]: bufferPostCreatedRecord() });
  let applyCalled = false;
  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: async () => {
      throw new Error("network error");
    },
    applyResult: async () => {
      applyCalled = true;
      return { ok: true };
    },
  });
  assert.equal(applyCalled, false);
  assert.match(results[0].detail, /reconcile_read_error/);
});

test("a missing claim_id on the record (should not be structurally reachable, but never assumed) skips applying without throwing", async () => {
  const record = bufferPostCreatedRecord();
  record.publishing.claim = null;
  const state = stateWith({ [STORY_ID]: record });
  let applyCalled = false;
  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: async () => ({ ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" } }),
    applyResult: async () => {
      applyCalled = true;
      return { ok: true };
    },
  });
  assert.equal(applyCalled, false);
  assert.equal(results[0].detail, "missing_claim_id");
});

// ---------------------------------------------------------------------------
// 11. idempotent repeated reconciliation
// ---------------------------------------------------------------------------

test("11. once a record's own state shows it already reached posted (a later fetch, after the first pass's completion landed), a second pass no longer considers it eligible at all — applyResult is never called twice for the same completion", async () => {
  const eligibleState = stateWith({ [STORY_ID]: bufferPostCreatedRecord() });
  let applyCount = 0;
  await runBufferCompletionReconciliation(eligibleState, {
    reconcileStory: async () => ({ ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" } }),
    applyResult: async () => {
      applyCount++;
      return { ok: true };
    },
  });
  assert.equal(applyCount, 1);

  // Simulates the durable commit having landed before the next scheduled run.
  const postedRecord = bufferPostCreatedRecord();
  postedRecord.publishing.status = "posted";
  postedRecord.publishing.instagram.feed.status = "posted";
  const nextState = stateWith({ [STORY_ID]: postedRecord });
  const secondResults = await runBufferCompletionReconciliation(nextState, {
    reconcileStory: async () => {
      throw new Error("must never be called for an already-posted record");
    },
    applyResult: async () => {
      applyCount++;
      return { ok: true };
    },
  });
  assert.equal(secondResults.length, 0, "an already-posted record must not even be considered eligible on the next pass");
  assert.equal(applyCount, 1, "no second completion event may be applied for the same publication");
});

// ---------------------------------------------------------------------------
// 12. multiple eligible records handled independently
// ---------------------------------------------------------------------------

test("12. multiple eligible records in the same pass are each reconciled independently — one story's failure never blocks another's", async () => {
  const recordA = bufferPostCreatedRecord();
  const recordB = { ...bufferPostCreatedRecord(), publishing: { ...bufferPostCreatedRecord().publishing, claim: { ...bufferPostCreatedRecord().publishing.claim, claim_id: "claim-b" }, instagram: { feed: { ...bufferPostCreatedRecord().publishing.instagram.feed, buffer: { ...bufferPostCreatedRecord().publishing.instagram.feed.buffer, post_id: "post-b" } } } } };
  const state = stateWith({ s1: recordA, s2: recordB });

  const appliedFor = [];
  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: async (storyId) => {
      if (storyId === "s1") throw new Error("s1's read fails");
      return { ok: true, matchedPost: { id: "post-b", text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" } };
    },
    applyResult: async (args) => {
      appliedFor.push(args.story_id);
      return { ok: true };
    },
  });

  assert.equal(results.length, 2);
  const s1Result = results.find((r) => r.story_id === "s1");
  const s2Result = results.find((r) => r.story_id === "s2");
  assert.match(s1Result.detail, /reconcile_read_error/);
  assert.equal(s2Result.action, "complete");
  assert.equal(s2Result.applied, true);
  assert.deepEqual(appliedFor, ["s2"], "s1's failure must never prevent s2 from being reconciled");
});

// ---------------------------------------------------------------------------
// 9, 10. no createPost / Meta capability anywhere in this module
// ---------------------------------------------------------------------------

test("9-10. this reconciler module's EXECUTABLE code (comments stripped — the header prose legitimately discusses the concept) never references Buffer's post-creation mutation, Buffer's API host, or Meta at all", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./bufferCompletionReconciler.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName), "the reconciler's executable code must never reference Buffer's post-creation mutation");
  assert.ok(!/api\.buffer\.com/.test(codeOnly), "the reconciler's executable code must never reference Buffer's API host directly — it only calls the existing Worker endpoints");
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly), "the reconciler's executable code must never reference Meta's API host");
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
