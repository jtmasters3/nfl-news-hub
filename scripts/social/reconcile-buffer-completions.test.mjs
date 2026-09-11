#!/usr/bin/env node
// Tests for the reconciliation launcher's dependency wiring. Every
// dependency (fetchState, the bridge's reconcile/recordPostingResult) is
// explicitly injected — this suite makes no real network call of any kind,
// and calls neither Buffer's createPost nor Meta. Run with:
// node scripts/social/reconcile-buffer-completions.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "../social-worker/lib/_networkGuard.mjs";
import { main } from "./reconcile-buffer-completions.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const STORY_ID = "s1";
const POST_ID = "6aa41879a323b4086d724a4e";
const CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";
const CAPTION = "Test caption.";

function bufferPostCreatedState() {
  return {
    stories: {
      [STORY_ID]: {
        publishing: {
          status: "posting",
          claim: { claim_id: "claim-1" },
          instagram: { feed: { status: "buffer_post_created", provider: "buffer", caption_used: CAPTION, buffer: { post_id: POST_ID, channel_id: CHANNEL_ID } } },
        },
      },
    },
  };
}

function fakeBridge({ reconcileResult, applyResultFn }) {
  return {
    reconcile: async () => reconcileResult,
    recordPostingResult: applyResultFn ?? (async () => ({ ok: true })),
  };
}

function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) original[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(vars)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

test("throws if AGGREGATE_ARTWORK_API_TOKEN is not set", async () => {
  await withEnv({ AGGREGATE_ARTWORK_API_TOKEN: "" }, async () => {
    delete process.env.AGGREGATE_ARTWORK_API_TOKEN;
    await assert.rejects(() => main({ fetchState: async () => ({ stories: {} }) }), /AGGREGATE_ARTWORK_API_TOKEN/);
  });
});

test("a sent post wires through to recordPostingResult with event_type posting-completed", async () => {
  await withEnv({ AGGREGATE_ARTWORK_API_TOKEN: "fake-token" }, async () => {
    let captured;
    const bridge = fakeBridge({
      reconcileResult: { ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sent", sentAt: "2026-09-11T15:05:23.177Z" } },
      applyResultFn: async (args) => {
        captured = args;
        return { ok: true };
      },
    });
    const result = await main({ fetchState: async () => bufferPostCreatedState(), bridge });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].applied, true);
    assert.equal(captured.eventType, "posting-completed");
    assert.equal(captured.storyId, STORY_ID);
    assert.equal(captured.payload.published_at, "2026-09-11T15:05:23.177Z");
  });
});

test("no eligible records -> no reconcile/apply calls at all, reports cleanly", async () => {
  await withEnv({ AGGREGATE_ARTWORK_API_TOKEN: "fake-token" }, async () => {
    let reconcileCalled = false;
    const bridge = {
      reconcile: async () => {
        reconcileCalled = true;
        return { ok: true, matchedPost: null };
      },
      recordPostingResult: async () => ({ ok: true }),
    };
    const result = await main({ fetchState: async () => ({ stories: {} }), bridge });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, []);
    assert.equal(reconcileCalled, false);
  });
});

test("a still-sending post never calls recordPostingResult", async () => {
  await withEnv({ AGGREGATE_ARTWORK_API_TOKEN: "fake-token" }, async () => {
    let applyCalled = false;
    const bridge = fakeBridge({
      reconcileResult: { ok: true, matchedPost: { id: POST_ID, text: CAPTION, channelId: CHANNEL_ID, status: "sending", sentAt: null } },
      applyResultFn: async () => {
        applyCalled = true;
        return { ok: true };
      },
    });
    await main({ fetchState: async () => bufferPostCreatedState(), bridge });
    assert.equal(applyCalled, false);
  });
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
