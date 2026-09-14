#!/usr/bin/env node
// Runs inside .github/workflows/social-artwork-event.yml — the only code
// that ever applies an artwork- or caption-bridge event (claimed/
// completed/failed for either, fired by the Cloudflare Worker via
// repository_dispatch) to data/social-state.json. Reads the event type +
// payload from env vars the workflow sets from github.event.action /
// github.event.client_payload, applies exactly one of the pure handlers in
// scripts/lib/artworkEvents.js or scripts/lib/captionEvents.js (both just
// call scripts/lib/socialState.js's existing transition()), writes state,
// and regenerates the two derived files that depend on it. Never touches
// news.json, never runs clustering/ingestion.
//
// Deliberately tolerant of "this event no longer applies" (e.g. a
// duplicate delivery, or a race where the record already moved on) —
// exits 0 and logs a skip rather than failing the workflow, since
// repository_dispatch has at-least-once delivery semantics and this
// script must be idempotent, not merely retried.
//
// ==========================================================================
// 2026-09-11 durability fix — claim_mismatch checkout-staleness race
// ==========================================================================
// Root cause (proven against a real production run, story_id
// 8e0f60e2-3e8e-4028-b141-05f8286466ce): two events for the SAME story
// (caption-claimed, then caption-completed moments later) are dispatched
// independently and land as two SEPARATE, CONCURRENT GitHub Actions runs
// with no ordering guarantee between them. Each run's actions/checkout@v7
// step clones `main` at that run's own start time — readSocialState()
// below reads that FROZEN local checkout, never anything fresher, for the
// rest of the job's lifetime. The observed failure: the caption-completed
// run's checkout happened 14 seconds BEFORE the caption-claimed run's own
// commit landed on `main`, so this script's local state showed no claim at
// all yet -> applyCaptionCompleteEvent's own (unmodified, still-correct)
// claim_id check legitimately returned "claim_mismatch" -> that error was
// (before this fix) unconditionally treated as a silent, expected no-op,
// so the job exited 0 with zero state mutation and no visible signal that
// anything was wrong.
//
// This is NOT a caption-generation bug, NOT a validation bug, and NOT
// fixed by regenerating anything — the underlying artwork and caption
// content were already correct. It is purely a "which snapshot of
// data/social-state.json did this job happen to see" problem.
//
// The fix below is a BOUNDED retry, entered ONLY for "claim_mismatch" and
// (see the 2026-09-14 addition further below) "invalid_state:*" — never
// for "not_found"/"invalid_transition"/"invalid_feed_state"/etc., which
// mean the record has legitimately already moved on or never existed and
// must stay an immediate, silent no-op exactly as before: re-fetch state
// via a FRESH, SHA-pinned GitHub REST API read (the same proven pattern
// githubStateReader.js already uses for the Approval Console — never the
// frozen local checkout, never the mutable raw.githubusercontent.com/main/
// URL) and re-apply the SAME reducer. Once the sibling event's commit
// becomes visible, the retry succeeds and applies the event exactly once —
// the loop stops immediately on success, never re-applying afterward. If
// claim_mismatch still persists once the retry budget is exhausted, the
// workflow now FAILS (non-zero exit) instead of silently succeeding — a
// required durable state transition that never actually happened must
// never be reported as a success. This also correctly keeps rejecting (by
// design, never as a workflow "failure" requiring retry) any completion
// event whose claim_id belongs to a genuinely different, already-superseded
// claim — that mismatch reflects real committed state, not staleness, and
// retrying it changes nothing; see this file's own tests for exactly which
// case is which.
//
// ==========================================================================
// 2026-09-14 durability fix — invalid_state checkout-staleness race
// (artwork-claimed -> artwork-completed)
// ==========================================================================
// Root cause (proven against a real production run, story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd): removing the local Windows Codex
// dependency (see process-one.js's own header) made artwork generation
// dramatically faster — a deterministic render instead of a multi-minute
// AI image-generation call — which shrank the gap between an
// artwork-claimed dispatch and its own artwork-completed dispatch (both
// fired from the SAME process-one.js run) to just a couple of seconds.
// Confirmed via the real GitHub Actions run timestamps: the
// artwork-completed run started at 16:59:45Z, 7 seconds BEFORE the
// artwork-claimed run's own commit landed on `main` at 16:59:52Z — so
// applyCompleteEvent's local-checkout read still showed "queued", not yet
// "artwork_requested", and its own (unmodified, still-correct) status
// check legitimately returned "invalid_state:queued". Before this fix,
// EVERY invalid_state:* error was an immediate, unconditional no-op —
// exactly the same class of silent data loss the claim_mismatch fix above
// closed, just reached through a different reducer error string. The
// downstream symptom was a Story-only record whose caption claim then
// polled "not_artwork_ready" for the full budget: not a destination-
// awareness bug in the caption-claim path (which was already correct),
// but the record genuinely never reaching "artwork_ready" at all.
//
// invalid_state:* now gets the SAME bounded retry-against-fresh-state
// treatment as claim_mismatch. It deliberately does NOT get escalated to a
// workflow failure if still unresolved after the retry budget, unlike
// claim_mismatch — invalid_state also legitimately covers ordinary
// at-least-once-delivery duplicates (a late-arriving event for a record
// that has since moved on for real, unrelated reasons) far more often than
// claim_mismatch's narrower "a claim_id genuinely doesn't match" case, so
// escalating every unresolved invalid_state would turn routine, harmless
// duplicate deliveries into false-alarm red builds. The retry exists only
// to give the checkout-staleness scenario a fair chance to resolve; a
// mismatch that persists past that is treated exactly as it always was.
//
// ==========================================================================
// 2026-09-14 durability fix #3 — retry budget too short for queued siblings
// (caption-claimed -> caption-completed)
// ==========================================================================
// Root cause (proven against a real production run, story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd, claim_id
// bffb0dee-f833-4f7f-a7d2-3419eadedf18, via exact GitHub Actions job/step
// timestamps — not inferred): the caption-completed run's own checkout
// (18:40:39-41Z) predated the caption-claimed commit (18:41:12Z) by over 30
// seconds, so applyCaptionCompleteEvent's claim_id check legitimately
// returned "claim_mismatch" on every attempt. The retry loop DID engage
// (claim_mismatch is retryable) and DID use a fresh, SHA-pinned read each
// time — it was not a coverage gap (mechanism A) — but it exhausted its
// then-5x3000ms=15s budget at 18:40:59Z, 13 seconds before the sibling
// commit landed. Confirmed via the jobs API that the sibling claimed run
// (34882248213) did not even START until 18:41:06Z, itself 7 seconds AFTER
// this job's retry had already given up — because both events'
// repository_dispatch webhooks reached GitHub only ~1 second apart
// (created_at 18:40:35Z vs 18:40:36Z) and the single global
// `concurrency: group: social-artwork-event` queue happened to run the
// COMPLETED job first, serializing the CLAIMED job's entire run (checkout,
// npm install, apply, commit, push) behind it. This is mechanism B ("retry
// budget expired before the prerequisite state became visible"), made
// materially worse by making caption composition itself deterministic and
// fast (see the 2026-09-14 invalid_state fix above for the same dynamic on
// the artwork side): claim and completion can now be dispatched close
// enough together that ordinary webhook-delivery jitter can queue them in
// EITHER order, and the shared concurrency group means a job can be
// serialized entirely behind an unrelated sibling before it even starts.
//
// Fix: raise the retry budget from 15s to 60s (20x3000ms), matching the
// SAME DURABLE_COMMIT_POLL_MAX_ATTEMPTS/INTERVAL_MS budget
// waitForDurableCommit.js already uses for exactly this class of "dispatch
// accepted, wait for it to become durable" polling elsewhere in this
// system — not a new, arbitrary number. 60s comfortably covers the
// observed ~32s real-world gap (retry start to sibling commit landing)
// with margin for a slower npm install or a second queued job ahead of it.
// This does not weaken claim matching or allow a stale claim to be
// accepted — the reducer's own claim_id equality check is untouched; only
// how long we wait for the CORRECT claim to become visible changes. See
// verify-durable-push.js for the companion post-push durable-verification
// check this fix pairs with (Section 4's "if durable verification fails,
// the workflow must fail RED" requirement).
export const STALE_CHECKOUT_RETRY_ATTEMPTS = 20;
export const STALE_CHECKOUT_RETRY_INTERVAL_MS = 3000;

