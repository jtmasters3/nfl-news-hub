#!/usr/bin/env node
// The Aggregate — Live Automation Acceleration, Stage 3B regression suite:
// Destination-Aware Artwork Pipeline. Fully offline and deterministic.
// Run with: node scripts/tests/artwork-destination-routing-regression.mjs
import assert from "node:assert/strict";
import { emptyState, ensureRecord, transition, buildQueueEntries, isArtworkQueueEligible } from "../lib/socialState.js";
import { applyClaimEvent, applyCompleteEvent } from "../lib/artworkEvents.js";
import { applyStoryArtworkClaimEvent, applyStoryArtworkCompleteEvent } from "../lib/storyArtworkEvents.js";
import { validateArtwork, validateArtworkForDestination } from "../lib/artworkValidation.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function stateWithStory(id, { createdAt = "2026-01-01T00:00:00.000Z", selectionActivatedAt = null } = {}) {
  let state = emptyState();
  state = { ...state, selection_activated_at: selectionActivatedAt };
  const result = ensureRecord(state, id, { status: "new" });
  state = result.state;
  state = {
    ...state,
    stories: { ...state.stories, [id]: { ...state.stories[id], created_at: createdAt, updated_at: createdAt } },
  };
  return state;
}

function withSelection(state, id, destination, extra = {}) {
  return {
    ...state,
    stories: {
      ...state.stories,
      [id]: { ...state.stories[id], selection: { destination, slot_id: `${destination}:test`, selected_at: "2026-01-02T00:00:00Z", ...extra } },
    },
  };
}

function queuedState(state, id) {
  return transition(state, id, "queued", {
    source_story: { post_headline: "Test headline", base_image_url: "https://example.test/img.jpg", source_name: "Test", source_url: "https://example.test/story", category: "league_news" },
  }).state;
}

function validPayload(overrides = {}) {
  return { story_id: null, claim_id: "claim-1", image_url: "https://example.test/out.png", storage_key: "social-artwork/x.png", width: 1080, height: 1350, mime_type: "image/png", size_bytes: 500000, provider: "test", ...overrides };
}

// ---------------------------------------------------------------------------
// QUEUE ELIGIBILITY GATE (Important Selection Gate)
// ---------------------------------------------------------------------------

test("1. no Stage 3A activation at all: a queued record with no selection is queue-eligible (pre-Stage-3A behavior unchanged)", () => {
  let state = stateWithStory("s1", { createdAt: "2026-01-01T00:00:00Z", selectionActivatedAt: null });
  state = queuedState(state, "s1");
  assert.equal(isArtworkQueueEligible(state.stories.s1, state.selection_activated_at), true);
  assert.equal(buildQueueEntries(state).length, 1);
});

test("2. record created BEFORE activation (legacy): queue-eligible with no selection", () => {
  let state = stateWithStory("s1", { createdAt: "2026-01-01T00:00:00Z", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  assert.equal(isArtworkQueueEligible(state.stories.s1, state.selection_activated_at), true);
  assert.equal(buildQueueEntries(state).length, 1);
});

test("3. record created AT/AFTER activation with NO selection: NOT queue-eligible (must wait for Stage 3A)", () => {
  let state = stateWithStory("s1", { createdAt: "2026-06-01T00:00:00Z", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  assert.equal(isArtworkQueueEligible(state.stories.s1, state.selection_activated_at), false);
  assert.equal(buildQueueEntries(state).length, 0, "an unselected post-activation record must never enter the artwork queue");
});

test("4. record created AFTER activation WITH a Feed selection: queue-eligible", () => {
  let state = stateWithStory("s1", { createdAt: "2026-06-02T00:00:00Z", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "feed");
  assert.equal(isArtworkQueueEligible(state.stories.s1, state.selection_activated_at), true);
  const entries = buildQueueEntries(state);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].destination, "feed");
});

test("5. record created AFTER activation WITH a Story selection: queue-eligible, tagged destination=story", () => {
  let state = stateWithStory("s1", { createdAt: "2026-06-02T00:00:00Z", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "story");
  const entries = buildQueueEntries(state);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].destination, "story");
});

test("6. legacy record (no destination) is tagged destination='feed' in the queue payload (backward-compatible default)", () => {
  let state = stateWithStory("s1", { createdAt: "2026-01-01T00:00:00Z", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  const entries = buildQueueEntries(state);
  assert.equal(entries[0].destination, "feed");
});

test("7. a malformed created_at never crashes the gate (fails open to queue-eligible rather than throwing)", () => {
  let state = stateWithStory("s1", { createdAt: "not-a-date", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  assert.doesNotThrow(() => isArtworkQueueEligible(state.stories.s1, state.selection_activated_at));
});

// ---------------------------------------------------------------------------
// applyCompleteEvent DESTINATION ROUTING
// ---------------------------------------------------------------------------

test("8. Feed-selected (or no selection) record: applyCompleteEvent patches record.artwork, uses validateArtwork's 4:5 rules, never touches story_artwork", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;

  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1350 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready");
  assert.equal(result.record.artwork.status, "created");
  assert.equal(result.record.story_artwork.status, "not_created", "Feed-selected completion must never touch story_artwork");
});

test("9. Story-selected record: applyCompleteEvent patches record.story_artwork (9:16), uses Story's own ratio rules, never touches record.artwork", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "story");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;

  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1920 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready");
  assert.equal(result.record.story_artwork.status, "created");
  assert.equal(result.record.story_artwork.width, 1080);
  assert.equal(result.record.story_artwork.height, 1920);
  assert.equal(result.record.artwork.status, "not_created", "Story-selected completion must never touch record.artwork (no Feed request/generation)");
});

test("10. Feed 4:5 enforcement: a Story-shaped (9:16) upload FAILS Feed validation when destination is feed/legacy", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1920 }), { reachable: true });
  assert.equal(result.record.status, "failed", "a 9:16 image must fail 4:5 Feed validation");
  assert.ok(result.validation.issues.some((i) => i.startsWith("aspect_ratio_out_of_range")));
});

