#!/usr/bin/env node
// Tests for the production launcher. Every dependency (fetchState,
// fetchImpl, the live orchestrator delegate) is explicitly injected — this
// suite makes no real network call of any kind, acquires no real posting
// claim, dispatches no real GitHub event, and calls neither Buffer nor
// Meta. installNetworkGuard() additionally makes any accidental use of the
// real globalThis.fetch throw immediately. Run with:
// node scripts/social/publish-buffer-feed.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "../social-worker/lib/_networkGuard.mjs";
import { parseArgs, isLiveAuthorized, runPreflight, runLive, main } from "./publish-buffer-feed.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const STORY_ID = "3287b40b-d88e-44cb-a2d7-c11c97844664";

function approvedFeedRecord(overrides = {}) {
  return {
    story_id: STORY_ID,
    status: "approved",
    selection: { destination: "feed" },
    approval: { status: "approved" },
    artwork: { status: "created", image_url: "https://example.test/social-artwork/story-1.png" },
    caption: { status: "ready", text: "The headline.\n\nSource: Test", hashtags: ["#NFL"] },
    publishing: { status: "not_posted" },
    ...overrides,
  };
}

function fakeFetchState(record) {
  return async () => ({ stories: { [STORY_ID]: record } });
}

function fakeFetchImplNoJpeg() {
  return async () => ({ ok: false, status: 404, headers: { get: () => null } });
}

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// ---------------------------------------------------------------------------
// 13. no args -> usage/preflight failure, no mutation
// ---------------------------------------------------------------------------

test("13. no story_id argument prints usage and exits nonzero, with no fetchState/fetchImpl ever called", async () => {
  const console_ = captureConsole();
  let fetchStateCalled = false;
  try {
    await main([], { fetchState: async () => { fetchStateCalled = true; }, fetchImpl: async () => { fetchStateCalled = true; } });
  } finally {
    console_.restore();
  }
  assert.equal(process.exitCode, 1);
  assert.equal(fetchStateCalled, false);
  assert.ok(console_.errors.some((l) => l.includes("Usage:")));
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// 14-17. dry-run mode: never claims, never dispatches, never calls Buffer
// ---------------------------------------------------------------------------

test("14. a story_id given without --live runs in dry-run mode only", async () => {
  const console_ = captureConsole();
  let liveCalled = false;
  try {
    await main([STORY_ID], {
      fetchState: fakeFetchState(approvedFeedRecord()),
      fetchImpl: fakeFetchImplNoJpeg(),
      runLive: async () => { liveCalled = true; return { ok: true }; },
    });
  } finally {
    console_.restore();
  }
  assert.equal(liveCalled, false);
  assert.ok(console_.logs.some((l) => l.includes("PREFLIGHT")));
  process.exitCode = 0;
});

test("15. dry-run never acquires a posting claim — runPreflight has no claimPosting dependency at all", async () => {
  const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord()), fetchImpl: fakeFetchImplNoJpeg() });
  assert.equal(report.ok, true);
  assert.ok(!("claim" in report), "the preflight report must never contain claim information — none was ever acquired");
});

test("16. dry-run never dispatches posting-publish-attempted — runPreflight's source contains no such call", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./publish-buffer-feed.js", import.meta.url), "utf-8");
  const preflightSection = src.slice(src.indexOf("export async function runPreflight"), src.indexOf("export async function runLive"));
  assert.ok(!/recordPublishAttempt|publish-attempted/i.test(preflightSection));
});

test("17. dry-run never calls the Buffer publish endpoint — runPreflight's source never references publishViaWorker/createBufferPostingBridge", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./publish-buffer-feed.js", import.meta.url), "utf-8");
  const preflightSection = src.slice(src.indexOf("export async function runPreflight"), src.indexOf("export async function runLive"));
  assert.ok(!/publishViaWorker|createBufferPostingBridge/i.test(preflightSection));
});

test("dry-run reports the JPEG derivative would be created when none exists yet, without downloading/converting/uploading anything", async () => {
  const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord()), fetchImpl: fakeFetchImplNoJpeg() });
  assert.equal(report.jpeg.exists, false);
  assert.equal(report.jpeg.note, "JPEG derivative would be created");
});

