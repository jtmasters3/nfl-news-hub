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
import { selectAutonomousCandidate, main, resolveRunMode, determineExitCode } from "./auto-prepare-social.js";

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
  assert.match(result.dryRun.would_require, /current auto-approval gate/);
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
// 2026-09-14 hands-off caption-completion recovery integration
// ---------------------------------------------------------------------------
// The exact proven-stuck shape: artwork_ready, caption not ready but with a
// known existing claim_id, publishing clean. The Durable Object side is
// mocked separately per test via getCaptionClaimStatusImpl.

function stuckCaptionRecord(overrides = {}) {
  return {
    story_id: "s1",
    status: "artwork_ready",
    merged_into: null,
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    source_story: validQueuedRecord().source_story,
    approval: { status: "pending" },
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "generating", text: null, claim: { claim_id: "claim-recover-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" } },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

function completedDoRecord(overrides = {}) {
  return {
    status: "completed",
    claim_id: "claim-recover-1",
    processor_id: "p1",
    dispatch_confirmed: true,
    payload: { story_id: "s1", claim_id: "claim-recover-1", text: "A recovered caption.\n\nSource: ESPN", provider: "chatgpt-codex-local" },
    ...overrides,
  };
}

function recoveredReadyRecord(overrides = {}) {
  return {
    ...stuckCaptionRecord(),
    status: "awaiting_approval",
    caption: { status: "ready", text: "A recovered caption.\n\nSource: ESPN", claim: { claim_id: "claim-recover-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" } },
    ...overrides,
  };
}

/** Returns the stuck record on the first fetchState() call (selection) and readyRecord on every subsequent call (the post-replay poll) — mirroring the exact real sequence. */
function statefulFetchStateForRecovery(readyRecord, storyId = "s1") {
  let callCount = 0;
  return async () => {
    callCount++;
    if (callCount === 1) return { stories: { [storyId]: stuckCaptionRecord({ story_id: storyId }) } };
    return { stories: { [storyId]: readyRecord } };
  };
}

test("55. selectAutonomousCandidate recognizes the exact proven stuck state as a recover-caption candidate", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
  });
  assert.equal(result.mode, "recover-caption");
  assert.equal(result.story_id, "s1");
});

test("56. dry run for a recover-caption candidate never touches the Durable Object, never replays, never polls, never approves", async () => {
  let statusCalled = false, replayCalled = false, waitCalled = false, decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: false,
    getCaptionClaimStatusImpl: async () => { statusCalled = true; return { do_record: completedDoRecord() }; },
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    waitForDurableCommitImpl: async () => { waitCalled = true; return { committed: true, record: recoveredReadyRecord() }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(statusCalled, false, "dry run must never read the Durable Object");
  assert.equal(replayCalled, false);
  assert.equal(waitCalled, false);
  assert.equal(decideCalled, false);
  assert.equal(result.dryRun.mode, "recover-caption");
  assert.match(result.dryRun.would_require, /replay recovery/);
});

test("57. a successful automatic recovery calls getCaptionClaimStatusImpl and replayCaptionCompletionImpl with EXACTLY the story_id and existing claim_id — no caption text supplied by the runner", async () => {
  let statusArgs, replayArgs;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: statefulFetchStateForRecovery(recoveredReadyRecord()),
    live: true,
    getCaptionClaimStatusImpl: async (storyId) => { statusArgs = { storyId }; return { do_record: completedDoRecord() }; },
    replayCaptionCompletionImpl: async (storyId, claimId) => { replayArgs = { storyId, claimId }; return { replayed: true }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(statusArgs.storyId, "s1");
  assert.equal(replayArgs.storyId, "s1");
  assert.equal(replayArgs.claimId, "claim-recover-1");
  assert.equal(Object.keys(replayArgs).length, 2, "replay must be called with exactly (story_id, claim_id) — no caption text, no hashtags, no other content");
  assert.equal(result.autoApproved, true);
});

test("58. an eligibility failure (e.g. the DO still shows 'claimed', not 'completed') fails closed on replay/approval, but is reported as a successful no-op (ok:true) — not yet eligible is routine, not an infrastructure failure — 2026-09-14 workflow-semantics fix", async () => {
  let replayCalled = false, decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord({ status: "claimed" }) }),
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(result.ok, true, "not-yet-eligible must never turn the workflow red — see determineExitCode()'s own header");
  assert.equal(result.step, "caption_recovery_eligibility");
  assert.equal(replayCalled, false, "an ineligible record must never be replayed");
  assert.equal(decideCalled, false);
});

test("59. a wrong/stale DO claim_id blocks replay end-to-end through main(), not just at the pure eligibility check — still reported as a successful no-op, never a workflow failure", async () => {
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord({ claim_id: "some-other-claim" }) }),
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.step, "caption_recovery_eligibility");
  assert.ok(result.eligibility.issues.includes("do_claim_id_mismatch"));
  assert.equal(replayCalled, false);
});

test("60. a replay refusal from the Worker (e.g. reason: claim_mismatch) fails closed — no approval, no second attempt within this run", async () => {
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord() }),
    replayCaptionCompletionImpl: async () => ({ replayed: false, reason: "claim_mismatch" }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "caption_recovery_replay");
  assert.equal(decideCalled, false);
});

test("61. a durable-confirmation TIMEOUT after a successful replay dispatch fails closed — no regeneration, no second replay, no approval", async () => {
  let replayCallCount = 0, decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord() }),
    replayCaptionCompletionImpl: async () => { replayCallCount++; return { replayed: true }; },
    waitForDurableCommitImpl: async () => ({ committed: false, status: "timeout" }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "caption_recovery_durable_poll");
  assert.equal(replayCallCount, 1, "a poll timeout must never trigger a second replay attempt within the same run — no replay storm");
  assert.equal(decideCalled, false);
});

