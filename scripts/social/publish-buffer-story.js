#!/usr/bin/env node
// The Story sibling of publish-buffer-feed.js. A THIN DEPENDENCY-WIRING
// LAYER ONLY — every actual sequencing/durability decision (claim ->
// confirm -> checkpoint -> confirm -> Buffer -> map -> result -> confirm)
// lives in the SAME already-proven
// scripts/social-worker/lib/bufferFeedOrchestrator.js's
// executeBufferFeedPublish, reused here (not duplicated) by passing Story's
// own precondition check, JPEG resolver, and Worker-publish adapter as
// dependencies. This file never contains embedded credentials; every
// secret comes from the environment only.
//
// Usage:
//   Dry-run / preflight (the default — always safe, NEVER mutates anything):
//     node scripts/social/publish-buffer-story.js <story_id>
//
//   Live (the ONLY way this script can ever call Buffer) — requires BOTH an
//   explicit --live flag AND an exact --confirm-story match of the same
//   story_id, so a bare/careless invocation can never accidentally publish:
//     node scripts/social/publish-buffer-story.js <story_id> --live --confirm-story <story_id>
//
// Required environment variables (LIVE mode only):
//   ARTWORK_WORKER_BASE_URL       - the deployed Worker's base URL
//   AGGREGATE_ARTWORK_API_TOKEN   - the Worker's shared bearer token
// Optional:
//   BUFFER_INSTAGRAM_CHANNEL_ID   - non-secret; defaults to the known
//                                   configured channel (the SAME Instagram
//                                   Buffer channel Feed publishes to — one
//                                   account, two post types)
//
// Dry-run mode requires NO Worker credentials and makes NO Worker call at
// all — it only reads the public, authoritative GitHub state (via
// githubStateReader.js) and performs one read-only existence check against
// the public R2 JPEG URL. It NEVER acquires a posting claim, NEVER
// dispatches a repository event, NEVER downloads/converts/uploads a JPEG,
// and NEVER calls Buffer. BUFFER_API_KEY is never read, needed, or
// referenced here — that secret remains Worker-only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFreshStateFetcher } from "../social-worker/lib/githubStateReader.js";
import { createBufferPostingBridge } from "../social-worker/lib/bufferPostingBridge.js";
import { resolveApprovedStoryJpeg, checkExistingApprovedStoryJpeg } from "../social-worker/lib/resolveApprovedStoryJpeg.js";
import { executeBufferFeedPublish, validateBufferStoryPublishPreconditions } from "../social-worker/lib/bufferFeedOrchestrator.js";
import { assembleInstagramCaption } from "../social-worker/lib/captionAssembly.js";

// Non-secret; matches cloudflare-worker/wrangler.toml's own committed
// BUFFER_INSTAGRAM_CHANNEL_ID — the same channel publish-buffer-feed.js
// uses, since Feed and Story post to the same single Instagram account.
const DEFAULT_CHANNEL_ID = "6aa2fb5fcd8b9c702c4530c5";

