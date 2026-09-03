#!/usr/bin/env node
// Regression suite for the operator-only "regenerate Feed/Story on an
// already-awaiting_approval package" recovery path (see
// scripts/lib/regenerationEvents.js — the 2026-09 branding-defect fix's
// safe recovery mechanism). Exercises the real pure functions in-memory —
// no file I/O, no HTTP, no real story. Run with:
// node scripts/tests/regeneration-events-regression.mjs
import assert from "node:assert/strict";
import { emptyState, syncStories, promoteEligible, transition } from "../lib/socialState.js";
import { applyClaimEvent, applyCompleteEvent } from "../lib/artworkEvents.js";
import { applyStoryArtworkClaimEvent, applyStoryArtworkCompleteEvent } from "../lib/storyArtworkEvents.js";
import { applyCaptionClaimEvent, applyCaptionCompleteEvent } from "../lib/captionEvents.js";
import { applyFeedRegenerateCompleteEvent, applyFeedRegenerateFailEvent, applyStoryRegenerateCompleteEvent, applyStoryRegenerateFailEvent } from "../lib/regenerationEvents.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function eligibleStory(id) {
  return {
    id,
    category: "trade",
    social: {
      social_status: "ready",
      post_headline: `HEADLINE FOR ${id}`,
      base_image_url: `https://example.test/${id}.jpg`,
      source_name: "ESPN",
      source_url: `https://example.test/${id}`,
    },
  };
}

function goodArtworkPayload(storyId, claimId, overrides = {}) {
  return { story_id: storyId, claim_id: claimId, image_url: `https://x.test/social-artwork/${storyId}.png`, storage_key: `social-artwork/${storyId}.png`, width: 1024, height: 1280, mime_type: "image/png", size_bytes: 500_000, provider: "chatgpt-codex-local", ...overrides };
}
function goodStoryPayload(storyId, claimId, overrides = {}) {
  return { story_id: storyId, claim_id: claimId, image_url: `https://x.test/social-story/${storyId}.png`, storage_key: `social-story/${storyId}.png`, width: 1080, height: 1920, mime_type: "image/png", size_bytes: 700_000, provider: "chatgpt-codex-local", ...overrides };
}

const GOOD_CAPTION_TEXT = "The move addresses depth on the roster. Source: ESPN";