test("dry-run reports an already-existing JPEG's public URL when one is present", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: (n) => (n === "content-type" ? "image/jpeg" : null) } });
  const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord()), fetchImpl });
  assert.equal(report.jpeg.exists, true);
  assert.ok(report.jpeg.jpegUrl.endsWith(`social-artwork-jpeg/${STORY_ID}.jpg`));
});

// ---------------------------------------------------------------------------
// 18-19. live interlock
// ---------------------------------------------------------------------------

test("18. --live without an exact --confirm-story is blocked — dry-run runs instead, live is never invoked", async () => {
  const console_ = captureConsole();
  let liveCalled = false;
  try {
    await main([STORY_ID, "--live"], {
      fetchState: fakeFetchState(approvedFeedRecord()),
      fetchImpl: fakeFetchImplNoJpeg(),
      runLive: async () => { liveCalled = true; return { ok: true }; },
    });
  } finally {
    console_.restore();
  }
  assert.equal(liveCalled, false);
  assert.ok(console_.errors.some((l) => l.includes("without an exact --confirm-story match")));
  process.exitCode = 0;
});

test("19. a --confirm-story value that does not exactly match the story_id is blocked — live is never invoked", async () => {
  const console_ = captureConsole();
  let liveCalled = false;
  try {
    await main([STORY_ID, "--live", "--confirm-story", "some-other-story-id"], {
      fetchState: fakeFetchState(approvedFeedRecord()),
      fetchImpl: fakeFetchImplNoJpeg(),
      runLive: async () => { liveCalled = true; return { ok: true }; },
    });
  } finally {
    console_.restore();
  }
  assert.equal(liveCalled, false);
  process.exitCode = 0;
});

test("isLiveAuthorized: requires BOTH --live and an exact confirm-story match", () => {
  assert.equal(isLiveAuthorized({ storyId: STORY_ID, live: true, confirmStory: STORY_ID }), true);
  assert.equal(isLiveAuthorized({ storyId: STORY_ID, live: false, confirmStory: STORY_ID }), false);
  assert.equal(isLiveAuthorized({ storyId: STORY_ID, live: true, confirmStory: "wrong" }), false);
  assert.equal(isLiveAuthorized({ storyId: STORY_ID, live: true, confirmStory: null }), false);
});

test("parseArgs: --confirm-story accepts both space-separated and = forms", () => {
  assert.equal(parseArgs([STORY_ID, "--live", "--confirm-story", STORY_ID]).confirmStory, STORY_ID);
  assert.equal(parseArgs([STORY_ID, "--live", `--confirm-story=${STORY_ID}`]).confirmStory, STORY_ID);
});

// ---------------------------------------------------------------------------
// 20-22. precondition gating (surfaced by dry-run's preconditionsPass)
// ---------------------------------------------------------------------------

test("20. an unapproved story is reported as failing preconditions", async () => {
  const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord({ approval: { status: "pending" } })), fetchImpl: fakeFetchImplNoJpeg() });
  assert.equal(report.preconditionsPass, false);
  assert.equal(report.preconditionError, "not_approved");
});

test("21. a wrong-destination (Story-selected) record is reported as failing preconditions", async () => {
  const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord({ selection: { destination: "story" } })), fetchImpl: fakeFetchImplNoJpeg() });
  assert.equal(report.preconditionsPass, false);
  assert.equal(report.preconditionError, "wrong_destination");
});

test("22. an already-posted story is reported as failing preconditions", async () => {
  const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord({ publishing: { status: "posted" } })), fetchImpl: fakeFetchImplNoJpeg() });
  assert.equal(report.preconditionsPass, false);
  assert.equal(report.preconditionError, "already_posted");
});

// ---------------------------------------------------------------------------
// 23-24. live delegation, exactly once, no retry
// ---------------------------------------------------------------------------

