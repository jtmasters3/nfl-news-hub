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
import { generatePostsForApproval } from "../generate-posts-for-approval.js";
import { writeFile } from "node:fs/promises";
import { SOCIAL_ARTWORK_QUEUE_JSON_PATH } from "../lib/store.js";

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
  let result;

  if (eventType === "artwork-claimed") {
    result = applyClaimEvent(state, payload);
  } else if (eventType === "artwork-completed") {
    const reachable = await checkReachable(payload.image_url);
    result = applyCompleteEvent(state, payload, { reachable });
  } else if (eventType === "artwork-failed") {
    result = applyFailEvent(state, payload);
  } else if (eventType === "caption-claimed") {
    result = applyCaptionClaimEvent(state, payload);
  } else if (eventType === "caption-completed") {
    result = applyCaptionCompleteEvent(state, payload);
  } else if (eventType === "caption-failed") {
    result = applyCaptionFailEvent(state, payload);
  } else {
    console.error(`Unknown ARTWORK_EVENT_TYPE: ${eventType}`);
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    if (SKIPPABLE_ERRORS.has(result.error) || String(result.error).startsWith("invalid_transition") || String(result.error).startsWith("invalid_state")) {
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

main().catch((err) => {
  console.error("apply-artwork-event failed:", err);
  process.exitCode = 1;
});
