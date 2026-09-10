#!/usr/bin/env node
// Regression suite for the Buffer-provider additive state support in
// scripts/lib/postingEvents.js + scripts/lib/socialState.js's emptyRecord().
// Fully offline and deterministic — no network, no Buffer/Meta call is
// possible from this file, no production data is touched. Run with:
// node scripts/tests/posting-events-buffer-provider-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord, canTransition } from "../lib/socialState.js";
import {
  applyPostingClaimedEvent,
  applyPostingPublishAttemptedEvent,
  applyPostingCompletedEvent,
  applyPostingFailedEvent,
  applyPostingAmbiguousEvent,
  applyPostingBufferCreatedEvent,
} from "../lib/postingEvents.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures (mirrors posting-events-regression.mjs's own fixture style)
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

/** Establishes a Buffer post_id via posting-buffer-created (required before ANY posting-completed for a Buffer-provider record — see the reducer-level hardening). */
function bufferPostCreatedState(id, { postId = "buffer-post-1", status = "sending", channelId = "6aa2fb5fcd8b9c702c4530c5", dueAt = null } = {}) {
  const state = bufferPublishAttemptedState(id);
  const result = applyPostingBufferCreatedEvent(state, { story_id: id, claim_id: "claim-1", post_id: postId, channel_id: channelId, status, due_at: dueAt });
  assert.equal(result.ok, true, "fixture setup: posting-buffer-created must succeed");
  return result.state;
}

// ---------------------------------------------------------------------------
// 1-2. legacy/Meta normalization unchanged
// ---------------------------------------------------------------------------

test("1. an existing (no-provider-argument) posting-claimed call still normalizes to provider 'meta' and behaves identically to before this change", () => {
  const state = approvedFeedState("s1");
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.provider, "meta");
  assert.equal(result.record.publishing.instagram.feed.status, "claimed");
});

test("2. existing Meta publishing fields (container_id lifecycle) remain completely unchanged for a Meta-provider record", () => {
  const claimed = applyPostingClaimedEvent(approvedFeedState("s1"), claimPayload("s1")).state;
  const container = applyPostingCompletedEvent; // sanity: functions still exported/importable as before
  assert.equal(typeof container, "function");
  assert.equal(claimed.stories.s1.publishing.instagram.feed.container_id, null);
});

// ---------------------------------------------------------------------------
// 3-5. provider values
// ---------------------------------------------------------------------------

