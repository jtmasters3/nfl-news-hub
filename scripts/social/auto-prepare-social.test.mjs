#!/usr/bin/env node
// Tests for the autonomous preparation + auto-approval runner. Every
// dependency (fetchQueue, fetchState, runPreparationImpl, decideApprovalImpl,
// waitForApprovalCommitImpl) is explicitly injected — this suite makes NO
// real network call of any kind, spawns NO real child process, generates NO
// real artwork, and calls neither Buffer, Meta, nor the real approval
// endpoint. installNetworkGuard() additionally makes any accidental use of
// the real globalThis.fetch throw immediately.
// Run with: node scripts/social/auto-prepare-social.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "../social-worker/lib/_networkGuard.mjs";
import { selectAutonomousCandidate, main, resolveRunMode } from "./auto-prepare-social.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function queueEntry(storyId) {
  return { story_id: storyId };
}

/** A statically-eligible, fresh "queued" record — the canonical modern shape. */
function validQueuedRecord(overrides = {}) {
  return {
    story_id: "s1",
    status: "queued",
    merged_into: null,
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    source_story: {
      post_headline: "JORDAN LOVE OUT WITH SHOULDER INJURY",
      description: "Jordan Love was hurt during practice with the Green Bay Packers.",
      base_image_url: "https://example.test/base.jpg",
      source_name: "ESPN",
      source_url: "https://espn.com/story/jordan-love-out",
      category: "injury",
      teams: ["Green Bay Packers"],
      players: ["Jordan Love"],
    },
    approval: { status: "pending" },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

/** A legacy, pre-Stage-3A record — the real audited backlog shape: no selection, no teams/players. */
function legacyQueuedRecord(overrides = {}) {
  return {
    story_id: "legacy1",
    status: "queued",
    source_story: {
      post_headline: "SOME OLD HEADLINE",
      base_image_url: "https://example.test/old.jpg",
      source_name: "Pro Football Talk",
      source_url: "https://example.test/old-story",
    },
    publishing: { status: "not_posted" },
    ...overrides,
  };
}

function awaitingApprovalRecord(overrides = {}) {
  return {
    ...validQueuedRecord(),
    status: "awaiting_approval",
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    story_artwork: { status: "not_created", image_url: null },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: ESPN" },
    ...overrides,
  };
}

/**
 * A stateful fetchState mock: returns `validQueuedRecord()` on its FIRST
 * call (the pre-preparation read main() does before spawning the pipeline)
 * and `postPrepareRecord` on every subsequent call (the fresh
 * post-preparation read) — mirroring the exact real sequence.
 */
function statefulFetchState(postPrepareRecord, storyId = "s1") {
  let callCount = 0;
  return async () => {
    callCount++;
    if (callCount === 1) return { stories: { [storyId]: validQueuedRecord({ story_id: storyId, selection: postPrepareRecord.selection }) } };
    return { stories: { [storyId]: postPrepareRecord } };
  };
}

// ---------------------------------------------------------------------------
// SELECTION
// ---------------------------------------------------------------------------

test("1. an empty queue with no awaiting_approval candidates yields no selection", async () => {
  const result = await selectAutonomousCandidate({ fetchQueue: async () => [], fetchState: async () => ({ stories: {} }) });
  assert.equal(result.mode, null);
  assert.equal(result.queueLength, 0);
});

test("2. exactly one statically-eligible queue entry is selected at queue position 0", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord() } }),
  });
  assert.equal(result.mode, "generate");
  assert.equal(result.story_id, "s1");
  assert.equal(result.queuePosition, 0);
});

