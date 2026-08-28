#!/usr/bin/env node
// Regression suite for the Phase 2B artwork-bridge event handlers (see
// scripts/lib/artworkEvents.js + scripts/lib/artworkValidation.js).
// Exercises the real pure functions in-memory — no file I/O, no HTTP, no
// synthetic data ever touches data/social-state.json. Covers the subset of
// the Phase 2B test list that is genuinely state-machine logic; claim
// atomicity/lease-expiry itself (a second concurrent claim being rejected,
// expired-lease recovery being allowed) is the Cloudflare Durable Object's
// job and is covered by cloudflare-worker/test/*.mjs instead — by the time
// an event reaches apply-artwork-event.js, the Worker has already decided
// it's legitimate; these handlers only need to record the outcome
// correctly and reject anything structurally invalid (wrong state, wrong
// claim_id). Run with: node scripts/tests/artwork-events-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord, syncStories, promoteEligible, buildQueueEntries, transition } from "../lib/socialState.js";
import { applyClaimEvent, applyCompleteEvent, applyFailEvent } from "../lib/artworkEvents.js";
import { validateArtwork } from "../lib/artworkValidation.js";

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
      post_headline: `POST HEADLINE FOR ${id}`,
      base_image_url: `https://example.test/${id}.jpg`,
      source_name: "ESPN",
      source_url: `https://example.test/${id}`,
    },
  };
}

function queuedState(id) {
  let state = emptyState();
  state = syncStories(state, [eligibleStory(id)]).state;
  state = promoteEligible(state, [eligibleStory(id)]).state;
  return state;
}

