#!/usr/bin/env node
// Tests for automatic approved-Feed publishing selection + wiring. Every
// dependency (fetchState, fetchImpl, runPreflightImpl, runLiveImpl) is
// explicitly injected — this suite makes no real network call of any kind,
// acquires no real posting claim, dispatches no real GitHub event, and
// calls neither Buffer nor Meta. installNetworkGuard() additionally makes
// any accidental use of the real globalThis.fetch throw immediately. Run
// with: node scripts/social/auto-publish-approved-feed.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "../social-worker/lib/_networkGuard.mjs";
import { selectEligibleStory, main } from "./auto-publish-approved-feed.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function eligibleFeedRecord(overrides = {}) {
  return {
    status: "approved",
    approval: { status: "approved" },
    selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" },
    publishing: { status: "not_posted" },
    artwork: { status: "created", image_url: "https://example.test/x.png" },
    caption: { status: "ready", text: "Headline.\n\nSource: Test" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1-3, 19-20. selection
// ---------------------------------------------------------------------------

test("1. zero eligible stories -> selectEligibleStory returns null", () => {
  const state = { stories: {} };
  assert.equal(selectEligibleStory(state), null);
});

test("2. exactly one eligible story -> it is selected", () => {
  const state = { stories: { s1: eligibleFeedRecord() } };
  const result = selectEligibleStory(state);
  assert.equal(result.story_id, "s1");
});

test("3. multiple eligible stories -> the OLDEST by selection.selected_at is deterministically chosen", () => {
  const state = {
    stories: {
      newer: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-02T00:00:00Z" } }),
      older: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }),
      newest: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-03T00:00:00Z" } }),
    },
  };
  const result = selectEligibleStory(state);
  assert.equal(result.story_id, "older", "the story that has been waiting longest must be selected");
});

test("3b. a tied/missing selected_at falls back to story_id as a final deterministic tiebreak — never random, never insertion-order-dependent", () => {
  const state = {
    stories: {
      zebra: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }),
      alpha: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }),
    },
  };
  const result = selectEligibleStory(state);
  assert.equal(result.story_id, "alpha");
});

test("running selection twice against the identical state always returns the identical story — fully deterministic", () => {
  const state = { stories: { b: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:01Z" } }), a: eligibleFeedRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:02Z" } }) } };
  assert.equal(selectEligibleStory(state).story_id, selectEligibleStory(state).story_id);
});

test("19-20. two already-posted stories (matching Drake's and Myles's real final shape) are naturally excluded", () => {
  const postedLikeDrake = eligibleFeedRecord({ status: "posted", publishing: { status: "posted" } });
  const postedLikeMyles = eligibleFeedRecord({ status: "posted", publishing: { status: "posted" } });
  const state = { stories: { drake: postedLikeDrake, myles: postedLikeMyles } };
  assert.equal(selectEligibleStory(state), null, "no posted story may ever be selected for automatic publishing");
});

// ---------------------------------------------------------------------------
// 4-10. every excluded state, individually
// ---------------------------------------------------------------------------