test("3. provider can be explicitly 'buffer'", () => {
  const result = applyPostingClaimedEvent(approvedFeedState("s1"), claimPayload("s1", { provider: "buffer" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.provider, "buffer");
});

test("4. provider can be explicitly 'meta'", () => {
  const result = applyPostingClaimedEvent(approvedFeedState("s1"), claimPayload("s1", { provider: "meta" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.provider, "meta");
});

test("5. an invalid provider value is rejected, matching the repo's existing schema discipline (explicit error code, no silent fallback)", () => {
  const result = applyPostingClaimedEvent(approvedFeedState("s1"), claimPayload("s1", { provider: "instagram-direct" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_provider");
});

// ---------------------------------------------------------------------------
// 6-10. Buffer field persistence
// ---------------------------------------------------------------------------

test("6-10. Buffer post_id/channel_id/status/due_at/sent_at can all be persisted via posting-completed (after the now-required posting-buffer-created step)", () => {
  const state = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(state, {
    story_id: "s1",
    claim_id: "claim-1",
    media_id: "buffer-post-1",
    published_at: "2026-01-01T01:03:00Z",
    buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", due_at: null, sent_at: "2026-01-01T01:03:00Z" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.publishing.instagram.feed.buffer, {
    post_id: "buffer-post-1",
    channel_id: "6aa2fb5fcd8b9c702c4530c5",
    status: "sent",
    due_at: null,
    sent_at: "2026-01-01T01:03:00Z",
  });
});

// ---------------------------------------------------------------------------
// 11-12. no duplication of shared fields
// ---------------------------------------------------------------------------

test("11. caption_used is NOT duplicated into the buffer object — it stays the single shared feed-level field", () => {
  const state = bufferClaimedState("s1");
  assert.ok(!("caption_used" in state.stories.s1.publishing.instagram.feed.buffer));
  assert.equal(state.stories.s1.publishing.instagram.feed.caption_used, claimPayload("s1").caption_used);
});

test("12. jpeg_url is NOT duplicated into the buffer object — it stays the single shared feed-level field", () => {
  const state = bufferClaimedState("s1");
  assert.ok(!("jpeg_url" in state.stories.s1.publishing.instagram.feed.buffer));
  assert.equal(state.stories.s1.publishing.instagram.feed.jpeg_url, claimPayload("s1").jpeg_url);
});

// ---------------------------------------------------------------------------
// 13-16. safety guarantees preserved for the Buffer path
// ---------------------------------------------------------------------------

test("13. publish_attempted_at remains required before completion — a Buffer-provider record cannot skip straight to completed", () => {
  const state = bufferClaimedState("s1"); // claimed, but publish-attempted never applied
  const result = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:claimed");
});

test("14. exact replay remains idempotent for a Buffer-provider record (publish-attempted and completed)", () => {
  const attempted = bufferPublishAttemptedState("s1", { attemptedAt: "2026-01-01T01:02:00Z" });
  const replay = applyPostingPublishAttemptedEvent(attempted, { story_id: "s1", claim_id: "claim-1", publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotentReplay, true);

  const created = applyPostingBufferCreatedEvent(attempted, { story_id: "s1", claim_id: "claim-1", post_id: "buffer-post-1", status: "sending" }).state;
  const bufferPayload = { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T01:03:00Z" };
  const posted = applyPostingCompletedEvent(created, { story_id: "s1", claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z", buffer: bufferPayload }).state;
  const postedReplay = applyPostingCompletedEvent(posted, { story_id: "s1", claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z", buffer: bufferPayload });
  assert.equal(postedReplay.ok, true);
  assert.equal(postedReplay.idempotentReplay, true);
});

test("15. a conflicting replay remains rejected for a Buffer-provider record (different publish_attempted_at, different media_id)", () => {
  const attempted = bufferPublishAttemptedState("s1", { attemptedAt: "2026-01-01T01:02:00Z" });
  const conflictingAttempt = applyPostingPublishAttemptedEvent(attempted, { story_id: "s1", claim_id: "claim-1", publish_attempted_at: "2026-01-01T01:09:00Z" });
  assert.equal(conflictingAttempt.ok, false);
  assert.equal(conflictingAttempt.error, "publish_attempt_conflict");

  const created = applyPostingBufferCreatedEvent(attempted, { story_id: "s1", claim_id: "claim-1", post_id: "buffer-post-1", status: "sending" }).state;
  const bufferPayload = { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T01:03:00Z" };
  const posted = applyPostingCompletedEvent(created, { story_id: "s1", claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z", buffer: bufferPayload }).state;
  const conflictingComplete = applyPostingCompletedEvent(posted, { story_id: "s1", claim_id: "claim-1", media_id: "buffer-post-DIFFERENT", published_at: "2026-01-01T01:03:00Z", buffer: bufferPayload });
  assert.equal(conflictingComplete.ok, false);
  assert.equal(conflictingComplete.error, "media_id_conflict");
});

test("16. 'posted' remains a true terminal, immutable state for a Buffer-provider record", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const posted = applyPostingCompletedEvent(created, { story_id: "s1", claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z", buffer: { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T01:03:00Z" } }).state;
  assert.equal(posted.stories.s1.status, "posted");
  assert.equal(canTransition("posted", "posting"), false);
  const secondClaim = applyPostingClaimedEvent(posted, claimPayload("s1", { claim_id: "claim-2", provider: "buffer" }));
  assert.equal(secondClaim.ok, false);
});

// ---------------------------------------------------------------------------
// 17. ambiguous cannot become automatic retry
// ---------------------------------------------------------------------------

test("17. an ambiguous Buffer outcome stays 'posting'/'ambiguous', never resets to a retryable state, and requires the same explicit human path as Meta", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingAmbiguousEvent(state, { story_id: "s1", claim_id: "claim-1", http_outcome_category: "rate_limited" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "ambiguous");
  assert.notEqual(result.record.publishing.instagram.feed.status, "not_posted");
  // Durable evidence survives untouched, exactly like the Meta path.
  assert.equal(result.record.publishing.instagram.feed.publish_attempted_at, state.stories.s1.publishing.instagram.feed.publish_attempted_at);
});

// ---------------------------------------------------------------------------
// No-container-step confirmation (Buffer has no posting-container-created step)
// ---------------------------------------------------------------------------

test("a Buffer-provider record can reach publish_attempted directly from 'claimed' — no container_id is ever required or checked", () => {
  const state = bufferClaimedState("s1");
  assert.equal(state.stories.s1.publishing.instagram.feed.status, "claimed");
  assert.equal(state.stories.s1.publishing.instagram.feed.container_id, null);
  const result = applyPostingPublishAttemptedEvent(state, { story_id: "s1", claim_id: "claim-1", publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.container_id, null, "container_id must stay null for Buffer — it is never populated or required");
});

test("a Meta-provider (or legacy, unset provider) record is completely unaffected — container_id is still required and matched exactly as before", () => {
  const state = applyPostingClaimedEvent(approvedFeedState("s1"), claimPayload("s1")).state; // default provider: "meta"
  const missingContainer = applyPostingPublishAttemptedEvent(state, { story_id: "s1", claim_id: "claim-1", publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(missingContainer.ok, false);
  assert.equal(missingContainer.error, "invalid_payload", "Meta's container_id requirement must remain exactly as strict as before this change");
});

// ---------------------------------------------------------------------------
// Secret/arbitrary-field safety on the new buffer sub-object
// ---------------------------------------------------------------------------

test("only the five known Buffer fields are ever copied from a completed-event payload's buffer object — arbitrary/sensitive fields are never persisted", () => {
  const state = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(state, {
    story_id: "s1",
    claim_id: "claim-1",
    media_id: "buffer-post-1",
    published_at: "2026-01-01T01:03:00Z",
    buffer: { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T01:03:00Z", access_token: "should-never-leak", api_key: "should-never-leak-either" },
  });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.record.publishing.instagram.feed.buffer);
  assert.ok(!serialized.includes("should-never-leak"));
  assert.deepEqual(Object.keys(result.record.publishing.instagram.feed.buffer).sort(), ["channel_id", "due_at", "post_id", "sent_at", "status"]);
});

// ---------------------------------------------------------------------------
// Backward compatibility with an old-shaped (pre-Buffer-stage) record
// ---------------------------------------------------------------------------

test("an old-shaped feed object with no `provider`/`buffer` fields at all is backward-compatible and does not crash on any event", () => {
  const state = approvedFeedState("s1", {
    publishing: {
      status: "not_posted",
      instagram: {
        feed: { status: "not_posted", container_id: null, media_id: null, published_at: null },
        story: { status: "not_posted", container_id: null, media_id: null, published_at: null },
      },
      facebook: { status: "not_posted", post_id: null, post_url: null },
      posted_at: null,
    },
  });
  const result = applyPostingClaimedEvent(state, claimPayload("s1", { provider: "buffer" }));
  assert.equal(result.ok, true, "an old-shaped record with no prior provider/buffer fields must not crash the new claim event");
  assert.equal(result.record.publishing.instagram.feed.provider, "buffer");
});

// ---------------------------------------------------------------------------
// Semantic correction: createPost success != published to Instagram
// ---------------------------------------------------------------------------
// Buffer's createPost returning PostActionSuccess with a post id proves
// Buffer accepted/created the post — it does NOT prove Instagram has
// received it. Only Buffer's own post.status === "sent" is affirmative
// proof of destination publication. See applyPostingBufferCreatedEvent's
// doc comment for the full design rationale.

function bufferCreatedPayload(id, overrides = {}) {
  return { story_id: id, claim_id: "claim-1", post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "scheduled", due_at: "2026-01-01T02:00:00Z", sent_at: null, ...overrides };
}

test("Buffer createPost success + status 'scheduled' does NOT mark posted — only posting-buffer-created applies, top-level status stays 'posting'", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "scheduled" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting", "scheduled must never reach top-level posted");
  assert.equal(result.record.publishing.instagram.feed.status, "buffer_post_created");
});

test("Buffer createPost success + status 'sending' does NOT mark posted", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "sending" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "buffer_post_created");
});

test("Buffer createPost success + status 'sent' CAN mark posted — but ONLY after the post_id was first established via posting-buffer-created", () => {
  // Real Buffer architecture: createPost/publication is asynchronous, so a
  // post_id must already be on record (via posting-buffer-created) before
  // completion is ever attempted — see the reducer-level hardening below.
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(created, {
    story_id: "s1",
    claim_id: "claim-1",
    media_id: "buffer-post-1",
    published_at: "2026-01-01T01:03:00Z",
    buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", sent_at: "2026-01-01T01:03:00Z" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posted");
});

test("Buffer 'sent' status reached via reconciliation (buffer_post_created -> completed) also correctly marks posted", () => {
  const created = applyPostingBufferCreatedEvent(bufferPublishAttemptedState("s1"), bufferCreatedPayload("s1", { status: "scheduled" })).state;
  assert.equal(created.stories.s1.status, "posting");

  // A later reconciliation confirms it's now sent — this goes DIRECTLY to
  // posting-completed, never through another posting-buffer-created call
  // (which structurally rejects "sent" — see the dedicated test below).
  const completed = applyPostingCompletedEvent(created, {
    story_id: "s1",
    claim_id: "claim-1",
    media_id: "buffer-post-1",
    published_at: "2026-01-01T02:00:05Z",
    buffer: { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T02:00:05Z" },
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.record.status, "posted");
});

test("Buffer 'sent' status persists post_id/channel_id/status/sent_at exactly", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(created, {
    story_id: "s1",
    claim_id: "claim-1",
    media_id: "buffer-post-1",
    published_at: "2026-01-01T01:03:00Z",
    buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", sent_at: "2026-01-01T01:03:00Z" },
  });
  assert.deepEqual(result.record.publishing.instagram.feed.buffer, { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", due_at: null, sent_at: "2026-01-01T01:03:00Z" });
});

// ---------------------------------------------------------------------------
// Reducer-level hardening: posting-completed itself must prove Buffer
// publication for provider "buffer" — never rely on caller discipline alone.
// ---------------------------------------------------------------------------

function completeBufferPayload(id, overrides = {}) {
  return { story_id: id, claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z", buffer: { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T01:03:00Z" }, ...overrides };
}

test("a Buffer completion with NO prior posting-buffer-created call, but INCOMPLETE proof (no channel_id), is rejected — Case B requires fully self-contained proof, not merely a post_id", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, completeBufferPayload("s1")); // completeBufferPayload supplies post_id but no channel_id
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_channel_id_missing");
});

// ---------------------------------------------------------------------------
// CASE B — immediate affirmative completion (no artificial buffer-created
// step required when Buffer's own createPost response already says "sent")
// ---------------------------------------------------------------------------

function immediateSentPayload(id, overrides = {}) {
  return { story_id: id, claim_id: "claim-1", media_id: "buffer-post-1", published_at: "2026-01-01T01:03:00Z", buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", sent_at: "2026-01-01T01:03:00Z" }, ...overrides };
}

test("1. publish_attempted + Buffer sent + valid post_id + valid channel_id + valid sent_at -> posted successfully, with NO prior posting-buffer-created call", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, immediateSentPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posted");
});

test("2. immediate completion persists post_id/channel_id/status/sent_at atomically", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, immediateSentPayload("s1"));
  assert.deepEqual(result.record.publishing.instagram.feed.buffer, { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", due_at: null, sent_at: "2026-01-01T01:03:00Z" });
  assert.equal(result.record.publishing.instagram.feed.media_id, "buffer-post-1");
});

test("3. publish_attempted + scheduled cannot complete (immediate case)", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, immediateSentPayload("s1", { buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "scheduled", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:scheduled");
});

test("4. publish_attempted + sending cannot complete (immediate case)", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, immediateSentPayload("s1", { buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sending", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:sending");
});

test("5. publish_attempted + sent but missing post_id cannot complete", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, immediateSentPayload("s1", { buffer: { channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", sent_at: "2026-01-01T01:03:00Z" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_post_id_missing");
});

test("6. publish_attempted + sent but missing channel_id cannot complete", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, immediateSentPayload("s1", { buffer: { post_id: "buffer-post-1", status: "sent", sent_at: "2026-01-01T01:03:00Z" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_channel_id_missing");
});

test("7. publish_attempted + sent but invalid/missing sent_at cannot complete", () => {
  const state = bufferPublishAttemptedState("s1");
  const missing = applyPostingCompletedEvent(state, immediateSentPayload("s1", { buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", sent_at: null } }));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "buffer_sent_at_invalid");

  const malformed = applyPostingCompletedEvent(state, immediateSentPayload("s1", { buffer: { post_id: "buffer-post-1", channel_id: "6aa2fb5fcd8b9c702c4530c5", status: "sent", sent_at: "not-a-date" } }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, "buffer_sent_at_invalid");
});

test("8. buffer_post_created + sent + matching stored post_id can complete (Case A)", () => {
  const created = bufferPostCreatedState("s1", { postId: "buffer-post-1", status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posted");
});

test("9. buffer_post_created + sent + DIFFERENT post_id rejects (Case A)", () => {
  const created = bufferPostCreatedState("s1", { postId: "buffer-post-1", status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-DIFFERENT", status: "sent", sent_at: "2026-01-01T01:03:00Z" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_post_id_mismatch");
});

test("10. posting-buffer-created still rejects 'sent' — immediate completion is handled exclusively by posting-completed's Case B, never by posting-buffer-created", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "sent" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_buffer_status:sent");
});

test("11. Meta lifecycle remains completely unchanged by the immediate-completion fix (provider gate never fires for Meta)", () => {
  const state = applyPostingClaimedEvent(approvedFeedState("metaStory2"), claimPayload("metaStory2")).state;
  const containerState = { ...state, stories: { ...state.stories, metaStory2: { ...state.stories.metaStory2, publishing: { ...state.stories.metaStory2.publishing, instagram: { ...state.stories.metaStory2.publishing.instagram, feed: { ...state.stories.metaStory2.publishing.instagram.feed, status: "container_created", container_id: "container-1" } } } } } };
  const attempted = applyPostingPublishAttemptedEvent(containerState, { story_id: "metaStory2", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "2026-01-01T01:02:00Z" }).state;
  const completed = applyPostingCompletedEvent(attempted, { story_id: "metaStory2", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(completed.ok, true);
  assert.equal(completed.record.status, "posted");
});

test("12. exact replay/idempotency remains correct for an immediate-completion Buffer record", () => {
  const state = bufferPublishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, immediateSentPayload("s1")).state;
  const replay = applyPostingCompletedEvent(posted, immediateSentPayload("s1"));
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotentReplay, true);
});

test("13. posted immutability remains correct for an immediate-completion Buffer record", () => {
  const state = bufferPublishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, immediateSentPayload("s1")).state;
  const conflicting = applyPostingCompletedEvent(posted, immediateSentPayload("s1", { media_id: "buffer-post-DIFFERENT" }));
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, "media_id_conflict");
  const secondClaim = applyPostingClaimedEvent(posted, claimPayload("s1", { claim_id: "claim-2", provider: "buffer" }));
  assert.equal(secondClaim.ok, false);
});

test("Buffer status 'scheduled' cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "scheduled" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "scheduled", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:scheduled");
});

test("Buffer status 'sending' cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "sending", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:sending");
});

test("Buffer status 'draft' cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "draft" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "draft", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:draft");
});

test("Buffer status 'needs_approval' cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "needs_approval" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "needs_approval", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:needs_approval");
});

test("Buffer status 'error' cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "error", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:error");
});

test("Buffer unknown status cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "some_future_status", sent_at: null } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:some_future_status");
});

test("Buffer missing status cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", sent_at: "2026-01-01T01:03:00Z" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_status_not_sent:missing");
});

test("Buffer 'sent' WITHOUT a valid sent_at cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const missing = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "sent", sent_at: null } }));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "buffer_sent_at_invalid");

  const malformed = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-1", status: "sent", sent_at: "not-a-real-date" } }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, "buffer_sent_at_invalid");
});

test("Buffer 'sent' with a MISMATCHED post_id cannot call posting-completed", () => {
  const created = bufferPostCreatedState("s1", { postId: "buffer-post-1", status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1", { buffer: { post_id: "buffer-post-DIFFERENT", status: "sent", sent_at: "2026-01-01T01:03:00Z" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "buffer_post_id_mismatch");
});

test("Buffer 'sent' + matching post_id + valid sent_at CAN complete", () => {
  const created = bufferPostCreatedState("s1", { postId: "buffer-post-1", status: "sending" });
  const result = applyPostingCompletedEvent(created, completeBufferPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posted");
});

test("posting-buffer-created rejects 'sent' — that status may only ever be recorded via posting-completed", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "sent" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_buffer_status:sent");
});

test("posting-buffer-created rejects 'error' — that status may only ever be recorded via posting-failed", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "error" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_buffer_status:error");
});

test("posting-buffer-created rejects an unknown status — that case may only ever be recorded via posting-ambiguous", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "some_future_status" }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_buffer_status:some_future_status");
});

test("posting-buffer-created rejects a missing status", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, { story_id: "s1", claim_id: "claim-1", post_id: "buffer-post-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_buffer_status:missing");
});

test("posting-buffer-created allows a scheduled -> sending update for the SAME post_id (legitimate nonterminal-to-nonterminal reconciliation)", () => {
  const created = bufferPostCreatedState("s1", { postId: "buffer-post-1", status: "scheduled" });
  const updated = applyPostingBufferCreatedEvent(created, bufferCreatedPayload("s1", { post_id: "buffer-post-1", status: "sending" }));
  assert.equal(updated.ok, true);
  assert.equal(updated.record.publishing.instagram.feed.buffer.status, "sending");
  assert.equal(updated.record.status, "posting");
});

test("Buffer 'scheduled' status persists post_id (and channel_id/due_at) for later reconciliation, without completing", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "scheduled", due_at: "2026-01-02T00:00:00Z" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.buffer.post_id, "buffer-post-1");
  assert.equal(result.record.publishing.instagram.feed.buffer.due_at, "2026-01-02T00:00:00Z");
  assert.equal(result.record.status, "posting");
});

test("Buffer 'sending' status persists post_id for later reconciliation, without completing", () => {
  const state = bufferPublishAttemptedState("s1");
  const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload("s1", { status: "sending" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.buffer.post_id, "buffer-post-1");
  assert.equal(result.record.status, "posting");
});

test("Buffer 'error' status maps safely to failed via the existing posting-failed event — NEVER through posting-buffer-created, which structurally rejects 'error'", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const rejectedAsCreated = applyPostingBufferCreatedEvent(created, bufferCreatedPayload("s1", { status: "error" }));
  assert.equal(rejectedAsCreated.ok, false, "posting-buffer-created must never accept 'error' as a status");

  const failed = applyPostingFailedEvent(created, { story_id: "s1", claim_id: "claim-1", message: "Buffer reported post status: error", http_outcome_category: "buffer_post_error" });
  assert.equal(failed.ok, true);
  assert.equal(failed.record.status, "failed");
  assert.equal(failed.record.publishing.instagram.feed.status, "failed");
});

test("an unknown/unrecognized Buffer status becomes ambiguous/manual-review via the existing posting-ambiguous event — NEVER through posting-buffer-created, which structurally rejects unrecognized statuses", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const rejectedAsCreated = applyPostingBufferCreatedEvent(created, bufferCreatedPayload("s1", { status: "some_future_status" }));
  assert.equal(rejectedAsCreated.ok, false);

  const result = applyPostingAmbiguousEvent(created, { story_id: "s1", claim_id: "claim-1", http_outcome_category: "unknown_buffer_status" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "ambiguous");
});

test("no NONTERMINAL Buffer status can ever reach top-level 'posted' via posting-buffer-created — scheduled/sending/draft/needs_approval all stay strictly below posted", () => {
  for (const status of ["scheduled", "sending", "draft", "needs_approval"]) {
    const state = bufferPublishAttemptedState(`s-${status}`);
    const result = applyPostingBufferCreatedEvent(state, bufferCreatedPayload(`s-${status}`, { status }));
    assert.equal(result.ok, true);
    assert.notEqual(result.record.status, "posted", `status '${status}' must never reach top-level posted via posting-buffer-created`);
  }
});

test("existing Meta posting completion behavior remains completely unchanged by this correction", () => {
  const state = applyPostingClaimedEvent(approvedFeedState("metaStory"), claimPayload("metaStory")).state; // provider defaults to "meta"
  const containerState = { ...state, stories: { ...state.stories, metaStory: { ...state.stories.metaStory, publishing: { ...state.stories.metaStory.publishing, instagram: { ...state.stories.metaStory.publishing.instagram, feed: { ...state.stories.metaStory.publishing.instagram.feed, status: "container_created", container_id: "container-1" } } } } } };
  const attempted = applyPostingPublishAttemptedEvent(containerState, { story_id: "metaStory", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "2026-01-01T01:02:00Z" }).state;
  const completed = applyPostingCompletedEvent(attempted, { story_id: "metaStory", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(completed.ok, true);
  assert.equal(completed.record.status, "posted");
  assert.equal(completed.record.publishing.instagram.feed.provider, "meta");
});

test("exact replay idempotency still holds for posting-buffer-created (same post_id, refreshed status is an ALLOWED update, not a rejection)", () => {
  const created = applyPostingBufferCreatedEvent(bufferPublishAttemptedState("s1"), bufferCreatedPayload("s1", { status: "scheduled" })).state;
  const refreshed = applyPostingBufferCreatedEvent(created, bufferCreatedPayload("s1", { status: "sending" }));
  assert.equal(refreshed.ok, true, "a status refresh for the SAME post_id must be allowed, not rejected as a conflict");
  assert.equal(refreshed.record.publishing.instagram.feed.buffer.status, "sending");
});

test("conflicting replay still rejects — a DIFFERENT Buffer post_id for the same story is never silently accepted", () => {
  const created = applyPostingBufferCreatedEvent(bufferPublishAttemptedState("s1"), bufferCreatedPayload("s1", { post_id: "buffer-post-1" })).state;
  const conflict = applyPostingBufferCreatedEvent(created, bufferCreatedPayload("s1", { post_id: "buffer-post-DIFFERENT" }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "buffer_post_id_conflict");
});

test("posted immutability still holds after this correction — a posted Buffer record cannot be re-claimed or re-completed with a different post", () => {
  const created = bufferPostCreatedState("s1", { status: "sending" });
  const posted = applyPostingCompletedEvent(created, completeBufferPayload("s1")).state;
  const secondClaim = applyPostingClaimedEvent(posted, claimPayload("s1", { claim_id: "claim-2", provider: "buffer" }));
  assert.equal(secondClaim.ok, false);
  const conflictingComplete = applyPostingCompletedEvent(posted, completeBufferPayload("s1", { media_id: "buffer-post-DIFFERENT" }));
  assert.equal(conflictingComplete.ok, false);
  assert.equal(conflictingComplete.error, "media_id_conflict");
});

test("no automatic retry appears anywhere in this correction — postingEvents.js still contains no network calls and no retry loop", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/postingEvents.js", import.meta.url), "utf-8");
  assert.ok(!/fetch\s*\(/.test(src));
  assert.ok(!/\bretry\b/i.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "no retry logic may exist in the executable code");
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