test("62. the durable-poll predicate requires the SAME claim/completion lineage, caption text present, AND awaiting_approval — not just top-level status alone", async () => {
  let capturedPredicate;
  await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord() }),
    replayCaptionCompletionImpl: async () => ({ replayed: true }),
    waitForDurableCommitImpl: async (fetchState, storyId, predicate) => {
      capturedPredicate = predicate;
      return { committed: true, record: recoveredReadyRecord() };
    },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(capturedPredicate(recoveredReadyRecord()), true);
  assert.equal(capturedPredicate({ status: "artwork_ready", caption: { status: "generating" } }), false, "not yet applied must never be mistaken for success");
  assert.equal(capturedPredicate({ status: "awaiting_approval", caption: { status: "ready", text: "x", claim: { claim_id: "a-DIFFERENT-claim" } } }), false, "a coincidental unrelated success must never be mistaken for THIS replay's own lineage");
  assert.equal(capturedPredicate({ status: "failed" }), true, "a genuine durably-committed failure is still a recognized end state");
});

test("63. a successful replay that durably confirms proceeds through the normal auto-approval gate exactly like the generate/approve-only paths", async () => {
  let decideArgs;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: statefulFetchStateForRecovery(recoveredReadyRecord()),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord() }),
    replayCaptionCompletionImpl: async () => ({ replayed: true }),
    decideApprovalImpl: async (storyId, decision, opts) => { decideArgs = { storyId, decision, opts }; return { result: "approved" }; },
  });
  assert.equal(decideArgs.opts.actor, "aggregate-auto-approver");
  assert.equal(decideArgs.opts.decisionSource, "autonomous-production-gate");
  assert.equal(result.autoApproved, true);
});

test("64. the NORMAL happy path (fresh queue generation) never touches the caption-recovery machinery at all", async () => {
  let statusCalled = false, replayCalled = false;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "approved" }),
    getCaptionClaimStatusImpl: async () => { statusCalled = true; return { do_record: null }; },
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: false }; },
  });
  assert.equal(statusCalled, false, "a normal successful generation run must never call the recovery DO read");
  assert.equal(replayCalled, false, "a normal successful generation run must never call replay");
});

test("65. the NORMAL approve-only happy path never touches the caption-recovery machinery either", async () => {
  let statusCalled = false, replayCalled = false;
  await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { ready1: awaitingApprovalRecord({ story_id: "ready1" }) } }),
    live: true,
    decideApprovalImpl: async () => ({ result: "approved" }),
    getCaptionClaimStatusImpl: async () => { statusCalled = true; return { do_record: null }; },
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: false }; },
  });
  assert.equal(statusCalled, false);
  assert.equal(replayCalled, false);
});

test("66. once caption becomes durably ready, a duplicate runner invocation no longer selects recover-caption for the same story — idempotent, never a second replay", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: recoveredReadyRecord() } }),
  });
  assert.notEqual(result.mode, "recover-caption");
});

test("67. an already-approved record is never selected for caption recovery, even if it somehow still carries a stale caption.claim", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord({ status: "approved", approval: { status: "approved" } }) } }),
  });
  assert.notEqual(result.mode, "recover-caption");
});

test("68. a posting record is never selected for caption recovery", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord({ status: "posting" }) } }),
  });
  assert.notEqual(result.mode, "recover-caption");
});

test("69. a posted record is never selected for caption recovery", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord({ status: "posted" }) } }),
  });
  assert.notEqual(result.mode, "recover-caption");
});

test("70. a record with an active posting claim or publish_attempted is never selected for caption recovery", async () => {
  const r1 = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord({ publishing: { status: "not_posted", claim: { claim_id: "stray" } } }) } }),
  });
  assert.notEqual(r1.mode, "recover-caption");

  const r2 = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({
      stories: { s1: stuckCaptionRecord({ publishing: { status: "not_posted", instagram: { feed: { status: "not_posted", publish_attempted_at: "2026-01-01T00:00:00Z" } } } }) },
    }),
  });
  assert.notEqual(r2.mode, "recover-caption");
});

test("71. a Durable Object read failure (network error) during recovery fails closed — no replay attempted", async () => {
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => { throw new Error("network blip"); },
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "caption_recovery_status_read");
  assert.equal(replayCalled, false);
});

test("72. this script still never references Buffer's post-creation mutation, Buffer's API host, or Meta directly, even after the recovery integration", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName));
  assert.ok(!/api\.buffer\.com/.test(codeOnly));
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly));
});

test("73. this script still never acquires a posting claim, never persists publish_attempted, and never invokes either live publisher, even after the recovery integration", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/claimPosting|publish-buffer-feed|publish-buffer-story|executeBufferFeedPublish|publishViaWorker/.test(codeOnly));
});

// ---------------------------------------------------------------------------
// 2026-09-14 — re-evaluating a previously gate-failed pending record
// ---------------------------------------------------------------------------
// A live run proved a real content-fidelity parser bug could strand a
// fully-prepared, otherwise-correct record at awaiting_approval forever,
// because selection used to permanently filter out any record that failed
// evaluateAutoApprovalGate() at selection time. Fixed by no longer
// pre-filtering by gate outcome (the oldest pending record is ALWAYS the
// approve-only candidate, gate-evaluated fresh every run) plus a bounded,
// single fallthrough so one still-failing record can never block newer
// recover-caption/generate work. No durable "gate version" field was
// added — gate evaluation is pure and free, so re-checking it every run
// costs nothing and automatically benefits from any later code fix.

function ineligibleAwaitingRecord(overrides = {}) {
  return awaitingApprovalRecord({
    story_id: "stale1",
    caption: { status: "ready", text: "Fabricated Player Name is out this week.\n\nSource: ESPN" },
    ...overrides,
  });
}

