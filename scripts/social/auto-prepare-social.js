#!/usr/bin/env node
// Autonomous PREPARATION + auto-approval runner — the piece that turns
// "queued -> awaiting_approval -> approved" fully hands-off, while leaving
// PUBLISHING exactly as it already is: the separate, already-proven,
// already-scheduled auto-publish-approved-feed.js / auto-publish-approved-
// story.js pick up any record this script approves and publish it on their
// own existing schedule. This script NEVER calls Buffer, NEVER calls Meta,
// NEVER acquires a posting claim, NEVER persists publish_attempted, and
// NEVER invokes either live publisher — its only two possible mutations
// are (1) the SAME existing artwork/caption generation pipeline a human
// operator already runs manually today, and (2) the SAME existing
// approval-decision endpoint a human already uses via approval-console.js.
// No second reliability system, no second state machine, no second
// validation standard.
//
// Reuses process-one.js completely unmodified for step (1) — that file has
// no import guard (main() runs as an import side effect), so it is
// invoked here as a genuine child process (`node process-one.js
// --story-id=<id>`), exactly as a human operator already does today, not
// imported. This is a deliberate, audited choice, not an oversight.
//
// ==========================================================================
// Candidate selection (2026-09-11 revision — static eligibility pre-filter)
// ==========================================================================
// A production dry-run revealed the live artwork queue's FIFO front is
// dominated by a legacy backlog (~472 of 514 records, audited 2026-09-11)
// that predates Stage-3A selection/canonical entity extraction — these
// records structurally can never pass contentFidelityGate.js no matter how
// well generation goes. Naively picking selectTarget(queue, null) (the
// front of the queue, unconditionally) would waste real Codex generation
// attempts on records statically incapable of auto-approval. This file now
// scans the queue in its EXISTING, UNCHANGED FIFO order and selects the
// FIRST entry whose corresponding record passes
// staticAutonomousEligibility.js's pre-generation check — never a new
// ranking, never importance-based, never skipping a record for any reason
// beyond "cannot possibly pass" (see that module's own header for the
// exact, narrow list of disqualifying conditions — an EMPTY teams[]/
// players[] array is explicitly NOT one of them). A record that fails this
// check is left completely untouched: not claimed, not sent through
// Codex, not mutated, not reassigned, not backfilled. It remains available
// to any existing human/manual workflow exactly as before.
//
// Before scanning the queue at all, this file also checks for an
// already-awaiting_approval record that already fully qualifies for
// automatic approval right now (deterministic oldest-selection.selected_at
// ordering, the same tie-break convention auto-publish-approved-story.js
// already uses) — finishing already-completed work is strictly cheaper
// and safer than starting new generation, so it takes priority. This does
// NOT scan for other mid-pipeline partial states (e.g. artwork done,
// caption missing, no longer in the live queue) — that broader recovery
// scan is a deliberately separate, out-of-scope concern for this pass;
// such records remain reachable via the existing human-operator recovery
// path (explicit --story-id) exactly as today. Still never more than ONE
// record acted on per run.
//
// Auto-approval is fail-closed: scripts/social-worker/lib/autoApprovalGate.js
// re-reads the FRESH post-preparation record and only proceeds through the
// existing decideApproval()/approval-decide state machine if every existing
// readiness/validation contract passes — see that file's own header for the
// exact reused checks. A gate failure is never an error condition; it's the
// expected, safe, correct outcome for a record that isn't ready yet, and
// this script exits 0 either way.
//
// Usage:
//   Dry-run / preflight (the default — always safe, NEVER mutates anything,
//   NEVER spawns Codex, NEVER calls the approval endpoint):
//     node scripts/social/auto-prepare-social.js
//
//   Live (the ONLY way this script can ever generate artwork/caption or
//   approve anything) — requires the explicit --live flag:
//     node scripts/social/auto-prepare-social.js --live
//
// Required env (live mode only): ARTWORK_WORKER_BASE_URL,
// AGGREGATE_ARTWORK_API_TOKEN (both already required by process-one.js and
// apiClient.js — this script reads no new environment variable of its own).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { evaluateAutoApprovalGate } from "../social-worker/lib/autoApprovalGate.js";
import { evaluateStaticAutonomousEligibility } from "../social-worker/lib/staticAutonomousEligibility.js";
import { createFreshStateFetcher } from "../social-worker/lib/githubStateReader.js";
import { fetchArtworkQueue, decideApproval } from "../social-worker/lib/apiClient.js";
import { waitForApprovalCommit } from "../social-worker/lib/waitForApprovalCommit.js";
import { waitForDurableCommit } from "../social-worker/lib/waitForDurableCommit.js";

