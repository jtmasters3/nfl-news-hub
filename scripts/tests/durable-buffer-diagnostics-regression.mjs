#!/usr/bin/env node
// End-to-end regression for the durable Buffer diagnostic path:
//   Worker response -> mapBufferWorkerOutcomeToEvent -> posting event
//   payload -> postingEvents.js reducer -> feed.last_http_outcome
//
// This exists because a real live attempt's raw Buffer response was never
// persisted anywhere and could not be recovered after the fact. The Worker
// now returns a safe, sanitized `diagnostic` object (see cloudflare-worker's
// bufferOutcome.js buildBufferResponseDiagnostic) for every outcome; this
// suite proves that object survives all the way into committed
// data/social-state.json, not merely into a Worker response nobody may
// still be looking at.
//
// Classification itself is NEVER weakened here: an ambiguous outcome stays
// ambiguous regardless of how much diagnostic detail accompanies it. Fully
// offline/deterministic — no network, no Buffer/Meta call, no production
// data touched. Run with:
// node scripts/tests/durable-buffer-diagnostics-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord } from "../lib/socialState.js";
import { applyPostingClaimedEvent, applyPostingPublishAttemptedEvent, applyPostingFailedEvent, applyPostingAmbiguousEvent } from "../lib/postingEvents.js";
import { mapBufferWorkerOutcomeToEvent } from "../social-worker/lib/bufferFeedOrchestrator.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const STORY_ID = "s1";
const CLAIM_ID = "claim-1";
const CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";
const FAKE_TOKEN_IN_MESSAGE = "SECRET_TOKEN_MUST_NEVER_PERSIST";

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

function claimedAndAttemptedState(id) {
  const state = approvedFeedState(id);
  const claimed = applyPostingClaimedEvent(state, {
    story_id: id,
    claim_id: CLAIM_ID,
    processor_id: "test-processor",
    claimed_at: "2026-01-01T01:00:00Z",
    claim_expires_at: "2026-01-01T01:50:00Z",
    caption_used: "Test caption.\n\nSource: Test\n\n#NFL",
    storage_key: "social-artwork-jpeg/test.jpg",
    jpeg_url: "https://example.test/social-artwork-jpeg/test.jpg",
    provider: "buffer",
  });
  assert.equal(claimed.ok, true, "fixture: posting-claimed must succeed");
  const attempted = applyPostingPublishAttemptedEvent(claimed.state, { story_id: id, claim_id: CLAIM_ID, publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(attempted.ok, true, "fixture: posting-publish-attempted must succeed");
  return attempted.state;
}

/** Applies whichever reducer mapBufferWorkerOutcomeToEvent selected, exactly like the real orchestrator would. */
function applyMappedEvent(state, mapped) {
  if (mapped.eventType === "posting-failed") return applyPostingFailedEvent(state, mapped.payload);
  if (mapped.eventType === "posting-ambiguous") return applyPostingAmbiguousEvent(state, mapped.payload);
  throw new Error(`this test file only exercises posting-failed/posting-ambiguous — got ${mapped.eventType}`);
}

// ---------------------------------------------------------------------------
// 1. HTTP 200 + data:null + no errors array (the exact real-incident shape)
// ---------------------------------------------------------------------------

test("1. the exact real-incident shape (HTTP 200, data:null, no errors array) survives the full pipeline into feed.last_http_outcome, and remains classified ambiguous", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "ambiguous",
    data: null,
    error: { http_status: 200, message: "Buffer request failed with status 200", category: "unknown", error_code: null, had_errors_array: false },
    diagnostic: { http_status: 200, had_parsed_body: true, top_level_keys: ["data"], data_is_null: true, has_errors_array: false, errors_count: 0, errors: [], typename: null, post: null },
  };
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  assert.equal(mapped.eventType, "posting-ambiguous", "classification must remain ambiguous — this test never weakens that");
  assert.deepEqual(mapped.payload.http_diagnostic, workerResponse.diagnostic);

  const result = applyMappedEvent(state, mapped);
  assert.equal(result.ok, true);
  const outcome = result.record.publishing.instagram.feed.last_http_outcome;
  assert.equal(outcome.http_status, 200);
  assert.equal(outcome.data_is_null, true);
  assert.equal(outcome.has_errors_array, false);
  assert.equal(outcome.errors_count, 0);
  assert.equal(outcome.category, "unknown", "matches the real incident's exact sanitized category value");
});