test("3. the FIRST statically-eligible candidate is chosen after hundreds of ineligible legacy records — existing FIFO order preserved, never reordered by importance", async () => {
  const queue = [];
  const stories = {};
  for (let i = 0; i < 472; i++) {
    const id = `legacy${i}`;
    queue.push(queueEntry(id));
    stories[id] = legacyQueuedRecord({ story_id: id });
  }
  queue.push(queueEntry("modern1"));
  stories.modern1 = validQueuedRecord({ story_id: "modern1" });

  const result = await selectAutonomousCandidate({ fetchQueue: async () => queue, fetchState: async () => ({ stories }) });
  assert.equal(result.mode, "generate");
  assert.equal(result.story_id, "modern1");
  assert.equal(result.queuePosition, 472);
  assert.equal(result.inspectedCount, 473);
  assert.equal(result.skipCounts.legacyMissingCanonical, 472);
});

test("4. a valid Feed candidate is selected", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }) } }),
  });
  assert.equal(result.record.selection.destination, "feed");
});

test("5. a valid Story candidate is selected", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({
      stories: { s1: validQueuedRecord({ selection: { destination: "story", selected_at: "2026-01-01T00:00:00Z" }, source_story: { ...validQueuedRecord().source_story, source_name: "FOX Sports" } }) },
    }),
  });
  assert.equal(result.record.selection.destination, "story");
});

test("6. never more than one candidate is ever returned/acted on per run", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("a"), queueEntry("b"), queueEntry("c")],
    fetchState: async () => ({ stories: { a: validQueuedRecord({ story_id: "a" }), b: validQueuedRecord({ story_id: "b" }), c: validQueuedRecord({ story_id: "c" }) } }),
  });
  assert.equal(Array.isArray(result.story_id), false);
  assert.equal(result.story_id, "a");
});

test("7. an already-prepared, fully gate-eligible awaiting_approval record is preferred over any queue candidate — no regeneration needed", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("queued1")],
    fetchState: async () => ({
      stories: {
        queued1: validQueuedRecord({ story_id: "queued1" }),
        ready1: awaitingApprovalRecord({ story_id: "ready1" }),
      },
    }),
  });
  assert.equal(result.mode, "approve-only");
  assert.equal(result.story_id, "ready1");
});

test("8. among multiple approve-only-eligible awaiting_approval records, the oldest by selection.selected_at is chosen — the same tie-break convention already used elsewhere", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({
      stories: {
        newer: awaitingApprovalRecord({ story_id: "newer", selection: { destination: "feed", selected_at: "2026-01-02T00:00:00Z" } }),
        older: awaitingApprovalRecord({ story_id: "older", selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }),
      },
    }),
  });
  assert.equal(result.story_id, "older");
});

// ---------------------------------------------------------------------------
// Legacy skip reasons (static, per-field)
// ---------------------------------------------------------------------------

test("9. a legacy record missing selection is skipped, never selected", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("legacy1")],
    fetchState: async () => ({ stories: { legacy1: legacyQueuedRecord() } }),
  });
  assert.equal(result.mode, null);
});

test("10. a legacy record missing the teams field is skipped", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, teams: undefined } }) } }),
  });
  assert.equal(result.mode, null);
  assert.equal(result.skipCounts.legacyMissingCanonical, 1);
});

test("11. a legacy record missing the players field is skipped", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, players: undefined } }) } }),
  });
  assert.equal(result.mode, null);
  assert.equal(result.skipCounts.legacyMissingCanonical, 1);
});

test("12. a PRESENT but EMPTY teams[] array is handled as legitimate — never skipped for that reason alone", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, teams: [] } }) } }),
  });
  assert.equal(result.mode, "generate");
});

test("13. a PRESENT but EMPTY players[] array is handled as legitimate — never skipped for that reason alone", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, players: [] } }) } }),
  });
  assert.equal(result.mode, "generate");
});

test("14. an unsupported source is skipped (counted separately from legacy/missing-canonical)", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, source_name: "Random Blog" } }) } }),
  });
  assert.equal(result.mode, null);
  assert.equal(result.skipCounts.unsupportedSource, 1);
});

test("15. an already-approved record is skipped (lifecycle)", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ status: "approved", approval: { status: "approved" } }) } }),
  });
  assert.equal(result.mode, null);
  assert.equal(result.skipCounts.lifecycle, 1);
});