const AUTO_APPROVE_ACTOR = "aggregate-auto-approver";
const AUTO_APPROVE_DECISION_SOURCE = "autonomous-production-gate";
// cloudflare-worker's approvalDecide.js accepts an optional, validated
// decision_source (restricted server-side to a small known set) rather
// than hardcoding "local-approval-console" for every caller. Both actor
// AND decision_source are therefore fully distinguishable in the durable
// audit trail for an automated decision; the existing human console never
// sends decision_source at all, so its own decisions are unaffected.

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Deterministic tie-break: oldest selection.selected_at first, story_id as
 * a final tiebreak — the SAME convention auto-publish-approved-story.js's
 * own selectEligibleStory() already uses, never a new ranking.
 */
function sortByOldestSelectedAt(a, b) {
  const aTime = Date.parse(a.record.selection?.selected_at ?? "");
  const bTime = Date.parse(b.record.selection?.selected_at ?? "");
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return aTime - bTime;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return a.story_id.localeCompare(b.story_id);
}

/**
 * Buckets a set of static-eligibility issue codes into the three
 * dry-run-report categories requested: records that are structurally
 * legacy/missing canonical autonomous fields, records on an unsupported
 * source, and records excluded for lifecycle/publishing-state reasons. A
 * single record's issues may set more than one bucket — these are
 * independent counts, not mutually exclusive classification.
 */
function categorizeIssues(issues) {
  const categories = { legacyMissingCanonical: false, unsupportedSource: false, lifecycle: false };
  for (const issue of issues) {
    if (
      issue === "no_selection" ||
      issue.startsWith("invalid_destination") ||
      issue === "headline_missing" ||
      issue === "description_missing" ||
      issue === "teams_field_missing" ||
      issue === "players_field_missing"
    ) {
      categories.legacyMissingCanonical = true;
    } else if (issue.startsWith("unrecognized_source") || issue === "source_url_invalid") {
      categories.unsupportedSource = true;
    } else {
      categories.lifecycle = true;
    }
  }
  return categories;
}

/**
 * Selects AT MOST ONE candidate for this run. Never mutates anything.
 * @param {{fetchQueue: Function, fetchState: Function}} deps
 * @returns {Promise<
 *   {mode: "approve-only"|"generate", story_id: string, record: object, queuePosition: number|null, inspectedCount: number|null, skipCounts: object|null} |
 *   {mode: null, story_id: null, record: null, queuePosition: null, inspectedCount: number, skipCounts: object, queueLength: number}
 * >}
 */
export async function selectAutonomousCandidate({ fetchQueue, fetchState }) {
  const [queue, state] = await Promise.all([fetchQueue(), fetchState()]);
  const stories = state?.stories ?? {};

  // Priority 1: an already-awaiting_approval record that already fully
  // qualifies for automatic approval right now — no generation needed.
  const awaitingCandidates = Object.entries(stories)
    .filter(([, r]) => r.status === "awaiting_approval")
    .map(([story_id, record]) => ({ story_id, record }))
    .filter(({ record }) => evaluateStaticAutonomousEligibility(record).eligible)
    .filter(({ record }) => evaluateAutoApprovalGate(record).eligible);
  awaitingCandidates.sort(sortByOldestSelectedAt);

  if (awaitingCandidates.length > 0) {
    const { story_id, record } = awaitingCandidates[0];
    return { mode: "approve-only", story_id, record, queuePosition: null, inspectedCount: null, skipCounts: null };
  }

  // Priority 2: the FIRST entry in the existing, unchanged queue FIFO order
  // whose record passes static eligibility.
  const skipCounts = { legacyMissingCanonical: 0, unsupportedSource: 0, lifecycle: 0 };
  for (let i = 0; i < queue.length; i++) {
    const record = stories[queue[i].story_id];
    const result = evaluateStaticAutonomousEligibility(record);
    if (result.eligible) {
      return { mode: "generate", story_id: queue[i].story_id, record, queuePosition: i, inspectedCount: i + 1, skipCounts };
    }
    const cats = categorizeIssues(result.issues);
    if (cats.legacyMissingCanonical) skipCounts.legacyMissingCanonical++;
    if (cats.unsupportedSource) skipCounts.unsupportedSource++;
    if (cats.lifecycle) skipCounts.lifecycle++;
  }

  return { mode: null, story_id: null, record: null, queuePosition: null, inspectedCount: queue.length, skipCounts, queueLength: queue.length };
}

// ---------------------------------------------------------------------------
// Preparation + approval
// ---------------------------------------------------------------------------

/**
 * Runs the EXISTING, unmodified process-one.js pipeline as a real child
 * process, exactly as a human operator already does today
 * (`node scripts/social-worker/process-one.js --story-id=<id>`). Never
 * imports it directly — see this file's own header for why (no import
 * guard exists in that file). Inherits the parent's stdio so progress is
 * visible in real time (e.g. in the GitHub Actions log), and inherits the
 * parent's environment unchanged (same ARTWORK_WORKER_BASE_URL/
 * AGGREGATE_ARTWORK_API_TOKEN/CODEX_* variables process-one.js itself reads).
 * @param {{storyId: string}} args
 * @returns {Promise<{exitCode: number}>}
 */
