#!/usr/bin/env node
// Stage 4B regression suite: publishing state + claim/idempotency
// foundation for a future Instagram Feed publishing workflow. Exercises
// the real pure functions in scripts/lib/postingEvents.js entirely
// in-memory — no file I/O, no HTTP, no synthetic data ever touches
// data/social-state.json, and no Meta/Instagram/Facebook call is possible
// from this library (see test 40). Run with:
// node scripts/tests/posting-events-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord, transition, canTransition } from "../lib/socialState.js";
import {
  applyPostingClaimedEvent,
  applyPostingContainerCreatedEvent,
  applyPostingPublishAttemptedEvent,
  applyPostingCompletedEvent,
  applyPostingFailedEvent,
  applyPostingAmbiguousEvent,
} from "../lib/postingEvents.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully "approved", Feed-selected, ready-to-claim record — the minimum starting point every posting event assumes. */
function approvedFeedState(id, overrides = {}) {
  let state = emptyState();
  state = ensureRecord(state, id, { status: "new" }).state;
  const record = {
    ...state.stories[id],
    status: "approved",
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z", window_start: "2026-01-01T00:00:00Z", window_end: "2026-01-01T02:00:00Z", score: 1, reason: "test" },
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

function claimedState(id, claimOverrides = {}) {
  const state = approvedFeedState(id);
  const result = applyPostingClaimedEvent(state, claimPayload(id, claimOverrides));
  assert.equal(result.ok, true, "fixture setup: posting-claimed must succeed");
  return result.state;
}

function containerCreatedState(id, containerId = "container-1") {
  const state = claimedState(id);
  const result = applyPostingContainerCreatedEvent(state, { story_id: id, claim_id: "claim-1", container_id: containerId, container_created_at: "2026-01-01T01:01:00Z" });
  assert.equal(result.ok, true, "fixture setup: posting-container-created must succeed");
  return result.state;
}

function publishAttemptedState(id, { containerId = "container-1", attemptedAt = "2026-01-01T01:02:00Z" } = {}) {
  const state = containerCreatedState(id, containerId);
  const result = applyPostingPublishAttemptedEvent(state, { story_id: id, claim_id: "claim-1", container_id: containerId, publish_attempted_at: attemptedAt });
  assert.equal(result.ok, true, "fixture setup: posting-publish-attempted must succeed");
  return result.state;
}

// ---------------------------------------------------------------------------
// 1-7. posting-claimed
// ---------------------------------------------------------------------------

test("1. an approved, Feed-selected, ready record accepts posting-claimed and moves approved -> posting", () => {
  const state = approvedFeedState("s1");
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "claimed");
});

test("2. a Story-selected record accepts posting-claimed into its own .story channel, never touching .feed", () => {
  const state = approvedFeedState("s1", { selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" } });
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.story.status, "claimed");
  assert.equal(result.record.publishing.instagram.feed.status, "not_posted");
});

test("2b. a record with a destination that is neither 'feed' nor 'story' rejects posting claim (wrong_destination)", () => {
  const state = approvedFeedState("s1", { selection: { destination: "reel", slot_id: "reel:test", selected_at: "2026-01-01T00:00:00Z" } });
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_destination");
});

test("3. an unapproved record (still awaiting_approval) rejects posting claim", () => {
  const state = approvedFeedState("s1", { status: "awaiting_approval", approval: { status: "pending" } });
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, false);
  assert.ok(result.error.startsWith("invalid_state") || result.error === "invalid_state:awaiting_approval");
});

test("4. a rejected record rejects posting claim", () => {
  const state = approvedFeedState("s1", { status: "rejected", approval: { status: "rejected" } });
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, false);
});

