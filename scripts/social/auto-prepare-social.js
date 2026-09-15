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
// already-awaiting_approval, still-pending record — the OLDEST one,
// regardless of whether it currently passes the full auto-approval gate
// (2026-09-14 revision, see the section below) — since finishing
// already-prepared work is strictly cheaper and safer than starting new
// generation, so it takes priority.
//
// ==========================================================================
// Re-evaluating a previously gate-failed pending record (2026-09-14)
// ==========================================================================
// A live run proved a real, narrow content-fidelity parser bug
// (unsupported_named_entity:"A.J. Brown. The" — a sentence-boundary
// tokenization defect, since fixed in contentFidelityGate.js) can leave a
// fully-prepared, otherwise-correct record sitting at awaiting_approval
// indefinitely. Selection used to permanently exclude any record that
// failed evaluateAutoApprovalGate() at selection time — meaning a record
// stuck on a bug like that one would never be reconsidered once the bug
// was fixed, unless a human happened to re-run/re-approve it manually.
//
// The fix is NOT a durable "gate version" field on the record (considered,
// and deliberately rejected as more architecture than this needs): gate
// evaluation is a pure, in-memory function of already-fetched data, with
// zero network/mutation cost, so simply re-evaluating it fresh on EVERY
// run is free — there is no real cost to "trying again," and a record
// automatically becomes newly eligible the moment the underlying gate code
// is fixed and deployed, with no additional state to track anywhere.
//
// The one real risk that fix alone doesn't address: if selection always
// picks the SAME oldest pending record and that record has a genuine,
// still-unfixed validation problem, a naive "select oldest pending, stop"
// design would repeat this same free-but-fruitless check every run and
// NEVER get to newer, otherwise-ready recover-caption/fresh-generation
// work — see main()'s own comment for the bounded-fallthrough mechanism
// that prevents this without any durable tracking either.
//
// ==========================================================================
// Caption-completion hands-off recovery (2026-09-14)
// ==========================================================================
// Between that check and the fresh-generation queue scan, this file also
// looks for a record stuck in exactly the state a real production race
// proved out: artwork_ready, caption not yet ready, but the caption's
// completion was already durably recorded "completed" by the Cloudflare
// Worker's Durable Object (repository_dispatch accepted, dispatch_confirmed
// true) and simply never landed in data/social-state.json — see
// scripts/social/apply-artwork-event.js's own 2026-09-11 header for the
// exact race, and scripts/social-worker/lib/captionRecoveryEligibility.js's
// own header for the full fail-closed eligibility contract this reuses.
// Recovering such a record only ever replays the DO's own already-stored
// completion payload (POST /social/caption/replay-completion) — it NEVER
// regenerates artwork, NEVER creates a new caption claim, and NEVER invents
// caption content. This does NOT scan for any OTHER mid-pipeline partial
// state (e.g. artwork itself stuck, a story no longer in the live queue for
// unrelated reasons) — that broader recovery scan remains a deliberately
// separate, out-of-scope concern; such records remain reachable via the
// existing human-operator recovery path (explicit --story-id) exactly as
// today. Still never more than ONE record acted on per run.
//
// ==========================================================================
// Primary artwork-completion hands-off recovery (2026-09-14)
// ==========================================================================
// The direct sibling of caption-completion recovery above, for the SAME
// checkout-staleness class of race hitting artwork-completed instead of
// caption-completed — proven against story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd once artwork generation got fast
// enough (the local Windows codex.exe removal) that an artwork-claimed
// dispatch and its own artwork-completed dispatch could land within
// seconds of each other. See apply-artwork-event.js's own 2026-09-14
// header for the underlying GitHub Action fix (invalid_state:* now also
// gets a bounded retry against fresh state) and
// scripts/social-worker/lib/artworkRecoveryEligibility.js's own header for
// the full fail-closed eligibility contract this reuses. Recovering such a
// record only ever replays the DO's own already-stored completion payload
// (POST /social/artwork/replay-completion) — it NEVER re-uploads, NEVER
// creates a new artwork claim, and NEVER regenerates anything. Once the
// artwork itself durably reaches "artwork_ready," this delegates to the
// SAME runGeneratePipeline() used for a fresh "generate" candidate —
// process-one.js's own existing recovery routing (routeRecovery.js,
// destination-aware as of this same date) correctly detects the record is
// no longer in the live queue and proceeds straight to caption-only work,
// with zero artwork regeneration.
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
import { githubSideCaptionRecoveryIssues, evaluateCaptionRecoveryEligibility } from "../social-worker/lib/captionRecoveryEligibility.js";
import { githubSideArtworkRecoveryIssues, evaluateArtworkRecoveryEligibility } from "../social-worker/lib/artworkRecoveryEligibility.js";
import { createFreshStateFetcher } from "../social-worker/lib/githubStateReader.js";
import {
  fetchArtworkQueue,
  decideApproval,
  getCaptionClaimStatus,
  replayCaptionCompletion,
  getArtworkClaimStatus,
  replayArtworkCompletion,
} from "../social-worker/lib/apiClient.js";
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
 * Selects AT MOST ONE candidate for this run. Never mutates anything, and
 * never performs a Durable Object read itself — a "recover-caption"
 * candidate's FULL eligibility (which requires a DO read) is only ever
 * confirmed later, in main(), immediately before a replay would be
 * attempted; this function only identifies which story_id is even worth
 * checking, from GitHub state alone. Priority 1 (approve-only) deliberately
 * does NOT filter by evaluateAutoApprovalGate() — see this file's own
 * 2026-09-14 header for why the oldest pending record is always the
 * candidate regardless of current gate outcome, and see main() for how a
 * gate failure there still can't block newer recover-caption/generate work.
 * @param {{fetchQueue: Function, fetchState: Function, excludeStoryIds?: Iterable<string>}} deps
 * @returns {Promise<
 *   {mode: "approve-only"|"recover-artwork"|"recover-caption"|"generate", story_id: string, record: object, queuePosition: number|null, inspectedCount: number|null, skipCounts: object|null} |
 *   {mode: null, story_id: null, record: null, queuePosition: null, inspectedCount: number, skipCounts: object, queueLength: number}
 * >}
 */
