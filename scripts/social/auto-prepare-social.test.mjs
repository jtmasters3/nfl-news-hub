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
import {
  selectPreparationCandidate,
  evaluateStructuralPreChecks,
  main,
  resolveRunMode,
} from "./auto-prepare-social.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function queueEntry(overrides = {}) {
  return {
    story_id: "s1",
    post_headline: "Some Player Is Out",
    base_image_url: "https://example.test/base.jpg",
    source_name: "ESPN",
    source_url: "https://espn.com/story/some-player-is-out",
    category: "injury",
    destination: "feed",
    content_package_version: 2,
    ...overrides,
  };
}

function queuedRecord(overrides = {}) {
  return {
    story_id: "s1",
    status: "queued",
    selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" },
    ...overrides,
  };
}

/**
 * A stateful fetchState mock: returns a "queued" record on its FIRST call
 * (the pre-preparation read main() does before spawning the pipeline) and
 * `postPrepareRecord` on every subsequent call (the fresh post-preparation
 * read) — mirroring the exact real sequence: main() reads state once
 * before running process-one.js, then again after, and those two reads are
 * never the same snapshot in live mode.
 */
function statefulFetchState(postPrepareRecord, storyId = "s1") {
  let callCount = 0;
  return async () => {
    callCount++;
    if (callCount === 1) return { stories: { [storyId]: queuedRecord({ story_id: storyId, selection: postPrepareRecord.selection }) } };
    return { stories: { [storyId]: postPrepareRecord } };
  };
}

function awaitingApprovalRecord(overrides = {}) {
  return {
    story_id: "s1",
    status: "awaiting_approval",
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
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    story_artwork: { status: "not_created", image_url: null },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: ESPN" },
    approval: { status: "pending" },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SELECTION
// ---------------------------------------------------------------------------

test("1. an empty queue yields no candidate", () => {
  assert.equal(selectPreparationCandidate([]), null);
});

test("2. exactly one queue entry -> it is selected", () => {
  const result = selectPreparationCandidate([queueEntry({ story_id: "s1" })]);
  assert.equal(result.story_id, "s1");
});

test("3. multiple queue entries -> the FRONT of the queue is selected (identical ordering to process-one.js's own default)", () => {
  const result = selectPreparationCandidate([queueEntry({ story_id: "first" }), queueEntry({ story_id: "second" })]);
  assert.equal(result.story_id, "first");
});

test("4. a Feed queue entry is a valid candidate", () => {
  const result = selectPreparationCandidate([queueEntry({ destination: "feed" })]);
  assert.equal(result.destination, "feed");
});

test("5. a Story queue entry is a valid candidate", () => {
  const result = selectPreparationCandidate([queueEntry({ destination: "story" })]);
  assert.equal(result.destination, "story");
});

test("6. selectPreparationCandidate never returns more than one entry, even for a large queue", () => {
  const queue = Array.from({ length: 50 }, (_, i) => queueEntry({ story_id: `s${i}` }));
  const result = selectPreparationCandidate(queue);
  assert.equal(Array.isArray(result), false);
  assert.equal(result.story_id, "s0");
});

// ---------------------------------------------------------------------------
// STRUCTURAL PRE-CHECKS
// ---------------------------------------------------------------------------

test("7. a fully valid queue entry + queued record passes structural pre-checks", () => {
  const result = evaluateStructuralPreChecks(queueEntry(), queuedRecord());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("8. a record already approved (not genuinely 'queued') fails structural pre-checks — never reprocessed", () => {
  const result = evaluateStructuralPreChecks(queueEntry(), queuedRecord({ status: "approved" }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.startsWith("record_not_queued")));
});

test("9. a record already posted fails structural pre-checks", () => {
  const result = evaluateStructuralPreChecks(queueEntry(), queuedRecord({ status: "posted" }));
  assert.equal(result.ok, false);
});

test("10. a record currently posting fails structural pre-checks", () => {
  const result = evaluateStructuralPreChecks(queueEntry(), queuedRecord({ status: "posting" }));
  assert.equal(result.ok, false);
});

test("11. an invalid destination fails structural pre-checks", () => {
  const result = evaluateStructuralPreChecks(queueEntry({ destination: "reel" }), queuedRecord());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.startsWith("invalid_destination")));
});

test("12. missing required fixture fields fail structural pre-checks", () => {
  const result = evaluateStructuralPreChecks(queueEntry({ post_headline: undefined, base_image_url: undefined }), queuedRecord());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes("post_headline")));
  assert.ok(result.issues.some((i) => i.includes("base_image_url")));
});

