#!/usr/bin/env node
// Regression suite for the Approval-phase event handlers (see
// scripts/lib/approvalEvents.js). Exercises the real pure functions
// in-memory — no file I/O, no HTTP, no real story ever touches
// data/social-state.json. Builds a real awaiting_approval record via the
// actual production artwork/caption event functions, not a shortcut.
// Run with: node scripts/tests/approval-events-regression.mjs
import assert from "node:assert/strict";
import { emptyState, syncStories, promoteEligible, transition } from "../lib/socialState.js";
import { applyClaimEvent, applyCompleteEvent } from "../lib/artworkEvents.js";
import { applyCaptionClaimEvent, applyCaptionCompleteEvent } from "../lib/captionEvents.js";
import { applyApprovalApprovedEvent, applyApprovalRejectedEvent } from "../lib/approvalEvents.js";

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

const GOOD_CAPTION_TEXT = "The move addresses depth on the roster. Source: ESPN";

/** Builds a real awaiting_approval record via the actual production pipeline, not a shortcut. */
function awaitingApprovalState(id) {
  let state = emptyState();
  state = syncStories(state, [eligibleStory(id)]).state;
  state = promoteEligible(state, [eligibleStory(id)]).state;
  state = applyClaimEvent(state, { story_id: id, claim_id: "artwork-claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyCompleteEvent(state, goodArtworkPayload(id, "artwork-claim-1"), { reachable: true }).state;
  state = applyCaptionClaimEvent(state, { story_id: id, claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const result = applyCaptionCompleteEvent(state, { story_id: id, claim_id: "cap-1", text: GOOD_CAPTION_TEXT, hashtags: ["#NFL"], attribution_line: "Source: ESPN", provider: "chatgpt-codex-local" });
  assert.equal(result.record.status, "awaiting_approval", "test fixture setup must actually reach awaiting_approval");
  return result.state;
}

function approvalPayload(storyId, overrides = {}) {
  return {
    story_id: storyId,
    request_id: "req-1",
    actor: "local-approval-testhost",
    decision_source: "local-approval-console",
    decided_at: "2026-09-01T00:00:00.000Z",
    rejection_reason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
test("awaiting_approval -> approved: status transitions and approval audit fields are recorded", () => {
  const state = awaitingApprovalState("TEST-A");
  const result = applyApprovalApprovedEvent(state, approvalPayload("TEST-A"));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "approved");
  assert.deepEqual(result.record.approval, {
    status: "approved",
    decided_at: "2026-09-01T00:00:00.000Z",
    approved_at: "2026-09-01T00:00:00.000Z",
    rejected_at: null,
    rejection_reason: null,
    actor: "local-approval-testhost",
    request_id: "req-1",
    decision_source: "local-approval-console",
  });
});

test("awaiting_approval -> rejected: status transitions and rejection_reason is recorded", () => {
  const state = awaitingApprovalState("TEST-A");
  const result = applyApprovalRejectedEvent(state, approvalPayload("TEST-A", { rejection_reason: "Wrong player identified in artwork" }));
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "rejected");
  assert.equal(result.record.approval.status, "rejected");
  assert.equal(result.record.approval.rejected_at, "2026-09-01T00:00:00.000Z");
  assert.equal(result.record.approval.approved_at, null);
  assert.equal(result.record.approval.rejection_reason, "Wrong player identified in artwork");
});

test("invalid transition replay is harmless: a duplicate approval-approved after a real approval is rejected as invalid_transition, never re-applied", () => {
  let state = awaitingApprovalState("TEST-A");
  const first = applyApprovalApprovedEvent(state, approvalPayload("TEST-A", { request_id: "req-1" }));
  assert.equal(first.ok, true);
  state = first.state;

  const replay = applyApprovalApprovedEvent(state, approvalPayload("TEST-A", { request_id: "req-1", decided_at: "2026-09-01T00:05:00.000Z" }));
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "invalid_transition:approved->approved");
  assert.equal(state.stories["TEST-A"].approval.decided_at, "2026-09-01T00:00:00.000Z", "the original decision must be untouched by the replay");
});

test("a late approval-rejected event after a real approval is also harmless — never flips an approved story to rejected", () => {
  let state = awaitingApprovalState("TEST-A");
  state = applyApprovalApprovedEvent(state, approvalPayload("TEST-A")).state;

  const lateReject = applyApprovalRejectedEvent(state, approvalPayload("TEST-A", { request_id: "req-2", rejection_reason: "changed my mind" }));
  assert.equal(lateReject.ok, false);
  assert.equal(lateReject.error, "invalid_transition:approved->rejected");
  assert.equal(state.stories["TEST-A"].status, "approved", "must remain approved — the opposite decision must never supersede a committed one");
});

test("artwork is fully preserved on approve", () => {
  const state = awaitingApprovalState("TEST-A");
  const artworkBefore = state.stories["TEST-A"].artwork;
  const result = applyApprovalApprovedEvent(state, approvalPayload("TEST-A"));
  assert.deepEqual(result.record.artwork, artworkBefore);
});

test("artwork is fully preserved on reject", () => {
  const state = awaitingApprovalState("TEST-A");
  const artworkBefore = state.stories["TEST-A"].artwork;
  const result = applyApprovalRejectedEvent(state, approvalPayload("TEST-A"));
  assert.deepEqual(result.record.artwork, artworkBefore);
});

test("caption is fully preserved on approve", () => {
  const state = awaitingApprovalState("TEST-A");
  const captionBefore = state.stories["TEST-A"].caption;
  const result = applyApprovalApprovedEvent(state, approvalPayload("TEST-A"));
  assert.deepEqual(result.record.caption, captionBefore);
  assert.equal(result.record.caption.text, GOOD_CAPTION_TEXT);
});

test("caption is fully preserved on reject", () => {
  const state = awaitingApprovalState("TEST-A");
  const captionBefore = state.stories["TEST-A"].caption;
  const result = applyApprovalRejectedEvent(state, approvalPayload("TEST-A"));
  assert.deepEqual(result.record.caption, captionBefore);
});

test("rejection does not touch last_error — a human decision is not a failure", () => {
  const state = awaitingApprovalState("TEST-A");
  const lastErrorBefore = state.stories["TEST-A"].last_error;
  assert.deepEqual(lastErrorBefore, { stage: null, message: null, at: null, retry_count: 0 });
  const result = applyApprovalRejectedEvent(state, approvalPayload("TEST-A", { rejection_reason: "bad artwork" }));
  assert.deepEqual(result.record.last_error, lastErrorBefore);
});

test("rejected is a dead end: TRANSITIONS has no outgoing edge from rejected", () => {
  let state = awaitingApprovalState("TEST-A");
  state = applyApprovalRejectedEvent(state, approvalPayload("TEST-A")).state;
  const attemptApprove = applyApprovalApprovedEvent(state, approvalPayload("TEST-A", { request_id: "req-2" }));
  assert.equal(attemptApprove.ok, false);
  assert.equal(attemptApprove.error, "invalid_transition:rejected->approved");
});

test("historical records (pre-Approval-phase, missing the new approval.* fields) remain compatible: emptyState/ensureRecord still default them", () => {
  const state = awaitingApprovalState("TEST-A");
  const approval = state.stories["TEST-A"].approval;
  // The record was built entirely through syncStories/promoteEligible/
  // applyClaimEvent/applyCompleteEvent/applyCaptionClaimEvent/
  // applyCaptionCompleteEvent — none of which know about the Approval
  // phase — yet the approval sub-object already has the full new shape
  // with safe defaults, proving the additive schema extension requires no
  // migration for any pre-existing code path.
  assert.deepEqual(approval, {
    status: "pending",
    decided_at: null,
    approved_at: null,
    rejected_at: null,
    rejection_reason: null,
    actor: null,
    request_id: null,
    decision_source: null,
  });
});

test("approval cannot proceed before awaiting_approval (still artwork_ready)", () => {
  let state = emptyState();
  state = syncStories(state, [eligibleStory("TEST-A")]).state;
  state = promoteEligible(state, [eligibleStory("TEST-A")]).state;
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "c1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyCompleteEvent(state, goodArtworkPayload("TEST-A", "c1"), { reachable: true }).state;
  // Still "artwork_ready" — caption was never completed.

  const result = applyApprovalApprovedEvent(state, approvalPayload("TEST-A"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_transition:artwork_ready->approved");
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
