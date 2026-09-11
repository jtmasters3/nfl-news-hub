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
// Candidate selection reuses selectTarget(queue, null) — the EXACT same
// "front of the live artwork queue" ordering process-one.js's own default
// (no --story-id) invocation already uses. This script never invents a
// new ordering, never scans for out-of-queue recovery candidates, and
// never processes more than one record per run.
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
import { selectTarget, missingFixtureFields } from "../social-worker/lib/selectTarget.js";
import { evaluateAutoApprovalGate } from "../social-worker/lib/autoApprovalGate.js";
import { sourceTier, UNKNOWN_SOURCE_TIER } from "../lib/editorialSourceConfidence.js";
import { createFreshStateFetcher } from "../social-worker/lib/githubStateReader.js";
import { fetchArtworkQueue, decideApproval } from "../social-worker/lib/apiClient.js";
import { waitForApprovalCommit } from "../social-worker/lib/waitForApprovalCommit.js";

const AUTO_APPROVE_ACTOR = "aggregate-auto-approver";
// NOTE: decision_source is NOT caller-controllable through the existing
// production approval-decide endpoint today — cloudflare-worker's
// approvalDecide.js hardcodes it to "local-approval-console" for every
// caller (audited 2026-09-11), so an automated decision's record.
// approval.decision_source will read the same string a human console
// decision's does. `actor` (fully caller-controlled end-to-end, set to
// AUTO_APPROVE_ACTOR below) is what actually distinguishes an automated
// decision in the audit trail today. Extending decision_source to be
// caller-provided would require a small, separate, dedicated Worker change
// — deliberately not made here, consistent with every other Worker change
// in this project requiring its own audit/test/deploy authorization cycle,
// never bundled into an unrelated task.

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isHttpsUrl(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Pure: picks the exact same next candidate process-one.js's own default
 * (no --story-id) invocation would pick — the front of the live artwork
 * queue. Never mutates anything. Returns null when the queue is empty.
 * @param {Array<object>} queue - the live social-artwork-queue.json entries
 * @returns {object|null} the raw queue entry (has story_id, post_headline, base_image_url, source_name, source_url, destination, ...)
 */
export function selectPreparationCandidate(queue) {
  return selectTarget(queue, null);
}

/**
 * Structural, artwork/caption-independent pre-checks — everything about a
 * queue entry that can be evaluated BEFORE ever spending a Codex generation
 * attempt on it. Used both for the dry-run preview (this is all a dry-run
 * can ever know, since it never runs the generation pipeline) and as a
 * live-mode fail-fast gate (never worth claiming/generating for a
 * structurally-doomed entry). Never approves anything itself — approval
 * always additionally requires evaluateAutoApprovalGate() against the
 * POST-preparation record.
 * @param {object} queueEntry
 * @param {object|null} record - the corresponding data/social-state.json record, if resolvable
 * @returns {{ok: boolean, issues: string[]}}
 */
export function evaluateStructuralPreChecks(queueEntry, record) {
  const issues = [];

  if (!queueEntry || !isNonEmptyString(queueEntry.story_id)) {
    return { ok: false, issues: ["invalid_queue_entry"] };
  }

  const missing = missingFixtureFields(queueEntry);
  for (const field of missing) issues.push(`missing_fixture_field:${field}`);

  if (!isHttpsUrl(queueEntry.source_url)) issues.push("source_url_invalid");

  const destination = queueEntry.destination;
  if (destination !== "feed" && destination !== "story") {
    issues.push(`invalid_destination:${destination ?? "none"}`);
  }

  const tier = sourceTier(queueEntry.source_name);
  if (tier === UNKNOWN_SOURCE_TIER) {
    issues.push(`unrecognized_source:${queueEntry.source_name ?? "none"}`);
  }

  // If the record already exists in state (it always should, by the time
  // it's queued), it must genuinely still need preparation — never
  // re-process something already further along.
  if (record) {
    if (record.status !== "queued") {
      issues.push(`record_not_queued:${record.status ?? "none"}`);
    }
    if (record.merged_into) issues.push("story_merged");
  }

  return { ok: issues.length === 0, issues };
}

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
 * @param {{fetchQueue?: Function, fetchState?: Function, live?: boolean, runPreparationImpl?: Function, decideApprovalImpl?: Function, waitForApprovalCommitImpl?: Function}} [args]
 */
export async function main({
  fetchQueue = fetchArtworkQueue,
  fetchState = createFreshStateFetcher(),
  live = false,
  runPreparationImpl = runExistingPreparationPipeline,
  decideApprovalImpl = decideApproval,
  waitForApprovalCommitImpl = waitForApprovalCommit,
} = {}) {
  const queue = await fetchQueue();
  const candidate = selectPreparationCandidate(queue);

  if (!candidate) {
    console.log("No queued social record requires preparation. Nothing to do.");
    return { ok: true, selected: null };
  }

  const storyId = candidate.story_id;
  const state = await fetchState();
  const record = state?.stories?.[storyId] ?? null;

  console.log(`Selected story_id=${storyId} (destination=${candidate.destination ?? "unknown"}, headline="${candidate.post_headline ?? "unknown"}") — front of the live artwork queue, the same candidate process-one.js's own default invocation would pick.`);

  const preCheck = evaluateStructuralPreChecks(candidate, record);

  if (!live) {
    console.log("=== DRY RUN — no artwork generation, no caption generation, no approval, no state mutation ===");
    const report = {
      ok: true,
      story_id: storyId,
      destination: candidate.destination ?? null,
      headline: candidate.post_headline ?? null,
      current_status: record?.status ?? "unknown",
      structural_pre_checks_passed: preCheck.ok,
      structural_pre_check_issues: preCheck.issues,
      note: preCheck.ok
        ? "Structural pre-checks pass. Live mode would run the existing artwork+caption generation pipeline (process-one.js) for this exact story_id; whether it then qualifies for automatic approval can only be determined after that completes, since artwork/caption content does not exist yet."
        : "Structural pre-checks FAIL. Live mode would refuse to spend a generation attempt on this candidate and would exit without calling Codex or the approval endpoint.",
    };
    console.log(JSON.stringify(report, null, 2));
    return { ok: true, selected: { story_id: storyId, record }, dryRun: report };
  }

  if (!preCheck.ok) {
    console.log(`Structural pre-checks failed for story_id=${storyId}: ${preCheck.issues.join(", ")}. Refusing to spend a generation attempt. No Codex call, no approval call.`);
    return { ok: true, selected: { story_id: storyId, record }, skipped: { reason: "structural_pre_check_failed", issues: preCheck.issues } };
  }

  console.log(`=== LIVE — running the existing artwork+caption generation pipeline for story_id=${storyId} ===`);
  const prepResult = await runPreparationImpl({ storyId });
  console.log(`process-one.js exited with code ${prepResult.exitCode}.`);

  // Always re-read fresh, authoritative, post-preparation state — never
  // trust the child process's own exit code alone to infer the record's
  // resulting status.
  const freshState = await fetchState();
  const freshRecord = freshState?.stories?.[storyId];

  if (!freshRecord) {
    console.log(`story_id=${storyId} not found in fresh state after preparation — cannot proceed to approval evaluation.`);
    return { ok: false, step: "post_prepare_read", selected: { story_id: storyId } };
  }

  if (freshRecord.status !== "awaiting_approval") {
    console.log(`story_id=${storyId} did not reach awaiting_approval (status=${freshRecord.status}) — preparation is incomplete or failed. No approval attempted. This is a safe, expected outcome for a generation that didn't fully succeed; a future run will pick this up again per the existing pipeline's own recovery rules.`);
    return { ok: true, selected: { story_id: storyId, record: freshRecord }, prepared: false, finalStatus: freshRecord.status };
  }

  const gate = evaluateAutoApprovalGate(freshRecord);
  console.log(`Auto-approval gate result for story_id=${storyId}: ${JSON.stringify(gate)}`);

  if (!gate.eligible) {
    console.log(`story_id=${storyId} reached awaiting_approval but does NOT qualify for automatic approval (${gate.issues.join(", ")}). Leaving it at awaiting_approval for human review — this is the exact same safe resting state the existing manual pipeline already uses.`);
    return { ok: true, selected: { story_id: storyId, record: freshRecord }, prepared: true, autoApproved: false, gateIssues: gate.issues };
  }

  console.log(`story_id=${storyId} passes every automatic-approval requirement. Recording approval via the existing production approval-decision mechanism (actor=${AUTO_APPROVE_ACTOR}).`);
  const requestId = `auto-${storyId}-${Date.now()}`;
  const decideResult = await decideApprovalImpl(storyId, "approved", { requestId, actor: AUTO_APPROVE_ACTOR });
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