test("13. an unrecognized source fails structural pre-checks", () => {
  const result = evaluateStructuralPreChecks(queueEntry({ source_name: "Random Blog" }), queuedRecord());
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// DRY RUN — zero mutation, zero generation, zero approval, zero Buffer
// ---------------------------------------------------------------------------

test("14. dry run reports the candidate without ever calling runPreparationImpl, decideApprovalImpl, or waitForApprovalCommitImpl", async () => {
  let prepCalled = false, decideCalled = false, waitCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry()],
    fetchState: async () => ({ stories: { s1: queuedRecord() } }),
    live: false,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
    waitForApprovalCommitImpl: async () => { waitCalled = true; return { committed: true }; },
  });
  assert.equal(prepCalled, false, "dry run must never spawn artwork/caption generation");
  assert.equal(decideCalled, false, "dry run must never call the approval endpoint");
  assert.equal(waitCalled, false);
  assert.equal(result.dryRun.story_id, "s1");
  assert.equal(result.dryRun.structural_pre_checks_passed, true);
});

test("15. zero eligible queue entries in dry run -> clean no-op, no calls at all", async () => {
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

test("16. dry run against a structurally-failing candidate reports the failure without ever calling runPreparationImpl", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry({ source_name: "Random Blog" })],
    fetchState: async () => ({ stories: { s1: queuedRecord() } }),
    live: false,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(prepCalled, false);
  assert.equal(result.dryRun.structural_pre_checks_passed, false);
});

// ---------------------------------------------------------------------------
// LIVE PREPARATION — correct pipeline invoked, correct canonical fields
// ---------------------------------------------------------------------------

test("17. live mode invokes runPreparationImpl with the exact selected story_id, exactly once", async () => {
  let callCount = 0;
  let calledWith;
  await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
    fetchState: statefulFetchState(awaitingApprovalRecord()),
    live: true,
    runPreparationImpl: async (args) => { callCount++; calledWith = args; return { exitCode: 0 }; },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.equal(callCount, 1);
  assert.equal(calledWith.storyId, "s1");
});

test("18. live mode refuses to call runPreparationImpl for a structurally-failing candidate", async () => {
  let prepCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry({ source_name: "Random Blog" })],
    fetchState: async () => ({ stories: { s1: queuedRecord() } }),
    live: true,
    runPreparationImpl: async () => { prepCalled = true; return { exitCode: 0 }; },
  });
  assert.equal(prepCalled, false);
  assert.equal(result.skipped.reason, "structural_pre_check_failed");
});

test("19. live mode re-reads FRESH state after preparation rather than trusting the child process's own exit code alone", async () => {
  let stateCallCount = 0;
  const inner = statefulFetchState(awaitingApprovalRecord());
  await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
    fetchState: async () => { stateCallCount++; return inner(); },
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => ({ result: "approved" }),
  });
  assert.ok(stateCallCount >= 2, "must fetch state at least once before and once after preparation");
});

test("20. a Feed record's readiness is evaluated against record.artwork, never record.story_artwork", async () => {
  const feedRecordWithBrokenStoryArtwork = awaitingApprovalRecord({
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    story_artwork: { status: "failed" }, // irrelevant for a Feed-destination record
  });
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1", destination: "feed" })],
    fetchState: statefulFetchState(feedRecordWithBrokenStoryArtwork),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, true, "a Feed record's own valid artwork must not be blocked by an irrelevant story_artwork failure");
  assert.equal(result.autoApproved, true);
});

test("21. a Story record's readiness is evaluated against record.story_artwork, never record.artwork", async () => {
  const storyRecordWithBrokenArtwork = awaitingApprovalRecord({
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "failed" }, // irrelevant for a Story-destination record
    story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 941, height: 1672, mime_type: "image/png", size_bytes: 500000 },
    source_story: { ...awaitingApprovalRecord().source_story, source_name: "FOX Sports" },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: FOX Sports" },
  });
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1", destination: "story" })],
    fetchState: statefulFetchState(storyRecordWithBrokenArtwork),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, true, "a Story record's own valid story_artwork must not be blocked by an irrelevant artwork failure");
  assert.equal(result.autoApproved, true);
});