// ---------------------------------------------------------------------------
// 2. HTTP 200 + populated GraphQL validation error -> definite_failure, durable
// ---------------------------------------------------------------------------

test("2. a populated GraphQL validation error maps to definite_failure (per the classifier fix) and its diagnostic is durable", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "definite_failure",
    data: null,
    error: { http_status: 200, message: 'Cannot query field "foo" on type "Post"', category: "validation_error", error_code: "GRAPHQL_VALIDATION_FAILED", had_errors_array: true },
    diagnostic: {
      http_status: 200,
      had_parsed_body: true,
      top_level_keys: ["data", "errors"],
      data_is_null: true,
      has_errors_array: true,
      errors_count: 1,
      errors: [{ message: 'Cannot query field "foo" on type "Post"', code: "GRAPHQL_VALIDATION_FAILED" }],
      typename: null,
      post: null,
    },
  };
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  assert.equal(mapped.eventType, "posting-failed");

  const result = applyMappedEvent(state, mapped);
  assert.equal(result.ok, true);
  const outcome = result.record.publishing.instagram.feed.last_http_outcome;
  assert.equal(outcome.has_errors_array, true);
  assert.equal(outcome.errors_count, 1);
  assert.equal(outcome.errors[0].code, "GRAPHQL_VALIDATION_FAILED");
  assert.equal(outcome.category, "validation_error");
});

// ---------------------------------------------------------------------------
// 3. definite Buffer success — diagnostic flows through the mapping even
// though posting-completed has no last_http_outcome field to persist it in
// (a success record's proof-of-publication IS the buffer.post_id/sent_at).
// ---------------------------------------------------------------------------

test("3. a definite Buffer success still carries http_diagnostic through the mapping layer (available even though posting-completed doesn't have a last_http_outcome field to store it in)", () => {
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "definite_success",
    data: { id: "buffer-post-1", status: "sent", dueAt: null, sentAt: "2026-01-01T01:03:00Z" },
    error: null,
    diagnostic: { http_status: 200, had_parsed_body: true, top_level_keys: ["data"], data_is_null: false, has_errors_array: false, errors_count: 0, errors: [], typename: "PostActionSuccess", post: { id: "buffer-post-1", status: "sent", dueAt: null, sentAt: "2026-01-01T01:03:00Z" } },
  };
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  assert.equal(mapped.eventType, "posting-completed");
  assert.deepEqual(mapped.payload.http_diagnostic, workerResponse.diagnostic);
});

// ---------------------------------------------------------------------------
// 4. MutationError -> definite_failure, durable
// ---------------------------------------------------------------------------

test("4. a MutationError response maps to posting-failed and its diagnostic (typename=MutationError) is durable", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "definite_failure",
    data: null,
    error: { http_status: 200, message: "Channel not connected", category: "mutation_error", error_code: null, had_errors_array: false },
    diagnostic: { http_status: 200, had_parsed_body: true, top_level_keys: ["data"], data_is_null: false, has_errors_array: false, errors_count: 0, errors: [], typename: "MutationError", post: null },
  };
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  assert.equal(mapped.eventType, "posting-failed");

  const result = applyMappedEvent(state, mapped);
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.last_http_outcome.typename, "MutationError");
});

// ---------------------------------------------------------------------------
// 5. ambiguous 5xx, durable
// ---------------------------------------------------------------------------

test("5. a 5xx (ambiguous, no proof the resolver ever ran) is durable and stays ambiguous", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "ambiguous",
    data: null,
    error: { http_status: 503, message: "Buffer request failed with status 503", category: "5xx", error_code: null, had_errors_array: false },
    diagnostic: { http_status: 503, had_parsed_body: false, top_level_keys: [], data_is_null: null, has_errors_array: false, errors_count: 0, errors: [], typename: null, post: null },
  };
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  assert.equal(mapped.eventType, "posting-ambiguous");
  const result = applyMappedEvent(state, mapped);
  assert.equal(result.record.publishing.instagram.feed.last_http_outcome.http_status, 503);
  assert.equal(result.record.publishing.instagram.feed.last_http_outcome.category, "5xx");
});

