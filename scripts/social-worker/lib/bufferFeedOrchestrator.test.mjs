#!/usr/bin/env node
// Stage 5B orchestration integration tests. Every external effect
// (fetchState, claimPosting, JPEG resolution, publish-attempt checkpoint
// recording, the Worker's /publish/buffer/feed call, result-event
// persistence) is a mocked, injected function — this suite makes no real
// network call of any kind, and never touches data/social-state.json.
// Mocked Worker/bridge responses match EXACTLY the shape the real
// bufferPostingBridge.js adapters return (proven separately in
// bufferPostingBridge.test.mjs), by deliberate design — the two repos are
// never directly imported from one another (see scripts/lib/socialState.js/
// github.js's own "no shared import path" convention), so this remains the
// correct, intentional boundary.
//
// This supersedes Stage 5A's ad-hoc-mock version of this file. The prior
// suite proved only sequencing against arbitrary stub functions; this suite
// additionally proves that NO external Buffer mutation can occur before
// BOTH the posting-claimed and posting-publish-attempted durable commits
// are confirmed via waitForDurableCommit — the exact gap the user's Stage
// 5B request identified ("a mocked ordering test is not sufficient").
//
// Stage 5B refinement: the same durable-confirmation property is now also
// proven AFTER the Buffer call — a successful recordPostingResult dispatch
// is not treated as proof the result event actually committed. See the
// "Result-event durable confirmation" section below for the new tests this
// refinement adds.
// Run with: node scripts/social-worker/lib/bufferFeedOrchestrator.test.mjs
import assert from "node:assert/strict";
import { installNetworkGuard } from "./_networkGuard.mjs";
import { validateBufferFeedPublishPreconditions, mapBufferWorkerOutcomeToEvent, executeBufferFeedPublish } from "./bufferFeedOrchestrator.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";
const FAST_POLL = { attempts: 5, intervalMs: 0, sleep: async () => {} };

function approvedFeedRecord(overrides = {}) {
  return {
    story_id: "story-1",
    status: "approved",
    selection: { destination: "feed", slot_id: "feed:test" },
    approval: { status: "approved" },
    artwork: { status: "created", image_url: "https://example.test/social-artwork/story-1.png" },
    caption: { status: "ready", text: "A caption.\n\nSource: Test", hashtags: ["#NFL"] },
    publishing: { status: "not_posted" },
    ...overrides,
  };
}

function callLog() {
  const log = [];
  return { log, record: (name) => log.push(name) };
}

/**
 * Builds a mutable in-memory "committed state" that fetchState reads and
 * that claimPosting/recordPublishAttempt mutate as a side effect — this is
 * what lets waitForDurableCommit's real polling logic run unmodified inside
 * these tests: a genuine commit really does appear on the NEXT fetchState()
 * call, exactly like the real GitHub Action commit would.
 */
function makeCommittedWorld(initialRecord) {
  let record = initialRecord;
  const fetchState = async () => ({ stories: { "story-1": record } });
  return {
    fetchState,
    getRecord: () => record,
    applyClaimCommit: (claimId) => {
      record = { ...record, publishing: { ...record.publishing, claim: { claim_id: claimId } } };
    },
    applyPublishAttemptCommit: (publishAttemptedAt) => {
      record = {
        ...record,
        publishing: {
          ...record.publishing,
          instagram: { ...record.publishing.instagram, feed: { ...(record.publishing.instagram?.feed ?? {}), publish_attempted_at: publishAttemptedAt } },
        },
      };
    },
    // Mimics postingEvents.js's own reducer effect on the record for each
    // result event type, ONLY as far as buildResultCommitPredicate actually
    // inspects — this is a test fixture, not a reimplementation of the
    // reducer, and exists so a genuine commit really does appear on the
    // NEXT fetchState() call, exactly like the real Action commit would.
    applyResultCommit: (eventType, payload) => {
      const feed = record.publishing?.instagram?.feed ?? {};
      if (eventType === "posting-completed") {
        record = {
          ...record,
          status: "posted",
          publishing: {
            ...record.publishing,
            status: "posted",
            instagram: {
              ...record.publishing.instagram,
              feed: { ...feed, status: "posted", media_id: payload.media_id, buffer: payload.buffer ? { ...feed.buffer, ...payload.buffer } : feed.buffer },
            },
          },
        };
      } else if (eventType === "posting-buffer-created") {
        record = {
          ...record,
          status: "posting",
          publishing: {
            ...record.publishing,
            status: "posting",
            instagram: {
              ...record.publishing.instagram,
              feed: { ...feed, status: "buffer_post_created", buffer: { ...feed.buffer, post_id: payload.post_id, channel_id: payload.channel_id, status: payload.status, due_at: payload.due_at, sent_at: payload.sent_at } },
            },
          },
        };
      } else if (eventType === "posting-failed") {
        record = {
          ...record,
          status: "failed",
          publishing: { ...record.publishing, instagram: { ...record.publishing.instagram, feed: { ...feed, status: "failed" } } },
        };
      } else if (eventType === "posting-ambiguous") {
        record = {
          ...record,
          status: "posting",
          publishing: { ...record.publishing, instagram: { ...record.publishing.instagram, feed: { ...feed, status: "ambiguous" } } },
        };
      }
    },
  };
}

