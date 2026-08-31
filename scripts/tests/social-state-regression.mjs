#!/usr/bin/env node
// Permanent regression suite for the social workflow state machine (see
// scripts/lib/socialState.js). Exercises the REAL pure functions in-memory
// — no file I/O, no parallel/reimplemented state machine, and no synthetic
// TEST-A/ORPHAN data ever touches the actual data/social-state.json. Run
// with: node scripts/tests/social-state-regression.mjs
import assert from "node:assert/strict";
import {
  emptyState,
  ensureRecord,
  syncStories,
  promoteEligible,
  buildQueueEntries,
  transition,
  canTransition,
  resolveCanonicalId,
  isEligible,
} from "../lib/socialState.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function eligibleStory(id, overrides = {}) {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B. New story: new -> queued, exactly one record, exactly one queue entry.
// ---------------------------------------------------------------------------
test("B: a genuinely new eligible story becomes queued with exactly one record and one queue entry", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];

  const sync = syncStories(state, stories);
  state = sync.state;
  assert.equal(sync.created, 1);

  const promote = promoteEligible(state, stories);
  state = promote.state;
  assert.equal(promote.promoted, 1);

  assert.equal(Object.keys(state.stories).length, 1);
  assert.equal(state.stories["TEST-A"].status, "queued");

  const queue = buildQueueEntries(state);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].story_id, "TEST-A");
  assert.equal(queue[0].post_headline, "POST HEADLINE FOR TEST-A");

  return state; // handed to the next test
});

// ---------------------------------------------------------------------------
// C. Repeated refresh: re-running sync+promote must not duplicate or reset.
// ---------------------------------------------------------------------------
test("C: repeated refresh does not duplicate the state record or reset its status", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;

  for (let i = 0; i < 5; i++) {
    const sync = syncStories(state, stories);
    state = sync.state;
    assert.equal(sync.created, 0, `run ${i}: sync should create 0 new records once TEST-A already exists`);
    const promote = promoteEligible(state, stories);
    state = promote.state;
    assert.equal(promote.promoted, 0, `run ${i}: promote should promote 0 records once TEST-A is already queued`);
  }

  assert.equal(Object.keys(state.stories).length, 1);
  assert.equal(state.stories["TEST-A"].status, "queued");
  assert.equal(buildQueueEntries(state).length, 1);
});

// ---------------------------------------------------------------------------
// D. Second outlet merges into the SAME story_id: zero additional workflow.
// ---------------------------------------------------------------------------
test("D: a second outlet's source merging into the same story_id creates no additional workflow", () => {
  let state = emptyState();
  const originalStory = eligibleStory("TEST-A");
  state = syncStories(state, [originalStory]).state;
  state = promoteEligible(state, [originalStory]).state;
  const beforeUpdatedAt = state.stories["TEST-A"].updated_at;
  const beforeSnapshot = state.stories["TEST-A"].source_story;

  // Same story_id, but the underlying story object has changed (as it
  // would after clustering merges a second outlet's source into it) —
  // different source_name/base_image_url, same story.id.
  const updatedStory = eligibleStory("TEST-A", {
    social: {
      social_status: "ready",
      post_headline: "A DIFFERENT HEADLINE NOW",
      base_image_url: "https://example.test/TEST-A-updated.jpg",
      source_name: "FOX Sports",
      source_url: "https://example.test/TEST-A-fox",
    },
  });

  const sync = syncStories(state, [updatedStory]);
  state = sync.state;
  assert.equal(sync.created, 0, "no new state record for the same story_id");
  const promote = promoteEligible(state, [updatedStory]);
  state = promote.state;
  assert.equal(promote.promoted, 0, "already-queued record must not be re-promoted/re-snapshotted");

  assert.equal(Object.keys(state.stories).length, 1);
  assert.equal(state.stories["TEST-A"].status, "queued");
  assert.equal(state.stories["TEST-A"].updated_at, beforeUpdatedAt, "record must not be touched at all");
  assert.deepEqual(state.stories["TEST-A"].source_story, beforeSnapshot, "original snapshot must be preserved, not overwritten by the second outlet's data");
  assert.equal(buildQueueEntries(state).length, 1, "still exactly one queue entry");
});