test("4. awaiting_approval is ignored", () => {
  const state = { stories: { s1: eligibleFeedRecord({ approval: { status: "pending" } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("5. posting (an active posting claim in progress) is ignored", () => {
  const state = { stories: { s1: eligibleFeedRecord({ publishing: { status: "posting" } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("6. buffer_post_created is ignored — this belongs to the reconciliation workflow, never automatic re-publishing", () => {
  const state = { stories: { s1: eligibleFeedRecord({ publishing: { status: "posting", instagram: { feed: { status: "buffer_post_created" } } } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("7. an unresolved ambiguous publication attempt is ignored", () => {
  const state = { stories: { s1: eligibleFeedRecord({ publishing: { status: "posting", instagram: { feed: { status: "ambiguous" } } } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("8. a failed attempt awaiting explicit recovery is ignored (publishing.status stays 'posting' until a recovery event explicitly resets it)", () => {
  const state = { stories: { s1: eligibleFeedRecord({ status: "failed", publishing: { status: "posting", instagram: { feed: { status: "failed" } } } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("8b. a story that WAS failed but has since gone through the existing explicit failure-reset recovery (publishing.status back to not_posted, status back to approved) IS eligible again — this is the intended, already-audited recovery path, not a bypass", () => {
  const state = { stories: { s1: eligibleFeedRecord({ status: "approved", approval: { status: "approved" }, publishing: { status: "not_posted" } }) } };
  assert.notEqual(selectEligibleStory(state), null);
});

test("9. a posted record is ignored", () => {
  const state = { stories: { s1: eligibleFeedRecord({ status: "posted", publishing: { status: "posted" } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("10. a Story-destination record is ignored, regardless of its other fields", () => {
  const state = { stories: { s1: eligibleFeedRecord({ selection: { destination: "story", selected_at: "2026-01-01T00:00:00Z" } }) } };
  assert.equal(selectEligibleStory(state), null);
});

// ---------------------------------------------------------------------------
// dry-run wiring — the default mode, must never call runLiveImpl
// ---------------------------------------------------------------------------

test("dry run (the default): calls runPreflightImpl for the selected story, never runLiveImpl", async () => {
  const state = { stories: { s1: eligibleFeedRecord() } };
  let preflightCalledWith, liveCalled = false;
  const result = await main({
    fetchState: async () => state,
    runPreflightImpl: async (args) => {
      preflightCalledWith = args;
      return { ok: true, preconditionsPass: true, story_id: args.storyId };
    },
    runLiveImpl: async () => {
      liveCalled = true;
      return { ok: true };
    },
  });
  assert.equal(liveCalled, false, "dry run must never call the live publisher");
  assert.equal(preflightCalledWith.storyId, "s1");
  assert.equal(result.dryRun.preconditionsPass, true);
});

test("zero eligible stories -> no preflight and no live call at all, clean success", async () => {
  let preflightCalled = false;
  let liveCalled = false;
  const result = await main({
    fetchState: async () => ({ stories: {} }),
    runPreflightImpl: async () => {
      preflightCalled = true;
      return { ok: true };
    },
    runLiveImpl: async () => {
      liveCalled = true;
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected, null);
  assert.equal(preflightCalled, false);
  assert.equal(liveCalled, false);
});

// ---------------------------------------------------------------------------
// 14-17. live mode delegates to the existing runLive exactly once, no retry
// ---------------------------------------------------------------------------

test("14. live mode + a definite Buffer success result: runLiveImpl is called exactly once with the selected story_id, result passed through unchanged", async () => {
  const state = { stories: { s1: eligibleFeedRecord() } };
  let liveCallCount = 0;
  let liveCalledWith;
  const result = await main({
    fetchState: async () => state,
    live: true,
    runLiveImpl: async (args) => {
      liveCallCount++;
      liveCalledWith = args;
      return { ok: true, workerResponse: { outcome: "definite_success" } };
    },
  });
  assert.equal(liveCallCount, 1, "runLive must be called exactly once");
  assert.equal(liveCalledWith.storyId, "s1");
  assert.equal(result.ok, true);
  assert.equal(result.live.workerResponse.outcome, "definite_success");
});

test("15. live mode + a definite Buffer failure result: still exactly one runLiveImpl call, result passed through unchanged, ok:false surfaced", async () => {
  const state = { stories: { s1: eligibleFeedRecord() } };
  let liveCallCount = 0;
  const result = await main({
    fetchState: async () => state,
    live: true,
    runLiveImpl: async () => {
      liveCallCount++;
      return { ok: false, step: "buffer", workerResponse: { outcome: "definite_failure" } };
    },
  });
  assert.equal(liveCallCount, 1);
  assert.equal(result.ok, false);
});

test("16. live mode + an ambiguous Buffer result: still exactly one runLiveImpl call, no retry attempted by this script", async () => {
  const state = { stories: { s1: eligibleFeedRecord() } };
  let liveCallCount = 0;
  const result = await main({
    fetchState: async () => state,
    live: true,
    runLiveImpl: async () => {
      liveCallCount++;
      return { ok: false, manualReconciliationRequired: true, workerResponse: { outcome: "ambiguous" } };
    },
  });
  assert.equal(liveCallCount, 1, "no retry may ever occur, ambiguous or not");
});

test("17. this script's own code contains no loop or repeated invocation of runLiveImpl — a single call site only", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-publish-approved-feed.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const callSites = [...codeOnly.matchAll(/runLiveImpl\s*\(/g)];
  assert.equal(callSites.length, 1, "runLiveImpl must be called from exactly one place in this file's source");
  assert.ok(!/for\s*\(|while\s*\(|\.retry\(/.test(codeOnly), "no loop or retry construct may exist in this file");
});

test("this script never references Buffer's post-creation mutation, Buffer's API host, or Meta directly — it only ever delegates to the existing runPreflight/runLive", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-publish-approved-feed.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName), "no direct reference to Buffer's post-creation mutation may exist outside the imported existing publisher");
  assert.ok(!/api\.buffer\.com/.test(codeOnly));
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly));
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
