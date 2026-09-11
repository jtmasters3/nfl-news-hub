#!/usr/bin/env node
// Regression suite for applyPostingFailureResetEvent — recovers a record
// from a PROVEN definite posting failure (top-level status "failed") back to
// "approved"/not_posted. Deliberately does NOT go through
// transition()/TRANSITIONS: TRANSITIONS.failed only ever contains
// ["awaiting_approval"] (the content-pipeline re-review edge), which is the
// wrong target for a posting-stage failure — canTransition("failed",
// "approved") stays false forever, proven explicitly below. Fully
// offline/deterministic — no network, no Buffer/Meta call is possible from
// this file, no production data is touched. Run with:
// node scripts/tests/posting-failure-reset-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord, canTransition } from "../lib/socialState.js";
import {
  applyPostingClaimedEvent,
  applyPostingPublishAttemptedEvent,
  applyPostingBufferCreatedEvent,
  applyPostingFailedEvent,
  applyPostingCompletedEvent,
  applyPostingFailureResetEvent,
} from "../lib/postingEvents.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function approvedFeedState(id, overrides = {}) {
  let state = emptyState();
  state = ensureRecord(state, id, { status: "new" }).state;
  const record = {
    ...state.stories[id],
    status: "approved",
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "created", image_url: "https://example.test/x.png", storage_key: "social-artwork/x.png", width: 1024, height: 1280, mime_type: "image/png", size_bytes: 500000, provider: "test", created_at: "2026-01-01T00:00:00Z" },
    caption: { ...state.stories[id].caption, status: "ready", text: "Test caption.\n\nSource: Test" },
    approval: { ...state.stories[id].approval, status: "approved", approved_at: "2026-01-01T00:00:00Z" },
    ...overrides,
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
    ...overrides,
  };
}

function bufferClaimedState(id, claimOverrides = {}) {
  const state = approvedFeedState(id);
  const result = applyPostingClaimedEvent(state, claimPayload(id, { provider: "buffer", ...claimOverrides }));
  assert.equal(result.ok, true, "fixture setup: Buffer posting-claimed must succeed");
  return result.state;
}

function bufferPublishAttemptedState(id, { attemptedAt = "2026-01-01T01:02:00Z" } = {}) {
  const state = bufferClaimedState(id);
  const result = applyPostingPublishAttemptedEvent(state, { story_id: id, claim_id: "claim-1", publish_attempted_at: attemptedAt });
  assert.equal(result.ok, true, "fixture setup: Buffer posting-publish-attempted must succeed");
  return result.state;
}

const REAL_MESSAGE = "Invalid post: Instagram posts require a type (post, story, or reel).";

/** The exact real-world sequence for a PROVEN definite failure: claimed -> publish_attempted -> failed (InvalidInputError, no post created). */
function failedBufferState(id, { attemptedAt = "2026-01-01T01:02:00Z" } = {}) {
  const state = bufferPublishAttemptedState(id, { attemptedAt });
  const result = applyPostingFailedEvent(state, {
    story_id: id,
    claim_id: "claim-1",
    message: REAL_MESSAGE,
    http_outcome_category: "mutation_error",
    http_diagnostic: { http_status: 200, had_parsed_body: true, top_level_keys: ["data"], data_is_null: false, has_errors_array: false, errors_count: 0, errors: [], typename: "InvalidInputError", message: REAL_MESSAGE, post: null },
  });
  assert.equal(result.ok, true, "fixture setup: posting-failed must succeed");
  return result.state;
}

function resetPayload(id, overrides = {}) {
  return {
    story_id: id,
    claim_id: "claim-1",
    confirmed_by: "operator-jt",
    confirmed_at: "2026-01-01T02:00:00Z",
    reason: "proven_buffer_input_validation_failure",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Global TRANSITIONS table is untouched
// ---------------------------------------------------------------------------

test("the global TRANSITIONS table has NO failed->approved edge — canTransition remains false even after this event exists", () => {
  assert.equal(canTransition("failed", "approved"), false);
});

// ---------------------------------------------------------------------------
// 1-6. successful recovery
// ---------------------------------------------------------------------------

test("1. a proven-failed Buffer attempt with a matching claim recovers successfully", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "approved");
  assert.equal(result.record.publishing.status, "not_posted");
  assert.equal(result.record.publishing.instagram.feed.status, "not_posted");
});