test("5. a posted record rejects a new posting claim", () => {
  const state = approvedFeedState("s1", { status: "posted", publishing: { status: "posted", claim: { claim_id: "old", processor_id: "p", claimed_at: "x", claim_expires_at: "y", retry_count: 0 }, instagram: { feed: { status: "posted", storage_key: null, jpeg_url: null, caption_used: "c", container_id: "c1", container_created_at: "t", publish_attempted_at: "t", media_id: "m1", permalink: null, published_at: "t", last_http_outcome: "success", last_reconciled_at: null }, story: { status: "not_posted", container_id: null, media_id: null, published_at: null } }, facebook: { status: "not_posted", post_id: null, post_url: null }, posted_at: "t" } });
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, false);
});

test("6. claim fields persist correctly", () => {
  const state = approvedFeedState("s1");
  const result = applyPostingClaimedEvent(state, claimPayload("s1", { claim_id: "claim-abc", processor_id: "proc-xyz", claimed_at: "2026-02-01T00:00:00Z", claim_expires_at: "2026-02-01T00:50:00Z" }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.publishing.claim, { claim_id: "claim-abc", processor_id: "proc-xyz", claimed_at: "2026-02-01T00:00:00Z", claim_expires_at: "2026-02-01T00:50:00Z", retry_count: 0 });
});

test("7. caption_used persists exactly as supplied — a snapshot, not a recomputation", () => {
  const state = approvedFeedState("s1", { caption: { status: "ready", text: "DIFFERENT current caption text" } });
  const snapshot = "The exact snapshot caption taken at claim time.";
  const result = applyPostingClaimedEvent(state, claimPayload("s1", { caption_used: snapshot }));
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.caption_used, snapshot);
});

// ---------------------------------------------------------------------------
// 8-11. posting-container-created
// ---------------------------------------------------------------------------

test("8. container-created succeeds with matching claim", () => {
  const state = claimedState("s1");
  const result = applyPostingContainerCreatedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", container_created_at: "2026-01-01T01:01:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting", "container-created must never change top-level status");
  assert.equal(result.record.publishing.instagram.feed.status, "container_created");
  assert.equal(result.record.publishing.instagram.feed.container_id, "container-1");
});

test("9. container-created rejects a mismatched claim_id", () => {
  const state = claimedState("s1");
  const result = applyPostingContainerCreatedEvent(state, { story_id: "s1", claim_id: "wrong-claim", container_id: "container-1", container_created_at: "2026-01-01T01:01:00Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

test("10. duplicate identical container-created is idempotent", () => {
  const state = containerCreatedState("s1", "container-1");
  const result = applyPostingContainerCreatedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", container_created_at: "2026-01-01T01:01:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.record, state.stories.s1, "an identical replay must be a true no-op, not a re-written record");
});

test("11. a conflicting container_id (different from the one already recorded) is rejected", () => {
  const state = containerCreatedState("s1", "container-1");
  const result = applyPostingContainerCreatedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-2", container_created_at: "2026-01-01T01:05:00Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "container_id_conflict");
});

// ---------------------------------------------------------------------------
// 12-15. posting-publish-attempted
// ---------------------------------------------------------------------------

test("12. publish-attempted succeeds with the matching container", () => {
  const state = containerCreatedState("s1", "container-1");
  const result = applyPostingPublishAttemptedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "publish_attempted");
});

test("13. publish_attempted_at timestamp persists exactly", () => {
  const state = containerCreatedState("s1", "container-1");
  const result = applyPostingPublishAttemptedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "2026-03-03T03:03:03Z" });
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.publish_attempted_at, "2026-03-03T03:03:03Z");
});

test("14. duplicate identical publish-attempted (same container, same timestamp) is idempotent", () => {
  const state = publishAttemptedState("s1", { attemptedAt: "2026-01-01T01:02:00Z" });
  const result = applyPostingPublishAttemptedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "2026-01-01T01:02:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.record, state.stories.s1);
});

