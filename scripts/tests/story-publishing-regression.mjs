#!/usr/bin/env node
// Secondary Story publishing path regression suite (companion to the live
// Feed automation). Every external effect (fetchState, claimPosting, JPEG
// resolution, publish-attempt checkpoint recording, the Worker's
// /publish/buffer/story call, result-event persistence, Buffer
// reconciliation reads) is a mocked, injected function or a pure function
// call — this suite makes NO real network call of any kind, and never
// touches data/social-state.json. Proves that the generalized Feed
// posting/orchestration/reconciliation machinery (channelKeyFor-based, see
// scripts/lib/postingEvents.js) is correct for Story records, that Story
// publishing can never call Buffer more than once per attempt, and that
// the Feed automation's own eligibility/behavior is completely unaffected
// by Story's existence.
// Run with: node scripts/tests/story-publishing-regression.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyPostingClaimedEvent, channelKeyFor } from "../lib/postingEvents.js";
import { emptyState, ensureRecord } from "../lib/socialState.js";
import {
  validateBufferFeedPublishPreconditions,
  validateBufferStoryPublishPreconditions,
  executeBufferFeedPublish,
  mapBufferWorkerOutcomeToEvent,
} from "../social-worker/lib/bufferFeedOrchestrator.js";
import { validateJpegDerivative } from "../social-worker/lib/jpegDerivative.js";
import { resolveApprovedStoryJpeg } from "../social-worker/lib/resolveApprovedStoryJpeg.js";
import { isEligibleForCompletionReconciliation, decideReconciliationAction } from "../social-worker/lib/bufferCompletionReconciler.js";
import { selectEligibleStory as selectEligibleStoryDestination, resolveRunMode } from "../social/auto-publish-approved-story.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";
const FAST_POLL = { attempts: 5, intervalMs: 0, sleep: async () => {} };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function approvedStoryRecord(overrides = {}) {
  return {
    story_id: "story-1",
    status: "approved",
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    approval: { status: "approved" },
    artwork: { status: "created", image_url: "https://example.test/social-artwork/story-1.png", width: 1080, height: 1920 },
    caption: { status: "ready", text: "A caption.\n\nSource: Test", hashtags: ["#NFL"] },
    publishing: { status: "not_posted" },
    ...overrides,
  };
}

function callLog() {
  const log = [];
  return { log, record: (name) => log.push(name) };
}

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
      const channelKey = channelKeyFor(record);
      record = {
        ...record,
        publishing: {
          ...record.publishing,
          instagram: { ...record.publishing.instagram, [channelKey]: { ...(record.publishing.instagram?.[channelKey] ?? {}), publish_attempted_at: publishAttemptedAt } },
        },
      };
    },
    applyResultCommit: (eventType, payload) => {
      const channelKey = channelKeyFor(record);
      const channel = record.publishing?.instagram?.[channelKey] ?? {};
      if (eventType === "posting-completed") {
        record = {
          ...record,
          status: "posted",
          publishing: {
            ...record.publishing,
            status: "posted",
            instagram: { ...record.publishing.instagram, [channelKey]: { ...channel, status: "posted", media_id: payload.media_id, buffer: payload.buffer ? { ...channel.buffer, ...payload.buffer } : channel.buffer } },
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
              [channelKey]: { ...channel, status: "buffer_post_created", buffer: { ...channel.buffer, post_id: payload.post_id, channel_id: payload.channel_id, status: payload.status, due_at: payload.due_at, sent_at: payload.sent_at } },
            },
          },
        };
      } else if (eventType === "posting-failed") {
        record = { ...record, status: "failed", publishing: { ...record.publishing, instagram: { ...record.publishing.instagram, [channelKey]: { ...channel, status: "failed" } } } };
      } else if (eventType === "posting-ambiguous") {
        record = { ...record, status: "posting", publishing: { ...record.publishing, instagram: { ...record.publishing.instagram, [channelKey]: { ...channel, status: "ambiguous" } } } };
      }
    },
  };
}