export async function selectAutonomousCandidate({ fetchQueue, fetchState, excludeStoryIds, now = Date.now() }) {
  const exclude = excludeStoryIds ? new Set(excludeStoryIds) : null;
  const [queue, state] = await Promise.all([fetchQueue(), fetchState()]);
  const stories = state?.stories ?? {};

  // Priority 1: the OLDEST already-awaiting_approval, still-pending record
  // — evaluated against the CURRENT gate fresh in main(), never pre-
  // filtered here by whether it happens to pass right now. Still subject to
  // evaluateStaticAutonomousEligibility's own selection-expiry check (see
  // that file's 2026-09-14 header) — a fully-prepared record whose
  // selection has since gone stale must not be auto-approved either.
  const awaitingCandidates = Object.entries(stories)
    .filter(([story_id, r]) => r.status === "awaiting_approval" && !(exclude && exclude.has(story_id)))
    .map(([story_id, record]) => ({ story_id, record }))
    .filter(({ record }) => evaluateStaticAutonomousEligibility(record, now).eligible);
  awaitingCandidates.sort(sortByOldestSelectedAt);

  if (awaitingCandidates.length > 0) {
    const { story_id, record } = awaitingCandidates[0];
    return { mode: "approve-only", story_id, record, queuePosition: null, inspectedCount: null, skipCounts: null };
  }

  // Priority 2: a record whose GitHub-side state alone already looks like
  // the proven PRIMARY artwork-completion-stuck shape (see this file's own
  // 2026-09-14 header above). The FULL decision — including the Durable
  // Object read — is deferred to main(); this is only a cheap, no-network
  // pre-filter, same spirit as the caption-recovery pre-filter below.
  const artworkRecoveryCandidates = Object.entries(stories)
    .filter(([story_id]) => !(exclude && exclude.has(story_id)))
    .map(([story_id, record]) => ({ story_id, record }))
    .filter(({ record }) => githubSideArtworkRecoveryIssues(record).length === 0);
  artworkRecoveryCandidates.sort(sortByOldestSelectedAt);

  if (artworkRecoveryCandidates.length > 0) {
    const { story_id, record } = artworkRecoveryCandidates[0];
    return { mode: "recover-artwork", story_id, record, queuePosition: null, inspectedCount: null, skipCounts: null };
  }

  // Priority 3: a record whose GitHub-side state alone already looks like
  // the proven caption-completion-stuck shape (see this file's own header
  // above). The FULL decision — including the Durable Object read — is
  // deferred to main(); this is only a cheap, no-network pre-filter, same
  // spirit as staticAutonomousEligibility.js's pre-generation filter below.
  const recoveryCandidates = Object.entries(stories)
    .filter(([story_id]) => !(exclude && exclude.has(story_id)))
    .map(([story_id, record]) => ({ story_id, record }))
    .filter(({ record }) => githubSideCaptionRecoveryIssues(record).length === 0);
  recoveryCandidates.sort(sortByOldestSelectedAt);

  if (recoveryCandidates.length > 0) {
    const { story_id, record } = recoveryCandidates[0];
    return { mode: "recover-caption", story_id, record, queuePosition: null, inspectedCount: null, skipCounts: null };
  }

  // Priority 4: the FIRST entry in the existing, unchanged queue FIFO order
  // whose record passes static eligibility.
  const skipCounts = { legacyMissingCanonical: 0, unsupportedSource: 0, lifecycle: 0 };
  for (let i = 0; i < queue.length; i++) {
    if (exclude && exclude.has(queue[i].story_id)) continue;
    const record = stories[queue[i].story_id];
    const result = evaluateStaticAutonomousEligibility(record, now);
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
async function tryAutoApprove(storyId, record, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now = Date.now() }) {
  const gate = evaluateAutoApprovalGate(record, now);
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
 * 2026-09-14 hands-off recovery integration. Handles a "recover-caption"
 * selection: a record whose caption-completed dispatch was durably
 * recorded "completed" by the Cloudflare Worker's Durable Object but never
 * durably applied to data/social-state.json (see this file's own header
 * and captionRecoveryEligibility.js's own header for the exact race and
 * the fail-closed contract this enforces). Fails closed at every step:
 * never regenerates artwork or caption, never creates a new caption claim,
 * never invents caller-supplied caption content, never approves before the
 * replay is durably confirmed, never retries a second replay within one run.
 */
async function tryRecoverCaption(storyId, record, { getCaptionClaimStatusImpl, replayCaptionCompletionImpl, waitForDurableCommitImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now = Date.now() }) {
  let statusResult;
  try {
    statusResult = await getCaptionClaimStatusImpl(storyId);
  } catch (err) {
    console.log(`story_id=${storyId} caption recovery: failed to read the Durable Object's claim status (${err.message}). Failing closed: no replay attempted.`);
    return { ok: false, step: "caption_recovery_status_read", selected: { story_id: storyId, record } };
  }

  const eligibility = evaluateCaptionRecoveryEligibility(record, statusResult?.do_record ?? null);
  console.log(`Caption recovery eligibility for story_id=${storyId}: ${JSON.stringify(eligibility)}`);

  if (!eligibility.eligible) {
    console.log(`story_id=${storyId} is NOT safely replayable (${eligibility.issues.join(", ")}). Failing closed: no replay, no regeneration, no approval.`);
    // ok:true (2026-09-14) — this is an ordinary, expected, frequent
    // outcome (e.g. the OTHER process still actively generating this
    // caption simply hasn't reached DO-completed yet), not an
    // infrastructure problem. It belongs in the SAME "legitimate gate
    // rejection handled as designed" success bucket as an ineligible
    // auto-approval-gate result — never a workflow failure. Only a
    // genuine inability to even READ the Durable Object (the branch
    // above), a Worker-side replay refusal, or a durable-confirmation
    // timeout (both below) are real failures worth turning the workflow red.
    return { ok: true, step: "caption_recovery_eligibility", selected: { story_id: storyId, record }, eligibility };
  }

  const claimId = eligibility.claimId;
  console.log(`story_id=${storyId} passes every automatic caption-recovery safety check. Replaying the Durable Object's own stored completion (claim_id=${claimId}) — no new claim, no new content, no artwork regeneration.`);
  const replayResult = await replayCaptionCompletionImpl(storyId, claimId);
  console.log(`replayCaptionCompletion result: ${JSON.stringify(replayResult)}`);

  if (!replayResult.replayed) {
    console.log(`story_id=${storyId} caption recovery replay was refused (${replayResult.reason ?? "unknown"}). Failing closed: no retry, no regeneration, no approval. A future run will re-evaluate this exact record fresh.`);
    return { ok: false, step: "caption_recovery_replay", selected: { story_id: storyId, record }, replayResult };
  }

  // Bounded durable poll, mirroring the exact same pattern already proven
  // for post-preparation confirmation below — the replay only proves
  // GitHub ACCEPTED the re-fired dispatch, never that the Action has
  // finished committing it. Requires the FULL expected post-condition
  // (caption ready, text present, same claim/completion lineage as the
  // one just replayed) before proceeding — never just the top-level
  // status alone — so a coincidental, unrelated status change can never
  // be mistaken for this replay's own success.
  const pollResult = await waitForDurableCommitImpl(
    fetchState,
    storyId,
    (r) =>
      (r.status === "awaiting_approval" && r.caption?.status === "ready" && typeof r.caption?.text === "string" && r.caption.text.length > 0 && r.caption?.claim?.claim_id === claimId) ||
      r.status === "failed",
    {
      onWaiting: (attempt, attempts, reason) => {
        console.log(`story_id=${storyId} has not yet durably confirmed the caption recovery replay — waiting (attempt ${attempt}/${attempts}, reason=${reason})...`);
      },
    }
  );

  if (!pollResult.committed) {
    console.log(
      `story_id=${storyId} caption recovery replay did not durably confirm within the poll budget (status=${pollResult.status}${pollResult.error ? `, error=${pollResult.error}` : ""}). Failing closed: no second replay, no regeneration, no approval. A future run will re-evaluate this exact record fresh.`
    );
    return { ok: false, step: "caption_recovery_durable_poll", selected: { story_id: storyId, record }, pollResult };
  }

  const recoveredRecord = pollResult.record;

  if (recoveredRecord.status !== "awaiting_approval") {
    console.log(`story_id=${storyId} reached a durable terminal state of "${recoveredRecord.status}" after replay (not awaiting_approval) — recovery did not fully succeed. No approval attempted.`);
    return { ok: true, selected: { story_id: storyId, record: recoveredRecord }, prepared: false, finalStatus: recoveredRecord.status };
  }

  return tryAutoApprove(storyId, recoveredRecord, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
}

/**
 * 2026-09-14 hands-off recovery integration. Handles a "recover-artwork"
 * selection: a record whose PRIMARY artwork-completed dispatch was
 * durably recorded "completed" by the Cloudflare Worker's Durable Object
 * but never durably applied to data/social-state.json (see this file's
 * own header and artworkRecoveryEligibility.js's own header for the exact
 * race and the fail-closed contract this enforces). Fails closed at every
 * step: never re-uploads or regenerates artwork, never creates a new
 * artwork claim, never approves before the replay is durably confirmed,
 * never retries a second replay within one run. Once the artwork itself
 * durably reaches "artwork_ready", delegates to the SAME runGeneratePipeline()
 * a fresh "generate" candidate uses — process-one.js's own existing,
 * destination-aware recovery routing takes it from there straight into
 * caption work, with zero artwork regeneration.
 */
async function tryRecoverArtwork(storyId, record, { getArtworkClaimStatusImpl, replayArtworkCompletionImpl, waitForDurableCommitImpl, runPreparationImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now = Date.now() }) {
  let statusResult;
  try {
    statusResult = await getArtworkClaimStatusImpl(storyId);
  } catch (err) {
    console.log(`story_id=${storyId} artwork recovery: failed to read the Durable Object's claim status (${err.message}). Failing closed: no replay attempted.`);
    return { ok: false, step: "artwork_recovery_status_read", selected: { story_id: storyId, record } };
  }

  const eligibility = evaluateArtworkRecoveryEligibility(record, statusResult?.do_record ?? null);
  console.log(`Artwork recovery eligibility for story_id=${storyId}: ${JSON.stringify(eligibility)}`);

  if (!eligibility.eligible) {
    console.log(`story_id=${storyId} is NOT safely replayable (${eligibility.issues.join(", ")}). Failing closed: no replay, no regeneration, no approval.`);
    // ok:true — same reasoning as caption recovery's own ineligibility
    // branch: a routine, frequent, expected outcome (e.g. generation
    // genuinely still in progress elsewhere), never a workflow failure.
    return { ok: true, step: "artwork_recovery_eligibility", selected: { story_id: storyId, record }, eligibility };
  }

  const claimId = eligibility.claimId;
  console.log(`story_id=${storyId} passes every automatic artwork-recovery safety check. Replaying the Durable Object's own stored completion (claim_id=${claimId}) — no new claim, no new content, no re-upload.`);
  const replayResult = await replayArtworkCompletionImpl(storyId, claimId);
  console.log(`replayArtworkCompletion result: ${JSON.stringify(replayResult)}`);

  if (!replayResult.replayed) {
    console.log(`story_id=${storyId} artwork recovery replay was refused (${replayResult.reason ?? "unknown"}). Failing closed: no retry, no regeneration, no approval. A future run will re-evaluate this exact record fresh.`);
    return { ok: false, step: "artwork_recovery_replay", selected: { story_id: storyId, record }, replayResult };
  }

  const pollResult = await waitForDurableCommitImpl(
    fetchState,
    storyId,
    (r) => r.status === "artwork_ready" || r.status === "failed",
    {
      onWaiting: (attempt, attempts, reason) => {
        console.log(`story_id=${storyId} has not yet durably confirmed the artwork recovery replay — waiting (attempt ${attempt}/${attempts}, reason=${reason})...`);
      },
    }
  );

  if (!pollResult.committed) {
    console.log(
      `story_id=${storyId} artwork recovery replay did not durably confirm within the poll budget (status=${pollResult.status}${pollResult.error ? `, error=${pollResult.error}` : ""}). Failing closed: no second replay, no regeneration, no approval. A future run will re-evaluate this exact record fresh.`
    );
    return { ok: false, step: "artwork_recovery_durable_poll", selected: { story_id: storyId, record }, pollResult };
  }

  const recoveredRecord = pollResult.record;

  if (recoveredRecord.status !== "artwork_ready") {
    console.log(`story_id=${storyId} reached a durable terminal state of "${recoveredRecord.status}" after replay (not artwork_ready) — recovery did not fully succeed. No further action attempted.`);
    return { ok: true, selected: { story_id: storyId, record: recoveredRecord }, prepared: false, finalStatus: recoveredRecord.status };
  }

  console.log(`story_id=${storyId} artwork durably recovered — continuing into caption work via the existing recovery-aware process-one.js pipeline (no artwork regeneration).`);
  return runGeneratePipeline(storyId, recoveredRecord, { runPreparationImpl, waitForDurableCommitImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
}

/**
 * @param {{fetchQueue?: Function, fetchState?: Function, live?: boolean, runPreparationImpl?: Function, decideApprovalImpl?: Function, waitForApprovalCommitImpl?: Function, waitForDurableCommitImpl?: Function, getCaptionClaimStatusImpl?: Function, replayCaptionCompletionImpl?: Function, getArtworkClaimStatusImpl?: Function, replayArtworkCompletionImpl?: Function, selectCandidateImpl?: Function, now?: number}} [args]
 */
export async function main({
  fetchQueue = fetchArtworkQueue,
  fetchState = createFreshStateFetcher(),
  live = false,
  runPreparationImpl = runExistingPreparationPipeline,
  decideApprovalImpl = decideApproval,
  waitForApprovalCommitImpl = waitForApprovalCommit,
  waitForDurableCommitImpl = waitForDurableCommit,
  getCaptionClaimStatusImpl = getCaptionClaimStatus,
  replayCaptionCompletionImpl = replayCaptionCompletion,
  getArtworkClaimStatusImpl = getArtworkClaimStatus,
  replayArtworkCompletionImpl = replayArtworkCompletion,
  selectCandidateImpl = selectAutonomousCandidate,
  now = Date.now(),
  // 2026-09-15 restoration: fresh artwork generation (Priority 4 below)
  // requires the local Codex/GPT-5.6 Sol creative path (see
  // process-one.js's own header) — codex.exe can never exist on a GitHub
  // Actions runner, exactly the original 2026-09-14 incident this whole
  // restoration traces back to. GITHUB_ACTIONS is set to "true" on every
  // GitHub-hosted run, unconditionally, by GitHub itself — no new secret,
  // no new config, and never set on the Windows machine's own local runs.
  // Injectable only for testing; production never overrides this.
  isCloudEnvironment = process.env.GITHUB_ACTIONS === "true",
} = {}) {
  // 2026-09-14: at most TWO selection attempts per run, never more — the
  // first is the normal, unqualified selection; the second (only reached
  // in LIVE mode, only when the first selection was "approve-only" and its
  // gate check failed) excludes that exact story_id and re-selects, so a
  // single not-yet-passing pending record can never block recover-caption
  // or fresh-generation work in the same run. This is NOT an open-ended
  // retry loop: a second "approve-only" failure (a different, older-next
  // pending record also failing) simply returns that result — there is no
  // third attempt, and no mutation ever occurs from a gate-check failure
  // itself, so this bound can never compound into more than one real
  // mutating action per run regardless of how many pending records exist.
  let excludeStoryIds;
  let firstPendingResult = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const selection = await selectCandidateImpl({ fetchQueue, fetchState, excludeStoryIds, now });

    if (!selection.mode) {
      // The excluded record (if any) is still the most useful thing to
      // report here — it was genuinely evaluated and left pending, not
      // simply "not found." Only fall back to the generic empty-queue
      // message when there truly was no first attempt to report.
      if (firstPendingResult) return firstPendingResult;
      console.log(
        `No statically-eligible autonomous candidate found. Inspected ${selection.inspectedCount} of ${selection.queueLength} queue records; skipped — legacy/missing canonical: ${selection.skipCounts.legacyMissingCanonical}, unsupported source: ${selection.skipCounts.unsupportedSource}, lifecycle: ${selection.skipCounts.lifecycle}.`
      );
      return { ok: true, selected: null, inspectedCount: selection.inspectedCount, queueLength: selection.queueLength, skipCounts: selection.skipCounts };
    }

    const { mode, story_id: storyId, record, queuePosition, inspectedCount, skipCounts } = selection;

    if (mode === "approve-only") {
      console.log(`Selected story_id=${storyId} — oldest pending awaiting_approval record; will be evaluated against the CURRENT auto-approval gate now.`);
    } else if (mode === "recover-artwork") {
      console.log(`Selected story_id=${storyId} — GitHub state alone looks like a stuck, durably-completed-but-unapplied PRIMARY artwork; eligibility against the Durable Object will be confirmed before any replay is attempted.`);
    } else if (mode === "recover-caption") {
      console.log(`Selected story_id=${storyId} — GitHub state alone looks like a stuck, durably-completed-but-unapplied caption; eligibility against the Durable Object will be confirmed before any replay is attempted.`);
    } else {
      console.log(`Selected story_id=${storyId} — queue position ${queuePosition} (${inspectedCount - 1} statically-ineligible record(s) skipped before it), the first statically-eligible candidate in existing FIFO order.`);
    }

    if (!live) {
      console.log("=== DRY RUN — no artwork generation, no caption generation, no Durable Object read, no replay, no approval, no state mutation ===");
      const wouldRequire =
        mode === "approve-only"
          ? "evaluation against the current auto-approval gate — approved only if every check currently passes"
          : mode === "recover-artwork"
            ? "Durable Object eligibility verification, then (only if safely eligible) a PRIMARY artwork-completion replay recovery — no regeneration — then caption work and full post-generation approval-gate evaluation"
            : mode === "recover-caption"
              ? "Durable Object eligibility verification, then (only if safely eligible) a caption-completion replay recovery — no regeneration — then full post-generation approval-gate evaluation"
              : "artwork generation, caption generation, then full post-generation approval-gate evaluation";
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
        would_require: wouldRequire,
      };
      console.log(JSON.stringify(report, null, 2));
      return { ok: true, selected: { story_id: storyId, record }, dryRun: report };
    }

    if (mode === "approve-only") {
      const result = await tryAutoApprove(storyId, record, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
      if (result.autoApproved || !result.ok || attempt === 2) return result;
      firstPendingResult = result;
      console.log(`story_id=${storyId} remains pending after re-evaluation — trying once more, excluding it, so it cannot block recover-artwork, recover-caption, or fresh-generation work this run.`);
      excludeStoryIds = [storyId];
      continue;
    }

    if (mode === "recover-artwork") {
      const result = await tryRecoverArtwork(storyId, record, { getArtworkClaimStatusImpl, replayArtworkCompletionImpl, waitForDurableCommitImpl, runPreparationImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
      // Same bounded-fallthrough principle as approve-only above: a pure
      // "not yet eligible" no-op (no replay ever attempted) must never
      // permanently block a DIFFERENT, genuinely-recoverable candidate —
      // proven necessary in practice: a record whose generation failed
      // BEFORE the cloud renderer existed (DO status "failed", never
      // "completed") sorts ahead of a genuinely-recoverable one by
      // selected_at, and would otherwise consume the entire run without
      // ever reaching it. A genuine failure past eligibility (replay
      // refused, durable-poll timeout) still stops here immediately.
      if (result.step !== "artwork_recovery_eligibility" || !result.ok || attempt === 2) return result;
      firstPendingResult = result;
      console.log(`story_id=${storyId} artwork is not yet safely recoverable — trying once more, excluding it, so it cannot block other work this run.`);
      excludeStoryIds = [storyId];
      continue;
    }

    if (mode === "recover-caption") {
      const result = await tryRecoverCaption(storyId, record, { getCaptionClaimStatusImpl, replayCaptionCompletionImpl, waitForDurableCommitImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
      // Same bounded-fallthrough principle — see recover-artwork's own
      // comment just above for the full reasoning.
      if (result.step !== "caption_recovery_eligibility" || !result.ok || attempt === 2) return result;
      firstPendingResult = result;
      console.log(`story_id=${storyId} caption is not yet safely recoverable — trying once more, excluding it, so it cannot block other work this run.`);
      excludeStoryIds = [storyId];
      continue;
    }

    // 2026-09-15 restoration guard — this is the ONE selection mode
    // ("generate": Priority 4, a "queued" record with no existing artwork
    // at all) that requires the local Codex creative path. Every other
    // mode above (approve-only, recover-artwork, recover-caption) either
    // never touches artwork generation or only replays an ALREADY-durably-
    // completed asset — none of them reach this line. Checked here,
    // BEFORE runPreparationImpl/runGeneratePipeline ever runs — no claim
    // has been made for this story_id by anything in this file at this
    // point, so skipping here can never poison a claim, mark the story
    // failed, or mutate any state: the story is simply left exactly as it
    // was, fully available for the Windows artwork runner's own next
    // (unmodified) run to claim and process normally.
    if (isCloudEnvironment) {
      console.log(
        `story_id=${storyId} requires fresh artwork generation (Priority 4), which needs the local Codex/GPT-5.6 Sol creative path — this GitHub Actions runner cannot perform it. Leaving it untouched; the Windows artwork runner will pick it up normally.`
      );
      return { ok: true, step: "generate_requires_local_runner", selected: { story_id: storyId, record } };
    }

    return runGeneratePipeline(storyId, record, { runPreparationImpl, waitForDurableCommitImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
  }
}

/**
 * The "generate" mode's full live-mode body — extracted from main() only so
 * the bounded selection-retry loop above stays readable; behavior is
 * unchanged from before this extraction.
 */
async function runGeneratePipeline(storyId, record, { runPreparationImpl, waitForDurableCommitImpl, decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now = Date.now() }) {
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

  return tryAutoApprove(storyId, freshRecord, { decideApprovalImpl, waitForApprovalCommitImpl, fetchState, now });
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

/**
 * 2026-09-14 workflow semantic-failure fix. Maps main()'s own resolved
 * result to a process exit code — extracted as a pure function so this
 * guarantee (a genuine infrastructure/durability failure MUST turn the
 * GitHub Actions workflow red, never green) is directly unit-testable.
 *
 * Before this fix, the CLI entrypoint only ever set a nonzero exit code if
 * main() itself REJECTED (an uncaught exception) — every one of main()'s
 * own considered `{ok: false, ...}` returns (a durable-commit timeout, a
 * caption-recovery replay refusal, an approval-commit-confirmation
 * timeout) resolved normally and reported a GREEN workflow run despite a
 * real semantic preparation failure — exactly what happened in production
 * (story_id 03388ac4-924c-48ac-91c1-987016029881: codex.exe unavailable on
 * the GitHub Actions runner, 3/3 generation attempts failed, the durable
 * post-preparation poll timed out, main() correctly returned `ok: false`
 * — and the workflow still showed green).
 *
 * main()'s own `ok` field already encodes exactly the SUCCESS/FAILURE
 * split this needs — "no eligible candidate," "candidate prepared and
 * approved," and "a legitimate gate/eligibility rejection handled as
 * designed" are all `ok: true`; "a durable state was never confirmed" and
 * "a Worker-side replay was refused" are `ok: false`. This function's only
 * job is making that field actually reach the process exit code.
 * @param {{ok: boolean}|null|undefined} result
 * @returns {0|1}
 */
export function determineExitCode(result) {
  return result && result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliLive = process.argv.includes("--live");
  const resolvedMode = resolveRunMode({ eventName: process.env.GITHUB_EVENT_NAME, inputMode: process.env.INPUT_MODE });
  const live = cliLive || resolvedMode === "live";
  main({ live })
    .then((result) => {
      const exitCode = determineExitCode(result);
      if (exitCode !== 0) {
        console.error(`auto-prepare-social finished with a non-success result (ok=${result?.ok}, step=${result?.step ?? "n/a"}) — failing the workflow visibly. See the log above for the exact reason.`);
      }
      process.exitCode = exitCode;
    })
    .catch((err) => {
      console.error("auto-prepare-social failed:", err);
      process.exitCode = 1;
    });
}