/** True for exactly the two error shapes proven to sometimes be pure checkout staleness rather than a genuine, permanent rejection. */
function isRetryableStalenessError(error) {
  return error === "claim_mismatch" || String(error).startsWith("invalid_state");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the ABSOLUTE latest committed data/social-state.json directly via
 * GitHub's REST API, pinned to the latest commit SHA — never the frozen
 * local git checkout, never a long-TTL CDN URL. Used ONLY as the
 * claim_mismatch/invalid_state retry fallback below; the normal fast path
 * still reads the local checkout via readSocialState(), unchanged.
 */
async function fetchFreshStateFromGitHub() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN;
  const sha = await getLatestCommitSha({ token });
  const data = await fetchStateAtCommit({ commitSha: sha, token });
  return normalizeStateShape(data);
}
import { readSocialState, writeSocialState, buildQueueEntries, normalizeStateShape } from "../lib/socialState.js";
import { getLatestCommitSha, fetchStateAtCommit } from "../social-worker/lib/githubStateReader.js";
import { applyClaimEvent, applyCompleteEvent, applyFailEvent } from "../lib/artworkEvents.js";
import { applyCaptionClaimEvent, applyCaptionCompleteEvent, applyCaptionFailEvent } from "../lib/captionEvents.js";
import { applyApprovalApprovedEvent, applyApprovalRejectedEvent } from "../lib/approvalEvents.js";
import { applyStoryArtworkClaimEvent, applyStoryArtworkCompleteEvent, applyStoryArtworkFailEvent } from "../lib/storyArtworkEvents.js";
import { applyFeedRegenerateCompleteEvent, applyFeedRegenerateFailEvent, applyStoryRegenerateCompleteEvent, applyStoryRegenerateFailEvent } from "../lib/regenerationEvents.js";
import {
  applyPostingClaimedEvent,
  applyPostingContainerCreatedEvent,
  applyPostingBufferCreatedEvent,
  applyPostingPublishAttemptedEvent,
  applyPostingCompletedEvent,
  applyPostingFailedEvent,
  applyPostingAmbiguousEvent,
  applyPostingManuallyConfirmedNotPostedEvent,
  applyPostingFailureResetEvent,
  applyPostingManuallyConfirmedPostedEvent,
} from "../lib/postingEvents.js";
import { generatePostsForApproval } from "../generate-posts-for-approval.js";
import { writeFile, mkdir } from "node:fs/promises";
import { SOCIAL_ARTWORK_QUEUE_JSON_PATH, DURABLE_EXPECTATION_PATH } from "../lib/store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "claim_mismatch" is deliberately NOT in this set — see this file's own
// 2026-09-11 durability-fix header comment above. It now goes through a
// bounded retry-against-fresh-state path in main() first; only a
// genuinely unresolvable mismatch (a real, different, already-committed
// claim) falls through to a silent no-op, and one that never resolves at
// all within the retry budget fails the workflow instead of silently
// succeeding. "invalid_state:*" is matched separately (via a prefix check
// below, same as before) rather than listed here, since it also now goes
// through the SAME retry path first (see this file's own 2026-09-14
// header) — unlike claim_mismatch, though, a still-unresolved invalid_state
// after the retry budget remains this ordinary silent skip, never a
// workflow failure.
const SKIPPABLE_ERRORS = new Set([
  "not_found",
  "redirect_loop",
  "max_depth_exceeded",
]);