test("2. the failed attempt is archived completely into publishing.prior_attempts", () => {
  const state = failedBufferState("s1", { attemptedAt: "2026-01-01T01:02:00Z" });
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  const attempts = result.record.publishing.prior_attempts;
  assert.equal(attempts.length, 1);
  const a = attempts[0];
  assert.equal(a.provider, "buffer");
  assert.equal(a.claim_id, "claim-1");
  assert.equal(a.claimed_at, "2026-01-01T01:00:00Z");
  assert.equal(a.publish_attempted_at, "2026-01-01T01:02:00Z");
  assert.equal(a.last_http_outcome.typename, "InvalidInputError");
  assert.equal(a.last_http_outcome.message, REAL_MESSAGE);
  assert.equal(a.feed_status, "failed");
  assert.equal(a.caption_used, "Test caption.\n\nSource: Test\n\n#NFL");
  assert.equal(a.jpeg_url, "https://example.test/social-artwork-jpeg/test.jpg");
  assert.equal(a.storage_key, "social-artwork-jpeg/test.jpg");
  assert.equal(a.buffer_post_id, null);
  assert.equal(a.buffer_status, null);
  assert.deepEqual(a.failure_reset, {
    confirmed_by: "operator-jt",
    confirmed_at: "2026-01-01T02:00:00Z",
    reason: "proven_buffer_input_validation_failure",
  });
});

test("3. approved caption/artwork/approval/destination are preserved untouched", () => {
  const state = failedBufferState("s1");
  const before = state.stories.s1;
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.approval, before.approval);
  assert.deepEqual(result.record.artwork, before.artwork);
  assert.deepEqual(result.record.selection, before.selection);
  assert.equal(result.record.caption.text, before.caption.text);
  assert.equal(result.record.caption.status, before.caption.status);
});

test("4. the claim is cleared", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.claim, null);
});

test("5. the live publish_attempted_at is cleared", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.publish_attempted_at, null);
});

test("6. the live Buffer state is cleared", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.buffer, null);
});

test("6b. last_error is left untouched — the codebase's existing convention treats it as a permanent historical breadcrumb, never cleared by a recovery event", () => {
  const state = failedBufferState("s1");
  const before = state.stories.s1.last_error;
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.last_error, before);
});

// ---------------------------------------------------------------------------
// 7-8, 17. idempotency
// ---------------------------------------------------------------------------

test("7. an exact replay of the same reset event is idempotent", () => {
  const state = failedBufferState("s1");
  const first = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(first.ok, true);
  const second = applyPostingFailureResetEvent(first.state, resetPayload("s1"));
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);
});

test("17. an exact replay never appends a duplicate prior_attempts entry", () => {
  const state = failedBufferState("s1");
  const first = applyPostingFailureResetEvent(state, resetPayload("s1"));
  const second = applyPostingFailureResetEvent(first.state, resetPayload("s1"));
  assert.equal(second.record.publishing.prior_attempts.length, 1);
});

test("8. a CONFLICTING replay (different confirmed_at, story already recovered) is rejected — never silently reprocessed", () => {
  const state = failedBufferState("s1");
  const first = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(first.ok, true);
  const conflicting = applyPostingFailureResetEvent(first.state, resetPayload("s1", { confirmed_at: "2026-01-01T03:00:00Z" }));
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, `invalid_state:${first.record.status}`);
});

// ---------------------------------------------------------------------------
// 9-15. rejection cases
// ---------------------------------------------------------------------------