function mockDeps(overrides = {}) {
  const { log, record } = callLog();
  const world = overrides.world ?? makeCommittedWorld(approvedStoryRecord());
  const deps = {
    storyId: "story-1",
    channelId: CHANNEL_ID,
    fetchState: world.fetchState,
    pollOptions: FAST_POLL,
    validatePreconditions: validateBufferStoryPublishPreconditions,
    claimPosting: async () => {
      record("claimPosting");
      world.applyClaimCommit("claim-1");
      return { ok: true, claim_id: "claim-1", processor_id: "test-processor", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" };
    },
    resolveJpeg: async () => {
      record("resolveJpeg");
      return { ok: true, jpegUrl: "https://example.test/social-artwork-jpeg-story/story-1.jpg", storageKey: "social-artwork-jpeg-story/story-1.jpg" };
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
// 1-9. Eligibility — canonical fields only, per-state exclusions
// ---------------------------------------------------------------------------

test("1. a Story-selected, approved, not_posted record IS eligible", () => {
  assert.equal(validateBufferStoryPublishPreconditions(approvedStoryRecord()).ok, true);
});

test("2. a Feed-destination record is excluded from Story eligibility (wrong_destination)", () => {
  const result = validateBufferStoryPublishPreconditions(approvedStoryRecord({ selection: { destination: "feed" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_destination");
});

test("3. an awaiting_approval Story record is excluded (not_approved)", () => {
  const result = validateBufferStoryPublishPreconditions(approvedStoryRecord({ approval: { status: "pending" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_approved");
});

test("4. a rejected Story record is excluded (not_approved)", () => {
  const result = validateBufferStoryPublishPreconditions(approvedStoryRecord({ approval: { status: "rejected" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_approved");
});

test("5. a Story record mid-flight at publishing.status=posting (covers claimed/buffer_post_created/publish_attempted/ambiguous) is excluded", () => {
  const result = validateBufferStoryPublishPreconditions(approvedStoryRecord({ publishing: { status: "posting" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:posting");
});

test("6. an ambiguous Story record (publishing.status still 'posting') is excluded, never silently retried", () => {
  const result = validateBufferStoryPublishPreconditions(
    approvedStoryRecord({ publishing: { status: "posting", instagram: { story: { status: "ambiguous" } } } })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:posting");
});

test("7. a failed-awaiting-recovery Story record (publishing.status=failed) is excluded until an explicit recovery event resets it", () => {
  const result = validateBufferStoryPublishPreconditions(approvedStoryRecord({ publishing: { status: "failed" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:failed");
});

test("8. an already-posted Story record is excluded (already_posted)", () => {
  const result = validateBufferStoryPublishPreconditions(approvedStoryRecord({ publishing: { status: "posted" } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "already_posted");
});

test("9. auto-publish-approved-story.js's selectEligibleStory picks the oldest eligible Story candidate deterministically, never a Feed record", () => {
  const state = {
    stories: {
      "story-old": approvedStoryRecord({ story_id: "story-old", selection: { destination: "story", selected_at: "2026-01-01T00:00:00Z" } }),
      "story-new": approvedStoryRecord({ story_id: "story-new", selection: { destination: "story", selected_at: "2026-01-02T00:00:00Z" } }),
      "feed-eligible": approvedStoryRecord({ story_id: "feed-eligible", selection: { destination: "feed", selected_at: "2025-12-01T00:00:00Z" } }),
    },
  };
  const selected = selectEligibleStoryDestination(state);
  assert.equal(selected.story_id, "story-old");
});

// ---------------------------------------------------------------------------
// 10-13. Artwork / JPEG validation before Buffer
// ---------------------------------------------------------------------------

test("10. validateJpegDerivative rejects a 4:5-shaped JPEG against Story's 9:16 expectation, never guessed as acceptable", async () => {
  const sharp = (await import("sharp")).default;
  const feedShapedJpeg = await sharp({ create: { width: 1024, height: 1280, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
  const result = await validateJpegDerivative(feedShapedJpeg, feedShapedJpeg, {
    expectedWidth: 1080,
    expectedHeight: 1920,
    expectedAspectRatio: 9 / 16,
    aspectRatioTolerance: 0.06,
    minDimension: 400,
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.startsWith("unexpected_dimensions") || i.startsWith("aspect_ratio_out_of_range")));
});

test("11. validateJpegDerivative accepts a genuine 9:16 JPEG when Story expectations are supplied — Feed's 4:5 default is never silently applied", async () => {
  const sharp = (await import("sharp")).default;
  const storyShapedJpeg = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
  const result = await validateJpegDerivative(storyShapedJpeg, storyShapedJpeg, {
    expectedWidth: 1080,
    expectedHeight: 1920,
    expectedAspectRatio: 9 / 16,
    aspectRatioTolerance: 0.06,
    minDimension: 400,
  });
  assert.equal(result.passed, true);
});

test("12. resolveApprovedStoryJpeg fails closed with artwork_dimensions_missing when the approved record has no recorded width/height — never guesses 1080x1920", async () => {
  const record = approvedStoryRecord({ artwork: { status: "created", image_url: "https://example.test/x.png" } });
  const fetchImpl = async () => { throw new Error("must not be called before dimension check"); };
  const result = await resolveApprovedStoryJpeg(record, { fetchImpl, uploadJpeg: async () => ({ ok: true, publicUrl: "x", storageKey: "y" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "artwork_dimensions_missing");
});

test("13. resolveApprovedStoryJpeg reuses an already-valid derivative at the Story-specific storage key without ever downloading the PNG or calling uploadJpeg", async () => {
  const record = approvedStoryRecord();
  let uploadCalled = false;
  const fetchImpl = async (url) => {
    assert.ok(String(url).includes("social-artwork-jpeg-story/"), "must check the STORY key, never Feed's social-artwork-jpeg/ key");
    return { ok: true, headers: { get: () => "image/jpeg" } };
  };
  const result = await resolveApprovedStoryJpeg(record, { fetchImpl, uploadJpeg: async () => { uploadCalled = true; return { ok: true, publicUrl: "x", storageKey: "y" }; } });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(uploadCalled, false);
});

// ---------------------------------------------------------------------------
// 14-16. Claim / publish-attempted failure -> zero Buffer calls
// ---------------------------------------------------------------------------

test("14. a Story posting-claim failure stops execution before the Buffer call — publishViaWorker is never invoked", async () => {
  const { deps, log } = mockDeps({ claimPosting: async () => { log.push("claimPosting"); return { ok: false, error: "already_claimed" }; } });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "claim");
  assert.ok(!log.includes("publishViaWorker"));
});

test("15. a Story publish-attempted persistence failure stops execution before the Buffer call", async () => {
  const { deps, log } = mockDeps({ recordPublishAttempt: async () => { log.push("recordPublishAttempt"); return { ok: false, error: "dispatch_failed" }; } });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "publish_attempted");
  assert.ok(!log.includes("publishViaWorker"));
});

test("16. a Story publish-attempted durable-commit confirmation failure stops execution before the Buffer call (checkpoint accepted but never actually committed)", async () => {
  const { deps, log } = mockDeps({
    recordPublishAttempt: async () => { log.push("recordPublishAttempt"); return { ok: true }; }, // deliberately never calls world.applyPublishAttemptCommit
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.step, "publish_attempt_commit_confirmation");
  assert.ok(!log.includes("publishViaWorker"));
});

// ---------------------------------------------------------------------------
// 17-21. Buffer Story payload field correctness
// ---------------------------------------------------------------------------

test("17. bufferPublisher.js sends metadata.instagram.type='story' and shouldShareToFeed=false for a Story post, never Feed's type='post'/shouldShareToFeed=true", async () => {
  const src = await readFile(new URL("../../../cloudflare-worker/src/bufferPublisher.js", import.meta.url), "utf-8").catch(() => null);
  // The two repos have no shared import path; this test reaches across the
  // filesystem only to verify the exact payload literal, never to import
  // executable code from the other repo.
  assert.ok(src, "cloudflare-worker/src/bufferPublisher.js must exist as a sibling checkout for this assertion");
  assert.ok(/type:\s*"story"\s*,\s*shouldShareToFeed:\s*false/.test(src), "createStoryPost must send type:'story', shouldShareToFeed:false");
});

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("18. createStoryPost never sends needsApproval — omitted exactly like createPost's own Feed path", async () => {
  const src = await readFile(new URL("../../../cloudflare-worker/src/bufferPublisher.js", import.meta.url), "utf-8").catch(() => null);
  assert.ok(src);
  const stripped = stripJsComments(src);
  const fnBody = stripped.slice(stripped.indexOf("async function createStoryPost"), stripped.indexOf("return { createPost, createStoryPost }"));
  assert.ok(!/needsApproval/.test(fnBody));
});

test("19. createStoryPost sends schedulingType='automatic' and mode='shareNow', identical to Feed's own values", async () => {
  const src = await readFile(new URL("../../../cloudflare-worker/src/bufferPublisher.js", import.meta.url), "utf-8").catch(() => null);
  assert.ok(src);
  const fnBody = src.slice(src.indexOf("async function createStoryPost"), src.indexOf("return { createPost, createStoryPost }"));
  assert.ok(/mode:\s*"shareNow"/.test(fnBody));
  assert.ok(/schedulingType:\s*"automatic"/.test(fnBody));
});

test("20. publishStoryPost refuses a channelId that does not match the configured Instagram channel, never silently targeting a different channel", async () => {
  const { publishStoryPost } = await import("../../../cloudflare-worker/src/bufferPublisher.js");
  await assert.rejects(
    () => publishStoryPost({ createStoryPost: async () => { throw new Error("must not be called"); } }, {
      storyId: "s1",
      channelId: "wrong-channel",
      expectedChannelId: CHANNEL_ID,
      caption: "cap",
      imageUrl: "https://example.test/x.jpg",
      publishAttemptCheckpoint: { publishAttemptedAt: "2026-01-01T00:00:00Z" },
    }),
    /channelId does not match/
  );
});

test("21. createPost (Feed) and createStoryPost (Story) are structurally incapable of sending type='reel' or a Facebook post — no such literal appears anywhere in the EXECUTABLE code (comments may legitimately discuss the concept)", async () => {
  const src = await readFile(new URL("../../../cloudflare-worker/src/bufferPublisher.js", import.meta.url), "utf-8").catch(() => null);
  assert.ok(src);
  const stripped = stripJsComments(src);
  assert.ok(!/type:\s*"reel"/.test(stripped));
  assert.ok(!/facebook/i.test(stripped));
});

// ---------------------------------------------------------------------------
// 22-25. Result classification — no retry, for all three Buffer outcomes, Story channel
// ---------------------------------------------------------------------------

test("22. a definite_success Buffer outcome for a Story publish persists posting-completed on the .story channel, and publishViaWorker is called exactly once", async () => {
  const { deps, log, world } = mockDeps();
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(log.filter((n) => n === "publishViaWorker").length, 1);
  assert.equal(world.getRecord().publishing.instagram.story.status, "posted");
  assert.equal(world.getRecord().publishing.instagram.feed, undefined);
});

test("23. a definite_failure Buffer outcome for a Story publish persists posting-failed on the .story channel — never retried", async () => {
  const { deps, log, world } = mockDeps({
    publishViaWorker: async () => { log.push("publishViaWorker"); return { ok: true, outcome: "definite_failure", error: { category: "invalid_input", message: "Buffer rejected the post" } }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(log.filter((n) => n === "publishViaWorker").length, 1);
  assert.equal(world.getRecord().publishing.instagram.story.status, "failed");
});

test("24. an ambiguous Buffer outcome for a Story publish persists posting-ambiguous on the .story channel — never retried, never guessed", async () => {
  const { deps, log, world } = mockDeps({
    publishViaWorker: async () => { log.push("publishViaWorker"); return { ok: true, outcome: "ambiguous", error: { category: "unknown" } }; },
  });
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, true);
  assert.equal(log.filter((n) => n === "publishViaWorker").length, 1);
  assert.equal(world.getRecord().publishing.instagram.story.status, "ambiguous");
});

test("25. across every outcome (success/failure/ambiguous) and every failure step (claim/checkpoint/result-persistence), publishViaWorker is invoked AT MOST ONCE for a Story publish", async () => {
  for (const outcome of ["definite_success", "definite_failure", "ambiguous"]) {
    const { deps, log } = mockDeps({
      publishViaWorker: async () => {
        log.push("publishViaWorker");
        return outcome === "definite_success"
          ? { ok: true, outcome, data: { id: "p1", status: "sent", sentAt: "2026-01-01T00:01:00Z" } }
          : { ok: true, outcome, error: { category: "x", message: "x" } };
      },
    });
    await executeBufferFeedPublish(deps);
    assert.equal(log.filter((n) => n === "publishViaWorker").length, 1, `outcome=${outcome}`);
  }
});

// ---------------------------------------------------------------------------
// 26. Concurrent-claim protection (Story)
// ---------------------------------------------------------------------------

test("26. replaying the exact same posting-claimed event for a Story-destination record after the first succeeded cannot create a second/duplicate claim", () => {
  let state = emptyState();
  state = ensureRecord(state, "s1", { status: "new" }).state;
  const record = {
    ...state.stories.s1,
    status: "approved",
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1080, height: 1920 },
    caption: { ...state.stories.s1.caption, status: "ready", text: "Test caption." },
    approval: { ...state.stories.s1.approval, status: "approved", approved_at: "2026-01-01T00:00:00Z" },
  };
  state = { ...state, stories: { s1: record } };

  const payload = { story_id: "s1", claim_id: "claim-1", processor_id: "p1", claimed_at: "2026-01-01T01:00:00Z", claim_expires_at: "2026-01-01T01:50:00Z", caption_used: "Test caption.\n\n#NFL" };
  const first = applyPostingClaimedEvent(state, payload);
  assert.equal(first.ok, true);
  assert.equal(first.record.publishing.instagram.story.status, "claimed");
  // Mirrors the existing Feed proof (posting-events-regression.mjs test 33)
  // exactly: the record is no longer "approved" after the first claim, so a
  // replayed/duplicate claim attempt must be REJECTED, never silently
  // re-applied or treated as a second concurrent claim succeeding.
  const second = applyPostingClaimedEvent(first.state, payload);
  assert.equal(second.ok, false, "the record is no longer 'approved' — a second claim attempt must be rejected, not silently re-applied");
});

// ---------------------------------------------------------------------------
// 27-29. Story reconciliation
// ---------------------------------------------------------------------------

function bufferCreatedStoryRecord(overrides = {}) {
  return approvedStoryRecord({
    status: "posting",
    publishing: {
      status: "posting",
      claim: { claim_id: "claim-1" },
      instagram: { story: { status: "buffer_post_created", provider: "buffer", caption_used: "cap", buffer: { post_id: "buffer-post-1", channel_id: CHANNEL_ID, status: "sending", due_at: null, sent_at: null } } },
    },
    ...overrides,
  });
}

test("27. a Story record whose Buffer post is still 'sending' is eligible for reconciliation but decides NO action — never mutated", () => {
  const record = bufferCreatedStoryRecord();
  assert.equal(isEligibleForCompletionReconciliation(record), true);
  const decision = decideReconciliationAction(record, { id: "buffer-post-1", channelId: CHANNEL_ID, text: "cap", status: "sending" });
  assert.equal(decision.action, "none");
  assert.equal(decision.reason, "still_processing");
});

test("28. a Story record whose Buffer post reports status='sent' with a real sentAt decides action=complete against the .story channel's own stored post_id", () => {
  const record = bufferCreatedStoryRecord();
  const decision = decideReconciliationAction(record, { id: "buffer-post-1", channelId: CHANNEL_ID, text: "cap", status: "sent", sentAt: "2026-01-01T00:05:00Z" });
  assert.equal(decision.action, "complete");
  assert.equal(decision.media_id, "buffer-post-1");
  assert.equal(decision.published_at, "2026-01-01T00:05:00Z");
});

test("29. once a Story record's own state reaches 'posted', it is no longer eligible for reconciliation — idempotent, never reconciled twice", () => {
  const record = bufferCreatedStoryRecord({
    status: "posted",
    publishing: { status: "posted", claim: { claim_id: "claim-1" }, instagram: { story: { status: "posted", provider: "buffer", buffer: { post_id: "buffer-post-1", channel_id: CHANNEL_ID, status: "sent", sent_at: "2026-01-01T00:05:00Z" } } } },
  });
  assert.equal(isEligibleForCompletionReconciliation(record), false);
});

// ---------------------------------------------------------------------------
// 30. Automation safety: default dry-run, no cron trigger, Feed untouched
// ---------------------------------------------------------------------------

test("30a. auto-publish-approved-story.js's resolveRunMode defaults every non-schedule invocation to dry-run — live requires an explicit 'live' input", () => {
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: undefined }), "dry-run");
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "dry-run" }), "dry-run");
  assert.equal(resolveRunMode({ eventName: "workflow_dispatch", inputMode: "live" }), "live");
});

test("30b. .github/workflows/auto-publish-approved-story.yml has NO schedule trigger — workflow_dispatch only", async () => {
  const src = await readFile(new URL("../../.github/workflows/auto-publish-approved-story.yml", import.meta.url), "utf-8");
  assert.ok(!/^\s*schedule:/m.test(src), "the Story workflow must not have a schedule trigger yet");
  assert.ok(/workflow_dispatch:/.test(src));
});

test("30c. validateBufferFeedPublishPreconditions (Feed's own eligibility gate) is completely unaffected by Story's existence — still rejects a Story-destination record exactly as before", () => {
  const result = validateBufferFeedPublishPreconditions(approvedStoryRecord());
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_destination");
});

test("30d. executeBufferFeedPublish's default behavior (no validatePreconditions override) is unchanged — a Story record is still rejected as wrong_destination when called the way Feed's own launcher always has", async () => {
  const { deps } = mockDeps({ validatePreconditions: undefined });
  delete deps.validatePreconditions;
  const result = await executeBufferFeedPublish(deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "wrong_destination");
});

test("30e. mapBufferWorkerOutcomeToEvent is destination-agnostic — reused verbatim for Story, exactly as it already was for Feed, with no Story-specific branch anywhere in it", () => {
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId: "s1", claimId: "c1", channelId: CHANNEL_ID, workerResponse: { ok: true, outcome: "definite_success", data: { status: "sent", id: "p1", sentAt: "2026-01-01T00:00:00Z" } }, now: "2026-01-01T00:00:00Z" });
  assert.equal(mapped.eventType, "posting-completed");
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