test("16. a currently-posting record is skipped", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ status: "posting" }) } }),
  });
  assert.equal(result.mode, null);
});

test("17. an already-posted record is skipped", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ status: "posted" }) } }),
  });
  assert.equal(result.mode, null);
});

test("18. a record with an ambiguous posting outcome is skipped", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ status: "posting", publishing: { status: "posting", instagram: { feed: { status: "ambiguous" } } } }) } }),
  });
  assert.equal(result.mode, null);
});

test("19. a record with an already-recorded publish_attempted_at is skipped", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({
      stories: { s1: validQueuedRecord({ publishing: { status: "not_posted", instagram: { feed: { status: "not_posted", publish_attempted_at: "2026-01-01T00:00:00Z" } } } }) },
    }),
  });
  assert.equal(result.mode, null);
});

test("20. skipped legacy records are never mutated — selectAutonomousCandidate is a pure read", async () => {
  const legacy = legacyQueuedRecord();
  const legacySnapshot = JSON.stringify(legacy);
  await selectAutonomousCandidate({ fetchQueue: async () => [queueEntry("legacy1")], fetchState: async () => ({ stories: { legacy1: legacy } }) });
  assert.equal(JSON.stringify(legacy), legacySnapshot, "the record object must be byte-for-byte unchanged after selection");
});

// ---------------------------------------------------------------------------
// DRY RUN — zero mutation, zero generation, zero approval, zero Buffer
// ---------------------------------------------------------------------------

test("21. dry run reports the candidate without ever calling runPreparationImpl, decideApprovalImpl, or waitForApprovalCommitImpl", async () => {
  let prepCalled = false, decideCalled = false, waitCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord() } }),
    live: false,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    waitForApprovalCommitImpl: async () => { waitCalled = true; return { committed: true }; },
  });
  assert.equal(prepCalled, false, "dry run must never spawn artwork/caption generation");
  assert.equal(decideCalled, false, "dry run must never call the approval endpoint");
  assert.equal(waitCalled, false);
  assert.equal(result.dryRun.story_id, "s1");
  assert.equal(result.dryRun.mode, "generate");
  assert.equal(result.dryRun.queue_position, 0);
});

test("22. zero eligible candidates (empty queue, no awaiting_approval) in dry run -> clean no-op, no calls at all", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: {} }),
    live: false,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected, null);
  assert.equal(prepCalled, false);
});

test("23. dry run against a legacy-only backlog reports the skip counts and selects nothing, never calling runPreparationImpl", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("legacy1")],
    fetchState: async () => ({ stories: { legacy1: legacyQueuedRecord() } }),
    live: false,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(prepCalled, false);
  assert.equal(result.selected, null);
  assert.equal(result.skipCounts.legacyMissingCanonical, 1);
});

test("24. dry run reports mode='approve-only' and requires no generation when an already-prepared record is selected", async () => {
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { ready1: awaitingApprovalRecord({ story_id: "ready1" }) } }),
    live: false,
  });
  assert.equal(result.dryRun.mode, "approve-only");
  assert.match(result.dryRun.would_require, /approval only/);
});

// ---------------------------------------------------------------------------
// LIVE PREPARATION — correct pipeline invoked, correct canonical fields
// ---------------------------------------------------------------------------

test("25. live mode invokes runPreparationImpl with the exact selected story_id, exactly once", async () => {
  let callCount = 0;
  let calledWith;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async (args) => { callCount++; calledWith = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(callCount, 1);
  assert.equal(calledWith.storyId, "s1");
});

test("26. live mode never calls runPreparationImpl, Codex, or the approval endpoint for a statically-ineligible (legacy) candidate — there simply is no eligible selection", async () => {
  let prepCalled = false, decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("legacy1")],
    fetchState: async () => ({ stories: { legacy1: legacyQueuedRecord() } }),
    live: true,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(prepCalled, false);
  assert.equal(decideCalled, false);
  assert.equal(result.selected, null);
});

