// Fail-closed eligibility check for the 2026-09-14 hands-off PRIMARY
// artwork-completion recovery — the direct sibling of
// captionRecoveryEligibility.js, for the artwork-completed event instead
// of caption-completed. Answers "would it be safe for the autonomous
// runner to automatically call POST /social/artwork/replay-completion for
// this story right now" — pure, no I/O, given an already-fetched GitHub
// record and an already-fetched Durable Object PRIMARY-artwork-claim
// record (cloudflare-worker's POST /social/artwork/claim-status).
//
// Exists because the 2026-09-14 invalid_state checkout-staleness fix (see
// scripts/social/apply-artwork-event.js's own header) closed the race
// going forward, but left one already-stuck record with no automatic
// recovery: an artwork-completed dispatch the Durable Object recorded as
// "completed" (repository_dispatch accepted by GitHub) that never durably
// landed in data/social-state.json — proven against story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd (a Story-primary completion).
// cloudflare-worker's /social/artwork/replay-completion re-fires that
// exact stored payload — this module decides WHETHER the runner may call
// it, and reports the exact reason when it may not.
//
// Deliberately reuses assessPostingCleanState() from autoApprovalGate.js —
// the same defense-in-depth posting-clean check every other eligibility
// filter in this codebase already shares — rather than a third, drifting copy.
import { isNonEmptyString, assessPostingCleanState } from "./autoApprovalGate.js";

/**
 * The GitHub-side half of eligibility — everything determinable from the
 * record alone, before any Durable Object read is even attempted. Used
 * both as this module's own first half AND as the cheap, no-network
 * pre-filter auto-prepare-social.js's selectAutonomousCandidate() uses to
 * decide which story_id is even worth fetching DO status for.
 * @param {object} record
 * @returns {string[]} issue codes, empty when the GitHub side is clean
 */
export function githubSideArtworkRecoveryIssues(record) {
  const issues = [];

  if (!record || !isNonEmptyString(record.story_id)) {
    return ["invalid_record"];
  }

  if (record.merged_into) issues.push("story_merged");

  // The ONLY observable "stuck" resting state a dropped artwork-completed
  // event can leave behind — applyCompleteEvent() (artworkEvents.js)
  // transitions artwork_requested -> artwork_created -> validating ->
  // (artwork_ready|failed) all within one call, writing only the FINAL
  // state, so "validating" is never itself an observable resting state.
  if (record.status !== "artwork_requested") {
    issues.push(`not_artwork_requested:${record.status ?? "none"}`);
  }
  if (record.approval?.status === "approved") issues.push("already_approved");
  if (record.status === "posting") issues.push("story_posting");
  if (record.status === "posted") issues.push("story_posted");

  if (!isNonEmptyString(record.claim?.claim_id)) {
    issues.push("no_existing_artwork_claim");
  }

  issues.push(...assessPostingCleanState(record));

  return issues;
}

/**
 * Full eligibility — GitHub-side issues above, plus the Durable Object
 * checks that can only be answered after a claim-status read.
 * @param {object} record - a data/social-state.json story record
 * @param {object|null} doRecord - cloudflare-worker's stored PRIMARY-artwork claim record for this story_id, or null if none exists
 * @returns {{eligible: boolean, issues: string[], claimId: string|null}}
 */
export function evaluateArtworkRecoveryEligibility(record, doRecord) {
  const issues = githubSideArtworkRecoveryIssues(record);
  const claimId = record?.claim?.claim_id ?? null;

  if (!doRecord) {
    issues.push("do_record_not_found");
  } else {
    if (!claimId || doRecord.claim_id !== claimId) {
      issues.push("do_claim_id_mismatch");
    }
    if (doRecord.status !== "completed") {
      issues.push(`do_status_not_completed:${doRecord.status ?? "none"}`);
    }
    if (!doRecord.payload) {
      issues.push("do_payload_missing");
    }
  }

  return { eligible: issues.length === 0, issues, claimId: issues.length === 0 ? claimId : null };
}