test("9. a wrong claim_id is rejected", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1", { claim_id: "wrong-claim" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

test("10. an already-posted story is rejected", () => {
  const state = bufferPostCreatedThenCompletedState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:posted");
});

function bufferPostCreatedThenCompletedState(id) {
  const state = bufferPublishAttemptedState(id);
  const created = applyPostingBufferCreatedEvent(state, { story_id: id, claim_id: "claim-1", post_id: "buffer-post-1", channel_id: "chan-1", status: "sending" });
  assert.equal(created.ok, true);
  const completed = applyPostingCompletedEvent(created.state, {
    story_id: id,
    claim_id: "claim-1",
    media_id: "buffer-post-1",
    published_at: "2026-01-01T01:05:00Z",
    buffer: { post_id: "buffer-post-1", channel_id: "chan-1", status: "sent", sent_at: "2026-01-01T01:05:00Z" },
  });
  assert.equal(completed.ok, true);
  return completed.state;
}

test("11. a known Buffer post_id is rejected — reconciliation, never this event, is the correct path when a real post id is on record", () => {
  // Constructed directly since the real event chain can't reach status=failed
  // with a known post_id simultaneously — this proves the gate itself, not
  // merely a reachable path.
  const state = bufferPostCreatedState("s1");
  const tampered = {
    ...state,
    stories: {
      ...state.stories,
      s1: {
        ...state.stories.s1,
        status: "failed",
        publishing: {
          ...state.stories.s1.publishing,
          instagram: {
            ...state.stories.s1.publishing.instagram,
            feed: { ...state.stories.s1.publishing.instagram.feed, status: "failed" },
          },
        },
      },
    },
  };
  const result = applyPostingFailureResetEvent(tampered, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_post_id_known");
});

function bufferPostCreatedState(id) {
  const state = bufferPublishAttemptedState(id);
  const result = applyPostingBufferCreatedEvent(state, { story_id: id, claim_id: "claim-1", post_id: "buffer-post-1", channel_id: "chan-1", status: "sending" });
  assert.equal(result.ok, true);
  return result.state;
}

test("12. a non-failed posting state (still publish_attempted, never reached failed) is rejected", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:posting");
});

test("12b. a non-failed posting state (still claimed, never even attempted) is rejected", () => {
  const state = bufferClaimedState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:posting");
});

test("12c. an ambiguous (not definite-failed) state is rejected — the ambiguous-recovery event, not this one, is the correct path for that", () => {
  const state = bufferPublishAttemptedState("s1");
  const tampered = {
    ...state,
    stories: {
      ...state.stories,
      s1: {
        ...state.stories.s1,
        publishing: {
          ...state.stories.s1.publishing,
          instagram: {
            ...state.stories.s1.publishing.instagram,
            feed: { ...state.stories.s1.publishing.instagram.feed, status: "ambiguous" },
          },
        },
      },
    },
  };
  const result = applyPostingFailureResetEvent(tampered, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:posting");
});

test("13. a missing publish_attempted_at is rejected — cannot happen via the real failed path, but the gate itself must never assume it", () => {
  const state = failedBufferState("s1");
  const tampered = {
    ...state,
    stories: {
      ...state.stories,
      s1: {
        ...state.stories.s1,
        publishing: {
          ...state.stories.s1.publishing,
          instagram: {
            ...state.stories.s1.publishing.instagram,
            feed: { ...state.stories.s1.publishing.instagram.feed, publish_attempted_at: null },
          },
        },
      },
    },
  };
  const result = applyPostingFailureResetEvent(tampered, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "publish_attempted_at_missing");
});

test("14. a missing reason is rejected", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1", { reason: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "reason_required");
});

test("a missing confirmed_by is rejected", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1", { confirmed_by: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "confirmed_by_required");
});

test("15. a malformed confirmed_at is rejected", () => {
  const state = failedBufferState("s1");
  const result = applyPostingFailureResetEvent(state, resetPayload("s1", { confirmed_at: "not-a-date" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "confirmed_at_invalid");
});

test("a wrong-provider (Meta) record is rejected — this event only ever applies to Buffer-provider failures", () => {
  const state = bufferClaimedState("s1", { provider: "meta" });
  const tampered = {
    ...state,
    stories: {
      ...state.stories,
      s1: {
        ...state.stories.s1,
        status: "failed",
        publishing: {
          ...state.stories.s1.publishing,
          status: "posting",
          instagram: {
            ...state.stories.s1.publishing.instagram,
            feed: { ...state.stories.s1.publishing.instagram.feed, status: "failed", publish_attempted_at: "2026-01-01T01:02:00Z" },
          },
        },
      },
    },
  };
  const result = applyPostingFailureResetEvent(tampered, resetPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_provider");
});

// ---------------------------------------------------------------------------
// 16. existing entries preserved across a later, different recovery
// ---------------------------------------------------------------------------

test("16. an existing prior_attempts entry (e.g. from an earlier ambiguous recovery) is preserved when a later failure-reset is applied", () => {
  const state = failedBufferState("s1");
  const seeded = {
    ...state,
    stories: {
      ...state.stories,
      s1: {
        ...state.stories.s1,
        publishing: {
          ...state.stories.s1.publishing,
          prior_attempts: [{ provider: "buffer", claim_id: "old-claim", claimed_at: "2025-01-01T00:00:00Z", publish_attempted_at: "2025-01-01T00:01:00Z", last_http_outcome: "ambiguous", feed_status: "ambiguous", caption_used: null, jpeg_url: null, storage_key: null, buffer_post_id: null, buffer_status: null, manual_confirmation: { confirmed_by: "someone-else", confirmed_at: "2025-01-01T01:00:00Z", evidence_note: "old evidence", result: "confirmed_not_posted" } }],
        },
      },
    },
  };
  const result = applyPostingFailureResetEvent(seeded, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.prior_attempts.length, 2);
  assert.equal(result.record.publishing.prior_attempts[0].claim_id, "old-claim");
  assert.equal(result.record.publishing.prior_attempts[1].claim_id, "claim-1");
});

// ---------------------------------------------------------------------------
// Cross-story safety
// ---------------------------------------------------------------------------

test("the reset is scoped to exactly the named story — an unrelated story's record is never touched", () => {
  let state = failedBufferState("s1");
  state = ensureRecord(state, "s2", { status: "new" }).state;
  const before = state.stories.s2;
  const result = applyPostingFailureResetEvent(state, resetPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.stories.s2, before);
});

test("not_found is returned for a story that doesn't exist", () => {
  const state = emptyState();
  const result = applyPostingFailureResetEvent(state, resetPayload("does-not-exist"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_found");
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