test("15. a conflicting publish-attempted (same container, DIFFERENT timestamp) is rejected — never silently re-attempted", () => {
  const state = publishAttemptedState("s1", { attemptedAt: "2026-01-01T01:02:00Z" });
  const result = applyPostingPublishAttemptedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "2026-01-01T01:09:00Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "publish_attempt_conflict");
  assert.equal(state.stories.s1.publishing.instagram.feed.publish_attempted_at, "2026-01-01T01:02:00Z", "the original durable evidence must never be erased or overwritten");
});

test("15b. publish-attempted is rejected if no JPEG asset reference (jpeg_url/storage_key) was ever supplied", () => {
  const state = containerCreatedState("s1");
  const stripped = { ...state, stories: { ...state.stories, s1: { ...state.stories.s1, publishing: { ...state.stories.s1.publishing, instagram: { ...state.stories.s1.publishing.instagram, feed: { ...state.stories.s1.publishing.instagram.feed, jpeg_url: null, storage_key: null } } } } } };
  const result = applyPostingPublishAttemptedEvent(stripped, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", publish_attempted_at: "t" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "asset_missing");
});

// ---------------------------------------------------------------------------
// 16-21. posting-completed
// ---------------------------------------------------------------------------

test("16. completion succeeds once publish-attempted with a media_id", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "posted");
});

test("17. posted_at persists on both the feed object and the top-level publishing object", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-04-04T04:04:04Z" });
  assert.equal(result.record.publishing.instagram.feed.published_at, "2026-04-04T04:04:04Z");
  assert.equal(result.record.publishing.posted_at, "2026-04-04T04:04:04Z");
});

test("18. media_id persists", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-XYZ", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(result.record.publishing.instagram.feed.media_id, "media-XYZ");
});

test("19. permalink persists when supplied", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", permalink: "https://instagram.com/p/abc123", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(result.record.publishing.instagram.feed.permalink, "https://instagram.com/p/abc123");
});

test("20. a posted record becomes immutable — a fresh posting-claimed against it is rejected", () => {
  const state = publishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).state;
  const result = applyPostingClaimedEvent(posted, claimPayload("s1", { claim_id: "claim-2" }));
  assert.equal(result.ok, false);
});

test("21. a conflicting second media_id on an already-posted record is rejected", () => {
  const state = publishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).state;
  const result = applyPostingCompletedEvent(posted, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-DIFFERENT", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "media_id_conflict");

  const identicalReplay = applyPostingCompletedEvent(posted, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" });
  assert.equal(identicalReplay.ok, true);
  assert.equal(identicalReplay.idempotentReplay, true, "an IDENTICAL replay of the same media_id must remain a safe no-op");
});

// ---------------------------------------------------------------------------
// 22-24. failure / ambiguous
// ---------------------------------------------------------------------------

test("22. a definite failure transitions posting -> failed", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingFailedEvent(state, { story_id: "s1", claim_id: "claim-1", message: "Meta returned a definite non-published error", http_outcome_category: "4xx" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "failed");
  assert.equal(result.record.publishing.instagram.feed.status, "failed");
  assert.equal(result.record.last_error.stage, "instagram");
});

test("23. an ambiguous outcome is recorded but remains non-retryable (feed.status becomes 'ambiguous', not 'not_posted')", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingAmbiguousEvent(state, { story_id: "s1", claim_id: "claim-1", http_outcome_category: "timeout" });
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.status, "ambiguous");
  assert.notEqual(result.record.publishing.instagram.feed.status, "not_posted");
});

test("24. an ambiguous event never resets top-level status back to approved/not_posted/claimed — it stays 'posting'", () => {
  const state = publishAttemptedState("s1");
  const result = applyPostingAmbiguousEvent(state, { story_id: "s1", claim_id: "claim-1", http_outcome_category: "connection_reset" });
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.status, "posting");
  // Durable evidence must survive an ambiguous marking untouched.
  assert.equal(result.record.publishing.instagram.feed.container_id, "container-1");
  assert.equal(result.record.publishing.instagram.feed.publish_attempted_at, "2026-01-01T01:02:00Z");
});