test("74. a pending record that CURRENTLY fails the gate is still selected as the approve-only candidate (no more pre-filtering by gate outcome)", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { stale1: ineligibleAwaitingRecord() } }),
  });
  assert.equal(result.mode, "approve-only");
  assert.equal(result.story_id, "stale1");
});

test("75. a pending record whose gate NOW passes (e.g. after a parser fix is deployed) is approved automatically on the very next run — no special re-check machinery needed, gate evaluation is simply fresh every time", async () => {
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { ready1: awaitingApprovalRecord({ story_id: "ready1" }) } }),
    live: true,
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, true);
  assert.equal(result.autoApproved, true);
});

test("76. a pending record that STILL fails the gate (with no other candidate anywhere) is left pending after exactly two evaluation attempts — never approved, never mutated", async () => {
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { stale1: ineligibleAwaitingRecord() } }),
    live: true,
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.autoApproved, false);
  assert.equal(result.selected.story_id, "stale1");
});

test("77. a permanently-failing oldest pending record NEVER blocks a newer, otherwise-ready recover-caption candidate in the same run", async () => {
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { stale1: ineligibleAwaitingRecord(), s1: stuckCaptionRecord() } }),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord() }),
    replayCaptionCompletionImpl: async (storyId, claimId) => { replayCalled = true; return { replayed: true }; },
    waitForDurableCommitImpl: async () => ({ committed: true, record: recoveredReadyRecord() }),
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, true, "the second selection attempt must reach the recover-caption candidate");
  assert.equal(result.autoApproved, true);
});

test("78. a permanently-failing oldest pending record NEVER blocks fresh queue generation in the same run", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { stale1: ineligibleAwaitingRecord(), s1: validQueuedRecord() } }),
    live: true,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 1 }; },
  });
  assert.equal(prepCalled, true, "the second selection attempt must reach fresh generation");
});

test("79. the bound is exactly TWO selection attempts, never three — a second failing candidate is never excluded and retried a third time", async () => {
  let selectCallCount = 0;
  const realSelect = selectAutonomousCandidate;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { a: ineligibleAwaitingRecord({ story_id: "a", selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }), b: ineligibleAwaitingRecord({ story_id: "b", selection: { destination: "feed", selected_at: "2026-01-02T00:00:00Z" } }) } }),
    live: true,
    selectCandidateImpl: async (args) => { selectCallCount++; return realSelect(args); },
  });
  assert.equal(selectCallCount, 2);
  assert.equal(result.selected.story_id, "b", "attempt 1 selects the oldest ('a'), fails, and excludes it; attempt 2 selects the next-oldest ('b') and stops there — never a third attempt");
});

test("80. a failed approve-only re-evaluation never regenerates artwork, never regenerates caption, never creates a new caption claim, and never calls the approval endpoint for the failing record", async () => {
  let prepCalled = false, statusCalled = false, replayCalled = false, decideCalled = false;
  await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { stale1: ineligibleAwaitingRecord() } }),
    live: true,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
    getCaptionClaimStatusImpl: async () => { statusCalled = true; return { do_record: null }; },
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: false }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(prepCalled, false);
  assert.equal(statusCalled, false);
  assert.equal(replayCalled, false);
  assert.equal(decideCalled, false);
});

test("81. an actual approval-commit-confirmation FAILURE (not just an ineligible gate) still stops the run immediately, never falling through to a second candidate — a real error must never be masked as 'try someone else'", async () => {
  let selectCallCount = 0;
  const realSelect = selectAutonomousCandidate;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { ready1: awaitingApprovalRecord({ story_id: "ready1" }) } }),
    live: true,
    selectCandidateImpl: async (args) => { selectCallCount++; return realSelect(args); },
    decideApprovalImpl: async () => ({ result: "pending" }),
    waitForApprovalCommitImpl: async () => ({ committed: false, status: "timeout" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "approval_commit_confirmation");
  assert.equal(selectCallCount, 1, "a genuine failure must never trigger a second selection attempt");
});

// ---------------------------------------------------------------------------
// 2026-09-14 workflow semantic-failure fix — determineExitCode()
// ---------------------------------------------------------------------------
// Proven production incident: story_id 03388ac4-924c-48ac-91c1-987016029881
// — codex.exe unavailable on the GitHub Actions runner, generation failed
// 3/3 attempts, the durable post-preparation poll timed out, main()
// correctly returned {ok:false,...}, and the workflow STILL showed green
// because nothing ever read that field. These tests prove every SUCCESS
// case exits 0 and every FAILURE case exits 1, per the exact taxonomy
// requested: no-eligible-candidate, successful prepare/approve, and a
// legitimate gate/eligibility rejection are all SUCCESS; a generator
// failure, an infrastructure error, or a durable-commit timeout are all
// FAILURE.

test("82. SUCCESS — no eligible candidate exits 0", () => {
  assert.equal(determineExitCode({ ok: true, selected: null }), 0);
});

test("83. SUCCESS — a candidate successfully prepared and auto-approved exits 0", () => {
  assert.equal(determineExitCode({ ok: true, autoApproved: true }), 0);
});

test("84. SUCCESS — a legitimate auto-approval-gate rejection (left pending) exits 0", () => {
  assert.equal(determineExitCode({ ok: true, autoApproved: false, gateIssues: ["fidelity:x"] }), 0);
});

test("85. SUCCESS — a legitimate caption-recovery eligibility rejection (not yet safe to replay) exits 0", () => {
  assert.equal(determineExitCode({ ok: true, step: "caption_recovery_eligibility" }), 0);
});

test("86. SUCCESS — a durably-recorded 'failed' generation outcome (properly finalized, not stuck) exits 0", () => {
  assert.equal(determineExitCode({ ok: true, prepared: false, finalStatus: "failed" }), 0);
});

test("87. FAILURE — a post-preparation durable-commit timeout (the exact proven incident) exits 1", () => {
  assert.equal(determineExitCode({ ok: false, step: "post_prepare_durable_poll" }), 1);
});

