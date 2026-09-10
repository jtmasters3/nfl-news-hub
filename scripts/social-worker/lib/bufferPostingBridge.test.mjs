#!/usr/bin/env node
// Tests the real HTTP-calling adapters that replace Stage 5A's ad-hoc
// mock-shaped stubs. Every test injects its own fetchImpl explicitly — no
// call in this suite can ever reach a real cloudflare-worker deployment or
// the real Buffer/GitHub APIs. installNetworkGuard() additionally makes any
// accidental use of the real globalThis.fetch impossible to miss: it would
// throw immediately rather than silently succeed or hang. Run with:
// node scripts/social-worker/lib/bufferPostingBridge.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "./_networkGuard.mjs";
import { createBufferPostingBridge } from "./bufferPostingBridge.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const WORKER_BASE_URL = "https://aggregate-artwork-bridge.example.workers.dev";
const WORKER_TOKEN = "TEST_WORKER_TOKEN_DO_NOT_LEAK";
const CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Construction fail-closed
// ---------------------------------------------------------------------------

test("construction: missing fetchImpl fails closed — no live-network fallback exists", () => {
  assert.throws(() => createBufferPostingBridge({ workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN }));
});

test("construction: missing workerBaseUrl fails closed", () => {
  assert.throws(() => createBufferPostingBridge({ fetchImpl: async () => {}, workerApiToken: WORKER_TOKEN }));
});

test("construction: missing workerApiToken fails closed", () => {
  assert.throws(() => createBufferPostingBridge({ fetchImpl: async () => {}, workerBaseUrl: WORKER_BASE_URL }));
});

// ---------------------------------------------------------------------------
// claimPosting
// ---------------------------------------------------------------------------

test("claimPosting posts to /social/posting/claim with the bearer token and forwards caption/storage/jpeg/provider", async () => {
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse(200, { claimed: true, story_id: "s1", claim_id: "claim-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" })
  );
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.claimPosting({ storyId: "s1", captionUsed: "A caption.\n\n#NFL", storageKey: "social-artwork-jpeg/s1.jpg", jpegUrl: "https://example.test/s1.jpg", provider: "buffer" });
  assert.equal(result.ok, true);
  assert.equal(result.claim_id, "claim-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WORKER_BASE_URL}/social/posting/claim`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${WORKER_TOKEN}`);
  assert.equal(calls[0].body.caption_used, "A caption.\n\n#NFL");
  assert.equal(calls[0].body.storage_key, "social-artwork-jpeg/s1.jpg");
  assert.equal(calls[0].body.provider, "buffer");
});

