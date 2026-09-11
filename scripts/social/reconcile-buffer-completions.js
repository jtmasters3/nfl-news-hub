#!/usr/bin/env node
// Thin dependency-wiring layer for automatic Buffer completion
// reconciliation (the async-completion gap identified after the Myles
// Garrett live test). Every actual decision lives in the pure
// scripts/social-worker/lib/bufferCompletionReconciler.js — this file only
// wires real HTTP-calling dependencies to it, exactly like
// scripts/social/publish-buffer-feed.js does for the live publisher.
//
// NEVER calls Buffer's createPost mutation and NEVER calls Meta — it only
// (a) reads the current authoritative social state via the SHA-pinned
// fetcher, (b) calls the EXISTING read-only /social/posting/reconcile
// endpoint for each already-buffer_post_created record, and (c) for a
// genuine terminal Buffer outcome (sent or error), persists the matching
// EXISTING result event via /social/posting/result. Both endpoints already
// existed before this stage; neither is modified here.
//
// Intended to run on a schedule (see
// .github/workflows/reconcile-buffer-completions.yml) — every invocation is
// idempotent and safe to run repeatedly; a story that has already reached
// "posted" is structurally excluded from consideration on the next run.
//
// Required environment variables:
//   AGGREGATE_ARTWORK_API_TOKEN   - the Worker's shared bearer token
// Optional:
//   ARTWORK_WORKER_BASE_URL       - defaults to the deployed Worker's real URL
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFreshStateFetcher } from "../social-worker/lib/githubStateReader.js";
import { createBufferPostingBridge } from "../social-worker/lib/bufferPostingBridge.js";
import { runBufferCompletionReconciliation, isEligibleForCompletionReconciliation } from "../social-worker/lib/bufferCompletionReconciler.js";

// Non-secret; the Worker's own real deployed URL — matches
// scripts/social/publish-buffer-feed.js's own DEFAULT_CHANNEL_ID pattern of
// hardcoding a known-safe default with an env override.
const DEFAULT_WORKER_BASE_URL = "https://aggregate-artwork-bridge.jtmasters3.workers.dev";

export async function main({ fetchState = createFreshStateFetcher(), bridge } = {}) {
  const workerBaseUrl = process.env.ARTWORK_WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL;
  const workerApiToken = process.env.AGGREGATE_ARTWORK_API_TOKEN;
  if (!workerApiToken) throw new Error("AGGREGATE_ARTWORK_API_TOKEN is not set.");

  const realBridge = bridge ?? createBufferPostingBridge({ fetchImpl: fetch, workerBaseUrl, workerApiToken });

  const state = await fetchState();
  const eligibleCount = Object.values(state?.stories ?? {}).filter(isEligibleForCompletionReconciliation).length;
  console.log(`Eligible records (publishing.status=posting, feed.status=buffer_post_created, provider=buffer, buffer_post_id present): ${eligibleCount}`);

  if (eligibleCount === 0) {
    console.log("Nothing to reconcile.");
    return { ok: true, results: [] };
  }

  const results = await runBufferCompletionReconciliation(state, {
    reconcileStory: (storyId) => realBridge.reconcile({ storyId }),
    applyResult: ({ story_id, claim_id, event_type, payload }) => realBridge.recordPostingResult({ storyId: story_id, claimId: claim_id, eventType: event_type, payload }),
  });

  for (const r of results) {
    if (r.action === "none") {
      console.log(`${r.story_id}: no action (${r.detail})`);
    } else {
      console.log(`${r.story_id}: ${r.action} -> dispatch ${r.applied ? "accepted" : `FAILED (${r.applyError})`}`);
    }
  }

  return { ok: true, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("reconcile-buffer-completions failed:", err);
    process.exitCode = 1;
  });
}