// ---------------------------------------------------------------------------
// 25-28. rejection / validation / secret safety
// ---------------------------------------------------------------------------

test("25. every posting event rejects a mismatched claim_id (container-created, publish-attempted, completed, ambiguous)", () => {
  const containerState = claimedState("s1");
  assert.equal(applyPostingContainerCreatedEvent(containerState, { story_id: "s1", claim_id: "nope", container_id: "c1", container_created_at: "t" }).error, "claim_mismatch");

  const paState = containerCreatedState("s2");
  assert.equal(applyPostingPublishAttemptedEvent(paState, { story_id: "s2", claim_id: "nope", container_id: "container-1", publish_attempted_at: "t" }).error, "claim_mismatch");

  const completedState = publishAttemptedState("s3");
  assert.equal(applyPostingCompletedEvent(completedState, { story_id: "s3", claim_id: "nope", container_id: "container-1", media_id: "m1", published_at: "2026-01-01T00:00:00Z" }).error, "claim_mismatch");

  const ambiguousState = publishAttemptedState("s4");
  assert.equal(applyPostingAmbiguousEvent(ambiguousState, { story_id: "s4", claim_id: "nope" }).error, "claim_mismatch");
});

test("26. a malformed posting-claimed payload (missing caption_used) is rejected", () => {
  const state = approvedFeedState("s1");
  const result = applyPostingClaimedEvent(state, claimPayload("s1", { caption_used: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "caption_missing");
});

test("27. arbitrary unknown fields in a payload are never persisted onto the record", () => {
  const state = approvedFeedState("s1");
  const result = applyPostingClaimedEvent(state, claimPayload("s1", { some_random_field: "should never appear", another_junk_field: 12345 }));
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.record);
  assert.ok(!serialized.includes("should never appear"));
  assert.ok(!serialized.includes("another_junk_field"));
});

test("28. an access_token-shaped field in a payload is never persisted anywhere in the record", () => {
  const state = approvedFeedState("s1");
  const result = applyPostingClaimedEvent(state, claimPayload("s1", { access_token: "IGQVJ-super-secret-value", app_secret: "another-secret", authorization: "Bearer secret" }));
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.record);
  assert.ok(!serialized.includes("super-secret-value"));
  assert.ok(!serialized.includes("another-secret"));
  assert.ok(!serialized.includes("Bearer secret"));
});

// ---------------------------------------------------------------------------
// 29-32. sibling-shape preservation / backward compatibility
// ---------------------------------------------------------------------------

test("29. the existing Story publishing shape is completely untouched by the full Feed posting lifecycle", () => {
  const state = publishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).state;
  assert.deepEqual(posted.stories.s1.publishing.instagram.story, {
    status: "not_posted",
    provider: null,
    storage_key: null,
    jpeg_url: null,
    caption_used: null,
    container_id: null,
    container_created_at: null,
    publish_attempted_at: null,
    media_id: null,
    permalink: null,
    published_at: null,
    last_http_outcome: null,
    last_reconciled_at: null,
    buffer: { post_id: null, channel_id: null, status: null, due_at: null, sent_at: null },
  });
});

test("30. the existing Facebook publishing shape is completely untouched by the full Feed posting lifecycle", () => {
  const state = publishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).state;
  assert.deepEqual(posted.stories.s1.publishing.facebook, { status: "not_posted", post_id: null, post_url: null });
});

test("31. a legacy record with no selection at all normalizes safely — rejected as wrong_destination, never crashes", () => {
  const state = approvedFeedState("s1", { selection: undefined });
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_destination");
});

test("32. an old-shaped publishing object (pre-Stage-4B, no `claim` field, minimal feed shape) is backward-compatible and does not crash", () => {
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
  const result = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(result.ok, true, "an old-shaped publishing object must not crash the new claim event");
  assert.equal(result.record.publishing.instagram.feed.status, "claimed");
  assert.equal(result.record.publishing.instagram.feed.caption_used, claimPayload("s1").caption_used);
});