export function runExistingPreparationPipeline({ storyId }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "social-worker", "process-one.js");
    const child = spawn(process.execPath, [scriptPath, `--story-id=${storyId}`], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve({ exitCode: exitCode ?? 1 }));
  });
}

/**
 * Evaluates the full post-preparation auto-approval gate and, only if it
 * passes, records approval via the existing production approval-decision
 * mechanism. Shared by both the "generate" (just-prepared) and
 * "approve-only" (already fully prepared) selection modes so the actual
 * decision logic exists in exactly one place.
 */
async function tryAutoApprove(storyId, record, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState }) {
  const gate = evaluateAutoApprovalGate(record);
  console.log(`Auto-approval gate result for story_id=${storyId}: ${JSON.stringify(gate)}`);

  if (!gate.eligible) {
    console.log(`story_id=${storyId} does NOT qualify for automatic approval (${gate.issues.join(", ")}). Leaving it at awaiting_approval for human review — this is the exact same safe resting state the existing manual pipeline already uses.`);
    return { ok: true, selected: { story_id: storyId, record }, prepared: true, autoApproved: false, gateIssues: gate.issues };
  }

  console.log(`story_id=${storyId} passes every automatic-approval requirement. Recording approval via the existing production approval-decision mechanism (actor=${AUTO_APPROVE_ACTOR}).`);
  const requestId = `auto-${storyId}-${Date.now()}`;
  const decideResult = await decideApprovalImpl(storyId, "approved", { requestId, actor: AUTO_APPROVE_ACTOR, decisionSource: AUTO_APPROVE_DECISION_SOURCE });
  console.log(`decideApproval result: ${JSON.stringify(decideResult)}`);

  if (decideResult.result === "pending") {
    const pollResult = await waitForApprovalCommitImpl(fetchState, storyId);
    console.log(`waitForApprovalCommit result: committed=${pollResult.committed}, status=${pollResult.status}`);
    if (!pollResult.committed) {
      return { ok: false, step: "approval_commit_confirmation", selected: { story_id: storyId }, decideResult, pollResult };
    }
    return { ok: true, selected: { story_id: storyId, record: pollResult.record }, prepared: true, autoApproved: true };
  }

  const approvedNow = decideResult.result === "approved" || decideResult.result === "already_approved";
  return { ok: approvedNow, selected: { story_id: storyId }, prepared: true, autoApproved: approvedNow, decideResult };
}

/**
 * @param {{fetchQueue?: Function, fetchState?: Function, live?: boolean, runPreparationImpl?: Function, decideApprovalImpl?: Function, waitForApprovalCommitImpl?: Function, waitForDurableCommitImpl?: Function, selectCandidateImpl?: Function}} [args]
 */
