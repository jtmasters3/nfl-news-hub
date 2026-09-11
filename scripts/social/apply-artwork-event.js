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
import { readSocialState, writeSocialState, buildQueueEntries } from "../lib/socialState.js";
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
} from "../lib/postingEvents.js";
import { generatePostsForApproval } from "../generate-posts-for-approval.js";
import { writeFile } from "node:fs/promises";
import { SOCIAL_ARTWORK_QUEUE_JSON_PATH } from "../lib/store.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIPPABLE_ERRORS = new Set([
  "not_found",
  "claim_mismatch",
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
  }
  return null;
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
  const result = await applyEventByType(state, eventType, payload);

  if (result === null) {
    console.error(`Unknown ARTWORK_EVENT_TYPE: ${eventType}`);
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    if (
      SKIPPABLE_ERRORS.has(result.error) ||
      String(result.error).startsWith("invalid_transition") ||
      String(result.error).startsWith("invalid_state") ||
      String(result.error).startsWith("invalid_feed_state")
    ) {
      console.log(`Skipped (no-op): ${eventType} for ${payload.story_id} — ${result.error}`);
      return;
    }
    console.error(`Failed to apply ${eventType} for ${payload.story_id}: ${result.error}`);
    process.exitCode = 1;
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
