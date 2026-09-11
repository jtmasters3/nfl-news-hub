#!/usr/bin/env node
// Regression suite for apply-artwork-event.js's dispatch table
// (applyEventByType) — proves the production repository_dispatch ingestion
// path itself routes correctly, WITHOUT ever touching the real
// data/social-state.json file and WITHOUT firing a real repository_dispatch.
// This exists because a prior stage discovered (twice) that a new posting
// event's reducer being fully implemented and tested does NOT guarantee it
// is actually wired into this script's dispatch table or the GitHub Actions
// workflow's `types:` allowlist — both were missing for
// posting-manually-confirmed-not-posted until this stage. Run with:
// node scripts/tests/apply-artwork-event-routing-regression.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { emptyState, ensureRecord } from "../lib/socialState.js";
import { applyPostingClaimedEvent, applyPostingPublishAttemptedEvent, applyPostingAmbiguousEvent, applyPostingManuallyConfirmedNotPostedEvent } from "../lib/postingEvents.js";
import { applyEventByType } from "../social/apply-artwork-event.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const WORKFLOW_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "social-artwork-event.yml");

function approvedFeedState(id) {
  let state = emptyState();
  state = ensureRecord(state, id, { status: "new" }).state;
  const record = {
    ...state.stories[id],
    status: "approved",
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "created", image_url: "https://example.test/x.png", storage_key: "social-artwork/x.png", width: 1024, height: 1280, mime_type: "image/png", size_bytes: 500000, provider: "test", created_at: "2026-01-01T00:00:00Z" },
    caption: { ...state.stories[id].caption, status: "ready", text: "Test caption.\n\nSource: Test" },
    approval: { ...state.stories[id].approval, status: "approved", approved_at: "2026-01-01T00:00:00Z" },
  };
  return { ...state, stories: { ...state.stories, [id]: record } };
}

function claimPayload(storyId, overrides = {}) {
  return {
    story_id: storyId,
    claim_id: "claim-1",
    processor_id: "test-processor",
    claimed_at: "2026-01-01T01:00:00Z",
    claim_expires_at: "2026-01-01T01:50:00Z",
    caption_used: "Test caption.\n\nSource: Test\n\n#NFL",
    storage_key: "social-artwork-jpeg/test.jpg",
    jpeg_url: "https://example.test/social-artwork-jpeg/test.jpg",
    provider: "buffer",
    ...overrides,
  };
}

function ambiguousBufferState(id) {
  const state = approvedFeedState(id);
  const claimed = applyPostingClaimedEvent(state, claimPayload(id));
  assert.equal(claimed.ok, true, "fixture: posting-claimed must succeed");
  const attempted = applyPostingPublishAttemptedEvent(claimed.state, { story_id: id, claim_id: "claim-1", publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(attempted.ok, true, "fixture: posting-publish-attempted must succeed");
  const ambiguous = applyPostingAmbiguousEvent(attempted.state, { story_id: id, claim_id: "claim-1", http_outcome_category: "unknown" });
  assert.equal(ambiguous.ok, true, "fixture: posting-ambiguous must succeed");
  return ambiguous.state;
}

function recoveryPayload(id, overrides = {}) {
  return {
    story_id: id,
    claim_id: "claim-1",
    confirmed_by: "operator-jt",
    confirmed_at: "2026-01-01T02:00:00Z",
    evidence_note: "Buffer Sent/Queue/Drafts checked; Instagram manually checked; no post exists.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 5. workflow event-type allowlist contains the new event
// ---------------------------------------------------------------------------

test("5. the GitHub Actions workflow's repository_dispatch types list includes posting-manually-confirmed-not-posted", async () => {
  const yaml = await readFile(WORKFLOW_PATH, "utf-8");
  assert.match(yaml, /posting-manually-confirmed-not-posted/, "the workflow's types: allowlist must include the new event, or a real dispatch would never even trigger the workflow");
});

// ---------------------------------------------------------------------------
// 1-2. accepted and routed to the correct reducer
// ---------------------------------------------------------------------------

test("1-2. posting-manually-confirmed-not-posted is accepted by applyEventByType and routes to applyPostingManuallyConfirmedNotPostedEvent — not the 'unknown event type' null branch", async () => {
  const state = ambiguousBufferState("s1");
  const viaDispatch = await applyEventByType(state, "posting-manually-confirmed-not-posted", recoveryPayload("s1"));
  assert.notEqual(viaDispatch, null, "must not fall through to the unknown-event-type branch");
  assert.equal(viaDispatch.ok, true);

  const viaDirectReducer = applyPostingManuallyConfirmedNotPostedEvent(state, recoveryPayload("s1"));
  assert.deepEqual(viaDispatch.record, viaDirectReducer.record, "routing through applyEventByType must produce byte-identical output to calling the reducer directly");
});

// ---------------------------------------------------------------------------
// 3. exact replay idempotent through the production event path
// ---------------------------------------------------------------------------

test("3. an exact replay through applyEventByType remains idempotent", async () => {
  const state = ambiguousBufferState("s1");
  const first = await applyEventByType(state, "posting-manually-confirmed-not-posted", recoveryPayload("s1"));
  assert.equal(first.ok, true);
  const second = await applyEventByType(first.state, "posting-manually-confirmed-not-posted", recoveryPayload("s1"));
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);
});

// ---------------------------------------------------------------------------
// 4. wrong claim fails through the production event path
// ---------------------------------------------------------------------------

test("4. a wrong claim_id fails through applyEventByType exactly like the direct reducer call", async () => {
  const state = ambiguousBufferState("s1");
  const result = await applyEventByType(state, "posting-manually-confirmed-not-posted", recoveryPayload("s1", { claim_id: "wrong-claim" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

// ---------------------------------------------------------------------------
// 6. no unrelated event behavior changed by this refactor
// ---------------------------------------------------------------------------

test("6. posting-claimed still routes correctly through applyEventByType, unaffected by this refactor", async () => {
  const state = approvedFeedState("s1");
  const result = await applyEventByType(state, "posting-claimed", claimPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
});

test("6b. posting-ambiguous still routes correctly through applyEventByType, unaffected by this refactor", async () => {
  const state = ambiguousBufferState("s1");
  // Replaying the SAME ambiguous event again must remain a legal, safe patch (feed.status stays "ambiguous").
  const result = await applyEventByType(state, "posting-ambiguous", { story_id: "s1", claim_id: "claim-1", http_outcome_category: "still_unknown" });
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.status, "ambiguous");
});

test("6c. an unrecognized event type still returns null (main()'s own error path is unaffected)", async () => {
  const state = approvedFeedState("s1");
  const result = await applyEventByType(state, "totally-made-up-event-type", { story_id: "s1" });
  assert.equal(result, null);
});

test("6d. an event requiring image reachability (artwork-completed) still calls the injected checkReachable, exactly as before the refactor", async () => {
  let called = false;
  const state = approvedFeedState("s1");
  await applyEventByType(
    state,
    "artwork-completed",
    { story_id: "s1", claim_id: "nope", image_url: "https://example.test/x.png", storage_key: "k", width: 1024, height: 1280, mime_type: "image/png", size_bytes: 1, provider: "test" },
    { checkReachable: async () => { called = true; return true; } }
  );
  assert.equal(called, true, "the injected checkReachable override must still be used by the extracted dispatch function");
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