export function parseArgs(argv) {
  const args = { storyId: null, live: false, confirmStory: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") {
      args.live = true;
    } else if (arg === "--confirm-story") {
      args.confirmStory = argv[i + 1] ?? null;
      i++;
    } else if (arg.startsWith("--confirm-story=")) {
      args.confirmStory = arg.slice("--confirm-story=".length);
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  args.storyId = positional[0] ?? null;
  return args;
}

/**
 * The ONLY thing that may ever authorize live mode: BOTH --live AND an
 * exact --confirm-story match of the positional story_id.
 */
export function isLiveAuthorized({ storyId, live, confirmStory }) {
  return live === true && typeof storyId === "string" && storyId.length > 0 && confirmStory === storyId;
}

function channelId() {
  return process.env.BUFFER_INSTAGRAM_CHANNEL_ID || DEFAULT_CHANNEL_ID;
}

function requireWorkerEnv() {
  const workerBaseUrl = process.env.ARTWORK_WORKER_BASE_URL;
  const workerApiToken = process.env.AGGREGATE_ARTWORK_API_TOKEN;
  if (!workerBaseUrl) throw new Error("ARTWORK_WORKER_BASE_URL is not set.");
  if (!workerApiToken) throw new Error("AGGREGATE_ARTWORK_API_TOKEN is not set.");
  return { workerBaseUrl, workerApiToken };
}

/**
 * Read-only preflight report. Loads the real current record, validates
 * every Story precondition, assembles the deterministic caption (the SAME
 * shared record.caption field Feed uses — no separate Story caption
 * mechanism exists), and performs ONE read-only existence check for the
 * Story JPEG derivative — NEVER a PNG download, NEVER a conversion, NEVER
 * an upload, NEVER a posting claim, NEVER a dispatch, NEVER a Buffer call.
 * @param {{storyId: string, fetchState: Function, fetchImpl: Function}} args
 */
export async function runPreflight({ storyId, fetchState, fetchImpl }) {
  const state = await fetchState();
  const record = state?.stories?.[storyId];
  if (!record) return { ok: false, step: "load_record", error: "not_found" };

  const precondition = validateBufferStoryPublishPreconditions(record);

  const captionResult = assembleInstagramCaption(record);

  let jpegReport;
  try {
    const check = await checkExistingApprovedStoryJpeg(record, { fetchImpl });
    jpegReport = !check.ok
      ? { exists: false, error: check.error }
      : check.exists
        ? { exists: true, jpegUrl: check.jpegUrl, storageKey: check.storageKey }
        : { exists: false, note: "JPEG derivative would be created", plannedStorageKey: check.storageKey };
  } catch (err) {
    jpegReport = { exists: false, error: err.message };
  }

  return {
    ok: true,
    preconditionsPass: precondition.ok,
    preconditionError: precondition.ok ? null : precondition.error,
    story_id: storyId,
    headline: record.caption?.text ? record.caption.text.split("\n")[0] : null,
    approval_status: record.approval?.status ?? null,
    destination: record.selection?.destination ?? null,
    publishing_status: record.publishing?.status ?? null,
    caption: captionResult.ok ? captionResult.caption : null,
    caption_error: captionResult.ok ? null : captionResult.error,
    approved_png_url: record.artwork?.image_url ?? null,
    approved_width: record.artwork?.width ?? null,
    approved_height: record.artwork?.height ?? null,
    jpeg: jpegReport,
    channel_id: channelId(),
  };
}

/**
 * Delegates to the existing approved orchestrator exactly once, reusing its
 * entire sequencing/durability implementation via injected Story
 * dependencies. Implements NO retry, NO reordering, and NO duplicate state
 * logic of its own.
 * @param {{storyId: string, deps?: object}} args
 */
export async function runLive({ storyId, deps = {} }) {
  const { workerBaseUrl, workerApiToken } = requireWorkerEnv();
  const bridge = deps.bridge ?? createBufferPostingBridge({ fetchImpl: fetch, workerBaseUrl, workerApiToken });
  const fetchState = deps.fetchState ?? createFreshStateFetcher();
  const resolveJpeg = deps.resolveJpeg ?? ((record) => resolveApprovedStoryJpeg(record, { fetchImpl: fetch, uploadJpeg: bridge.uploadStoryJpeg }));
  const executePublish = deps.executePublish ?? executeBufferFeedPublish;

  return executePublish({
    storyId,
    channelId: channelId(),
    fetchState,
    claimPosting: bridge.claimPosting,
    resolveJpeg,
    recordPublishAttempt: bridge.recordPublishAttempt,
    publishViaWorker: bridge.publishViaWorkerStory,
    recordPostingResult: bridge.recordPostingResult,
    validatePreconditions: validateBufferStoryPublishPreconditions,
  });
}

function printPreflightReport(report) {
  console.log("=== PREFLIGHT (dry-run) — no claim, no dispatch, no Buffer call, no production write ===");
  console.log(JSON.stringify(report, null, 2));
}

/**
 * The CLI entrypoint. `deps` lets tests inject fakes for every piece that
 * would otherwise touch the network or real environment.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);

  if (!args.storyId) {
    console.error("Usage: node scripts/social/publish-buffer-story.js <story_id> [--live --confirm-story <story_id>]");
    process.exitCode = 1;
    return;
  }

  const fetchState = deps.fetchState ?? createFreshStateFetcher();
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!isLiveAuthorized(args)) {
    if (args.live) {
      console.error("--live was given without an exact --confirm-story match — refusing to publish. Running preflight only.");
    }
    const report = await runPreflight({ storyId: args.storyId, fetchState, fetchImpl });
    printPreflightReport(report);
    process.exitCode = report.ok && report.preconditionsPass ? 0 : 1;
    return;
  }

  console.log(`=== LIVE MODE AUTHORIZED for story_id=${args.storyId} — delegating to executeBufferFeedPublish (Story deps) ===`);
  const result = await (deps.runLive ?? runLive)({ storyId: args.storyId, deps: deps.liveDeps });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