test("88. FAILURE — an approval-commit-confirmation timeout exits 1", () => {
  assert.equal(determineExitCode({ ok: false, step: "approval_commit_confirmation" }), 1);
});

test("89. FAILURE — a caption-recovery Durable Object read error (infrastructure) exits 1", () => {
  assert.equal(determineExitCode({ ok: false, step: "caption_recovery_status_read" }), 1);
});

test("90. FAILURE — a caption-recovery replay refusal exits 1", () => {
  assert.equal(determineExitCode({ ok: false, step: "caption_recovery_replay" }), 1);
});

test("91. FAILURE — a caption-recovery durable-commit timeout exits 1", () => {
  assert.equal(determineExitCode({ ok: false, step: "caption_recovery_durable_poll" }), 1);
});

test("92. FAILURE — an unexpected null/undefined result (main() itself misbehaved) exits 1, never silently 0", () => {
  assert.equal(determineExitCode(null), 1);
  assert.equal(determineExitCode(undefined), 1);
});

test("93. end-to-end: a real generator-unavailable-style failure (process-one exits nonzero, durable poll times out) produces ok:false through main() itself, which determineExitCode() then turns into exit 1", async () => {
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord() } }),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 1 }),
    waitForDurableCommitImpl: async () => ({ committed: false, status: "timeout" }),
  });
  assert.equal(result.ok, false);
  assert.equal(determineExitCode(result), 1);
});

test("94. a generator-unavailable-style failure calls zero downstream side effects — no approval, no caption-recovery DO read, no replay — matching the exact proven incident (codex.exe missing on a Linux runner)", async () => {
  let decideCalled = false, statusCalled = false, replayCalled = false;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord() } }),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 1 }),
    waitForDurableCommitImpl: async () => ({ committed: false, status: "timeout" }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    getCaptionClaimStatusImpl: async () => { statusCalled = true; return { do_record: null }; },
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: false }; },
  });
  assert.equal(decideCalled, false, "a generator failure must never reach approval");
  assert.equal(statusCalled, false);
  assert.equal(replayCalled, false);
});

// ---------------------------------------------------------------------------
// 2026-09-14 — PRIMARY artwork-completion hands-off recovery
// ---------------------------------------------------------------------------
// The direct sibling of the caption-recovery tests above, for the SAME
// checkout-staleness race hitting artwork-completed instead of
// caption-completed — proven against story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd (a Story-primary completion).

function stuckArtworkRecord(overrides = {}) {
  return {
    story_id: "0cba51db-8c38-436f-ae48-a4af46e9f6bd",
    status: "artwork_requested",
    merged_into: null,
    content_package_version: 2,
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    source_story: { post_headline: "TEST HEADLINE", source_name: "ESPN", source_url: "https://espn.test/x", teams: [], players: [], description: "A description." },
    approval: { status: "pending" },
    claim: { claim_id: "artwork-claim-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" },
    story_artwork: { status: "not_created", image_url: null },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

function completedArtworkDoRecord(overrides = {}) {
  return {
    status: "completed",
    claim_id: "artwork-claim-1",
    processor_id: "p1",
    dispatch_confirmed: true,
    payload: { story_id: "0cba51db-8c38-436f-ae48-a4af46e9f6bd", claim_id: "artwork-claim-1", image_url: "https://example.test/x.png", storage_key: "social-artwork/x.png", width: 1080, height: 1920, mime_type: "image/png", size_bytes: 500000, provider: "deterministic-renderer" },
    ...overrides,
  };
}

function recoveredArtworkReadyRecord(overrides = {}) {
  return {
    ...stuckArtworkRecord(),
    status: "artwork_ready",
    validation: { status: "passed", passed: true, issues: [] },
    story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 1080, height: 1920 },
    ...overrides,
  };
}

test("95. selectAutonomousCandidate recognizes the exact proven stuck PRIMARY-artwork state as a recover-artwork candidate", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
  });
  assert.equal(result.mode, "recover-artwork");
  assert.equal(result.story_id, "s1");
});

test("96. dry run for a recover-artwork candidate never touches the Durable Object, never replays, never polls, never runs process-one.js", async () => {
  let statusCalled = false, replayCalled = false, prepCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: false,
    getArtworkClaimStatusImpl: async () => { statusCalled = true; return { do_record: completedArtworkDoRecord() }; },
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(statusCalled, false, "dry run must never read the Durable Object");
  assert.equal(replayCalled, false);
  assert.equal(prepCalled, false);
  assert.equal(result.dryRun.mode, "recover-artwork");
  assert.match(result.dryRun.would_require, /PRIMARY artwork-completion replay recovery/);
});

test("97. a successful automatic recovery calls getArtworkClaimStatusImpl and replayArtworkCompletionImpl with EXACTLY the story_id and existing claim_id — no image content supplied by the runner", async () => {
  let statusArgs, replayArgs;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async (storyId) => { statusArgs = { storyId }; return { do_record: completedArtworkDoRecord({ claim_id: "artwork-claim-1" }) }; },
    replayArtworkCompletionImpl: async (storyId, claimId) => { replayArgs = { storyId, claimId }; return { replayed: true }; },
    waitForDurableCommitImpl: async () => ({ committed: true, record: { status: "failed" } }),
  });
  assert.equal(statusArgs.storyId, "s1");
  assert.equal(replayArgs.storyId, "s1");
  assert.equal(replayArgs.claimId, "artwork-claim-1");
  assert.equal(Object.keys(replayArgs).length, 2, "replay must be called with exactly (story_id, claim_id) — no image_url, no dimensions, no other content");
  assert.equal(result.finalStatus, "failed");
});

test("98. an eligibility failure (e.g. the DO still shows 'claimed', not 'completed') is a successful no-op — no replay attempted, no regeneration, no approval", async () => {
  let replayCalled = false, prepCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord({ status: "claimed" }) }),
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(result.ok, true, "not-yet-eligible must never turn the workflow red");
  assert.equal(result.step, "artwork_recovery_eligibility");
  assert.equal(replayCalled, false);
  assert.equal(prepCalled, false);
});

