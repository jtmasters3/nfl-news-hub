#!/usr/bin/env node
// Regression suite for the Feed+Story phase's Story-artwork event handlers
// (see scripts/lib/storyArtworkEvents.js + storyArtworkValidation.js).
// Exercises the real pure functions in-memory — no file I/O, no HTTP.
// Run with: node scripts/tests/story-artwork-events-regression.mjs
import assert from "node:assert/strict";
import { emptyState, syncStories, promoteEligible, transition } from "../lib/socialState.js";
import { applyClaimEvent, applyCompleteEvent } from "../lib/artworkEvents.js";
import { applyStoryArtworkClaimEvent, applyStoryArtworkCompleteEvent, applyStoryArtworkFailEvent } from "../lib/storyArtworkEvents.js";
import { validateStoryArtwork } from "../lib/storyArtworkValidation.js";

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
  return {
    story_id: storyId,
    claim_id: claimId,
    image_url: `https://artwork.example.test/social-artwork/${storyId}.png`,
    storage_key: `social-artwork/${storyId}.png`,
    width: 1024,
    height: 1280,
    mime_type: "image/png",
    size_bytes: 500_000,
    provider: "chatgpt-codex-local",
    ...overrides,
  };
}

function goodStoryPayload(storyId, claimId, overrides = {}) {
  return {
    story_id: storyId,
    claim_id: claimId,
    image_url: `https://artwork.example.test/social-story/${storyId}.png`,
    storage_key: `social-story/${storyId}.png`,
    width: 1080,
    height: 1920,
    mime_type: "image/png",
    size_bytes: 700_000,
    provider: "chatgpt-codex-local",
    ...overrides,
  };
}

/** Builds a real artwork_ready record via the actual production Feed functions. */
function artworkReadyState(id) {
  let state = emptyState();
  state = syncStories(state, [eligibleStory(id)]).state;
  state = promoteEligible(state, [eligibleStory(id)]).state;
  state = applyClaimEvent(state, { story_id: id, claim_id: "artwork-claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const result = applyCompleteEvent(state, goodArtworkPayload(id, "artwork-claim-1"), { reachable: true });
  assert.equal(result.record.status, "artwork_ready", "test fixture setup must actually reach artwork_ready");
  return result.state;
}

// ---------------------------------------------------------------------------
test("Story-artwork cannot claim before artwork_ready (still artwork_requested)", () => {
  let state = emptyState();
  state = syncStories(state, [eligibleStory("TEST-A")]).state;
  state = promoteEligible(state, [eligibleStory("TEST-A")]).state;
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "c1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:artwork_requested");
});

test("Story-artwork claim is independent of Feed's own claim — claiming Story never changes top-level status and never touches Feed's claim record", () => {
  let state = artworkReadyState("TEST-A");
  const feedClaimBefore = state.stories["TEST-A"].claim;
  const feedArtworkBefore = state.stories["TEST-A"].artwork;

  const result = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p2", claimed_at: "t2", claim_expires_at: "t3" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready", "claiming Story artwork must never change top-level status");
  assert.deepEqual(result.record.claim, feedClaimBefore, "Feed's own claim must be completely untouched");
  assert.deepEqual(result.record.artwork, feedArtworkBefore, "Feed's own artwork must be completely untouched");
  assert.equal(result.record.story_artwork.claim.claim_id, "story-1");
  assert.equal(result.record.story_artwork.status, "generating");
});