// ---------------------------------------------------------------------------
// E. Acknowledged job: queued -> artwork_requested disappears from the queue.
// ---------------------------------------------------------------------------
test("E: acknowledging a job (queued -> artwork_requested) removes it from the queue", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;
  assert.equal(buildQueueEntries(state).length, 1);

  const result = transition(state, "TEST-A", "artwork_requested");
  assert.equal(result.ok, true);
  state = result.state;

  assert.equal(state.stories["TEST-A"].status, "artwork_requested");
  assert.equal(buildQueueEntries(state).length, 0, "artwork_requested must not appear in the queue — it represents claimed work, not unclaimed work");
});

// ---------------------------------------------------------------------------
// F. Artwork created: no new queue entry on a subsequent refresh.
// ---------------------------------------------------------------------------
test("F: artwork_created does not reappear in the queue on a subsequent refresh", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;
  state = transition(state, "TEST-A", "artwork_requested").state;
  state = transition(state, "TEST-A", "artwork_created", {
    artwork: { status: "created", image_url: "https://example.test/TEST-A-art.png", created_at: new Date().toISOString(), provider: "test" },
  }).state;

  // Simulate a subsequent refresh cycle against the same live story data.
  const sync = syncStories(state, stories);
  state = sync.state;
  const promote = promoteEligible(state, stories);
  state = promote.state;

  assert.equal(sync.created, 0);
  assert.equal(promote.promoted, 0);
  assert.equal(state.stories["TEST-A"].status, "artwork_created");
  assert.equal(buildQueueEntries(state).length, 0);
});

// ---------------------------------------------------------------------------
// G. Awaiting approval: exactly one item would appear on Posts For Approval.
// ---------------------------------------------------------------------------
test("G: reaching awaiting_approval surfaces exactly one item for the approval view", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;
  state = transition(state, "TEST-A", "artwork_requested").state;
  state = transition(state, "TEST-A", "artwork_created").state;
  state = transition(state, "TEST-A", "validating").state;
  state = transition(state, "TEST-A", "artwork_ready").state;
  state = transition(state, "TEST-A", "awaiting_approval").state;

  const approvalItems = Object.values(state.stories).filter((r) => r.status === "awaiting_approval");
  assert.equal(approvalItems.length, 1);
  assert.equal(approvalItems[0].story_id, "TEST-A");
});

// ---------------------------------------------------------------------------
// H. Posted: never returns to the queue, never appears as awaiting approval.
// ---------------------------------------------------------------------------
test("H: a posted story never returns to the artwork queue or the approval view", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;
  state = transition(state, "TEST-A", "artwork_requested").state;
  state = transition(state, "TEST-A", "artwork_created").state;
  state = transition(state, "TEST-A", "validating").state;
  state = transition(state, "TEST-A", "artwork_ready").state;
  state = transition(state, "TEST-A", "awaiting_approval").state;
  state = transition(state, "TEST-A", "approved").state;
  state = transition(state, "TEST-A", "posting").state;
  state = transition(state, "TEST-A", "posted").state;

  assert.equal(state.stories["TEST-A"].status, "posted");

  // Simulate more refreshes against the same (still "eligible") live story.
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;

  assert.equal(state.stories["TEST-A"].status, "posted", "must not be reset by a later refresh");
  assert.equal(buildQueueEntries(state).length, 0);
  assert.equal(Object.values(state.stories).filter((r) => r.status === "awaiting_approval").length, 0);

  return state;
});