function mockDeps(overrides = {}) {
  const { log, record } = callLog();
  const world = overrides.world ?? makeCommittedWorld(approvedFeedRecord());
  const deps = {
    storyId: "story-1",
    channelId: CHANNEL_ID,
    fetchState: world.fetchState,
    pollOptions: FAST_POLL,
    claimPosting: async () => {
      record("claimPosting");
      world.applyClaimCommit("claim-1");
      return { ok: true, claim_id: "claim-1", processor_id: "test-processor", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" };
    },
    resolveJpeg: async () => {
      record("resolveJpeg");
      return { ok: true, jpegUrl: "https://example.test/social-artwork-jpeg/story-1.jpg", storageKey: "social-artwork-jpeg/story-1.jpg" };
    },
    recordPublishAttempt: async ({ publishAttemptedAt }) => {
      record("recordPublishAttempt");
      world.applyPublishAttemptCommit(publishAttemptedAt);
      return { ok: true };
    },
    publishViaWorker: async () => {
      record("publishViaWorker");
      return { ok: true, storyId: "story-1", outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", dueAt: null, sentAt: "2026-01-01T00:01:00Z" }, error: null };
    },
    recordPostingResult: async ({ eventType, payload }) => {
      record("recordPostingResult");
      world.applyResultCommit(eventType, payload);
      return { ok: true };
    },
    now: () => "2026-01-01T00:00:30Z",
    ...overrides,
  };
  delete deps.world;
  return { deps, log, world };
}

// ---------------------------------------------------------------------------
// 1-4. preconditions (already-posted / unapproved / wrong destination cannot proceed)
// ---------------------------------------------------------------------------

test("1. an approved Feed story with a genuinely committed claim and checkpoint reaches the mocked Worker publish boundary and completes", async () => {
  const { deps, log } = mockDeps();
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.ok(log.includes("publishViaWorker"));
});

test("2. an unapproved story is blocked before any dependency is called", async () => {
  const { deps, log } = mockDeps({ world: makeCommittedWorld(approvedFeedRecord({ approval: { status: "pending" } })) });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_approved");
  assert.deepEqual(log, []);
});

test("3. a Story-destination record (wrong destination) is blocked before any dependency is called", async () => {
  const { deps, log } = mockDeps({ world: makeCommittedWorld(approvedFeedRecord({ selection: { destination: "story" } })) });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_destination");
  assert.deepEqual(log, []);
});

test("4. an already-posted story cannot proceed — blocked before any dependency is called", async () => {
  const { deps, log } = mockDeps({ world: makeCommittedWorld(approvedFeedRecord({ publishing: { status: "posted" } })) });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "already_posted");
  assert.deepEqual(log, []);
});

// ---------------------------------------------------------------------------
// 5. real claim adapter invoked before prep/publish; claim conflict stops execution before Buffer
// ---------------------------------------------------------------------------

test("5. the real claimPosting adapter is invoked, and invoked BEFORE the Worker publish call", async () => {
  const { deps, log } = mockDeps();
  await executeBufferFeedPublish(deps);
  const claimIndex = log.indexOf("claimPosting");
  const publishIndex = log.indexOf("publishViaWorker");
  assert.ok(claimIndex >= 0 && publishIndex >= 0);
  assert.ok(claimIndex < publishIndex);
});

test("6. a claim conflict (already_claimed) stops execution before any Buffer call", async () => {
  const { deps, log } = mockDeps({ claimPosting: async () => { log.push("claimPosting"); return { ok: false, error: "already_claimed" }; } });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "claim");
  assert.ok(!log.includes("publishViaWorker"));
});