async function checkReachable(url, { timeoutMs = 10_000 } = {}) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", signal: controller.signal });
    if (!res.ok) res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function regenerateDerivedFiles(state) {
  const queueEntries = buildQueueEntries(state);
  await writeFile(SOCIAL_ARTWORK_QUEUE_JSON_PATH, JSON.stringify(queueEntries, null, 2) + "\n", "utf-8");
  await generatePostsForApproval();
}

/**
 * The single dispatch table mapping a repository_dispatch event type to its
 * pure reducer — extracted from main() as its own exported, testable
 * function so the routing itself (does this event type reach the right
 * reducer, does an exact replay stay idempotent, does a wrong claim get
 * rejected) can be verified WITHOUT touching the real data/social-state.json
 * file or firing a real dispatch. Behavior is unchanged from before this
 * extraction — same event types, same reducers, same "checkReachable before
 * a completion event" pattern. Returns `null` for an unrecognized event
 * type (main() logs and exits 1 in that case), otherwise the reducer's own
 * `{ok, ...}` result.
 * @param {object} state
 * @param {string} eventType
 * @param {object} payload
 * @param {{checkReachable?: Function}} [deps] - test-only override for the image-reachability check
 */
export async function applyEventByType(state, eventType, payload, { checkReachable: checkReachableImpl = checkReachable } = {}) {
  if (eventType === "artwork-claimed") {
    return applyClaimEvent(state, payload);
  } else if (eventType === "artwork-completed") {
    const reachable = await checkReachableImpl(payload.image_url);
    return applyCompleteEvent(state, payload, { reachable });
  } else if (eventType === "artwork-failed") {
    return applyFailEvent(state, payload);
  } else if (eventType === "caption-claimed") {
    return applyCaptionClaimEvent(state, payload);
  } else if (eventType === "caption-completed") {
    return applyCaptionCompleteEvent(state, payload);
  } else if (eventType === "caption-failed") {
    return applyCaptionFailEvent(state, payload);
  } else if (eventType === "approval-approved") {
    return applyApprovalApprovedEvent(state, payload);
  } else if (eventType === "approval-rejected") {
    return applyApprovalRejectedEvent(state, payload);
  } else if (eventType === "story-artwork-claimed") {
    return applyStoryArtworkClaimEvent(state, payload);
  } else if (eventType === "story-artwork-completed") {
    const reachable = await checkReachableImpl(payload.image_url);
    return applyStoryArtworkCompleteEvent(state, payload, { reachable });
  } else if (eventType === "story-artwork-failed") {
    return applyStoryArtworkFailEvent(state, payload);
  } else if (eventType === "feed-regenerate-completed") {
    const reachable = await checkReachableImpl(payload.image_url);
    return applyFeedRegenerateCompleteEvent(state, payload, { reachable });
  } else if (eventType === "feed-regenerate-failed") {
    return applyFeedRegenerateFailEvent(state, payload);
  } else if (eventType === "story-regenerate-completed") {
    const reachable = await checkReachableImpl(payload.image_url);
    return applyStoryRegenerateCompleteEvent(state, payload, { reachable });
  } else if (eventType === "story-regenerate-failed") {
    return applyStoryRegenerateFailEvent(state, payload);
  } else if (eventType === "posting-claimed") {
    return applyPostingClaimedEvent(state, payload);
  } else if (eventType === "posting-container-created") {
    return applyPostingContainerCreatedEvent(state, payload);
  } else if (eventType === "posting-buffer-created") {
    return applyPostingBufferCreatedEvent(state, payload);
  } else if (eventType === "posting-publish-attempted") {
    return applyPostingPublishAttemptedEvent(state, payload);
  } else if (eventType === "posting-completed") {
    return applyPostingCompletedEvent(state, payload);
  } else if (eventType === "posting-failed") {
    return applyPostingFailedEvent(state, payload);
  } else if (eventType === "posting-ambiguous") {
    return applyPostingAmbiguousEvent(state, payload);
  } else if (eventType === "posting-manually-confirmed-not-posted") {
    return applyPostingManuallyConfirmedNotPostedEvent(state, payload);
  } else if (eventType === "posting-failure-reset") {
    return applyPostingFailureResetEvent(state, payload);
  } else if (eventType === "posting-manually-confirmed-posted") {
    return applyPostingManuallyConfirmedPostedEvent(state, payload);
  }
  return null;
}

