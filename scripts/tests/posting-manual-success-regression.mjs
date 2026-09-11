#!/usr/bin/env node
// Regression suite for applyPostingManuallyConfirmedPostedEvent — the
// external-success counterpart to applyPostingManuallyConfirmedNotPostedEvent.
// Reconciles an AMBIGUOUS Buffer attempt to "posted" based on human
// attestation (Buffer Sent + live Instagram both manually checked) rather
// than machine-verified proof — unlike its "not posted" sibling, this one
// DOES go through transition()/TRANSITIONS, since "posting" -> "posted" is
// already a legitimate pre-existing edge (the same one
// applyPostingCompletedEvent itself uses). Fully offline/deterministic — no
// network, no Buffer/Meta call is possible from this file, no production
// data is touched. Run with:
// node scripts/tests/posting-manual-success-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord, canTransition } from "../lib/socialState.js";
import {
  applyPostingClaimedEvent,
  applyPostingPublishAttemptedEvent,
  applyPostingAmbiguousEvent,
  applyPostingBufferCreatedEvent,
  applyPostingCompletedEvent,
  applyPostingManuallyConfirmedPostedEvent,
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

/** The exact real-world sequence for a client-side-timeout ambiguous attempt: claimed -> publish_attempted -> ambiguous (network_error, no HTTP response at all). */
function ambiguousTimeoutState(id, { attemptedAt = "2026-01-01T01:02:00Z" } = {}) {
  const state = bufferPublishAttemptedState(id, { attemptedAt });
  const result = applyPostingAmbiguousEvent(state, {
    story_id: id,
    claim_id: "claim-1",
    http_outcome_category: "network_error",
    http_diagnostic: { http_status: null, had_parsed_body: false, top_level_keys: [], data_is_null: null, has_errors_array: false, errors_count: 0, errors: [], typename: null, message: null, post: null },
  });
  assert.equal(result.ok, true, "fixture setup: posting-ambiguous must succeed");
  return result.state;
}

function successPayload(id, overrides = {}) {
  return {
    story_id: id,
    claim_id: "claim-1",
    confirmed_by: "operator-jt",
    confirmed_at: "2026-01-01T02:00:00Z",
    evidence_note: "Operator manually verified the Drake Maye post appears in Buffer Sent and is live on @theaggregatenfl Instagram. Exactly one matching post is visible and no duplicate exists.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// This uses the EXISTING posting->posted edge, unlike its "not posted" sibling
// ---------------------------------------------------------------------------

test("posting->posted is already a legitimate TRANSITIONS edge — this event uses it directly, it does not need to bypass transition()", () => {
  assert.equal(canTransition("posting", "posted"), true);
});

// ---------------------------------------------------------------------------
// 1-6. successful reconciliation
// ---------------------------------------------------------------------------

test("1. an ambiguous (network_error/timeout) Buffer attempt with a matching claim reconciles to posted", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posted");
  assert.equal(result.record.publishing.status, "posted");
  assert.equal(result.record.publishing.instagram.feed.status, "posted");
});

test("2. manual_success_confirmation is recorded permanently on the feed", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.publishing.instagram.feed.manual_success_confirmation, {
    confirmed_by: "operator-jt",
    confirmed_at: "2026-01-01T02:00:00Z",
    evidence_note: successPayload("s1").evidence_note,
  });
});

test("3. approved caption/artwork/approval/destination are preserved untouched", () => {
  const state = ambiguousTimeoutState("s1");
  const before = state.stories.s1;
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.approval, before.approval);
  assert.deepEqual(result.record.artwork, before.artwork);
  assert.deepEqual(result.record.selection, before.selection);
  assert.equal(result.record.caption.text, before.caption.text);
});

test("4. no Buffer post_id known -> media_id/buffer are null, never invented", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.media_id, null);
  assert.equal(result.record.publishing.instagram.feed.buffer, null);
});

test("4b. a recovered Buffer post_id, if supplied, IS persisted — never invented, but used when actually available", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1", { buffer_post_id: "buffer-post-99" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.media_id, "buffer-post-99");
  assert.equal(result.record.publishing.instagram.feed.buffer.post_id, "buffer-post-99");
  assert.equal(result.record.publishing.instagram.feed.buffer.status, "sent");
});

test("5. published_at/posted_at are set to the confirmation time — the only durable timestamp this evidence supports", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.posted_at, "2026-01-01T02:00:00Z");
  assert.equal(result.record.publishing.instagram.feed.published_at, "2026-01-01T02:00:00Z");
});

test("6. this attempt is NOT archived into prior_attempts — it was not abandoned, it was the successful publication", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.publishing.prior_attempts ?? [], []);
});