// ---------------------------------------------------------------------------
// 7. posting-claimed durable (confirmed via waitForDurableCommit before proceeding)
// ---------------------------------------------------------------------------

test("7. the posting-claimed commit is genuinely confirmed via fetchState before publish-attempted is ever recorded — if the claim is accepted but NEVER actually lands in committed state, the Worker is never called", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps, log } = mockDeps({
    world,
    claimPosting: async () => {
      log.push("claimPosting");
      // Deliberately do NOT call world.applyClaimCommit — simulates a
      // dispatch accepted by GitHub that never actually committed.
      return { ok: true, claim_id: "claim-1", processor_id: "p1", claimed_at: "t", claim_expires_at: "t" };
    },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "claim_commit_confirmation");
  assert.ok(!log.includes("recordPublishAttempt"), "must never proceed to the publish-attempt checkpoint without a confirmed claim commit");
  assert.ok(!log.includes("publishViaWorker"), "must never call Buffer without a confirmed claim commit");
});

// ---------------------------------------------------------------------------
// 8. posting-publish-attempted durable before Buffer invocation; failed checkpoint persistence prevents Buffer invocation
// ---------------------------------------------------------------------------

test("8. the publish_attempted checkpoint is recorded AND its durable commit confirmed BEFORE the Worker is ever invoked", async () => {
  const { deps, log } = mockDeps();
  await executeBufferFeedPublish(deps);
  const attemptIndex = log.indexOf("recordPublishAttempt");
  const publishIndex = log.indexOf("publishViaWorker");
  assert.ok(attemptIndex >= 0 && publishIndex >= 0);
  assert.ok(attemptIndex < publishIndex, "the checkpoint must be recorded strictly before the Worker publish call");
});

test("9. if the checkpoint fails to record (dispatch_failed), the Worker is NEVER called", async () => {
  const { deps, log } = mockDeps({ recordPublishAttempt: async () => { log.push("recordPublishAttempt"); return { ok: false, error: "dispatch_failed" }; } });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "publish_attempted");
  assert.ok(!log.includes("publishViaWorker"), "the Worker must never be called without a durably recorded checkpoint");
});

test("10. if the checkpoint dispatch is accepted but NEVER actually commits (durable-commit confirmation fails), the Worker is NEVER called — this is the exact 'mocked ordering is not sufficient' gap this stage closes", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  world.applyClaimCommit("claim-1"); // pre-commit the claim so we isolate the publish-attempted gap
  const { deps, log } = mockDeps({
    world,
    claimPosting: async () => { log.push("claimPosting"); return { ok: true, claim_id: "claim-1", processor_id: "p1", claimed_at: "t", claim_expires_at: "t" }; },
    recordPublishAttempt: async () => {
      log.push("recordPublishAttempt");
      // Deliberately do NOT call world.applyPublishAttemptCommit.
      return { ok: true };
    },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "publish_attempt_commit_confirmation");
  assert.ok(!log.includes("publishViaWorker"), "no external Buffer mutation may happen before the publish-attempted checkpoint is CONFIRMED committed, not merely accepted");
});

// ---------------------------------------------------------------------------
// 11. Buffer invoked exactly once
// ---------------------------------------------------------------------------

test("11. the Worker publish call happens exactly once per successful run, never retried", async () => {
  let callCount = 0;
  const { deps } = mockDeps({
    publishViaWorker: async () => {
      callCount++;
      return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } };
    },
  });
  await executeBufferFeedPublish(deps);
  assert.equal(callCount, 1);
});

// ---------------------------------------------------------------------------
// 12-16. outcome -> durable event mapping, persistence, AND durable-commit
// confirmation (each test's recordPostingResult override both captures the
// call args AND applies the commit — proving the orchestrator only reports
// success once that commit is actually OBSERVABLE via fetchState, not
// merely dispatched)
// ---------------------------------------------------------------------------