test("A valid 9:16 Story submission reaches story_artwork.status 'created' with validation passed, top-level status still artwork_ready", () => {
  let state = artworkReadyState("TEST-A");
  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyStoryArtworkCompleteEvent(state, goodStoryPayload("TEST-A", "story-1"), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready");
  assert.equal(result.record.story_artwork.status, "created");
  assert.equal(result.record.story_artwork.validation.passed, true);
  assert.equal(result.record.story_artwork.image_url, `https://artwork.example.test/social-story/TEST-A.png`);
});

test("A nearby-but-not-exact 9:16 resolution (e.g. 1080x1908) still passes — ratio-based, not exact-dimension", () => {
  let state = artworkReadyState("TEST-A");
  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyStoryArtworkCompleteEvent(state, goodStoryPayload("TEST-A", "story-1", { width: 1080, height: 1908 }), { reachable: true });
  assert.equal(result.record.story_artwork.validation.passed, true);
});

test("A wrong-ratio Story submission (e.g. accidentally 4:5) fails validation, story_artwork.status becomes 'failed', top-level status untouched", () => {
  let state = artworkReadyState("TEST-A");
  const feedArtworkBefore = state.stories["TEST-A"].artwork;
  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyStoryArtworkCompleteEvent(state, goodStoryPayload("TEST-A", "story-1", { width: 1024, height: 1280 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready", "a failed Story submission must never move top-level status to failed");
  assert.equal(result.record.story_artwork.status, "failed");
  assert.equal(result.record.story_artwork.validation.passed, false);
  assert.ok(result.record.story_artwork.validation.issues.some((i) => i.startsWith("aspect_ratio_out_of_range")));
  assert.deepEqual(result.record.artwork, feedArtworkBefore, "Feed's own artwork must be completely untouched by a Story failure");
});

test("Story failure preserves Feed's R2 metadata exactly (image_url, storage_key, dimensions)", () => {
  let state = artworkReadyState("TEST-A");
  const feedBefore = state.stories["TEST-A"].artwork;
  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyStoryArtworkFailEvent(state, { story_id: "TEST-A", claim_id: "story-1", stage: "generation", message: "wrong player" }).state;

  assert.deepEqual(state.stories["TEST-A"].artwork, feedBefore);
  assert.equal(state.stories["TEST-A"].story_artwork.status, "failed");
});

test("A Story retry (new claim after a failure) does not regenerate or re-upload Feed — Feed's claim/artwork stay byte-identical", () => {
  let state = artworkReadyState("TEST-A");
  const feedClaimBefore = state.stories["TEST-A"].claim;
  const feedArtworkBefore = state.stories["TEST-A"].artwork;

  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyStoryArtworkFailEvent(state, { story_id: "TEST-A", claim_id: "story-1", stage: "generation", message: "bad output" }).state;
  // Retry: a fresh Story-only claim + successful completion.
  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-2", processor_id: "p", claimed_at: "t2", claim_expires_at: "t3" }).state;
  const result = applyStoryArtworkCompleteEvent(state, goodStoryPayload("TEST-A", "story-2"), { reachable: true });

  assert.equal(result.record.story_artwork.status, "created");
  assert.deepEqual(result.record.claim, feedClaimBefore, "Feed's claim must never change across a Story retry");
  assert.deepEqual(result.record.artwork, feedArtworkBefore, "Feed's artwork must never change across a Story retry — no second Feed upload");
});

test("Completing with a claim_id that doesn't match the active Story claim is rejected", () => {
  let state = artworkReadyState("TEST-A");
  state = applyStoryArtworkClaimEvent(state, { story_id: "TEST-A", claim_id: "story-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyStoryArtworkCompleteEvent(state, goodStoryPayload("TEST-A", "wrong-claim"), { reachable: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

test("validateStoryArtwork: rejects an unreachable image", () => {
  const record = { status: "artwork_ready", story_artwork: { status: "created", image_url: "https://x.test/a.png", mime_type: "image/png", size_bytes: 100, width: 1080, height: 1920, claim: { claim_id: "c1" } } };
  const { passed, issues } = validateStoryArtwork({ record, claimId: "c1", reachable: false });
  assert.equal(passed, false);
  assert.ok(issues.includes("image_unreachable"));
});

test("validateStoryArtwork: rejects dimensions below the minimum floor", () => {
  const record = { status: "artwork_ready", story_artwork: { status: "created", image_url: "https://x.test/a.png", mime_type: "image/png", size_bytes: 100, width: 100, height: 178, claim: { claim_id: "c1" } } };
  const { passed, issues } = validateStoryArtwork({ record, claimId: "c1", reachable: true });
  assert.equal(passed, false);
  assert.ok(issues.some((i) => i.startsWith("insane_dimensions")));
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