/**
 * Applies one event, transparently retrying against FRESH (never frozen
 * local-checkout) state when the first attempt returns a retryable
 * checkout-staleness error — "claim_mismatch" (2026-09-11) or
 * "invalid_state:*" (2026-09-14) — see this file's own header comments for
 * the exact two races this closes. Every dependency is injectable so this
 * can be tested deterministically, with no real network call, no real
 * timer, and no dependency on the actual local filesystem checkout.
 * @param {object} initialState - the normal (local-checkout) state, already read
 * @param {string} eventType
 * @param {object} payload
 * @param {{applyEventByTypeImpl?: Function, fetchFreshStateImpl?: Function, sleepImpl?: Function, attempts?: number, intervalMs?: number, onRetry?: Function}} [opts]
 * @returns {Promise<object|null>} the SAME shape applyEventByType returns — null for an unrecognized event type, otherwise `{ok, ...}`
 */
export async function applyEventWithStalenessRetry(
  initialState,
  eventType,
  payload,
  {
    applyEventByTypeImpl = applyEventByType,
    fetchFreshStateImpl = fetchFreshStateFromGitHub,
    sleepImpl = sleep,
    attempts = STALE_CHECKOUT_RETRY_ATTEMPTS,
    intervalMs = STALE_CHECKOUT_RETRY_INTERVAL_MS,
    onRetry,
  } = {}
) {
  let result = await applyEventByTypeImpl(initialState, eventType, payload);
  if (result === null || result.ok || !isRetryableStalenessError(result.error)) {
    return result;
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleepImpl(intervalMs);
    let freshState;
    try {
      freshState = await fetchFreshStateImpl();
    } catch (err) {
      onRetry?.(attempt, attempts, err);
      continue;
    }
    onRetry?.(attempt, attempts, null);
    result = await applyEventByTypeImpl(freshState, eventType, payload);
    if (result.ok || !isRetryableStalenessError(result.error)) break;
  }

  return result;
}