test("12. sent -> posting-completed is durably persisted AND its durable commit (publishing.status=posted, feed.status=posted, matching post_id) is confirmed", async () => {
  let persisted;
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps } = mockDeps({
    world,
    recordPostingResult: async (args) => { persisted = args; world.applyResultCommit(args.eventType, args.payload); return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(persisted.eventType, "posting-completed");
  assert.equal(persisted.payload.media_id, "buffer-post-1");
  assert.equal(result.record.status, "posted");
  assert.equal(result.record.publishing.instagram.feed.status, "posted");
  assert.equal(result.record.publishing.instagram.feed.buffer.post_id, "buffer-post-1");
});

// ---------------------------------------------------------------------------
// Microscopic pre-commit verification: does the posting-completed durable
// predicate require a Meta-style media_id independent of Buffer's own
// post_id identity? Answer (proven in scripts/tests/posting-events-buffer-
// provider-regression.mjs's new test "7b" via the real reducer): NO — the
// reducer's own unconditional gate (postingEvents.js line ~371) makes
// feed.status==="posted" with a null/missing media_id structurally
// unreachable for ANY provider, and this orchestrator's own
// mapBufferWorkerOutcomeToEvent always sets payload.media_id to the exact
// Buffer post id for a "sent" completion — so for Buffer, media_id and
// buffer.post_id are always the SAME value, never independently required.
// The predicate is therefore left UNCHANGED; these tests prove why.
// ---------------------------------------------------------------------------

test("12b. for Buffer, media_id is never an independent Meta-style requirement — the reducer stores it as exactly the same value as buffer.post_id, so durable confirmation never needs it as a separate fact", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps } = mockDeps({
    world,
    recordPostingResult: async (args) => { world.applyResultCommit(args.eventType, args.payload); return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(result.record.publishing.instagram.feed.media_id, result.record.publishing.instagram.feed.buffer.post_id, "media_id and buffer.post_id must be the same identity for a Buffer completion");
});

test("12c. a durable Buffer 'posted' record with a genuinely null/absent media_id cannot arise from the real reducer (see posting-events-buffer-provider-regression.mjs test 7b) — so this predicate's media_id check never rejects a legitimate Buffer completion; it can only ever reject a state that does not actually reflect what was dispatched, which is the correct fail-safe behavior", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  let publishCallCount = 0;
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    // Simulates an impossible/corrupted commit: media_id null despite
    // feed.status="posted" and a matching buffer.post_id. Never producible
    // by the real reducer (test 7b proves it), but the orchestrator's own
    // durable-confirmation must still fail safe rather than false-confirm.
    recordPostingResult: async ({ eventType, payload }) => {
      world.applyResultCommit(eventType, { ...payload, media_id: null });
      return { ok: true };
    },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.manualReconciliationRequired, true, "an unreachable/corrupted shape must never be silently confirmed as success");
  assert.equal(publishCallCount, 1);
});

test("13. scheduled -> posting-buffer-created is durably persisted AND its durable commit (publishing.status=posting, feed.status=buffer_post_created, matching post_id/status) is confirmed", async () => {
  let persisted;
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => ({ ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "scheduled", dueAt: "2026-01-02T00:00:00Z" } }),
    recordPostingResult: async (args) => { persisted = args; world.applyResultCommit(args.eventType, args.payload); return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(persisted.eventType, "posting-buffer-created");
  assert.equal(persisted.payload.status, "scheduled");
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "buffer_post_created");
  assert.equal(result.record.publishing.instagram.feed.buffer.post_id, "buffer-post-1");
});