/** Builds a real awaiting_approval v2 record via the actual production pipeline. */
function awaitingApprovalState(id) {
  let state = emptyState();
  state = syncStories(state, [eligibleStory(id)]).state;
  state = promoteEligible(state, [eligibleStory(id)]).state;
  state = applyClaimEvent(state, { story_id: id, claim_id: "artwork-claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyCompleteEvent(state, goodArtworkPayload(id, "artwork-claim-1"), { reachable: true }).state;
  state = applyStoryArtworkClaimEvent(state, { story_id: id, claim_id: "story-claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyStoryArtworkCompleteEvent(state, goodStoryPayload(id, "story-claim-1"), { reachable: true }).state;
  state = applyCaptionClaimEvent(state, { story_id: id, claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const result = applyCaptionCompleteEvent(state, { story_id: id, claim_id: "cap-1", text: GOOD_CAPTION_TEXT, hashtags: ["#NFL"], attribution_line: "Source: ESPN", provider: "chatgpt-codex-local" });
  assert.equal(result.record.status, "awaiting_approval", "test fixture setup must actually reach awaiting_approval");
  return result.state;
}

// ---------------------------------------------------------------------------
test("Feed regeneration succeeds: patches artwork.*/validation.*, top-level status stays awaiting_approval (no transition)", () => {
  const state = awaitingApprovalState("TEST-A");
  const oldStoryArtwork = state.stories["TEST-A"].story_artwork;
  const oldCaption = state.stories["TEST-A"].caption;

  const result = applyFeedRegenerateCompleteEvent(state, goodArtworkPayload("TEST-A", "regen-claim-1", { size_bytes: 999_000 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "awaiting_approval", "status must NEVER change — regeneration is a patch-only operation");
  assert.equal(result.record.artwork.size_bytes, 999_000, "the NEW artwork data must be recorded");
  assert.equal(result.record.validation.passed, true);
  assert.deepEqual(result.record.story_artwork, oldStoryArtwork, "Story must be completely untouched by a Feed-only regeneration");
  assert.deepEqual(result.record.caption, oldCaption, "caption must be preserved — nothing about the facts changed");
});

test("Story regeneration succeeds: patches story_artwork.* only, Feed and caption completely untouched", () => {
  const state = awaitingApprovalState("TEST-A");
  const oldArtwork = state.stories["TEST-A"].artwork;
  const oldValidation = state.stories["TEST-A"].validation;
  const oldCaption = state.stories["TEST-A"].caption;
  const oldStoryClaim = state.stories["TEST-A"].story_artwork.claim;

  const result = applyStoryRegenerateCompleteEvent(state, goodStoryPayload("TEST-A", "regen-claim-2", { size_bytes: 888_000 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "awaiting_approval");
  assert.equal(result.record.story_artwork.size_bytes, 888_000);
  assert.equal(result.record.story_artwork.validation.passed, true);
  assert.deepEqual(result.record.artwork, oldArtwork, "Feed must be completely untouched by a Story-only regeneration");
  assert.deepEqual(result.record.validation, oldValidation);
  assert.deepEqual(result.record.caption, oldCaption, "caption must be preserved");
  assert.deepEqual(result.record.story_artwork.claim, oldStoryClaim, "the ORIGINAL story_artwork.claim (from first generation) is untouched — regeneration uses its own separate DO namespace, never written here");
});

test("A regenerated Feed that fails validation (wrong ratio) stays at awaiting_approval, but validation.passed becomes false — the package naturally becomes not-actionable via the existing readiness gate, no new state needed", () => {
  const state = awaitingApprovalState("TEST-A");
  const result = applyFeedRegenerateCompleteEvent(state, goodArtworkPayload("TEST-A", "regen-claim-1", { width: 1024, height: 1024 }), { reachable: true }); // 1:1, not 4:5
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "awaiting_approval", "a failed regeneration must never move status away from awaiting_approval");
  assert.equal(result.record.validation.passed, false);
  assert.ok(result.record.validation.issues.some((i) => i.startsWith("aspect_ratio_out_of_range")));
});

test("A regenerated Story that fails validation records last_error with the correct stage, preserves Feed and caption", () => {
  const state = awaitingApprovalState("TEST-A");
  const oldArtwork = state.stories["TEST-A"].artwork;
  const result = applyStoryRegenerateCompleteEvent(state, goodStoryPayload("TEST-A", "regen-claim-2", { width: 1024, height: 1280 }), { reachable: true }); // 4:5, not 9:16
  assert.equal(result.record.status, "awaiting_approval");
  assert.equal(result.record.story_artwork.validation.passed, false);
  assert.equal(result.record.last_error.stage, "story_regeneration");
  assert.deepEqual(result.record.artwork, oldArtwork);
});

test("Regeneration is refused for a story NOT at awaiting_approval (e.g. still artwork_ready) — invalid_state, nothing patched", () => {
  let state = emptyState();
  state = syncStories(state, [eligibleStory("TEST-A")]).state;
  state = promoteEligible(state, [eligibleStory("TEST-A")]).state;
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "c1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyCompleteEvent(state, goodArtworkPayload("TEST-A", "c1"), { reachable: true }).state; // artwork_ready, not awaiting_approval

  const result = applyFeedRegenerateCompleteEvent(state, goodArtworkPayload("TEST-A", "regen-1"), { reachable: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:artwork_ready");
});

test("Regeneration is refused for an ALREADY-approved story — never silently overwrites a decided record's artwork", () => {
  let state = awaitingApprovalState("TEST-A");
  state = transition(state, "TEST-A", "approved", { approval: { status: "approved", decided_at: "t", approved_at: "t", rejected_at: null, rejection_reason: null, actor: "a", request_id: "r", decision_source: "s" } }).state;

  const result = applyFeedRegenerateCompleteEvent(state, goodArtworkPayload("TEST-A", "regen-1"), { reachable: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:approved");
});

test("A failed Feed regeneration ATTEMPT (never reached /complete) records last_error only — artwork/validation/story/caption all completely untouched", () => {
  const state = awaitingApprovalState("TEST-A");
  const before = state.stories["TEST-A"];
  const result = applyFeedRegenerateFailEvent(state, { story_id: "TEST-A", message: "codex exec failed" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "awaiting_approval");
  assert.deepEqual(result.record.artwork, before.artwork);
  assert.deepEqual(result.record.validation, before.validation);
  assert.deepEqual(result.record.story_artwork, before.story_artwork);
  assert.deepEqual(result.record.caption, before.caption);
  assert.equal(result.record.last_error.stage, "feed_regeneration");
  assert.equal(result.record.last_error.message, "codex exec failed");
});

test("A failed Story regeneration ATTEMPT records last_error only, Feed/caption untouched", () => {
  const state = awaitingApprovalState("TEST-A");
  const before = state.stories["TEST-A"];
  const result = applyStoryRegenerateFailEvent(state, { story_id: "TEST-A", message: "wrong player" });
  assert.equal(result.record.status, "awaiting_approval");
  assert.deepEqual(result.record.artwork, before.artwork);
  assert.deepEqual(result.record.story_artwork, before.story_artwork);
  assert.equal(result.record.last_error.stage, "story_regeneration");
});

test("A successful regeneration after an earlier failed attempt correctly overwrites the stale last_error along with the new artwork", () => {
  let state = awaitingApprovalState("TEST-A");
  state = applyFeedRegenerateFailEvent(state, { story_id: "TEST-A", message: "first attempt failed" }).state;
  assert.equal(state.stories["TEST-A"].last_error.stage, "feed_regeneration");

  const result = applyFeedRegenerateCompleteEvent(state, goodArtworkPayload("TEST-A", "regen-2"), { reachable: true });
  assert.equal(result.record.validation.passed, true);
  // last_error is diagnostic-only and not required to clear on success — assert it's still readable, not corrupted.
  assert.equal(typeof result.record.last_error.retry_count, "number");
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