test("23. a valid live invocation delegates exactly once to executeBufferFeedPublish, with the exact storyId and configured channelId", async () => {
  const originalBase = process.env.ARTWORK_WORKER_BASE_URL;
  const originalToken = process.env.AGGREGATE_ARTWORK_API_TOKEN;
  process.env.ARTWORK_WORKER_BASE_URL = "https://worker.example.test";
  process.env.AGGREGATE_ARTWORK_API_TOKEN = "test-token";
  let callCount = 0;
  let captured;
  try {
    const executePublish = async (args) => {
      callCount++;
      captured = args;
      return { ok: true };
    };
    const result = await runLive({ storyId: STORY_ID, deps: { executePublish, bridge: {}, fetchState: async () => ({}) } });
    assert.equal(result.ok, true);
    assert.equal(callCount, 1);
    assert.equal(captured.storyId, STORY_ID);
    assert.equal(captured.channelId, "6aa2fb5fcd8b9c702c4530c5");
  } finally {
    process.env.ARTWORK_WORKER_BASE_URL = originalBase;
    process.env.AGGREGATE_ARTWORK_API_TOKEN = originalToken;
  }
});

test("runLive fails closed if ARTWORK_WORKER_BASE_URL is not set, before touching any dependency", async () => {
  const originalBase = process.env.ARTWORK_WORKER_BASE_URL;
  const originalToken = process.env.AGGREGATE_ARTWORK_API_TOKEN;
  delete process.env.ARTWORK_WORKER_BASE_URL;
  process.env.AGGREGATE_ARTWORK_API_TOKEN = "test-token";
  try {
    await assert.rejects(() => runLive({ storyId: STORY_ID, deps: { executePublish: async () => { throw new Error("must never be called"); } } }));
  } finally {
    process.env.ARTWORK_WORKER_BASE_URL = originalBase;
    process.env.AGGREGATE_ARTWORK_API_TOKEN = originalToken;
  }
});

test("24. this launcher implements no retry loop of its own — its source contains no 'retry' and calls executeBufferFeedPublish from exactly one call site", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./publish-buffer-feed.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\bretry\b/i.test(codeOnly));
  const callSites = codeOnly.match(/executePublish\(/g) || [];
  assert.equal(callSites.length, 1, "executeBufferFeedPublish (via executePublish) must be invoked from exactly one call site");
});

// ---------------------------------------------------------------------------
// 25. secrets never printed
// ---------------------------------------------------------------------------

test("25. neither the preflight report nor a live result ever contains the worker token, even if it appears in an env var during the call", async () => {
  const FAKE_TOKEN = "SECRET_TOKEN_MUST_NEVER_APPEAR_IN_OUTPUT";
  const originalBase = process.env.ARTWORK_WORKER_BASE_URL;
  const originalToken = process.env.AGGREGATE_ARTWORK_API_TOKEN;
  process.env.ARTWORK_WORKER_BASE_URL = "https://worker.example.test";
  process.env.AGGREGATE_ARTWORK_API_TOKEN = FAKE_TOKEN;
  try {
    const report = await runPreflight({ storyId: STORY_ID, fetchState: fakeFetchState(approvedFeedRecord()), fetchImpl: fakeFetchImplNoJpeg() });
    assert.ok(!JSON.stringify(report).includes(FAKE_TOKEN));

    const result = await runLive({ storyId: STORY_ID, deps: { executePublish: async () => ({ ok: true, claim: { claim_id: "c1" } }), bridge: {}, fetchState: async () => ({}) } });
    assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN));
  } finally {
    process.env.ARTWORK_WORKER_BASE_URL = originalBase;
    process.env.AGGREGATE_ARTWORK_API_TOKEN = originalToken;
  }
});

test("this launcher's source never logs an Authorization header or any of the three named secrets by name in a console call", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./publish-buffer-feed.js", import.meta.url), "utf-8");
  const consoleCalls = src.match(/console\.(log|error)\([^)]*\)/g) || [];
  for (const call of consoleCalls) {
    assert.ok(!/AGGREGATE_ARTWORK_API_TOKEN|BUFFER_API_KEY|GITHUB_DISPATCH_TOKEN|authorization/i.test(call), `a console call must never reference a secret by name: ${call}`);
  }
});

// ---------------------------------------------------------------------------
// 26. network guard remains effective
// ---------------------------------------------------------------------------

test("26. installNetworkGuard() still makes an unmocked call to globalThis.fetch throw immediately", () => {
  installNetworkGuard();
  assert.throws(() => globalThis.fetch("https://api.buffer.com"), /unexpected_real_network_call/);
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