// ---------------------------------------------------------------------------
// J. Invalid transitions are rejected.
// ---------------------------------------------------------------------------
test("J: invalid transitions (posted/awaiting_approval/artwork_created -> new) are rejected", () => {
  assert.equal(canTransition("posted", "new"), false);
  assert.equal(canTransition("awaiting_approval", "new"), false);
  assert.equal(canTransition("artwork_created", "new"), false);

  // And transition() itself must refuse to apply them, not just the table.
  let state = emptyState();
  state = ensureRecord(state, "X", { status: "posted" }).state;
  let result = transition(state, "X", "new");
  assert.equal(result.ok, false);
  assert.equal(state.stories["X"].status, "posted", "rejected transition must not mutate state");

  state = ensureRecord(emptyState(), "Y", { status: "awaiting_approval" }).state;
  result = transition(state, "Y", "new");
  assert.equal(result.ok, false);

  state = ensureRecord(emptyState(), "Z", { status: "artwork_created" }).state;
  result = transition(state, "Z", "new");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// K. Canonical redirect resolution + loop detection.
// ---------------------------------------------------------------------------
test("K: merged_into resolves to the canonical record, and redirect loops are detected", () => {
  let state = emptyState();
  state = ensureRecord(state, "CANONICAL", { status: "queued" }).state;
  state = ensureRecord(state, "ORPHAN", { status: "new" }).state;
  state.stories["ORPHAN"] = { ...state.stories["ORPHAN"], merged_into: "CANONICAL" };

  const resolved = resolveCanonicalId(state, "ORPHAN");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.story_id, "CANONICAL");
  assert.equal(resolved.record.status, "queued");

  // A transition routed through the orphan id must apply to the canonical
  // record, not create/modify a separate one for the orphan.
  const result = transition(state, "ORPHAN", "artwork_requested");
  assert.equal(result.ok, true);
  assert.equal(result.story_id, "CANONICAL");
  assert.equal(result.state.stories["CANONICAL"].status, "artwork_requested");
  assert.equal(result.state.stories["ORPHAN"].status, "new", "the orphan's own record must be left untouched");

  // Redirect loop: A -> B -> A.
  let loopState = emptyState();
  loopState = ensureRecord(loopState, "A", {}).state;
  loopState = ensureRecord(loopState, "B", {}).state;
  loopState.stories["A"] = { ...loopState.stories["A"], merged_into: "B" };
  loopState.stories["B"] = { ...loopState.stories["B"], merged_into: "A" };

  const loopResolved = resolveCanonicalId(loopState, "A");
  assert.equal(loopResolved.ok, false);
  assert.equal(loopResolved.error, "redirect_loop");
});

// ---------------------------------------------------------------------------
// L. News pruning: the social-state record survives a story disappearing
// from the live news.json data (e.g. aged out of the 7-day retention window).
// ---------------------------------------------------------------------------
test("L: a social-state record survives its story disappearing from current news data", () => {
  let state = emptyState();
  const stories = [eligibleStory("TEST-A")];
  state = syncStories(state, stories).state;
  state = promoteEligible(state, stories).state;
  assert.equal(state.stories["TEST-A"].status, "queued");

  // Simulate a refresh where TEST-A is no longer present in news.json at all.
  const sync = syncStories(state, []);
  state = sync.state;
  const promote = promoteEligible(state, []);
  state = promote.state;

  assert.equal(sync.created, 0);
  assert.ok(state.stories["TEST-A"], "record must still exist");
  assert.equal(state.stories["TEST-A"].status, "queued", "status must be untouched");
  assert.equal(buildQueueEntries(state).length, 1, "queue payload (from the snapshot) must still be servable");
});

// ---------------------------------------------------------------------------
// Extra: eligibility gating itself (a story missing an image/headline/
// source must never be promoted, regardless of how many refreshes pass).
// ---------------------------------------------------------------------------
test("Extra: an ineligible story (social_status != 'ready') is never promoted to queued", () => {
  let state = emptyState();
  const notReady = { id: "TEST-B", category: "injury", social: { social_status: "needs_media", post_headline: "X", base_image_url: null, source_name: "ESPN", source_url: "https://example.test/b" } };
  assert.equal(isEligible(notReady), false);

  state = syncStories(state, [notReady]).state;
  const promote = promoteEligible(state, [notReady]);
  state = promote.state;

  assert.equal(promote.promoted, 0);
  assert.equal(state.stories["TEST-B"].status, "new");
  assert.equal(buildQueueEntries(state).length, 0);
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
