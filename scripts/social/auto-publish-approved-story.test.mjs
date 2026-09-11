#!/usr/bin/env node
// Tests for automatic approved-Story publishing selection + wiring —
// mirrors auto-publish-approved-feed.test.mjs's own exact pattern. Every
// dependency (fetchState, fetchImpl, runPreflightImpl, runLiveImpl) is
// explicitly injected — this suite makes no real network call of any kind,
// acquires no real posting claim, dispatches no real GitHub event, and
// calls neither Buffer nor Meta. installNetworkGuard() additionally makes
// any accidental use of the real globalThis.fetch throw immediately.
//
// This file fills the specific gap identified in the production-readiness
// audit (2026-09-11): selectEligibleStory()/resolveRunMode() already had
// thorough coverage (see scripts/tests/story-publishing-regression.mjs),
// but main()'s own dry-run/live branching, its no-retry/no-auto-approval
// invariants, and the workflow YAML's external-dispatch contract had never
// been directly tested for the Story automation the way they already were
// for Feed's.
// Run with: node scripts/social/auto-publish-approved-story.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "../social-worker/lib/_networkGuard.mjs";
import { selectEligibleStory, main, resolveRunMode } from "./auto-publish-approved-story.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function eligibleStoryRecord(overrides = {}) {
  return {
    status: "approved",
    approval: { status: "approved" },
    selection: { destination: "story", selected_at: "2026-01-01T00:00:00Z" },
    publishing: { status: "not_posted" },
    // Canonical field (fixed 2026-09-11): a destination="story" record's
    // approved asset lives in story_artwork, never artwork.
    artwork: { status: "not_created", image_url: null },
    story_artwork: { status: "created", image_url: "https://example.test/social-artwork/x.png", width: 941, height: 1672 },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "ready", text: "Headline.\n\nSource: Test" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Selection — max one per run, Feed isolation (cross-checks; full exclusion
// matrix already lives in story-publishing-regression.mjs tests 1-9)
// ---------------------------------------------------------------------------

test("1. exactly one eligible Story -> it is selected", () => {
  const state = { stories: { s1: eligibleStoryRecord() } };
  const result = selectEligibleStory(state);
  assert.equal(result.story_id, "s1");
});

test("2. multiple eligible Stories -> at most ONE is ever returned, the OLDEST by selection.selected_at", () => {
  const state = {
    stories: {
      newer: eligibleStoryRecord({ selection: { destination: "story", selected_at: "2026-01-02T00:00:00Z" } }),
      older: eligibleStoryRecord({ selection: { destination: "story", selected_at: "2026-01-01T00:00:00Z" } }),
    },
  };
  const result = selectEligibleStory(state);
  assert.equal(result.story_id, "older");
  assert.equal(Array.isArray(result), false, "selectEligibleStory must return a single record, never an array/batch");
});

test("3. a Feed-destination record is never selected by the Story automation, regardless of its other fields", () => {
  const state = { stories: { s1: eligibleStoryRecord({ selection: { destination: "feed", selected_at: "2026-01-01T00:00:00Z" } }) } };
  assert.equal(selectEligibleStory(state), null);
});

test("4. Drake/Myles-shaped already-posted Story records are naturally excluded", () => {
  const state = {
    stories: {
      drakeLike: eligibleStoryRecord({ status: "posted", publishing: { status: "posted" } }),
      mylesLike: eligibleStoryRecord({ status: "posted", publishing: { status: "posted" } }),
    },
  };
  assert.equal(selectEligibleStory(state), null);
});

// ---------------------------------------------------------------------------
// main() dry-run wiring — the default mode, must never call runLiveImpl
// ---------------------------------------------------------------------------

test("5. dry run (the default): calls runPreflightImpl for the selected Story, never runLiveImpl", async () => {
  const state = { stories: { s1: eligibleStoryRecord() } };
  let preflightCalledWith;
  let liveCalled = false;
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

test("6. zero eligible Stories -> no preflight and no live call at all, clean success (the expected steady-state result of most runs)", async () => {
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
// main() live wiring — delegates to the existing runLive exactly once, no retry
// ---------------------------------------------------------------------------

test("7. live mode + a definite Buffer success result: runLiveImpl is called exactly once with the selected story_id, result passed through unchanged", async () => {
  const state = { stories: { s1: eligibleStoryRecord() } };
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

test("8. live mode + a definite Buffer failure result: still exactly one runLiveImpl call, result passed through unchanged, ok:false surfaced, never retried", async () => {
  const state = { stories: { s1: eligibleStoryRecord() } };
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

test("9. live mode + an ambiguous Buffer result: still exactly one runLiveImpl call, no retry attempted by this script", async () => {
  const state = { stories: { s1: eligibleStoryRecord() } };
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

test("10. this script's own code contains no loop or repeated invocation of runLiveImpl — a single call site only", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-publish-approved-story.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const callSites = [...codeOnly.matchAll(/runLiveImpl\s*\(/g)];
  assert.equal(callSites.length, 1, "runLiveImpl must be called from exactly one place in this file's source");
  assert.ok(!/for\s*\(|while\s*\(|\.retry\(/.test(codeOnly), "no loop or retry construct may exist in this file");
});

test("11. this script never references Buffer's post-creation mutation, Buffer's API host, or Meta directly — it only ever delegates to the existing runPreflight/runLive", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-publish-approved-story.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const mutationName = ["create", "Post"].join("");
  assert.ok(!codeOnly.includes(mutationName), "no direct reference to Buffer's post-creation mutation may exist outside the imported existing publisher");
  assert.ok(!/api\.buffer\.com/.test(codeOnly));
  assert.ok(!/graph\.(facebook|instagram)\.com/i.test(codeOnly));
});

test("12. this script never references approval decisions — auto-approval remains impossible by construction", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./auto-publish-approved-story.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/approval\/decide|decideApproval|approval-approved/i.test(codeOnly), "this script must never call or reference the approval-decision mechanism");
});

// ---------------------------------------------------------------------------
// Mode resolution (schedule always live [dormant — no schedule trigger
// exists], workflow_dispatch defaults dry-run)
// ---------------------------------------------------------------------------

test("13. a schedule event ALWAYS resolves to live, regardless of inputMode (dormant logic — no schedule trigger exists on this workflow yet)", () => {
  assert.equal(resolveRunMode({ eventName: "schedule", inputMode: undefined }), "live");
  assert.equal(resolveRunMode({ eventName: "schedule", inputMode: "dry-run" }), "live");
});

test("14. a workflow_dispatch event with no explicit inputMode (a missing 'mode' input) resolves to dry-run — NEVER live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: undefined }), "dry-run");
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "" }), "dry-run");
});

test("15. a workflow_dispatch event with explicit inputMode=dry-run resolves to dry-run", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "dry-run" }), "dry-run");
});

test("16. a workflow_dispatch event with explicit inputMode=live resolves to live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "live" }), "live");
});

test("17. no accidental fall-through: an unrecognized/garbage inputMode value on a non-schedule event always resolves to the safe dry-run default, never live", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "LIVE" }), "dry-run", "case must match exactly — no case-insensitive coercion to live");
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "yes" }), "dry-run");
  assert.equal(resolveRunMode({ eventName: undefined, inputMode: undefined }), "dry-run", "a completely unset context (e.g. running locally outside Actions) must default to dry-run");
});