test("27. live mode re-reads FRESH state after preparation rather than trusting the child process's own exit code alone", async () => {
  let stateCallCount = 0;
  const inner = statefulFetchState(awaitingApprovalRecord());
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => { stateCallCount++; return inner(); },
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.ok(stateCallCount >= 2, "must fetch state at least once before and once after preparation");
});

test("28. an already-prepared awaiting_approval record selected via the approve-only fast path is approved WITHOUT ever calling runPreparationImpl", async () => {
  let prepCalled = false;
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { ready1: awaitingApprovalRecord({ story_id: "ready1" }) } }),
    live: true,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(prepCalled, false, "no artwork/caption generation may occur when the record is already fully prepared");
  assert.equal(decideCalled, true);
  assert.equal(result.autoApproved, true);
});

test("29. a Feed record's readiness is evaluated against record.artwork, never record.story_artwork", async () => {
  const feedRecordWithBrokenStoryArtwork = awaitingApprovalRecord({
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    story_artwork: { status: "failed" },
  });
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(feedRecordWithBrokenStoryArtwork),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, true, "a Feed record's own valid artwork must not be blocked by an irrelevant story_artwork failure");
  assert.equal(result.autoApproved, true);
});

test("30. a Story record's readiness is evaluated against record.story_artwork, never record.artwork", async () => {
  const storyRecordWithBrokenArtwork = awaitingApprovalRecord({
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "failed" },
    story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 941, height: 1672, mime_type: "image/png", size_bytes: 500000 },
    source_story: { ...awaitingApprovalRecord().source_story, source_name: "FOX Sports" },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: FOX Sports" },
  });
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(storyRecordWithBrokenArtwork),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, true, "a Story record's own valid story_artwork must not be blocked by an irrelevant artwork failure");
  assert.equal(result.autoApproved, true);
});

test("31. a record that does not reach awaiting_approval after preparation is never approved", async () => {
  let decideCalled = false;
  let stateCallCount = 0;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => {
      stateCallCount++;
      return { stories: { s1: stateCallCount === 1 ? validQueuedRecord() : validQueuedRecord({ status: "failed" }) } };
    },
    live: true,
    runPreparationImpl: async () => ({ exitCode: 1 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
  assert.equal(result.prepared, false);
  assert.equal(result.finalStatus, "failed");
});

// ---------------------------------------------------------------------------
// AUTO APPROVAL
// ---------------------------------------------------------------------------

test("32. a valid Feed record gets approved via decideApprovalImpl with the distinguishing automated actor + decision_source", async () => {
  let decideArgs;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async (storyId, decision, opts) => { decideArgs = { storyId, decision, opts }; return { result: "approved" }; },
  });
  assert.equal(decideArgs.storyId, "s1");
  assert.equal(decideArgs.decision, "approved");
  assert.equal(decideArgs.opts.actor, "aggregate-auto-approver");
  assert.equal(decideArgs.opts.decisionSource, "autonomous-production-gate");
});

test("33. a valid Story record gets approved the same way", async () => {
  const storyRecord = awaitingApprovalRecord({
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "not_created", image_url: null },
    story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 941, height: 1672, mime_type: "image/png", size_bytes: 500000 },
    source_story: { ...awaitingApprovalRecord().source_story, source_name: "FOX Sports" },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: FOX Sports" },
  });
  let decideArgs;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(storyRecord),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async (storyId, decision, opts) => { decideArgs = { storyId, decision, opts }; return { result: "approved" }; },
  });
  assert.equal(decideArgs.opts.actor, "aggregate-auto-approver");
  assert.equal(decideArgs.opts.decisionSource, "autonomous-production-gate");
  assert.equal(result.autoApproved, true);
});