test("99. a wrong/stale DO claim_id blocks replay end-to-end through main()", async () => {
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord({ claim_id: "some-other-claim" }) }),
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.step, "artwork_recovery_eligibility");
  assert.ok(result.eligibility.issues.includes("do_claim_id_mismatch"));
  assert.equal(replayCalled, false);
});

test("100. a replay refusal from the Worker fails closed — no approval, no second attempt within this run", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord() }),
    replayArtworkCompletionImpl: async () => ({ replayed: false, reason: "claim_mismatch" }),
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "artwork_recovery_replay");
  assert.equal(prepCalled, false);
});

test("101. a durable-confirmation TIMEOUT after a successful replay dispatch fails closed — no regeneration, no second replay, no approval", async () => {
  let replayCallCount = 0, prepCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord() }),
    replayArtworkCompletionImpl: async () => { replayCallCount++; return { replayed: true }; },
    waitForDurableCommitImpl: async () => ({ committed: false, status: "timeout" }),
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "artwork_recovery_durable_poll");
  assert.equal(replayCallCount, 1, "a poll timeout must never trigger a second replay attempt within the same run");
  assert.equal(prepCalled, false, "artwork must never be regenerated after a durable-poll timeout");
});

test("102. a successful replay that durably confirms artwork_ready delegates to the EXISTING generate pipeline (process-one.js), never regenerating artwork itself", async () => {
  let prepCallArgs;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord() }),
    replayArtworkCompletionImpl: async () => ({ replayed: true }),
    waitForDurableCommitImpl: async (fetchState, storyId, predicate) => {
      // First call: the recovery poll waiting for artwork_ready. Second
      // call (inside runGeneratePipeline): the post-preparation poll.
      if (predicate({ status: "artwork_ready" })) return { committed: true, record: recoveredArtworkReadyRecord({ story_id: "s1" }) };
      return { committed: true, record: awaitingApprovalRecord({ story_id: "s1" }) };
    },
    runPreparationImpl: async (args) => { prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(prepCallArgs.storyId, "s1", "must delegate to the existing process-one.js pipeline, which itself performs the destination-aware, no-regeneration recovery routing");
  assert.equal(result.autoApproved, true);
});

test("103. a replay that durably confirms a genuinely committed 'failed' status (not a timeout) is a clean, non-error outcome — never approved, never regenerated", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord() }),
    replayArtworkCompletionImpl: async () => ({ replayed: true }),
    waitForDurableCommitImpl: async () => ({ committed: true, record: { status: "failed" } }),
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.prepared, false);
  assert.equal(result.finalStatus, "failed");
  assert.equal(prepCalled, false);
});

test("104. a Durable Object read failure (network error) during artwork recovery fails closed — no replay attempted", async () => {
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    getArtworkClaimStatusImpl: async () => { throw new Error("network blip"); },
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "artwork_recovery_status_read");
  assert.equal(replayCalled, false);
});

test("105. the NORMAL happy path (fresh queue generation) never touches the artwork-recovery machinery at all", async () => {
  let statusCalled = false, replayCalled = false;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "approved" }),
    getArtworkClaimStatusImpl: async () => { statusCalled = true; return { do_record: null }; },
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: false }; },
  });
  assert.equal(statusCalled, false, "a normal successful generation run must never call the artwork-recovery DO read");
  assert.equal(replayCalled, false);
});

test("106. once artwork becomes durably ready (artwork_ready), a duplicate runner invocation no longer selects recover-artwork for the same story — idempotent, never a second replay", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: recoveredArtworkReadyRecord({ story_id: "s1" }) } }),
  });
  assert.notEqual(result.mode, "recover-artwork");
});

test("107. an already-approved record is never selected for artwork recovery", async () => {
  const result = await selectAutonomousCandidate({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ status: "approved", approval: { status: "approved" } }) } }),
  });
  assert.notEqual(result.mode, "recover-artwork");
});

test("108. a posting or posted record is never selected for artwork recovery", async () => {
  const r1 = await selectAutonomousCandidate({ fetchQueue: async () => [], fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ status: "posting" }) } }) });
  assert.notEqual(r1.mode, "recover-artwork");
  const r2 = await selectAutonomousCandidate({ fetchQueue: async () => [], fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ status: "posted" }) } }) });
  assert.notEqual(r2.mode, "recover-artwork");
});

test("109. this script still never acquires a posting claim, never calls Buffer, and never invokes either live publisher, even after the artwork-recovery integration", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName));
  assert.ok(!/api\.buffer\.com/.test(codeOnly));
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly));
  assert.ok(!/claimPosting|publish-buffer-feed|publish-buffer-story|executeBufferFeedPublish|publishViaWorker/.test(codeOnly));
});

test("110. a permanently-ineligible recover-artwork candidate (e.g. a pre-cloud-renderer failure whose DO status is 'failed', not 'completed') NEVER blocks a newer, genuinely-recoverable recover-artwork candidate in the same run — the exact real scenario found auditing story_ids 03388ac4-924c-48ac-91c1-987016029881 and 0cba51db-8c38-436f-ae48-a4af46e9f6bd", async () => {
  const olderIneligible = stuckArtworkRecord({
    story_id: "older-ineligible",
    claim: { claim_id: "old-claim-1" },
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
  });
  const newerRecoverable = stuckArtworkRecord({
    story_id: "newer-recoverable",
    claim: { claim_id: "new-claim-1" },
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-02T00:00:00Z" },
  });
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { "older-ineligible": olderIneligible, "newer-recoverable": newerRecoverable } }),
    live: true,
    getArtworkClaimStatusImpl: async (storyId) =>
      storyId === "older-ineligible" ? { do_record: completedArtworkDoRecord({ claim_id: "old-claim-1", status: "failed" }) } : { do_record: completedArtworkDoRecord({ claim_id: "new-claim-1" }) },
    replayArtworkCompletionImpl: async (storyId, claimId) => { replayCalled = { storyId, claimId }; return { replayed: true }; },
    waitForDurableCommitImpl: async () => ({ committed: true, record: { status: "failed" } }),
  });
  assert.ok(replayCalled, "the second selection attempt must reach the genuinely-recoverable candidate");
  assert.equal(replayCalled.storyId, "newer-recoverable");
  assert.equal(result.finalStatus, "failed");
});