// ---------------------------------------------------------------------------
// Workflow YAML — the external cron-job.org dispatch contract
// ---------------------------------------------------------------------------

test("18. the workflow file declares workflow_dispatch with an explicit 'mode' input (dry-run/live), default dry-run", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-publish-approved-story.yml", import.meta.url), "utf-8");
  assert.match(yaml, /^\s*workflow_dispatch:\s*$/m);
  assert.match(yaml, /mode:/);
  assert.match(yaml, /default:\s*"dry-run"/);
  assert.match(yaml, /-\s*dry-run/);
  assert.match(yaml, /-\s*live/);
});

test("19. the workflow file declares NO native schedule trigger — external cron-job.org dispatch only", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-publish-approved-story.yml", import.meta.url), "utf-8");
  assert.ok(!/^\s*schedule:/m.test(yaml), "the Story workflow must not declare a schedule: trigger yet");
  assert.ok(!/cron:/.test(yaml));
});

test("20. the workflow still declares a concurrency group — a second safety layer on top of the Worker's own exclusive Durable Object posting claim", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-publish-approved-story.yml", import.meta.url), "utf-8");
  assert.match(yaml, /^concurrency:\s*$/m);
  assert.match(yaml, /group:\s*auto-publish-approved-story/);
});

test("21. the workflow references the existing AGGREGATE_ARTWORK_API_TOKEN secret, and no other/new secret", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-publish-approved-story.yml", import.meta.url), "utf-8");
  assert.match(yaml, /secrets\.AGGREGATE_ARTWORK_API_TOKEN/);
  const secretRefs = [...yaml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secretRefs)], ["AGGREGATE_ARTWORK_API_TOKEN"], "no additional GitHub secret may be referenced by this workflow");
});

test("22. GITHUB_EVENT_NAME is never manually overridden (already provided automatically), and inputs.mode is passed through as INPUT_MODE — the exact two inputs resolveRunMode() consumes", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(new URL("../../.github/workflows/auto-publish-approved-story.yml", import.meta.url), "utf-8");
  assert.ok(!/GITHUB_EVENT_NAME\s*:/.test(yaml), "GITHUB_EVENT_NAME must never be manually overridden — it is already provided automatically");
  assert.match(yaml, /INPUT_MODE:\s*\$\{\{\s*inputs\.mode\s*\}\}/);
});

test("23. an external dispatch body of exactly {ref:'main', inputs:{mode:'live'}} resolves this script to live — the exact contract cron-job.org will call", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "live" }), "live");
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
