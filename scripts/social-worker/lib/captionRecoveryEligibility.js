// Fail-closed eligibility check for the 2026-09-14 hands-off caption-
// completion recovery integration. Answers "would it be safe for the
// autonomous runner to automatically call
// POST /social/caption/replay-completion for this story right now" — pure,
// no I/O, given an already-fetched GitHub record and an already-fetched
// Durable Object caption-claim record (cloudflare-worker's
// POST /social/caption/claim-status).
//
// Exists because the 2026-09-11 claim_mismatch durability fix (see
// scripts/social/apply-artwork-event.js's own header) closed the race going
// forward, but left one class of ALREADY-stuck record with no automatic
// recovery: a caption-completed dispatch the Durable Object recorded as
// "completed" (repository_dispatch accepted by GitHub) that never durably
// landed in data/social-state.json. cloudflare-worker's
// /social/caption/replay-completion re-fires that exact stored payload —
// this module decides WHETHER the runner may call it, and reports the
// exact reason when it may not.
//
// Deliberately reuses assessPostingCleanState() from autoApprovalGate.js
// (the same defense-in-depth posting-clean check the pre-generation
// eligibility filter and the post-generation approval gate already share)
// rather than a third, drifting copy.
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
export function githubSideCaptionRecoveryIssues(record) {
  const issues = [];

  if (!record || !isNonEmptyString(record.story_id)) {
    return ["invalid_record"];
  }

  if (record.merged_into) issues.push("story_merged");

  // The state machine's own mutual exclusivity already makes this single
  // check equivalent to "not posted, not posting, not rejected, not
  // failed" — checked explicitly anyway (same defense-in-depth style as
  // autoApprovalGate.js's own not_awaiting_approval check) so a caller
  // sees a precise reason rather than inferring one.
  if (record.status !== "artwork_ready") {
    issues.push(`not_artwork_ready:${record.status ?? "none"}`);
  }
  if (record.approval?.status === "approved") issues.push("already_approved");
  if (record.status === "posting") issues.push("story_posting");
  if (record.status === "posted") issues.push("story_posted");

  if (record.caption?.status === "ready") {
    // Nothing to recover — either it was already applied normally, or a
    // prior recovery replay already succeeded. Never re-replay.
    issues.push("caption_already_ready");
  }

  // 2026-09-17: deliberately NOT a "no_existing_caption_claim" disqualifier
  // here anymore. Confirmed live (story 68026926) that the checkout-
  // staleness race this module exists to close can be more severe than
  // originally modeled: not just the caption-COMPLETED dispatch failing to
  // land, but the ORIGINAL caption-CLAIMED dispatch too — leaving GitHub
  // showing claim_attempt_count: 0 / claim.claim_id: null even though the
  // Durable Object durably recorded a full claim+completion lifecycle
  // (status: completed, dispatch_confirmed: true, real caption text). A
  // record with no GitHub-side claim at all is the ordinary, common case
  // (nothing has been attempted yet, or another run is mid-flight) far
  // more often than this one — evaluateCaptionRecoveryEligibility below
  // still correctly reports ineligible (do_record_not_found, or
  // do_status_not_completed for an active/expired claim) for every one of
  // those; only a genuinely DO-completed record for THIS exact story_id
  // now also becomes visible for automatic recovery.
  issues.push(...assessPostingCleanState(record));

  return issues;
}

/**
 * Full eligibility — GitHub-side issues above, plus the Durable Object
 * checks that can only be answered after a claim-status read. The DO
 * checks are ordered last and only evaluated for their own sake (a
 * GitHub-side issue is reported regardless of DO state) so a caller always
 * sees every reason at once, never just the first one found.
 * @param {object} record - a data/social-state.json story record
 * @param {object|null} doRecord - cloudflare-worker's stored caption:{story_id} claim record, or null if none exists
 * @returns {{eligible: boolean, issues: string[], claimId: string|null}}
 */
export function evaluateCaptionRecoveryEligibility(record, doRecord) {
  const issues = githubSideCaptionRecoveryIssues(record);
  const githubClaimId = record?.caption?.claim?.claim_id ?? null;
  let claimId = githubClaimId;

  if (!doRecord) {
    issues.push("do_record_not_found");
  } else if (githubClaimId) {
    // The ordinary case this module was originally built for: GitHub
    // already shows the claim that was made, only its COMPLETION never
    // landed. The DO's claim_id must match the exact claim GitHub knows
    // about — never a different, later claim.
    if (doRecord.claim_id !== githubClaimId) {
      issues.push("do_claim_id_mismatch");
    }
    if (doRecord.status !== "completed") {
      issues.push(`do_status_not_completed:${doRecord.status ?? "none"}`);
    }
    if (!doRecord.payload) {
      issues.push("do_payload_missing");
    }
  } else {
    // 2026-09-17: GitHub shows NO claim at all — either nothing has been
    // attempted yet (do_record_not_found above already covers that, since
    // this branch only runs when doRecord exists), or the ORIGINAL
    // caption-claimed dispatch itself never landed either. Safe to trust
    // the DO's own claim_id here ONLY when its stored payload's story_id
    // matches this exact record — the same story_id-namespaced DO key
    // (captionDoKey()) makes a mismatch practically impossible, but this
    // is a cheap, free extra guarantee before ever using a claim_id GitHub
    // itself never confirmed.
    if (doRecord.status !== "completed") {
      issues.push(`do_status_not_completed:${doRecord.status ?? "none"}`);
    }
    if (!doRecord.payload) {
      issues.push("do_payload_missing");
    } else if (doRecord.payload.story_id !== record?.story_id) {
      issues.push("do_payload_story_id_mismatch");
    } else {
      claimId = doRecord.claim_id ?? null;
      if (!claimId) issues.push("do_claim_id_missing");
    }
  }

  return { eligible: issues.length === 0, issues, claimId: issues.length === 0 ? claimId : null };
}