/**
 * Pure decision step for what main() does with the retry-wrapper's result —
 * extracted so the one property this whole fix exists to guarantee ("a
 * workflow must NEVER report semantic success for an unresolved
 * claim_mismatch") can be tested without any file I/O, network call, or
 * environment variable. Behavior is unchanged from the inline version this
 * replaced; every message string is identical. invalid_state:* (2026-09-14)
 * ALSO goes through the retry above, but — unlike claim_mismatch — still
 * falls through to the ordinary silent skip if it never resolves, per this
 * file's own 2026-09-14 header comment.
 * @param {object|null} result - applyEventWithStalenessRetry's return value
 * @param {{eventType: string, storyId: string, retryAttempts?: number}} ctx
 * @returns {{action: "unknown_event"|"claim_mismatch_unresolved"|"skip"|"fail"|"apply", message: string|null}}
 */
export function determineApplyOutcome(result, { eventType, storyId, retryAttempts = STALE_CHECKOUT_RETRY_ATTEMPTS }) {
  if (result === null) {
    return { action: "unknown_event", message: `Unknown ARTWORK_EVENT_TYPE: ${eventType}` };
  }

  if (!result.ok) {
    if (result.error === "claim_mismatch") {
      // Unlike every other skippable error, this must NEVER report a
      // silent success: either the sibling commit this event actually
      // depends on never became visible within the retry budget (a
      // required durable state transition did not occur), or this
      // completion genuinely belongs to a claim that has since been
      // superseded — either way it must be visible, not swallowed. See
      // this file's own 2026-09-11 header comment for the full reasoning.
      return {
        action: "claim_mismatch_unresolved",
        message: `claim_mismatch for ${eventType} on ${storyId} persisted after ${retryAttempts} retries against fresh state. Failing the workflow rather than reporting a false success.`,
      };
    }
    if (
      SKIPPABLE_ERRORS.has(result.error) ||
      String(result.error).startsWith("invalid_transition") ||
      String(result.error).startsWith("invalid_state") ||
      String(result.error).startsWith("invalid_feed_state")
    ) {
      return { action: "skip", message: `Skipped (no-op): ${eventType} for ${storyId} — ${result.error}` };
    }
    return { action: "fail", message: `Failed to apply ${eventType} for ${storyId}: ${result.error}` };
  }

  return { action: "apply", message: null };
}