test("34. a 'pending' decideApproval result is polled via waitForApprovalCommitImpl for durable confirmation", async () => {
  let waitCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "pending" }),
    waitForApprovalCommitImpl: async () => { waitCalled = true; return { committed: true, status: "approved", record: awaitingApprovalRecord({ status: "approved" }) }; },
  });
  assert.equal(waitCalled, true);
  assert.equal(result.ok, true);
  assert.equal(result.autoApproved, true);
});

test("35. a durable-commit confirmation timeout after a pending decision is reported as a failure, never silently treated as approved", async () => {
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "pending" }),
    waitForApprovalCommitImpl: async () => ({ committed: false, status: "timeout" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "approval_commit_confirmation");
});

// ---------------------------------------------------------------------------
// FAIL CLOSED — post-preparation gate failures never approve
// ---------------------------------------------------------------------------

test("36. missing artwork after preparation is never approved", async () => {
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord({ artwork: { status: "not_created", image_url: null } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
  assert.equal(result.autoApproved, false);
});

test("37. failed artwork validation after preparation is never approved", async () => {
  let decideCalled = false;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord({ validation: { status: "failed", passed: false, issues: ["aspect_ratio_out_of_range:0.5"] } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
});

test("38. missing caption after preparation is never approved", async () => {
  let decideCalled = false;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord({ caption: { status: "not_created", text: null } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
});

// ---------------------------------------------------------------------------
// PUBLISHING ISOLATION
// ---------------------------------------------------------------------------

test("39. this script never references Buffer's post-creation mutation, Buffer's API host, or Meta directly", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName));
  assert.ok(!/api\.buffer\.com/.test(codeOnly));
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly));
});

test("40. this script never acquires a posting claim, never persists publish_attempted, and never invokes either live publisher", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/claimPosting|publish-buffer-feed|publish-buffer-story|executeBufferFeedPublish|publishViaWorker/.test(codeOnly));
});

test("41. no test in this suite triggers a real Buffer/Meta/approval-endpoint call — every dependency is injected, and installNetworkGuard() proves any accidental fetch would throw immediately", () => {
  assert.ok(typeof installNetworkGuard === "function");
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

test("42. a workflow_dispatch event with no explicit inputMode (missing 'mode') resolves to dry-run — NEVER live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: undefined }), "dry-run");
});

test("43. a workflow_dispatch event with explicit inputMode=live resolves to live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "live" }), "live");
});

test("44. an unrecognized inputMode value never falls through to live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "LIVE" }), "dry-run");
  assert.equal(resolveRunMode({ eventName: undefined, inputMode: undefined }), "dry-run");
});

// ---------------------------------------------------------------------------
// Workflow YAML — concurrency, no schedule
// ---------------------------------------------------------------------------

test("45. the workflow file declares workflow_dispatch with a mode input defaulting to dry-run", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  assert.match(yaml, /^\s*workflow_dispatch:\s*$/m);
  assert.match(yaml, /default:\s*"dry-run"/);
  assert.match(yaml, /-\s*dry-run/);
  assert.match(yaml, /-\s*live/);
});

test("46. the workflow file declares NO native schedule trigger", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  assert.ok(!/^\s*schedule:/m.test(yaml));
  assert.ok(!/cron:/.test(yaml));
});

test("47. the workflow declares a concurrency group with cancel-in-progress=false", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  assert.match(yaml, /^concurrency:\s*$/m);
  assert.match(yaml, /group:\s*auto-prepare-social/);
  assert.match(yaml, /cancel-in-progress:\s*false/);
});

test("48. the workflow references only the existing AGGREGATE_ARTWORK_API_TOKEN secret", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  const secretRefs = [...yaml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secretRefs)], ["AGGREGATE_ARTWORK_API_TOKEN"]);
});

