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
// The fix below is a BOUNDED retry, entered ONLY for the specific
// "claim_mismatch" error (never for "not_found"/"invalid_state"/etc.,
// which mean the record has legitimately already moved on or never
// existed and must stay an immediate, silent no-op exactly as before):
// re-fetch state via a FRESH, SHA-pinned GitHub REST API read (the same
// proven pattern githubStateReader.js already uses for the Approval
// Console — never the frozen local checkout, never the mutable
// raw.githubusercontent.com/main/ URL) and re-apply the SAME reducer.
// Once the sibling event's commit becomes visible, the retry succeeds and
// applies the event exactly once — the loop stops immediately on success,
// never re-applying afterward. If claim_mismatch still persists once the
// retry budget is exhausted, the workflow now FAILS (non-zero exit)
// instead of silently succeeding — a required durable state transition
// that never actually happened must never be reported as a success. This
// also correctly keeps rejecting (by design, never as a workflow
// "failure" requiring retry) any completion event whose claim_id belongs
// to a genuinely different, already-superseded claim — that mismatch
// reflects real committed state, not staleness, and retrying it changes
// nothing; see this file's own tests for exactly which case is which.
const CLAIM_MISMATCH_RETRY_ATTEMPTS = 5;
const CLAIM_MISMATCH_RETRY_INTERVAL_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the ABSOLUTE latest committed data/social-state.json directly via
 * GitHub's REST API, pinned to the latest commit SHA — never the frozen
 * local git checkout, never a long-TTL CDN URL. Used ONLY as the
 * claim_mismatch retry fallback below; the normal fast path still reads
 * the local checkout via readSocialState(), unchanged.
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
import { writeFile } from "node:fs/promises";
import { SOCIAL_ARTWORK_QUEUE_JSON_PATH } from "../lib/store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "claim_mismatch" is deliberately NOT in this set — see this file's own
// 2026-09-11 durability-fix header comment above. It now goes through a
// bounded retry-against-fresh-state path in main() first; only a
// genuinely unresolvable mismatch (a real, different, already-committed
// claim) falls through to a silent no-op, and one that never resolves at
// all within the retry budget fails the workflow instead of silently
// succeeding.
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
 * local-checkout) state when the first attempt returns exactly
 * "claim_mismatch" — see this file's own 2026-09-11 header comment for the
 * exact race this closes. Every dependency is injectable so this can be
 * tested deterministically, with no real network call, no real timer, and
 * no dependency on the actual local filesystem checkout.
 * @param {object} initialState - the normal (local-checkout) state, already read
 * @param {string} eventType
 * @param {object} payload
 * @param {{applyEventByTypeImpl?: Function, fetchFreshStateImpl?: Function, sleepImpl?: Function, attempts?: number, intervalMs?: number, onRetry?: Function}} [opts]
 * @returns {Promise<object|null>} the SAME shape applyEventByType returns — null for an unrecognized event type, otherwise `{ok, ...}`
 */
export async function applyEventWithClaimMismatchRetry(
  initialState,
  eventType,
  payload,
  {
    applyEventByTypeImpl = applyEventByType,
    fetchFreshStateImpl = fetchFreshStateFromGitHub,
    sleepImpl = sleep,
    attempts = CLAIM_MISMATCH_RETRY_ATTEMPTS,
    intervalMs = CLAIM_MISMATCH_RETRY_INTERVAL_MS,
    onRetry,
  } = {}
) {
  let result = await applyEventByTypeImpl(initialState, eventType, payload);
  if (result === null || result.ok || result.error !== "claim_mismatch") {
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
    if (result.ok || result.error !== "claim_mismatch") break;
  }

  return result;
}

/**
 * Pure decision step for what main() does with the retry-wrapper's result —
 * extracted so the one property this whole fix exists to guarantee ("a
 * workflow must NEVER report semantic success for an unresolved
 * claim_mismatch") can be tested without any file I/O, network call, or
 * environment variable. Behavior is unchanged from the inline version this
 * replaced; every message string is identical.
 * @param {object|null} result - applyEventWithClaimMismatchRetry's return value
 * @param {{eventType: string, storyId: string, retryAttempts?: number}} ctx
 * @returns {{action: "unknown_event"|"claim_mismatch_unresolved"|"skip"|"fail"|"apply", message: string|null}}
 */
export function determineApplyOutcome(result, { eventType, storyId, retryAttempts = CLAIM_MISMATCH_RETRY_ATTEMPTS }) {
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
  const result = await applyEventWithClaimMismatchRetry(state, eventType, payload, {
    onRetry: (attempt, attempts, err) => {
      if (err) console.error(`Fresh state fetch failed during claim_mismatch retry (attempt ${attempt}/${attempts}): ${err.message}`);
      else console.log(`claim_mismatch for ${eventType} on ${payload.story_id} — retrying against fresh, SHA-pinned state (attempt ${attempt}/${attempts})...`);
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