/**
 * Companion to the 2026-09-14 durability fix #3 above (retry budget). Even
 * with a generous retry budget, "this job's local write succeeded" is not
 * the same claim as "this reached origin/main" — the actual commit/push
 * happens in a LATER, separate step of the workflow YAML, outside this
 * process. Computes the one fact worth re-verifying, from a genuinely
 * FRESH post-push GitHub read, before the workflow is allowed to report
 * success for a caption-completed event: that the exact caption text this
 * job just accepted is the caption text that actually landed. Scoped
 * narrowly to caption-completed (the event this incident was about) rather
 * than generalized to every completion event type, and only for the
 * validation-passed branch — a server-side-rejected candidate's own
 * retry/re-claim behavior is already covered by applyCaptionFailEvent's
 * existing, separately-tested contract and isn't part of this durability
 * gap. Returns null when there is nothing new worth verifying (every other
 * event type, or a caption-completed whose validation did not pass).
 * @param {string} eventType
 * @param {object} payload
 * @param {{ok: boolean, validation?: {passed: boolean}}|null} result - a successful applyEventWithStalenessRetry result
 * @returns {{path: string[], expected: string}|null}
 */
export function computeDurableExpectation(eventType, payload, result) {
  if (eventType !== "caption-completed") return null;
  if (!result?.ok || result.validation?.passed !== true) return null;
  return { path: ["caption", "text"], expected: payload.text };
}

async function main() {
  const eventType = process.env.ARTWORK_EVENT_TYPE;
  const payloadRaw = process.env.ARTWORK_EVENT_PAYLOAD;

  if (!eventType || !payloadRaw) {
    console.error("ARTWORK_EVENT_TYPE and ARTWORK_EVENT_PAYLOAD must both be set.");
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (err) {
    console.error(`ARTWORK_EVENT_PAYLOAD is not valid JSON: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!payload.story_id || typeof payload.story_id !== "string") {
    console.error("payload.story_id is required.");
    process.exitCode = 1;
    return;
  }

  const state = await readSocialState();
  const result = await applyEventWithStalenessRetry(state, eventType, payload, {
    onRetry: (attempt, attempts, err) => {
      if (err) console.error(`Fresh state fetch failed during checkout-staleness retry (attempt ${attempt}/${attempts}): ${err.message}`);
      else console.log(`Possible checkout staleness for ${eventType} on ${payload.story_id} — retrying against fresh, SHA-pinned state (attempt ${attempt}/${attempts})...`);
    },
  });

  const outcome = determineApplyOutcome(result, { eventType, storyId: payload.story_id });

  if (outcome.action === "unknown_event" || outcome.action === "claim_mismatch_unresolved" || outcome.action === "fail") {
    console.error(outcome.message);
    process.exitCode = 1;
    return;
  }

  if (outcome.action === "skip") {
    console.log(outcome.message);
    return;
  }

  await writeSocialState(result.state);
  await regenerateDerivedFiles(result.state);

  const durableExpectation = computeDurableExpectation(eventType, payload, result);
  if (durableExpectation) {
    await mkdir(path.dirname(DURABLE_EXPECTATION_PATH), { recursive: true });
    await writeFile(DURABLE_EXPECTATION_PATH, JSON.stringify({ story_id: payload.story_id, ...durableExpectation }, null, 2) + "\n", "utf-8");
  }

  const finalStatus = result.record?.status ?? result.state.stories[payload.story_id]?.status;
  console.log(`Applied ${eventType} for ${payload.story_id} -> ${finalStatus}`);
  if (result.validation) {
    console.log(`Validation: ${result.validation.passed ? "passed" : "failed"}${result.validation.issues.length ? ` (${result.validation.issues.join(", ")})` : ""}`);
  }
  if (result.recovered) {
    console.log("Lease recovery: claimed after previous lease expired.");
  }
  if (result.idempotentReplay) {
    console.log("Idempotent replay: identical event already applied, no new state written.");
  }
  if ("escalatedToFailed" in result) {
    console.log(
      result.escalatedToFailed
        ? "Caption claim_attempt_count cap reached — escalated to failed for human review."
        : "Caption claim run exhausted but retryable — story remains at artwork_ready."
    );
  }
  if ("alreadyFailed" in result && result.alreadyFailed) {
    console.log("Story was already in a terminal failed state — diagnostics appended only.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("apply-artwork-event failed:", err);
    process.exitCode = 1;
  });
}