test("11. Story 9:16 enforcement: a Feed-shaped (4:5) upload FAILS Story validation when destination is story", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "story");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1350 }), { reachable: true });
  assert.equal(result.record.status, "failed", "a 4:5 image must fail 9:16 Story validation");
  assert.ok(result.validation.issues.some((i) => i.startsWith("aspect_ratio_out_of_range")));
});

test("12. absent unselected asset is NOT treated as a failure — a Feed-selected record reaching artwork_ready has story_artwork still 'not_created', and that alone causes no error", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "feed");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1350 }), { reachable: true });
  assert.equal(result.record.status, "artwork_ready");
  assert.equal(result.record.story_artwork.status, "not_created");
});

test("13. Feed-only record CAN reach artwork_ready with only Feed valid", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "feed");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1350 }), { reachable: true });
  assert.equal(result.record.status, "artwork_ready");
});

test("14. Story-only record CAN reach artwork_ready with only Story valid", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "story");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1920 }), { reachable: true });
  assert.equal(result.record.status, "artwork_ready");
});

// ---------------------------------------------------------------------------
// LEGACY COMPATIBILITY — validateArtwork() and the paired pathway are
// completely untouched.
// ---------------------------------------------------------------------------

test("15. validateArtwork() (legacy Feed validator) is untouched — identical behavior to before Stage 3B", () => {
  const record = { status: "validating", artwork: { status: "created", image_url: "https://x.test/a.png", mime_type: "image/png", size_bytes: 1000, width: 1080, height: 1350 }, claim: { claim_id: "c1" }, publishing: { status: "not_posted" }, approval: { status: "pending" } };
  const result = validateArtwork({ record, claimId: "c1", reachable: true });
  assert.equal(result.passed, true);
});

test("16. legacy paired record (no selection): applyStoryArtworkClaimEvent/CompleteEvent (the OLD sibling pathway) still works exactly as before, from artwork_ready", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  state = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1350 }), { reachable: true }).state;
  assert.equal(state.stories.s1.status, "artwork_ready");

  const claimResult = applyStoryArtworkClaimEvent(state, { story_id: "s1", claim_id: "sc1", processor_id: "p1", claimed_at: "2026-01-01T02:00:00Z", claim_expires_at: "2026-01-01T03:00:00Z" });
  assert.equal(claimResult.ok, true);
  assert.equal(claimResult.record.story_artwork.status, "generating");

  const completeResult = applyStoryArtworkCompleteEvent(claimResult.state, { story_id: "s1", claim_id: "sc1", image_url: "https://x.test/s.png", storage_key: "social-story/s1.png", width: 1080, height: 1920, mime_type: "image/png", size_bytes: 900000, provider: "test" }, { reachable: true });
  assert.equal(completeResult.ok, true);
  assert.equal(completeResult.record.story_artwork.status, "created");
  assert.equal(completeResult.record.story_artwork.validation.passed, true);
  assert.equal(completeResult.record.status, "artwork_ready", "the legacy sibling pathway must never change top-level status");
});

test("17. legacy Story-as-sibling claim is still rejected before artwork_ready (unchanged precondition)", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  const result = applyStoryArtworkClaimEvent(state, { story_id: "s1", claim_id: "sc1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:queued");
});

// ---------------------------------------------------------------------------
// validateArtworkForDestination — direct unit tests
// ---------------------------------------------------------------------------