// ---------------------------------------------------------------------------
// 2026-09-15 restoration guard — GitHub Actions must never attempt fresh
// artwork generation (Priority 4), which requires the restored local Codex
// path (process-one.js). Every other selection mode either never touches
// artwork generation or only replays an ALREADY-durably-completed asset.
// ---------------------------------------------------------------------------

test("111. GitHub environment + a fresh 'generate' candidate: the run exits ok:true without ever spawning process-one.js, without claiming, and without any state mutation", async () => {
  let prepCalled = false;
  let approvalCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: async () => ({ stories: { s1: validQueuedRecord({ story_id: "s1" }) } }),
    live: true,
    isCloudEnvironment: true,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { approvalCalled = true; return { result: "approved" }; },
  });
  assert.equal(result.ok, true, "must exit successfully — never a false failure");
  assert.equal(result.step, "generate_requires_local_runner");
  assert.equal(result.selected.story_id, "s1");
  assert.equal(prepCalled, false, "process-one.js (and therefore runCodex()) must never be spawned on a GitHub runner");
  assert.equal(approvalCalled, false, "nothing downstream of generation may run either, since generation never happened");
});

test("112. the candidate skipped on GitHub remains exactly as it was — no claim consumed, no exclude-and-retry burns it, so the SAME candidate is still selectable next time (by GitHub again, harmlessly, or by the Windows runner)", async () => {
  const fetchQueue = async () => [queueEntry("s1")];
  const fetchState = async () => ({ stories: { s1: validQueuedRecord({ story_id: "s1" }) } });
  const firstRun = await main({ fetchQueue, fetchState, live: true, isCloudEnvironment: true, runPreparationImpl: async () => ({ exitCode: 0 }) });
  const secondRun = await main({ fetchQueue, fetchState, live: true, isCloudEnvironment: true, runPreparationImpl: async () => ({ exitCode: 0 }) });
  assert.equal(firstRun.selected.story_id, "s1");
  assert.equal(secondRun.selected.story_id, "s1", "the exact same untouched candidate must still be selected — nothing about it was consumed or excluded");
});

test("113. GitHub caption-only recovery is completely unaffected by the cloud guard — it never reaches the generate dispatch at all", async () => {
  const s1 = { story_id: "s1", status: "artwork_ready", selection: { destination: "feed", slot_id: "feed:test" }, source_story: validQueuedRecord().source_story, approval: { status: "pending" }, publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } }, caption: { status: "generating", claim: { claim_id: "c1" } } };
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1 } }),
    live: true,
    isCloudEnvironment: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: { status: "completed", claim_id: "c1", payload: { text: "final caption" } } }),
    replayCaptionCompletionImpl: async () => ({ replayed: true }),
    waitForDurableCommitImpl: async () => ({ committed: true, record: { status: "awaiting_approval", caption: { status: "ready", text: "final caption", claim: { claim_id: "c1" } } } }),
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.step, "generate_requires_local_runner");
});

test("114. GitHub approve-only processing is completely unaffected by the cloud guard", async () => {
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: awaitingApprovalRecord({ story_id: "s1" }) } }),
    live: true,
    isCloudEnvironment: true,
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.autoApproved, true);
});

test("115. GitHub recover-artwork: an ALREADY-durably-completed replay still delegates to the generate pipeline (process-one.js) even with isCloudEnvironment:true — that continuation is caption-only in practice (never touches Codex), so the Priority-4 guard correctly does not apply to it", async () => {
  let prepCallArgs;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: stuckArtworkRecord({ story_id: "s1" }) } }),
    live: true,
    isCloudEnvironment: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord() }),
    replayArtworkCompletionImpl: async () => ({ replayed: true }),
    waitForDurableCommitImpl: async (fetchState, storyId, predicate) => {
      if (predicate({ status: "artwork_ready" })) return { committed: true, record: recoveredArtworkReadyRecord({ story_id: "s1" }) };
      return { committed: true, record: awaitingApprovalRecord({ story_id: "s1" }) };
    },
    runPreparationImpl: async (args) => { prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(prepCallArgs.storyId, "s1", "the recovery continuation must still reach process-one.js — it never performs fresh Codex generation, only destination-aware caption-only routing");
  assert.equal(result.autoApproved, true);
});