function goodCompletePayload(storyId, claimId, overrides = {}) {
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

// ---------------------------------------------------------------------------
// A: a queued story can be claimed (queued -> artwork_requested + lease).
// ---------------------------------------------------------------------------
test("A: a queued story can be claimed, recording claim/lease metadata", () => {
  let state = queuedState("TEST-A");
  const result = applyClaimEvent(state, {
    story_id: "TEST-A",
    claim_id: "claim-1",
    processor_id: "local-codex-jacks",
    claimed_at: "2026-08-28T00:00:00.000Z",
    claim_expires_at: "2026-08-28T00:50:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_requested");
  assert.deepEqual(result.record.claim, {
    claim_id: "claim-1",
    processor_id: "local-codex-jacks",
    claimed_at: "2026-08-28T00:00:00.000Z",
    claim_expires_at: "2026-08-28T00:50:00.000Z",
    retry_count: 0,
  });
  assert.equal(result.recovered, false);
});

// ---------------------------------------------------------------------------
// C: an invalid/unknown story_id is rejected.
// ---------------------------------------------------------------------------
test("C: claiming an unknown story_id is rejected as not_found", () => {
  const result = applyClaimEvent(emptyState(), {
    story_id: "NOPE",
    claim_id: "claim-1",
    processor_id: "p",
    claimed_at: "now",
    claim_expires_at: "later",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_found");
});

// ---------------------------------------------------------------------------
// H: lease recovery — claiming a still-artwork_requested story updates the
// lease/claim ownership without touching status (the Worker/DO is the one
// that decided this claim is legitimate, i.e. the previous lease expired).
// ---------------------------------------------------------------------------
test("H: recovering an abandoned claim updates lease ownership, not status", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, {
    story_id: "TEST-A",
    claim_id: "claim-1",
    processor_id: "worker-1",
    claimed_at: "t0",
    claim_expires_at: "t0+50m",
  }).state;

  const result = applyClaimEvent(state, {
    story_id: "TEST-A",
    claim_id: "claim-2",
    processor_id: "worker-2",
    claimed_at: "t1",
    claim_expires_at: "t1+50m",
    retry_count: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.record.status, "artwork_requested", "status stays artwork_requested — no back-to-queued edge exists");
  assert.equal(result.record.claim.claim_id, "claim-2");
  assert.equal(result.record.claim.retry_count, 1);
});

// ---------------------------------------------------------------------------
// I: completing with the wrong claim_id is rejected.
// ---------------------------------------------------------------------------
test("I: completing with a claim_id that doesn't match the active claim is rejected", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyCompleteEvent(state, goodCompletePayload("TEST-A", "wrong-claim"), { reachable: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
  assert.equal(state.stories["TEST-A"].status, "artwork_requested", "rejected completion must not mutate state");
});

// ---------------------------------------------------------------------------
// Q: a fully valid artwork submission reaches awaiting_approval.
// ---------------------------------------------------------------------------
test("Q: a valid artwork submission reaches awaiting_approval with a permanent image_url recorded", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  assert.equal(buildQueueEntries(state).length, 0, "S: queue entry disappears once claimed");

  const result = applyCompleteEvent(state, goodCompletePayload("TEST-A", "claim-1"), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.validation.passed, true);
  assert.equal(result.record.status, "awaiting_approval");
  assert.equal(result.record.artwork.image_url, "https://artwork.example.test/social-artwork/TEST-A.png"); // O
  assert.equal(buildQueueEntries(result.state).length, 0, "T: never reappears in the queue after completion");
});

// ---------------------------------------------------------------------------
// R: a failing validation (bad aspect ratio) routes to "failed", not approval.
// ---------------------------------------------------------------------------
test("R: an artwork failing validation (wrong aspect ratio) transitions to failed", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyCompleteEvent(state, goodCompletePayload("TEST-A", "claim-1", { width: 1000, height: 1000 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.validation.passed, false);
  assert.ok(result.validation.issues.some((i) => i.startsWith("aspect_ratio_out_of_range")));
  assert.equal(result.record.status, "failed");
  assert.equal(result.state.stories["TEST-A"].last_error.stage, "validation");
});

// ---------------------------------------------------------------------------
// N/U: completion after completion is rejected, and a repeated (duplicate)
// completed event is a safe no-op — the caller (apply-artwork-event.js)
// treats "invalid_state:*" as skippable, exactly this shape.
// ---------------------------------------------------------------------------
test("N/U: a second completion attempt after success is rejected (idempotent no-op)", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const first = applyCompleteEvent(state, goodCompletePayload("TEST-A", "claim-1"), { reachable: true });
  assert.equal(first.ok, true);
  assert.equal(first.record.status, "awaiting_approval");

  const second = applyCompleteEvent(first.state, goodCompletePayload("TEST-A", "claim-1"), { reachable: true });
  assert.equal(second.ok, false);
  assert.equal(second.error, "invalid_state:awaiting_approval");
  assert.equal(second.state.stories["TEST-A"].status, "awaiting_approval", "must not overwrite the completed artwork — rule D");
  assert.equal(second.state.stories["TEST-A"].artwork.image_url, first.record.artwork.image_url);
});

// ---------------------------------------------------------------------------
// Fail path: artwork_requested -> failed, retry_count increments; a second
// fail call on an already-failed record updates last_error without
// attempting an illegal self-transition.
// ---------------------------------------------------------------------------
test("Fail path: a generation failure moves artwork_requested -> failed and increments retry_count", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyFailEvent(state, { story_id: "TEST-A", claim_id: "claim-1", stage: "generation", message: "codex exec failed" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "failed");
  assert.equal(result.record.last_error.stage, "generation");
  assert.equal(result.record.last_error.retry_count, 1);

  const second = applyFailEvent(result.state, { story_id: "TEST-A", stage: "generation", message: "still failing" });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyFailed, true);
  assert.equal(second.record.status, "failed");
  assert.equal(second.record.last_error.retry_count, 2);
});

test("Fail: a fail event with a mismatched claim_id is rejected", () => {
  let state = queuedState("TEST-A");
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyFailEvent(state, { story_id: "TEST-A", claim_id: "wrong", stage: "upload", message: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

// ---------------------------------------------------------------------------
// A merged story cannot be claimed under its orphan id (resolves through,
// same behavior socialState.js already guarantees — exercised here through
// the artwork event layer specifically).
// ---------------------------------------------------------------------------
test("A merged story's claim resolves to the canonical record, not a separate one", () => {
  let state = queuedState("CANONICAL");
  state = ensureRecord(state, "ORPHAN", { status: "new" }).state;
  state.stories["ORPHAN"] = { ...state.stories["ORPHAN"], merged_into: "CANONICAL" };

  const result = applyClaimEvent(state, { story_id: "ORPHAN", claim_id: "claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" });
  assert.equal(result.ok, true);
  assert.equal(result.story_id, "CANONICAL");
  assert.equal(result.state.stories["CANONICAL"].status, "artwork_requested");
  assert.equal(result.state.stories["ORPHAN"].status, "new");
});

// ---------------------------------------------------------------------------
// validateArtwork: unit-level checks independent of the transition plumbing.
// ---------------------------------------------------------------------------
test("validateArtwork: rejects an unreachable image", () => {
  const record = {
    status: "validating",
    artwork: { status: "created", image_url: "https://x.test/a.png", mime_type: "image/png", size_bytes: 100, width: 1024, height: 1280 },
    publishing: { status: "not_posted" },
    approval: { status: "pending" },
    claim: { claim_id: "claim-1" },
  };
  const { passed, issues } = validateArtwork({ record, claimId: "claim-1", reachable: false });
  assert.equal(passed, false);
  assert.ok(issues.includes("image_unreachable"));
});

test("validateArtwork: rejects a story that's already posted or already approved/rejected", () => {
  const base = {
    status: "validating",
    artwork: { status: "created", image_url: "https://x.test/a.png", mime_type: "image/png", size_bytes: 100, width: 1024, height: 1280 },
    claim: { claim_id: "claim-1" },
  };
  const posted = validateArtwork({ record: { ...base, publishing: { status: "posted" }, approval: { status: "pending" } }, claimId: "claim-1", reachable: true });
  assert.equal(posted.passed, false);
  assert.ok(posted.issues.includes("already_posted"));

  const approved = validateArtwork({ record: { ...base, publishing: { status: "not_posted" }, approval: { status: "approved" } }, claimId: "claim-1", reachable: true });
  assert.equal(approved.passed, false);
  assert.ok(approved.issues.some((i) => i.startsWith("approval_already_resolved")));
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