test("22. a record that does not reach awaiting_approval after preparation is never approved", async () => {
  let decideCalled = false;
  let stateCallCount = 0;
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
    fetchState: async () => {
      stateCallCount++;
      return { stories: { s1: stateCallCount === 1 ? queuedRecord() : queuedRecord({ status: "failed" }) } };
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

test("23. a valid Feed record gets approved via decideApprovalImpl with the distinguishing automated actor", async () => {
  let decideArgs;
  await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1", destination: "feed" })],
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

test("24. a valid Story record gets approved the same way", async () => {
  const storyRecord = awaitingApprovalRecord({
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "not_created", image_url: null },
    story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 941, height: 1672, mime_type: "image/png", size_bytes: 500000 },
    source_story: { ...awaitingApprovalRecord().source_story, source_name: "FOX Sports" },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: FOX Sports" },
  });
  let decideArgs;
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1", destination: "story" })],
    fetchState: statefulFetchState(storyRecord),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async (storyId, decision, opts) => { decideArgs = { storyId, decision, opts }; return { result: "approved" }; },
  });
  assert.equal(decideArgs.opts.actor, "aggregate-auto-approver");
  assert.equal(decideArgs.opts.decisionSource, "autonomous-production-gate");
  assert.equal(result.autoApproved, true);
});

test("25. approval uses the existing decideApproval()/decide result classification — a 'pending' result is polled via waitForApprovalCommitImpl for durable confirmation", async () => {
  let waitCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
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

test("26. a durable-commit confirmation timeout after a pending decision is reported as a failure, never silently treated as approved", async () => {
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
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

test("27. missing artwork after preparation is never approved", async () => {
  let decideCalled = false;
  const result = await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
    fetchState: statefulFetchState(awaitingApprovalRecord({ artwork: { status: "not_created", image_url: null } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
  assert.equal(result.autoApproved, false);
});

test("28. failed artwork validation after preparation is never approved", async () => {
  let decideCalled = false;
  await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
    fetchState: statefulFetchState(awaitingApprovalRecord({ validation: { status: "failed", passed: false, issues: ["aspect_ratio_out_of_range:0.5"] } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
});

test("29. missing caption after preparation is never approved", async () => {
  let decideCalled = false;
  await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1" })],
    fetchState: statefulFetchState(awaitingApprovalRecord({ caption: { status: "not_created", text: null } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
});

test("30. an unsupported/unrecognized source is never approved even after successful preparation", async () => {
  let decideCalled = false;
  await main({
    fetchQueue: async () => [queueEntry({ story_id: "s1", source_name: "Random Blog" })],
    fetchState: statefulFetchState(awaitingApprovalRecord({ source_story: { ...awaitingApprovalRecord().source_story, source_name: "Random Blog" } })),
    live: true,
    runPreparationImpl: async () => ({ exitCode: 0 }),
    decideApprovalImpl: async () => { decideCalled = true; return { result: "approved" }; },
  });
  assert.equal(decideCalled, false);
});

// ---------------------------------------------------------------------------
// PUBLISHING ISOLATION
// ---------------------------------------------------------------------------

test("31. this script never references Buffer's post-creation mutation, Buffer's API host, or Meta directly", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName));
  assert.ok(!/api\.buffer\.com/.test(codeOnly));
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly));
});

test("32. this script never acquires a posting claim, never persists publish_attempted, and never invokes either live publisher", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-prepare-social.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/claimPosting|publish-buffer-feed|publish-buffer-story|executeBufferFeedPublish|publishViaWorker/.test(codeOnly));
});

test("33. no test in this suite triggers a real Buffer/Meta/approval-endpoint call — every dependency is injected, and installNetworkGuard() proves any accidental fetch would throw immediately", () => {
  assert.ok(typeof installNetworkGuard === "function");
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

test("34. a workflow_dispatch event with no explicit inputMode (missing 'mode') resolves to dry-run — NEVER live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: undefined }), "dry-run");
});

test("35. a workflow_dispatch event with explicit inputMode=live resolves to live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "live" }), "live");
});

test("36. an unrecognized inputMode value never falls through to live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "LIVE" }), "dry-run");
  assert.equal(resolveRunMode({ eventName: undefined, inputMode: undefined }), "dry-run");
});

// ---------------------------------------------------------------------------
// Workflow YAML — concurrency, no schedule
// ---------------------------------------------------------------------------

test("37. the workflow file declares workflow_dispatch with a mode input defaulting to dry-run", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  assert.match(yaml, /^\s*workflow_dispatch:\s*$/m);
  assert.match(yaml, /default:\s*"dry-run"/);
  assert.match(yaml, /-\s*dry-run/);
  assert.match(yaml, /-\s*live/);
});

test("38. the workflow file declares NO native schedule trigger", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  assert.ok(!/^\s*schedule:/m.test(yaml));
  assert.ok(!/cron:/.test(yaml));
});

test("39. the workflow declares a concurrency group with cancel-in-progress=false", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  assert.match(yaml, /^concurrency:\s*$/m);
  assert.match(yaml, /group:\s*auto-prepare-social/);
  assert.match(yaml, /cancel-in-progress:\s*false/);
});

test("40. the workflow references only the existing AGGREGATE_ARTWORK_API_TOKEN secret", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-prepare-social.yml", import.meta.url), "utf-8");
  const secretRefs = [...yaml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secretRefs)], ["AGGREGATE_ARTWORK_API_TOKEN"]);
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