test("116. Windows/local execution (isCloudEnvironment:false, the real production default off GitHub Actions) still reaches the restored generate pipeline normally for a fresh candidate", async () => {
  let prepCallArgs;
  await main({
    fetchQueue: async () => [queueEntry("s1")],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    isCloudEnvironment: false,
    runPreparationImpl: async (args) => { prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(prepCallArgs.storyId, "s1", "off GitHub Actions, fresh generation must be dispatched exactly as before this guard existed");
});

test("117. the cloud-skip result maps to a successful (0) exit code via the existing determineExitCode() — a GitHub run leaving artwork for the Windows runner must never appear as a red build", () => {
  const outcome = determineExitCode({ ok: true, step: "generate_requires_local_runner", selected: { story_id: "s1" } });
  assert.equal(outcome, 0);
});

// ---------------------------------------------------------------------------
// 118-124. 2026-09-17 zombie-recovery fix — a recover-artwork/recover-caption
// candidate whose Durable Object claim has already come back authoritatively
// "failed" must never be able to permanently occupy a selection attempt and
// starve Priority 4, while a genuinely still-in-progress or genuinely
// recoverable candidate must behave exactly as before.
// ---------------------------------------------------------------------------

test("118. a permanently failed (DO status: failed) artwork-recovery candidate does not block Priority-4 generation reaching a fresh candidate", async () => {
  const zombie = stuckArtworkRecord({ story_id: "zombie-artwork" });
  const freshQueued = validQueuedRecord({ story_id: "fresh1" });
  const freshApproved = awaitingApprovalRecord({ story_id: "fresh1", selection: freshQueued.selection });
  let prepStarted = false;
  let prepCallArgs, replayCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("fresh1")],
    fetchState: async () => ({ stories: { "zombie-artwork": zombie, fresh1: prepStarted ? freshApproved : freshQueued } }),
    live: true,
    isCloudEnvironment: false,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord({ status: "failed" }) }),
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async (args) => { prepStarted = true; prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, false, "a permanently-failed recovery must never be replayed");
  assert.equal(prepCallArgs?.storyId, "fresh1", "Priority 4 must be reached and dispatched for the fresh candidate despite a permanently-dead recovery candidate outranking it");
  assert.equal(result.autoApproved, true);
});

test("118b. 2026-09-17 (part 2) real incident (story 994dfb71, the 8:00 PM Story slot): a caption whose Durable Object claim genuinely FAILED, but whose Stage 3A selection is still FRESH (not expired), is retried with a brand-new caption attempt via the existing caption-only recovery path — never treated as a permanent zombie, never replayed", async () => {
  const freshFailedCaption = stuckCaptionRecord({
    story_id: "s1",
    // A selection made "now" (fresh) rather than the fixture's own stale
    // 2026-01-01 default — mirrors the real 8:00 PM slot's own timing.
    // Destination stays "feed", matching this fixture's own artwork shape
    // (it has no story_artwork field) — the destination itself is not
    // what this test is about.
    selection: { destination: "feed", slot_id: "feed:test", selected_at: new Date().toISOString(), window_start: new Date(Date.now() - 60 * 60 * 1000).toISOString(), window_end: new Date().toISOString() },
  });
  const recoveredReady = { ...freshFailedCaption, status: "awaiting_approval", caption: { status: "ready", text: "Real caption.\n\nSource: ESPN" } };
  let prepStarted = false;
  let prepCallArgs;
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => ({ stories: { s1: prepStarted ? recoveredReady : freshFailedCaption } }),
    live: true,
    isCloudEnvironment: false,
    getCaptionClaimStatusImpl: async () => ({ do_record: { status: "failed", claim_id: "claim-recover-1", processor_id: "p1" } }),
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async (args) => { prepStarted = true; prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, false, "a genuinely FAILED claim has nothing to replay — this must never call replayCaptionCompletion");
  assert.equal(prepCallArgs?.storyId, "s1", "the fresh, still-relevant record must be retried via the existing caption-only recovery path (process-one.js --story-id), exactly like a manual invocation would");
  assert.equal(result.autoApproved, true);
});

test("119. a permanently failed (DO status: failed) caption-recovery candidate does not block Priority-4 generation reaching a fresh candidate", async () => {
  const zombie = stuckCaptionRecord({ story_id: "zombie-caption", selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z", window_end: "2026-01-01T00:00:00Z" } });
  const freshQueued = validQueuedRecord({ story_id: "fresh1" });
  const freshApproved = awaitingApprovalRecord({ story_id: "fresh1", selection: freshQueued.selection });
  let prepStarted = false;
  let prepCallArgs, replayCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry("fresh1")],
    fetchState: async () => ({ stories: { "zombie-caption": zombie, fresh1: prepStarted ? freshApproved : freshQueued } }),
    live: true,
    isCloudEnvironment: false,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord({ status: "failed" }) }),
    replayCaptionCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async (args) => { prepStarted = true; prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, false, "a permanently-failed recovery must never be replayed");
  assert.equal(prepCallArgs?.storyId, "fresh1", "Priority 4 must be reached and dispatched for the fresh candidate despite a permanently-dead recovery candidate outranking it");
  assert.equal(result.autoApproved, true);
});

test("120. a genuinely COMPLETED artwork recovery still replays and approves exactly as before this fix", async () => {
  let replayCalled = false;
  let prepStarted = false;
  const stuckRecord = stuckArtworkRecord({ story_id: "s1", source_story: { ...stuckArtworkRecord().source_story, base_image_url: "https://example.test/base.jpg" } });
  const readyRecord = recoveredArtworkReadyRecord({ story_id: "s1", source_story: stuckRecord.source_story });
  const approvedRecord = { ...readyRecord, status: "awaiting_approval", caption: { status: "ready", text: "Recovered artwork caption.\n\nSource: ESPN" } };
  const fetchState = async () => {
    if (!prepStarted) return { stories: { s1: readyRecord } };
    return { stories: { s1: approvedRecord } };
  };
  const result = await main({
    fetchQueue: async () => [],
    fetchState: async () => (replayCalled ? fetchState() : { stories: { s1: stuckRecord } }),
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord() }),
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async () => { prepStarted = true; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, true, "a genuinely completed recovery must still be replayed — the new zombie check must not interfere");
  assert.equal(result.autoApproved, true);
});

test("121. a genuinely COMPLETED caption recovery still replays and approves exactly as before this fix", async () => {
  let replayCalled = false;
  const result = await main({
    fetchQueue: async () => [],
    fetchState: statefulFetchStateForRecovery(recoveredReadyRecord()),
    live: true,
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord() }),
    replayCaptionCompletionImpl: async (storyId, claimId) => { replayCalled = true; return { replayed: true }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, true, "a genuinely completed recovery must still be replayed — the new zombie check must not interfere");
  assert.equal(result.autoApproved, true);
});