export async function main({
  fetchQueue = fetchArtworkQueue,
  fetchState = createFreshStateFetcher(),
  live = false,
  runPreparationImpl = runExistingPreparationPipeline,
  decideApprovalImpl = decideApproval,
  waitForApprovalCommitImpl = waitForApprovalCommit,
  waitForDurableCommitImpl = waitForDurableCommit,
  selectCandidateImpl = selectAutonomousCandidate,
} = {}) {
  const selection = await selectCandidateImpl({ fetchQueue, fetchState });

  if (!selection.mode) {
    console.log(
      `No statically-eligible autonomous candidate found. Inspected ${selection.inspectedCount} of ${selection.queueLength} queue records; skipped — legacy/missing canonical: ${selection.skipCounts.legacyMissingCanonical}, unsupported source: ${selection.skipCounts.unsupportedSource}, lifecycle: ${selection.skipCounts.lifecycle}.`
    );
    return { ok: true, selected: null, inspectedCount: selection.inspectedCount, queueLength: selection.queueLength, skipCounts: selection.skipCounts };
  }

  const { mode, story_id: storyId, record, queuePosition, inspectedCount, skipCounts } = selection;

  if (mode === "approve-only") {
    console.log(`Selected story_id=${storyId} — already awaiting_approval and fully gate-eligible; no artwork/caption generation needed.`);
  } else {
    console.log(`Selected story_id=${storyId} — queue position ${queuePosition} (${inspectedCount - 1} statically-ineligible record(s) skipped before it), the first statically-eligible candidate in existing FIFO order.`);
  }

  if (!live) {
    console.log("=== DRY RUN — no artwork generation, no caption generation, no approval, no state mutation ===");
    const report = {
      ok: true,
      mode,
      story_id: storyId,
      destination: record.selection?.destination ?? null,
      headline: record.source_story?.post_headline ?? null,
      source_name: record.source_story?.source_name ?? null,
      source_url: record.source_story?.source_url ?? null,
      current_status: record.status,
      selection_slot: record.selection?.slot_id ?? null,
      teams: record.source_story?.teams ?? null,
      players: record.source_story?.players ?? null,
      queue_position: queuePosition,
      inspected_count: inspectedCount,
      skip_counts: skipCounts,
      static_eligibility_passed: true,
      would_require: mode === "approve-only" ? "approval only — artwork and caption already exist and already pass every gate" : "artwork generation, caption generation, then full post-generation approval-gate evaluation",
    };
    console.log(JSON.stringify(report, null, 2));
    return { ok: true, selected: { story_id: storyId, record }, dryRun: report };
  }

  if (mode === "approve-only") {
    return tryAutoApprove(storyId, record, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState });
  }

  console.log(`=== LIVE — running the existing artwork+caption generation pipeline for story_id=${storyId} ===`);
  const prepResult = await runPreparationImpl({ storyId });
  console.log(`process-one.js exited with code ${prepResult.exitCode}.`);

  // 2026-09-11 durability hardening: process-one.js's exit code only proves
  // its own claim/dispatch HTTP calls were ACCEPTED. The caption's final
  // "caption-completed" event (like every artwork/caption event) is applied
  // by an INDEPENDENT, concurrent GitHub Actions run — see
  // apply-artwork-event.js's own 2026-09-11 header comment for the exact,
  // proven checkout-staleness race this closes — that can still be mid-
  // flight (or, now, mid-retry) when this child process exits. A single
  // immediate read here is exactly the bug a live run just proved out in
  // production: it observed the record moments BEFORE the completion event
  // durably landed, and wrongly concluded preparation had failed. Give the
  // SAME bounded durable-commit poll already proven for posting-claimed/
  // publish-attempted a fair chance to observe the real end state — a
  // resting state the record can only reach via a durable commit, never via
  // dispatch-acceptance alone — before concluding anything. "failed" is
  // included as a committed end state (not just "awaiting_approval") so a
  // genuine, durably-recorded failure is recognized immediately rather than
  // burning the full poll budget only to time out on it.
  const pollResult = await waitForDurableCommitImpl(
    fetchState,
    storyId,
    (record) => record.status === "awaiting_approval" || record.status === "failed",
    {
      onWaiting: (attempt, attempts, reason) => {
        console.log(`story_id=${storyId} has not yet reached a durable post-preparation resting state — waiting (attempt ${attempt}/${attempts}, reason=${reason})...`);
      },
    }
  );

  if (!pollResult.committed) {
    console.log(
      `story_id=${storyId} did not reach a durable post-preparation resting state (awaiting_approval or failed) within the poll budget (status=${pollResult.status}${pollResult.error ? `, error=${pollResult.error}` : ""}). Failing closed: no regeneration, no approval, no publishing attempted. A future run will re-evaluate this exact record fresh — it is never abandoned, and nothing here creates a new claim or a new generation attempt.`
    );
    return { ok: false, step: "post_prepare_durable_poll", selected: { story_id: storyId }, pollResult };
  }

  const freshRecord = pollResult.record;

  if (freshRecord.status !== "awaiting_approval") {
    console.log(`story_id=${storyId} reached a durable terminal state of "${freshRecord.status}" (not awaiting_approval) — preparation did not succeed. No approval attempted. This is a safe, expected outcome; a future run will pick this up again per the existing pipeline's own recovery rules.`);
    return { ok: true, selected: { story_id: storyId, record: freshRecord }, prepared: false, finalStatus: freshRecord.status };
  }

  return tryAutoApprove(storyId, freshRecord, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState });
}

/**
 * Pure, explicit mode resolution — same shape as auto-publish-approved-
 * feed.js's / auto-publish-approved-story.js's own resolveRunMode()
 * (duplicated, not imported, so this file has no runtime dependency on
 * either publishing automation file). No schedule trigger exists on this
 * workflow yet, so `eventName` can only ever be "workflow_dispatch" in
 * practice today — the schedule branch is kept anyway so enabling one
 * later is a pure YAML change, matching the exact same precedent.
 * @param {{eventName?: string, inputMode?: string}} args
 * @returns {"live"|"dry-run"}
 */
export function resolveRunMode({ eventName, inputMode } = {}) {
  if (eventName === "schedule") return "live";
  return inputMode === "live" ? "live" : "dry-run";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliLive = process.argv.includes("--live");
  const resolvedMode = resolveRunMode({ eventName: process.env.GITHUB_EVENT_NAME, inputMode: process.env.INPUT_MODE });
  const live = cliLive || resolvedMode === "live";
  main({ live }).catch((err) => {
    console.error("auto-prepare-social failed:", err);
    process.exitCode = 1;
  });
}