// ---------------------------------------------------------------------------
// 33-34. replay safety / transition table
// ---------------------------------------------------------------------------

test("33. replaying the exact same posting-claimed event after the first succeeded cannot create a second claim/duplicate work", () => {
  const state = approvedFeedState("s1");
  const first = applyPostingClaimedEvent(state, claimPayload("s1"));
  assert.equal(first.ok, true);
  const replay = applyPostingClaimedEvent(first.state, claimPayload("s1"));
  assert.equal(replay.ok, false, "the record is no longer 'approved' — a second claim attempt must be rejected, not silently re-applied");
});

test("34. the top-level transition rules remain exactly approved->[posting], posting->[posted,failed], posted->[] — unmodified by this stage", () => {
  assert.equal(canTransition("approved", "posting"), true);
  assert.equal(canTransition("posting", "posted"), true);
  assert.equal(canTransition("posting", "failed"), true);
  assert.equal(canTransition("posted", "posting"), false);
  assert.equal(canTransition("posted", "approved"), false);
  assert.equal(canTransition("approved", "posted"), false, "approved must go through posting, never straight to posted");
});

// ---------------------------------------------------------------------------
// 35-39. isolation from unrelated record fields
// ---------------------------------------------------------------------------

test("35. posting events never mutate record.artwork", () => {
  const state = publishAttemptedState("s1");
  const before = JSON.stringify(state.stories.s1.artwork);
  const after = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).record.artwork;
  assert.equal(JSON.stringify(after), before);
});

test("36. posting events never mutate record.caption", () => {
  const state = publishAttemptedState("s1");
  const before = JSON.stringify(state.stories.s1.caption);
  const after = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).record.caption;
  assert.equal(JSON.stringify(after), before);
});

test("37. posting events never mutate record.approval", () => {
  const state = publishAttemptedState("s1");
  const before = JSON.stringify(state.stories.s1.approval);
  const after = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).record.approval;
  assert.equal(JSON.stringify(after), before);
});

test("38. posting events never modify record.selection (destination stays exactly as selected)", () => {
  const state = publishAttemptedState("s1");
  const before = JSON.stringify(state.stories.s1.selection);
  const after = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).record.selection;
  assert.equal(JSON.stringify(after), before);
});

test("39. 'posted' remains a true terminal state — no legal outgoing transition exists", () => {
  const state = publishAttemptedState("s1");
  const posted = applyPostingCompletedEvent(state, { story_id: "s1", claim_id: "claim-1", container_id: "container-1", media_id: "media-1", published_at: "2026-01-01T01:03:00Z" }).state;
  assert.equal(posted.stories.s1.status, "posted");
  assert.equal(canTransition("posted", "posting"), false);
  assert.equal(canTransition("posted", "approved"), false);
  assert.equal(canTransition("posted", "failed"), false);
});

// ---------------------------------------------------------------------------
// 40. no network/Meta dependency
// ---------------------------------------------------------------------------

test("40. postingEvents.js contains no network calls and no Meta/Instagram/Facebook API client code", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/postingEvents.js", import.meta.url), "utf-8");
  // The doc comments legitimately reference the future media_publish call
  // this file's events will one day sit around — only actual invocation
  // patterns (a real fetch/XHR call, or a literal Graph API URL) would
  // indicate a Meta client accidentally crept into this pure state library.
  assert.ok(!/fetch\s*\(/.test(src), "no fetch() call may exist in this pure state library");
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(src));
  assert.ok(!/XMLHttpRequest/.test(src));
  assert.ok(!/from\s+["'].*(instagram|facebook|meta|graph)/i.test(src), "no import from an Instagram/Facebook/Meta/Graph client module");
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