test("122. existing priority ordering is unchanged: a genuinely recoverable (DO status: completed) record still outranks a fresh Priority-4 candidate", async () => {
  const fresh = validQueuedRecord({ story_id: "fresh1" });
  let prepCallArgs, replayCalled = false, prepStarted = false;
  const readyRecord = recoveredArtworkReadyRecord({ story_id: "recoverable-artwork" });
  const approvedRecord = { ...readyRecord, status: "awaiting_approval", caption: { status: "ready", text: "Recovered artwork caption.\n\nSource: ESPN" } };
  await main({
    fetchQueue: async () => [queueEntry("fresh1")],
    fetchState: async () => {
      if (!replayCalled) return { stories: { "recoverable-artwork": stuckArtworkRecord({ story_id: "recoverable-artwork" }), fresh1: fresh } };
      return { stories: { "recoverable-artwork": prepStarted ? approvedRecord : readyRecord, fresh1: fresh } };
    },
    live: true,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord({ claim_id: "artwork-claim-1" }) }),
    replayArtworkCompletionImpl: async () => { replayCalled = true; return { replayed: true }; },
    runPreparationImpl: async (args) => { prepStarted = true; prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(replayCalled, true, "a genuinely recoverable Priority-2 candidate must still win over Priority 4");
  // A successful recovery legitimately continues into caption-only prep for
  // the RECOVERED story itself (process-one.js's own recovery routing,
  // never fresh Codex generation) — the point being verified here is that
  // Priority 4's fresh1 is never the one selected/prepared while this
  // genuinely recoverable candidate exists.
  assert.equal(prepCallArgs?.storyId, "recoverable-artwork", "Priority 4's fresh1 must not be reached while a genuinely recoverable higher-priority candidate exists");
});

test("123. BOTH a permanently failed artwork-recovery AND a permanently failed caption-recovery candidate together still do not block Priority 4 — the exact real 2026-09-17 incident", async () => {
  const artworkZombie = stuckArtworkRecord({ story_id: "zombie-artwork" });
  const captionZombie = stuckCaptionRecord({ story_id: "zombie-caption", selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z", window_end: "2026-01-01T00:00:00Z" } });
  const freshQueued = validQueuedRecord({ story_id: "fresh1" });
  const freshApproved = awaitingApprovalRecord({ story_id: "fresh1", selection: freshQueued.selection });
  let prepStarted = false;
  let prepCallArgs;
  const result = await main({
    fetchQueue: async () => [queueEntry("fresh1")],
    fetchState: async () => ({
      stories: { "zombie-artwork": artworkZombie, "zombie-caption": captionZombie, fresh1: prepStarted ? freshApproved : freshQueued },
    }),
    live: true,
    isCloudEnvironment: false,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord({ status: "failed" }) }),
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord({ status: "failed" }) }),
    replayArtworkCompletionImpl: async () => ({ replayed: true }),
    replayCaptionCompletionImpl: async () => ({ replayed: true }),
    runPreparationImpl: async (args) => { prepStarted = true; prepCallArgs = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(prepCallArgs?.storyId, "fresh1", "two permanently-dead recovery records together must still not exhaust the fixed 2-attempt budget before reaching Priority 4");
  assert.equal(result.autoApproved, true);
});

test("124. resolving two zombie recovery candidates plus a fresh candidate never double-generates or double-approves — exactly one prepare and one approval call occur, and neither zombie is ever replayed", async () => {
  const artworkZombie = stuckArtworkRecord({ story_id: "zombie-artwork" });
  const captionZombie = stuckCaptionRecord({ story_id: "zombie-caption", selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z", window_end: "2026-01-01T00:00:00Z" } });
  const freshQueued = validQueuedRecord({ story_id: "fresh1" });
  const freshApproved = awaitingApprovalRecord({ story_id: "fresh1", selection: freshQueued.selection });
  let prepStarted = false;
  let prepCallCount = 0, decideCallCount = 0, artworkReplayCount = 0, captionReplayCount = 0;
  await main({
    fetchQueue: async () => [queueEntry("fresh1")],
    fetchState: async () => ({
      stories: { "zombie-artwork": artworkZombie, "zombie-caption": captionZombie, fresh1: prepStarted ? freshApproved : freshQueued },
    }),
    live: true,
    isCloudEnvironment: false,
    getArtworkClaimStatusImpl: async () => ({ do_record: completedArtworkDoRecord({ status: "failed" }) }),
    getCaptionClaimStatusImpl: async () => ({ do_record: completedDoRecord({ status: "failed" }) }),
    replayArtworkCompletionImpl: async () => { artworkReplayCount++; return { replayed: true }; },
    replayCaptionCompletionImpl: async () => { captionReplayCount++; return { replayed: true }; },
    runPreparationImpl: async () => { prepStarted = true; prepCallCount++; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCallCount++; return { result: "approved" }; },
  });
  assert.equal(prepCallCount, 1, "exactly one story must be prepared, never zero and never more than one");
  assert.equal(decideCallCount, 1, "exactly one approval decision must be made");
  assert.equal(artworkReplayCount, 0, "a permanently-dead artwork recovery must never be replayed");
  assert.equal(captionReplayCount, 0, "a permanently-dead caption recovery must never be replayed");
});

// ---------------------------------------------------------------------------
// 2026-09-17 preflight investigation (no new tests needed): confirmed that
// Priority 1 does NOT have the same zombie-starvation class of bug as
// Priority 2/3. selectAutonomousCandidate()'s own Priority-1 filter already
// requires evaluateStaticAutonomousEligibility(record).eligible, which
// itself already excludes no_selection / expired-selection records before
// they can ever become "the" approve-only candidate — see test 74 above
// (existing coverage) and this file's own auto-prepare-social.js header
// note near isPermanentlyFailedRecovery for the live-data verification.
// ---------------------------------------------------------------------------

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