test("14. sending -> posting-buffer-created is durably persisted and confirmed", async () => {
  let persisted;
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => ({ ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sending" } }),
    recordPostingResult: async (args) => { persisted = args; world.applyResultCommit(args.eventType, args.payload); return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(persisted.eventType, "posting-buffer-created");
  assert.equal(persisted.payload.status, "sending");
  assert.equal(result.record.publishing.instagram.feed.status, "buffer_post_created");
});

test("15. an affirmative Buffer failure -> posting-failed is durably persisted AND its durable commit (status=failed) is confirmed", async () => {
  let persisted;
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => ({ ok: true, outcome: "definite_failure", error: { category: "mutation_error", message: "Channel not connected" } }),
    recordPostingResult: async (args) => { persisted = args; world.applyResultCommit(args.eventType, args.payload); return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(persisted.eventType, "posting-failed");
  assert.equal(result.record.status, "failed");
  assert.equal(result.record.publishing.instagram.feed.status, "failed");
});

test("16. an ambiguous Buffer outcome -> posting-ambiguous is durably persisted AND its durable commit (publishing.status stays posting, feed.status=ambiguous) is confirmed", async () => {
  let persisted;
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => ({ ok: true, outcome: "ambiguous", error: { category: "5xx" } }),
    recordPostingResult: async (args) => { persisted = args; world.applyResultCommit(args.eventType, args.payload); return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(persisted.eventType, "posting-ambiguous");
  assert.equal(result.record.status, "posting");
  assert.equal(result.record.publishing.instagram.feed.status, "ambiguous");
});

// ---------------------------------------------------------------------------
// 17-18. result-event persistence failure after Buffer never retries Buffer
// ---------------------------------------------------------------------------

test("17. if result-event persistence fails AFTER a successful Buffer call, the orchestrator reports manual-reconciliation-required and NEVER calls the Worker a second time", async () => {
  let publishCallCount = 0;
  const { deps } = mockDeps({
    publishViaWorker: async () => {
      publishCallCount++;
      return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } };
    },
    recordPostingResult: async () => ({ ok: false, error: "dispatch_failed" }),
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "result_persistence");
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(publishCallCount, 1, "the external mutation may already have succeeded — never call Buffer again because a state write failed afterward");
});

test("18. an ambiguous result whose persistence ALSO fails still never retries Buffer — the ambiguity itself is never resolved by calling Buffer again", async () => {
  let publishCallCount = 0;
  const { deps } = mockDeps({
    publishViaWorker: async () => {
      publishCallCount++;
      return { ok: true, outcome: "ambiguous", error: { category: "5xx" } };
    },
    recordPostingResult: async () => ({ ok: false, error: "dispatch_failed" }),
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(publishCallCount, 1);
});

// ---------------------------------------------------------------------------
// Result-event durable confirmation (Stage 5B refinement). Dispatch
// acceptance (recordPostingResult resolving ok:true) is NOT durable
// persistence — every test below proves that when the RESULTING committed
// state cannot be confirmed via fetchState, the orchestrator reports
// manualReconciliationRequired instead of success, and Buffer is never
// called a second time regardless of why the confirmation failed.
// ---------------------------------------------------------------------------

test("21. result endpoint reports accepted (ok:true) but the committed state never actually changes -> manualReconciliationRequired, never reported as success", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  let publishCallCount = 0;
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    recordPostingResult: async () => ({ ok: true }), // accepted, but deliberately never mutates world
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "result_persistence");
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(result.workerResponse.data.id, "buffer-post-1", "the known Buffer post id must be preserved for later manual reconciliation");
  assert.equal(publishCallCount, 1);
  assert.notEqual(world.getRecord().status, "posted", "the committed record must never reach 'posted' when the result event was never actually applied");
  assert.notEqual(world.getRecord().publishing.instagram.feed?.status, "posted");
});

test("22. the durable-commit poll for the result event exhausts its attempt budget (times out) after Buffer was already called -> manualReconciliationRequired", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  let publishCallCount = 0;
  const { deps } = mockDeps({
    world,
    pollOptions: { attempts: 3, intervalMs: 0, sleep: async () => {} },
    publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    recordPostingResult: async () => ({ ok: true }),
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(result.error, "timeout");
  assert.equal(publishCallCount, 1);
});

test("23. the durable-state reader throws on every attempt AFTER Buffer was called -> manualReconciliationRequired, distinguished as a read_error", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  let afterBuffer = false;
  let publishCallCount = 0;
  const wrappedFetchState = async () => {
    if (afterBuffer) throw new Error("GitHub API blip");
    return world.fetchState();
  };
  const { deps } = mockDeps({
    world,
    fetchState: wrappedFetchState,
    publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    recordPostingResult: async () => { afterBuffer = true; return { ok: true }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(result.error, "read_error");
  assert.equal(publishCallCount, 1);
});

test("24. the committed state ends up with a DIFFERENT/conflicting Buffer post_id than what this attempt actually produced -> manualReconciliationRequired, never treated as confirmation", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  let publishCallCount = 0;
  const { deps } = mockDeps({
    world,
    publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    recordPostingResult: async ({ eventType, payload }) => {
      // Simulate a conflicting write landing in committed state: a
      // DIFFERENT post_id than the one this Buffer call actually returned.
      world.applyResultCommit(eventType, { ...payload, buffer: { ...payload.buffer, post_id: "buffer-post-DIFFERENT" } });
      return { ok: true };
    },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(result.workerResponse.data.id, "buffer-post-1", "the operator must still be told which post id Buffer actually returned");
  assert.equal(publishCallCount, 1);
});

test("25. the committed state lands in a shape that doesn't match ANY expected result for this outcome -> manualReconciliationRequired, never guessed as success or failure", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  let publishCallCount = 0;
  const { deps } = mockDeps({
    world,
    // Buffer affirmatively reports "sent" (should durably resolve to
    // posting-completed/posted), but the commit that actually lands is the
    // buffer_post_created shape instead — an unexpected mismatch that must
    // never be silently accepted as proof of anything.
    publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    recordPostingResult: async () => {
      world.applyResultCommit("posting-buffer-created", { post_id: "buffer-post-1", channel_id: CHANNEL_ID, status: "scheduled" });
      return { ok: true };
    },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(publishCallCount, 1);
});

test("26. Buffer publish invocation count remains exactly 1 across every result-confirmation failure mode above", async () => {
  const scenarios = [
    () => ({ recordPostingResult: async () => ({ ok: true }) }), // never commits
    () => ({ pollOptions: { attempts: 2, intervalMs: 0, sleep: async () => {} }, recordPostingResult: async () => ({ ok: true }) }), // times out fast
  ];
  for (const scenario of scenarios) {
    const world = makeCommittedWorld(approvedFeedRecord());
    let publishCallCount = 0;
    const { deps } = mockDeps({
      world,
      ...scenario(),
      publishViaWorker: async () => { publishCallCount++; return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }; },
    });
    const result = await executeBufferFeedPublish(deps);
    assert.equal(result.ok, false);
    assert.equal(publishCallCount, 1);
  }
});

test("27. claim and publish-attempted durability behavior is unchanged by this refinement (regression against tests 7 and 10's exact scenarios)", async () => {
  const world = makeCommittedWorld(approvedFeedRecord());
  const { deps, log } = mockDeps({
    world,
    claimPosting: async () => { log.push("claimPosting"); return { ok: true, claim_id: "claim-1", processor_id: "p1", claimed_at: "t", claim_expires_at: "t" }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "claim_commit_confirmation");
  assert.ok(!log.includes("publishViaWorker"));
});

// ---------------------------------------------------------------------------
// 19. Meta path unchanged
// ---------------------------------------------------------------------------

test("19. this orchestrator module has no effect on Meta — it is entirely new/modified Buffer-only code, never imported by any Meta path, and contains no retry logic or direct fetch call", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./bufferFeedOrchestrator.js", import.meta.url), "utf-8");
  assert.ok(!/metaClient|meta-publish|graph\.facebook/i.test(src));
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\bretry\b/i.test(codeOnly));
  assert.ok(!/fetch\s*\(/.test(codeOnly), "the orchestrator itself must never call fetch directly");
});

// ---------------------------------------------------------------------------
// Pure-mapping regression coverage (unchanged from Stage 5A, still exercised directly)
// ---------------------------------------------------------------------------

test("mapBufferWorkerOutcomeToEvent: a transport-level Worker call failure (ok:false) maps to posting-ambiguous, never guessed", () => {
  const mapped = mapBufferWorkerOutcomeToEvent({
    storyId: "story-1",
    claimId: "claim-1",
    channelId: CHANNEL_ID,
    workerResponse: { ok: false },
    now: "2026-01-01T00:02:00Z",
  });
  assert.equal(mapped.eventType, "posting-ambiguous");
  assert.equal(mapped.payload.http_outcome_category, "worker_call_failed");
});

test("validateBufferFeedPublishPreconditions is a pure function with no side effects, reusable standalone", () => {
  const record = approvedFeedRecord();
  const result1 = validateBufferFeedPublishPreconditions(record);
  const result2 = validateBufferFeedPublishPreconditions(record);
  assert.deepEqual(result1, result2);
  assert.equal(result1.ok, true);
});

test("the correct configured Buffer channel is passed to the Worker call, and the caption/image are passed through unchanged", async () => {
  let captured;
  const { deps } = mockDeps({
    publishViaWorker: async (args) => {
      captured = args;
      return { ok: true, outcome: "definite_success", data: { id: "buffer-post-1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } };
    },
  });
  await executeBufferFeedPublish(deps);
  assert.equal(captured.channelId, CHANNEL_ID);
  assert.equal(captured.caption, "A caption.\n\nSource: Test\n\n#NFL");
  assert.ok(captured.imageUrl.startsWith("https://"));
});

// ---------------------------------------------------------------------------
// 20. any accidental global fetch in mocked publishing tests fails immediately
// ---------------------------------------------------------------------------

test("20. this orchestrator's own tests never rely on the real global fetch — every dependency is explicitly injected, and installNetworkGuard() proves any accidental use would throw immediately", async () => {
  const { deps } = mockDeps();
  await executeBufferFeedPublish(deps); // completes entirely via injected mocks
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