test("claimPosting: a claim conflict (claimed:false) is surfaced as ok:false with the Worker's reason, exactly once, no retry", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(409, { claimed: false, reason: "already_claimed" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.claimPosting({ storyId: "s1", captionUsed: "A caption." });
  assert.equal(result.ok, false);
  assert.equal(result.error, "already_claimed");
  assert.equal(calls.length, 1);
});

test("claimPosting: a network failure is reported as ok:false, never thrown", async () => {
  const bridge = createBufferPostingBridge({ fetchImpl: async () => { throw new Error("ECONNRESET"); }, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.claimPosting({ storyId: "s1", captionUsed: "A caption." });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network_error");
});

// ---------------------------------------------------------------------------
// recordPublishAttempt
// ---------------------------------------------------------------------------

test("recordPublishAttempt posts to /social/posting/publish-attempted with story_id/claim_id/publish_attempted_at", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { ok: true, story_id: "s1", claim_id: "claim-1", publish_attempted_at: "2026-01-01T00:00:30Z" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.recordPublishAttempt({ storyId: "s1", claimId: "claim-1", publishAttemptedAt: "2026-01-01T00:00:30Z" });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `${WORKER_BASE_URL}/social/posting/publish-attempted`);
  assert.equal(calls[0].body.publish_attempted_at, "2026-01-01T00:00:30Z");
});

test("recordPublishAttempt: a claim_mismatch is surfaced as ok:false", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(409, { ok: false, reason: "claim_mismatch" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.recordPublishAttempt({ storyId: "s1", claimId: "wrong-claim", publishAttemptedAt: "2026-01-01T00:00:30Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
});

// ---------------------------------------------------------------------------
// recordPostingResult
// ---------------------------------------------------------------------------

test("recordPostingResult posts to /social/posting/result with event_type and payload, exactly once", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { ok: true, story_id: "s1", claim_id: "claim-1", event_type: "posting-completed" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.recordPostingResult({ storyId: "s1", claimId: "claim-1", eventType: "posting-completed", payload: { media_id: "buffer-post-1" } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.event_type, "posting-completed");
  assert.deepEqual(calls[0].body.payload, { media_id: "buffer-post-1" });
});

test("recordPostingResult: a dispatch_failed (502) response is reported as ok:false, never retried by this adapter", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(502, { ok: false, reason: "dispatch_failed", message: "GitHub API error" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.recordPostingResult({ storyId: "s1", claimId: "claim-1", eventType: "posting-ambiguous", payload: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, "dispatch_failed");
  assert.equal(calls.length, 1, "no retry may ever be attempted by this adapter — the caller decides what a failure here means");
});

// ---------------------------------------------------------------------------
// publishViaWorker
// ---------------------------------------------------------------------------

test("publishViaWorker posts to /publish/buffer/feed and returns the Worker's response shape unchanged", async () => {
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse(200, { ok: true, storyId: "s1", outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" }, error: null })
  );
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.publishViaWorker({ storyId: "s1", channelId: CHANNEL_ID, caption: "A caption.", imageUrl: "https://example.test/s1.jpg", publishAttemptCheckpoint: { publishAttemptedAt: "2026-01-01T00:00:30Z" } });
  assert.equal(result.outcome, "definite_success");
  assert.equal(result.data.id, "buffer-post-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WORKER_BASE_URL}/publish/buffer/feed`);
  assert.equal(calls[0].body.channelId, CHANNEL_ID);
});

test("publishViaWorker: the fake worker token never appears in the returned result", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent" } }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.publishViaWorker({ storyId: "s1", channelId: CHANNEL_ID, caption: "A caption.", imageUrl: "https://example.test/s1.jpg", publishAttemptCheckpoint: { publishAttemptedAt: "2026-01-01T00:00:30Z" } });
  assert.ok(!JSON.stringify(result).includes(WORKER_TOKEN));
});

// ---------------------------------------------------------------------------
// reconcile — a read-only pass-through; the actual decision logic lives
// entirely in the Worker's postingReconcile.js and is already proven there
// (test/postingReconcile.test.mjs: exact stored post ID used, absence from
// a listing never becomes CONFIRMED_NOT_POSTED, a mismatched post ID never
// confirms). This adapter's own job is only to relay that outcome
// faithfully, never to make or override the decision itself.
// ---------------------------------------------------------------------------

test("reconcile posts story_id only — it never supplies a post_id or channel_id itself, since the Worker uses only its own already-stored values", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { ok: true, story_id: "s1", outcome: "CONFIRMED_POSTED", matchedPost: { id: "buffer-post-1" } }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.reconcile({ storyId: "s1" });
  assert.equal(result.outcome, "CONFIRMED_POSTED");
  assert.deepEqual(Object.keys(calls[0].body), ["story_id"]);
});

test("reconcile: an AMBIGUOUS_REQUIRES_HUMAN outcome from the Worker is relayed unchanged, never upgraded to a confirmation by this adapter", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { ok: true, story_id: "s1", outcome: "AMBIGUOUS_REQUIRES_HUMAN", matchedPost: null }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.reconcile({ storyId: "s1" });
  assert.equal(result.outcome, "AMBIGUOUS_REQUIRES_HUMAN");
});

// ---------------------------------------------------------------------------
// uploadJpeg — multipart upload to the Worker's deterministic JPEG endpoint
// ---------------------------------------------------------------------------

function recordingFormFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

test("uploadJpeg posts multipart form data to /social/artwork/jpeg with the bearer token, story_id, and jpeg file", async () => {
  const { fetchImpl, calls } = recordingFormFetch(() => jsonResponse(200, { uploaded: true, storyId: "s1", storageKey: "social-artwork-jpeg/s1.jpg", publicUrl: "https://artwork.example.test/social-artwork-jpeg/s1.jpg" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.uploadJpeg({ storyId: "s1", jpegBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, "https://artwork.example.test/social-artwork-jpeg/s1.jpg");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WORKER_BASE_URL}/social/artwork/jpeg`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${WORKER_TOKEN}`);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("story_id"), "s1");
  assert.ok(calls[0].init.body.get("jpeg") instanceof Blob);
});

test("uploadJpeg: a Worker-reported reused:true (idempotent collision-safe reuse) is passed through as ok:true, reused:true", async () => {
  const { fetchImpl } = recordingFormFetch(() => jsonResponse(200, { uploaded: true, reused: true, storyId: "s1", storageKey: "social-artwork-jpeg/s1.jpg", publicUrl: "https://artwork.example.test/social-artwork-jpeg/s1.jpg" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.uploadJpeg({ storyId: "s1", jpegBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
});

test("uploadJpeg: a Worker-side collision conflict (409, uploaded:false) is surfaced as ok:false with the exact reason", async () => {
  const { fetchImpl, calls } = recordingFormFetch(() => jsonResponse(409, { uploaded: false, reason: "existing_object_conflict" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.uploadJpeg({ storyId: "s1", jpegBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "existing_object_conflict");
  assert.equal(calls.length, 1, "no retry may ever be attempted after a collision conflict");
});

test("uploadJpeg: a Worker-side rejection (uploaded:false) is surfaced as ok:false with the reason, exactly once, no retry", async () => {
  const { fetchImpl, calls } = recordingFormFetch(() => jsonResponse(400, { uploaded: false, reason: "invalid_jpeg" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.uploadJpeg({ storyId: "s1", jpegBuffer: Buffer.from([0x00]) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_jpeg");
  assert.equal(calls.length, 1);
});

test("uploadJpeg: a network failure is reported as ok:false, never thrown", async () => {
  const bridge = createBufferPostingBridge({ fetchImpl: async () => { throw new Error("ECONNRESET"); }, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.uploadJpeg({ storyId: "s1", jpegBuffer: Buffer.from([0xff]) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network_error");
});

test("uploadJpeg: the fake worker token never appears in the returned result", async () => {
  const { fetchImpl } = recordingFormFetch(() => jsonResponse(200, { uploaded: true, storyId: "s1", storageKey: "social-artwork-jpeg/s1.jpg", publicUrl: "https://artwork.example.test/social-artwork-jpeg/s1.jpg" }));
  const bridge = createBufferPostingBridge({ fetchImpl, workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
  const result = await bridge.uploadJpeg({ storyId: "s1", jpegBuffer: Buffer.from([0xff, 0xd8]) });
  assert.ok(!JSON.stringify(result).includes(WORKER_TOKEN));
});

// ---------------------------------------------------------------------------
// No-live-network / guard proof
// ---------------------------------------------------------------------------

test("every request in this suite is routed exclusively through the injected fetchImpl, never globalThis.fetch", async () => {
  const original = globalThis.fetch;
  let usedRealFetch = false;
  globalThis.fetch = () => {
    usedRealFetch = true;
    throw new Error("unexpected_real_network_call");
  };
  try {
    const bridge = createBufferPostingBridge({ fetchImpl: async () => jsonResponse(200, { claimed: true, claim_id: "c1", processor_id: "p1", claimed_at: "t", claim_expires_at: "t" }), workerBaseUrl: WORKER_BASE_URL, workerApiToken: WORKER_TOKEN });
    await bridge.claimPosting({ storyId: "s1", captionUsed: "A caption." });
    assert.equal(usedRealFetch, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("21. installNetworkGuard() makes an unmocked call to globalThis.fetch throw immediately, before any request could leave the process", () => {
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