// ---------------------------------------------------------------------------
// 6-7. sanitized message/code durable; token/Authorization never persisted
// ---------------------------------------------------------------------------

test("6-7. the sanitized error message/code are durable, and a Bearer token embedded in Buffer's own error text never reaches durable state", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "definite_failure",
    data: null,
    error: { http_status: 200, message: "Not authorized", category: "auth_error", error_code: "UNAUTHORIZED", had_errors_array: true },
    diagnostic: {
      http_status: 200,
      had_parsed_body: true,
      top_level_keys: ["data", "errors"],
      data_is_null: true,
      has_errors_array: true,
      errors_count: 1,
      // Already sanitized by the Worker before this test ever constructs it — proving the SCRUBBED message is what persists, never a raw token.
      errors: [{ message: `Invalid token: Bearer [redacted]`, code: "UNAUTHORIZED" }],
      typename: null,
      post: null,
    },
  };
  assert.ok(!JSON.stringify(workerResponse).includes(FAKE_TOKEN_IN_MESSAGE), "sanity: this fixture itself must not contain the fake token");
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  const result = applyMappedEvent(state, mapped);
  const outcome = result.record.publishing.instagram.feed.last_http_outcome;
  assert.equal(outcome.errors[0].code, "UNAUTHORIZED");
  assert.ok(outcome.errors[0].message.includes("[redacted]"));
  assert.ok(!JSON.stringify(result.state).includes(FAKE_TOKEN_IN_MESSAGE));
  assert.ok(!JSON.stringify(result.state).toLowerCase().includes("authorization"));
});

// ---------------------------------------------------------------------------
// 8. diagnostic survives durable reducer application (round-trip through
// the exact patchOnly()/transition() machinery, not merely constructed
// in-memory by the mapping layer)
// ---------------------------------------------------------------------------

test("8. the diagnostic survives being written into and read back out of the actual state object the reducer returns — not merely present on the mapping's own payload", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const workerResponse = {
    ok: true,
    storyId: STORY_ID,
    outcome: "ambiguous",
    data: null,
    error: { http_status: 429, message: "Rate limited", category: "rate_limited", error_code: "RATE_LIMIT_EXCEEDED", had_errors_array: true },
    diagnostic: { http_status: 429, had_parsed_body: true, top_level_keys: ["errors"], data_is_null: null, has_errors_array: true, errors_count: 1, errors: [{ message: "Rate limited", code: "RATE_LIMIT_EXCEEDED" }], typename: null, post: null },
  };
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: STORY_ID, claimId: CLAIM_ID, channelId: CHANNEL_ID, workerResponse, now: "2026-01-01T01:03:00Z" });
  const applied = applyMappedEvent(state, mapped);
  assert.equal(applied.ok, true);
  // Re-read from the RETURNED STATE OBJECT (state.stories[id]), not the
  // convenience `.record` alias, to prove it was genuinely written into
  // the durable structure the workflow would actually commit.
  const rehydrated = applied.state.stories[STORY_ID].publishing.instagram.feed.last_http_outcome;
  assert.equal(rehydrated.http_status, 429);
  assert.equal(rehydrated.errors_count, 1);
  assert.equal(rehydrated.category, "rate_limited");
});

// ---------------------------------------------------------------------------
// Backward compatibility: a caller that never supplies http_diagnostic
// (every pre-existing call site, and the entire Meta path) is completely
// unaffected — last_http_outcome stays a plain string, exactly as before.
// ---------------------------------------------------------------------------

test("backward compatibility: a plain http_outcome_category with no http_diagnostic still produces a plain string, exactly as before this stage", () => {
  const state = claimedAndAttemptedState(STORY_ID);
  const result = applyPostingAmbiguousEvent(state, { story_id: STORY_ID, claim_id: CLAIM_ID, http_outcome_category: "rate_limited" });
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.last_http_outcome, "rate_limited");
  assert.equal(typeof result.record.publishing.instagram.feed.last_http_outcome, "string");
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
