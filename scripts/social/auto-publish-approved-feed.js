#!/usr/bin/env node
// Automatic publishing of AT MOST ONE already-approved Feed story per run.
// A thin selection + delegation layer ONLY — every actual publishing
// decision (JPEG resolution, precondition re-check, claim, durable-commit
// confirmation, the single Buffer createPost call, result classification,
// durable result persistence) lives entirely in the SAME already-proven
// scripts/social/publish-buffer-feed.js (runPreflight/runLive) this file
// imports and calls directly — there is no second Buffer-publishing
// implementation here, and no retry loop exists anywhere in this file.
//
// This script does NOT approve stories, does NOT create Story-destination
// posts, and does NOT wait for Buffer's async "sent" confirmation — a
// definite Buffer create success is left at feed.status=buffer_post_created
// for the EXISTING scripts/social/reconcile-buffer-completions.js (running
// on its own 10-minute schedule) to finish.
//
// Eligibility reuses bufferFeedOrchestrator.js's own
// validateBufferFeedPublishPreconditions() — the exact same precondition
// gate the live launcher itself already enforces — rather than inventing a
// second eligibility rule. Selection among multiple simultaneously-eligible
// stories is deterministic: the one with the OLDEST selection.selected_at
// (i.e. the story that has been waiting longest), with story_id as a final
// tiebreak if that timestamp is ever equal or missing.
//
// Usage:
//   Dry-run / preflight (the default — always safe, NEVER mutates anything):
//     node scripts/social/auto-publish-approved-feed.js
//
//   Live (the ONLY way this script can ever call Buffer) — requires the
//   explicit --live flag:
//     node scripts/social/auto-publish-approved-feed.js --live
//
// Mode resolution when run from GitHub Actions (see
// .github/workflows/auto-publish-approved-feed.yml): deliberately NOT left
// as inline shell conditionals in the YAML — resolveRunMode() below is the
// single, explicit, unit-tested source of truth, driven by GITHUB_EVENT_NAME
// (a variable GitHub Actions always sets automatically, needing no manual
// wiring) and the INPUT_MODE env var the workflow passes through from
// workflow_dispatch's own `inputs.mode` (empty for a schedule event, where
// `inputs` doesn't exist at all). A `schedule` event ALWAYS resolves to
// live, regardless of INPUT_MODE's value (which is moot for that event
// anyway) — there is no path by which a scheduled run can resolve to
// dry-run, and no path by which a manual run with no explicit mode
// (INPUT_MODE unset/empty, matching the workflow input's own "dry-run"
// default) can resolve to live.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFreshStateFetcher } from "../social-worker/lib/githubStateReader.js";
import { validateBufferFeedPublishPreconditions } from "../social-worker/lib/bufferFeedOrchestrator.js";
import { runPreflight, runLive } from "./publish-buffer-feed.js";

/**
 * Pure: filters `state.stories` down to every record satisfying the exact
 * same eligibility gate the live launcher itself checks, then picks AT MOST
 * ONE deterministically. Never mutates `state`. Returns `null` when no
 * story is eligible.
 * @param {object} state - the current data/social-state.json document
 * @returns {{story_id: string, record: object}|null}
 */
export function selectEligibleStory(state) {
  const stories = state?.stories ?? {};
  const eligible = Object.entries(stories)
    .filter(([, record]) => validateBufferFeedPublishPreconditions(record).ok)
    .map(([story_id, record]) => ({ story_id, record }));

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const aTime = Date.parse(a.record.selection?.selected_at ?? "");
    const bTime = Date.parse(b.record.selection?.selected_at ?? "");
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid && aTime !== bTime) return aTime - bTime; // oldest first
    if (aValid !== bValid) return aValid ? -1 : 1; // a real timestamp always sorts before a missing one
    return a.story_id.localeCompare(b.story_id); // final deterministic tiebreak
  });

  return eligible[0];
}

/**
 * Pure, explicit mode resolution — the single source of truth for whether a
 * given invocation may go live. A `schedule` event ALWAYS resolves to
 * "live", independent of `inputMode` (which schedule events never actually
 * supply). Every other event resolves to "live" ONLY when `inputMode` is
 * literally the string "live" — any other value, including undefined/empty
 * (a manual run with no explicit input, or the workflow_dispatch default of
 * "dry-run"), resolves to "dry-run". There is no third value and no
 * fall-through path to "live" by omission.
 * @param {{eventName?: string, inputMode?: string}} args
 * @returns {"live"|"dry-run"}
 */
export function resolveRunMode({ eventName, inputMode } = {}) {
  if (eventName === "schedule") return "live";
  return inputMode === "live" ? "live" : "dry-run";
}

/**
 * @param {{fetchState?: Function, fetchImpl?: Function, live?: boolean, runPreflightImpl?: Function, runLiveImpl?: Function}} [args]
 */
export async function main({
  fetchState = createFreshStateFetcher(),
  fetchImpl = fetch,
  live = false,
  runPreflightImpl = runPreflight,
  runLiveImpl = runLive,
} = {}) {
  const state = await fetchState();
  const selected = selectEligibleStory(state);

  if (!selected) {
    console.log("No eligible approved Feed story found (publishing.status=not_posted, approval.status=approved, destination=feed). Nothing to do.");
    return { ok: true, selected: null };
  }

  const { story_id, record } = selected;
  console.log(`Selected story_id=${story_id} — oldest eligible by selection.selected_at=${record.selection?.selected_at ?? "unknown"} among all eligible candidates this run.`);

  if (!live) {
    const preflight = await runPreflightImpl({ storyId: story_id, fetchState, fetchImpl });
    console.log("=== DRY RUN — no claim, no dispatch, no Buffer call, no production write ===");
    console.log(JSON.stringify(preflight, null, 2));
    return { ok: true, selected: { story_id, record }, dryRun: preflight };
  }

  console.log(`=== LIVE — delegating to the existing, already-proven publish-buffer-feed.js runLive() for story_id=${story_id} ===`);
  const result = await runLiveImpl({ storyId: story_id });
  console.log(JSON.stringify(result, null, 2));
  return { ok: result.ok, selected: { story_id, record }, live: result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--live` (local manual testing) and the GitHub Actions env-driven
  // resolution are combined with OR, never AND — either one requesting live
  // mode is enough, but neither is required for the safe dry-run default.
  const cliLive = process.argv.includes("--live");
  const resolvedMode = resolveRunMode({ eventName: process.env.GITHUB_EVENT_NAME, inputMode: process.env.INPUT_MODE });
  const live = cliLive || resolvedMode === "live";
  main({ live }).catch((err) => {
    console.error("auto-publish-approved-feed failed:", err);
    process.exitCode = 1;
  });
}