test("18. validateArtworkForDestination('feed') matches validateArtwork()'s pass/fail for the same record", () => {
  const record = { status: "validating", artwork: { status: "created", image_url: "https://x.test/a.png", mime_type: "image/png", size_bytes: 1000, width: 1080, height: 1350 }, claim: { claim_id: "c1" }, publishing: { status: "not_posted" }, approval: { status: "pending" } };
  const legacy = validateArtwork({ record, claimId: "c1", reachable: true });
  const routed = validateArtworkForDestination({ record, claimId: "c1", reachable: true, destination: "feed" });
  assert.deepEqual(routed, legacy);
});

test("19. validateArtworkForDestination('story') validates record.story_artwork with 9:16 rules", () => {
  const record = { status: "validating", story_artwork: { status: "created", image_url: "https://x.test/s.png", mime_type: "image/png", size_bytes: 1000, width: 1080, height: 1920 }, claim: { claim_id: "c1" }, publishing: { status: "not_posted" }, approval: { status: "pending" } };
  const result = validateArtworkForDestination({ record, claimId: "c1", reachable: true, destination: "story" });
  assert.equal(result.passed, true);
});

test("20. validateArtworkForDestination rejects already_posted / approval_already_resolved exactly like validateArtwork does", () => {
  const base = { status: "validating", story_artwork: { status: "created", image_url: "https://x.test/s.png", mime_type: "image/png", size_bytes: 1000, width: 1080, height: 1920 }, claim: { claim_id: "c1" } };
  const posted = { ...base, publishing: { status: "posted" }, approval: { status: "pending" } };
  const decided = { ...base, publishing: { status: "not_posted" }, approval: { status: "approved" } };
  assert.ok(validateArtworkForDestination({ record: posted, claimId: "c1", reachable: true, destination: "story" }).issues.includes("already_posted"));
  assert.ok(validateArtworkForDestination({ record: decided, claimId: "c1", reachable: true, destination: "story" }).issues.some((i) => i.startsWith("approval_already_resolved")));
});

test("21. an unknown/malformed destination fails safely with a clear reason code, never throws", () => {
  const record = { status: "validating" };
  assert.doesNotThrow(() => validateArtworkForDestination({ record, claimId: "c1", reachable: true, destination: "bogus" }));
  const result = validateArtworkForDestination({ record, claimId: "c1", reachable: true, destination: "bogus" });
  assert.equal(result.passed, false);
  assert.ok(result.issues[0].startsWith("unknown_destination"));
});

test("22. a null record is handled safely by validateArtworkForDestination", () => {
  const result = validateArtworkForDestination({ record: null, claimId: "c1", reachable: true, destination: "feed" });
  assert.deepEqual(result, { passed: false, issues: ["record_not_found"] });
});

// ---------------------------------------------------------------------------
// No duplicate claims / idempotency
// ---------------------------------------------------------------------------

test("23. a story with a Feed selection cannot also be claimed via the legacy Story-sibling path while still artwork_requested (duplicate-claim safety)", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "feed");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  // Still "artwork_requested" (not yet artwork_ready) — a story-artwork claim attempt must be rejected.
  const result = applyStoryArtworkClaimEvent(state, { story_id: "s1", claim_id: "sc1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" });
  assert.equal(result.ok, false);
});

test("24. a repeated applyClaimEvent for an already-artwork_requested record is a lease recovery, not a duplicate transition (existing behavior preserved)", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  const first = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" });
  const second = applyClaimEvent(first.state, { story_id: "s1", claim_id: "c2", processor_id: "p2", claimed_at: "2026-01-01T02:00:00Z", claim_expires_at: "2026-01-01T03:00:00Z" });
  assert.equal(second.recovered, true);
  assert.equal(second.record.status, "artwork_requested", "a recovered claim never re-enters 'queued'");
});

test("25. completing with a mismatched claim_id is rejected regardless of destination (duplicate/stale completion safety)", () => {
  let state = stateWithStory("s1");
  state = queuedState(state, "s1");
  state = withSelection(state, "s1", "story");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "real-claim", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "wrong-claim", width: 1080, height: 1920 }), { reachable: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

// ---------------------------------------------------------------------------
// no-selection compatibility rule with materially-engaged legacy records
// ---------------------------------------------------------------------------

test("26. a legacy record already materially engaged (e.g. artwork_requested) BEFORE Stage 3A activation remains fully compatible — no gate re-applied retroactively", () => {
  let state = stateWithStory("s1", { createdAt: "2026-01-01T00:00:00Z", selectionActivatedAt: "2026-06-01T00:00:00Z" });
  state = queuedState(state, "s1");
  state = applyClaimEvent(state, { story_id: "s1", claim_id: "c1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T01:00:00Z" }).state;
  assert.equal(state.stories.s1.status, "artwork_requested");
  // The queue-eligibility gate only ever governs entry INTO "queued" candidacy — a record already past "queued" is unaffected by it entirely.
  const result = applyCompleteEvent(state, validPayload({ story_id: "s1", claim_id: "c1", width: 1080, height: 1350 }), { reachable: true });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready");
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