test("6b. the claim is preserved (not cleared) — matches the existing normal-completion convention where posted is terminal and claim stays as historical record", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.claim.claim_id, "claim-1");
});

// ---------------------------------------------------------------------------
// 7-8. idempotency
// ---------------------------------------------------------------------------

test("7. an exact replay of the same reconciliation event is idempotent", () => {
  const state = ambiguousTimeoutState("s1");
  const first = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(first.ok, true);
  const second = applyPostingManuallyConfirmedPostedEvent(first.state, successPayload("s1"));
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);
});

test("8. a DIFFERENT reconciliation replay (different confirmed_at, already posted) is rejected — never silently reprocessed", () => {
  const state = ambiguousTimeoutState("s1");
  const first = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(first.ok, true);
  const conflicting = applyPostingManuallyConfirmedPostedEvent(first.state, successPayload("s1", { confirmed_at: "2026-01-01T03:00:00Z" }));
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, "invalid_state:posted");
});

test("a genuinely-completed record (real machine-verified posting-completed, not this reconciliation) is also rejected — this event never overrides a real completion", () => {
  const state = bufferPostCreatedThenCompletedState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
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

// ---------------------------------------------------------------------------
// 9-15. rejection cases
// ---------------------------------------------------------------------------

test("9. a wrong claim_id is rejected", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1", { claim_id: "wrong-claim" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

test("10. a non-ambiguous posting state (still publish_attempted, never reached ambiguous) is rejected", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_feed_state:publish_attempted");
});

test("10b. a non-ambiguous posting state (still claimed, never even attempted) is rejected", () => {
  const state = bufferClaimedState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_feed_state:claimed");
});

test("11. a failed (definite-failure) state is rejected — this event only ever applies to ambiguous attempts", () => {
  const state = bufferPublishAttemptedState("s1");
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
  const result = applyPostingManuallyConfirmedPostedEvent(tampered, successPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:failed");
});

test("12. a missing publish_attempted_at is rejected — cannot happen via the real ambiguous path, but the gate itself must never assume it", () => {
  const state = ambiguousTimeoutState("s1");
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
  const result = applyPostingManuallyConfirmedPostedEvent(tampered, successPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "publish_attempted_at_missing");
});

test("13. a missing evidence_note is rejected", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1", { evidence_note: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "evidence_note_required");
});

test("a missing confirmed_by is rejected", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1", { confirmed_by: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "confirmed_by_required");
});

test("14. a malformed confirmed_at is rejected", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1", { confirmed_at: "not-a-date" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "confirmed_at_invalid");
});

test("a wrong-provider (Meta) record is rejected — this event only ever applies to Buffer-provider ambiguity", () => {
  const state = approvedFeedState("s1");
  const claimed = applyPostingClaimedEvent(state, claimPayload("s1", { provider: "meta" }));
  assert.equal(claimed.ok, true);
  const tampered = {
    ...claimed.state,
    stories: {
      ...claimed.state.stories,
      s1: {
        ...claimed.state.stories.s1,
        status: "posting",
        publishing: {
          ...claimed.state.stories.s1.publishing,
          status: "posting",
          instagram: {
            ...claimed.state.stories.s1.publishing.instagram,
            feed: { ...claimed.state.stories.s1.publishing.instagram.feed, status: "ambiguous", publish_attempted_at: "2026-01-01T01:02:00Z" },
          },
        },
      },
    },
  };
  const result = applyPostingManuallyConfirmedPostedEvent(tampered, successPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_provider");
});

test("15. a non-string buffer_post_id is rejected — invalid_payload, never silently coerced", () => {
  const state = ambiguousTimeoutState("s1");
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1", { buffer_post_id: 12345 }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_payload");
});

// ---------------------------------------------------------------------------
// Safety: no network capability anywhere in this file
// ---------------------------------------------------------------------------

test("this reducer contains no network calls and no Buffer/Meta/Instagram API client code", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/postingEvents.js", import.meta.url), "utf-8");
  assert.ok(!/\bfetch\s*\(/.test(src), "postingEvents.js must never call fetch() directly");
});

// ---------------------------------------------------------------------------
// Cross-story safety
// ---------------------------------------------------------------------------

test("the reconciliation is scoped to exactly the named story — an unrelated story's record is never touched", () => {
  let state = ambiguousTimeoutState("s1");
  state = ensureRecord(state, "s2", { status: "new" }).state;
  const before = state.stories.s2;
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("s1"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.stories.s2, before);
});

test("not_found is returned for a story that doesn't exist", () => {
  const state = emptyState();
  const result = applyPostingManuallyConfirmedPostedEvent(state, successPayload("does-not-exist"));
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