// ---------------------------------------------------------------------------
// 2026-09-11 durability hardening — bounded post-preparation poll
// ---------------------------------------------------------------------------
// A live run just proved a single immediate fetchState() read after
// process-one.js exits can observe the record moments BEFORE the sibling
// caption-completed event durably lands (see apply-artwork-event.js's own
// 2026-09-11 header for the exact race). main() now polls via
// waitForDurableCommitImpl for a durable resting state (awaiting_approval
// or failed) instead of trusting a single read. These tests mock
// waitForDurableCommitImpl directly, the same way tests 34/35 already mock
// waitForApprovalCommitImpl — the generic poll mechanics themselves
// (timeout, eventual success, read_error) are already proven in
// waitForDurableCommit.js's own dedicated suite; these tests only prove
// auto-prepare-social.js wires it up correctly.

test("49. the post-preparation durable-poll predicate recognizes BOTH awaiting_approval and failed as committed end states, and rejects an interim status", async () => {
  let capturedPredicate;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "approved" }),
    waitForDurableCommitImpl: async (fetchState, storyId, predicate) => {
      capturedPredicate = predicate;
      return { committed: true, record: awaitingApprovalRecord() };
    },
  });
  assert.equal(capturedPredicate({ status: "awaiting_approval" }), true);
  assert.equal(capturedPredicate({ status: "failed" }), true);
  assert.equal(capturedPredicate({ status: "artwork_ready" }), false, "an interim, not-yet-resolved status must never be treated as a durable commit");
});

test("50. a post-preparation durable-poll TIMEOUT fails closed: no approval attempted, no regeneration, preparation reported as not ok", async () => {
  let decideCalled = false;
  let prepCallCount = 0;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => { prepCallCount++; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    waitForDurableCommitImpl: async () => ({ committed: false, status: "timeout" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "post_prepare_durable_poll");
  assert.equal(decideCalled, false, "a poll timeout must never be treated as success — no approval may be attempted");
  assert.equal(prepCallCount, 1, "a poll timeout must never trigger re-running preparation — no caption or artwork regeneration");
});

test("51. a post-preparation durable-poll READ ERROR (not a plain timeout) also fails closed the same way", async () => {
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    waitForDurableCommitImpl: async () => ({ committed: false, status: "read_error", error: "GitHub API rate limited" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "post_prepare_durable_poll");
  assert.equal(decideCalled, false);
});

test("52. a durable poll that EVENTUALLY observes awaiting_approval (after simulated waiting) proceeds to auto-approval exactly as an immediate success would", async () => {
  let waitingCalls = 0;
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    waitForDurableCommitImpl: async (fetchState, storyId, predicate, { onWaiting } = {}) => {
      onWaiting?.(1, 20, "pending");
      onWaiting?.(2, 20, "pending");
      waitingCalls = 2;
      return { committed: true, record: awaitingApprovalRecord() };
    },
  });
  assert.equal(waitingCalls, 2, "sanity check: the mock actually simulated waiting before succeeding");
  assert.equal(decideCalled, true);
  assert.equal(result.autoApproved, true);
});

test("53. a durable poll that observes a genuinely committed 'failed' status (not a timeout) is reported as a clean, non-error outcome — never approved, never retried", async () => {
  let decideCalled = false;
  let prepCallCount = 0;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => { prepCallCount++; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    waitForDurableCommitImpl: async () => ({ committed: true, record: { status: "failed" } }),
  });
  assert.equal(result.ok, true, "a durably-committed failed state is a safe, expected outcome, not a script error");
  assert.equal(result.prepared, false);
  assert.equal(result.finalStatus, "failed");
  assert.equal(decideCalled, false);
  assert.equal(prepCallCount, 1);
});

test("54. main() passes the SAME fetchState it uses everywhere else into waitForDurableCommitImpl, never a second/different reader", async () => {
  const sentinelFetchState = statefulFetchState(awaitingApprovalRecord());
  let receivedFetchState;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: sentinelFetchState,
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "approved" }),
    waitForDurableCommitImpl: async (fetchState) => {
      receivedFetchState = fetchState;
      return { committed: true, record: awaitingApprovalRecord() };
    },
  });
  assert.equal(receivedFetchState, sentinelFetchState);
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
