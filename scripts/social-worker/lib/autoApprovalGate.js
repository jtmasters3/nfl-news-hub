// Fail-closed automatic-approval gate for the autonomous preparation
// runner (scripts/social/auto-prepare-social.js). Pure function, no I/O —
// every check reuses an EXISTING production validation/state contract
// rather than inventing a second one:
//
//   - assessApprovalReadiness() (approvalReadiness.js) — the SAME
//     destination-aware artwork/caption readiness check the human Approval
//     Console already uses to decide whether to even show live Approve/
//     Reject buttons, itself a mirror of the Worker's own authoritative
//     storyReadyForApproval() gate. This is the single biggest piece of
//     this gate, deliberately reused rather than re-implemented.
//   - isAutoApprovalAllowedSource() (autoApprovalSourceAllowlist.js) — an
//     EXPLICIT, audited, exact-match allowlist of sources actually
//     intended for autonomous approval (2026-09-11: replaced an earlier
//     version of this gate that leaned on editorialSourceConfidence.js's
//     scoring-tier map as a stand-in for a real allowlist — that map is a
//     confidence score, not a gate, and included aliases never seen in
//     real production data. See that file's own header for the exact
//     audit).
//   - evaluateContentFidelity() (contentFidelityGate.js) — added
//     2026-09-11 to close a real, audited gap: nothing previously verified
//     that the generated caption's own CONTENT (named players/teams,
//     injury/transaction claims, quotes, numbers) was consistent with the
//     canonical, already-extracted source-article data. See that file's
//     own header for exactly what it checks and its honest limits.
//   - channelKeyFor() (postingEvents.js) — the same destination-to-channel
//     mapping the posting/publishing path already uses, reused here only
//     to point at the right publishing.instagram.<channel> sub-object for
//     the claim/publish_attempted/ambiguity checks.
//
// This module NEVER approves anything itself — it only answers "would an
// approval decision be safe right now," fully offline, given an already-
// fetched record. The actual decision (if this says yes) is still made
// through the existing production decideApproval()/approval-decide state
// machine, never by writing approval.status directly.
import { assessApprovalReadiness } from "./approvalReadiness.js";
import { isAutoApprovalAllowedSource } from "../../lib/autoApprovalSourceAllowlist.js";
import { evaluateContentFidelity } from "./contentFidelityGate.js";
import { channelKeyFor } from "../../lib/postingEvents.js";

export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function isHttpsUrl(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Shared defense-in-depth check, reused by both this gate and
 * staticAutonomousEligibility.js's pre-generation check: proves a record
 * has never begun (or is not mid) a posting cycle. For a record legitimately
 * at "queued" or "awaiting_approval" this is structurally guaranteed by the
 * state machine itself (approved -> posting is the only edge into posting),
 * so this exists purely so a bug elsewhere can never silently slip an
 * in-flight/ambiguous record through either gate.
 * @param {object} record
 * @returns {string[]} issue codes, empty when clean
 */
export function assessPostingCleanState(record) {
  const issues = [];
  if (isNonEmptyString(record.publishing?.claim?.claim_id)) {
    issues.push("active_posting_claim");
  }
  if (record.publishing?.status && record.publishing.status !== "not_posted") {
    issues.push(`publishing_status_not_clean:${record.publishing.status}`);
  }
  const channelKey = channelKeyFor(record);
  const channel = record.publishing?.instagram?.[channelKey];
  if (channel?.publish_attempted_at) {
    issues.push("publish_attempted_already_recorded");
  }
  if (channel?.status === "ambiguous") {
    issues.push("ambiguous_posting_outcome");
  }
  return issues;
}

/**
 * @param {object} record - a data/social-state.json story record, freshly
 *   read (SHA-pinned) immediately before this gate is evaluated — never a
 *   stale/cached snapshot.
 * @returns {{eligible: boolean, issues: string[]}}
 */
export function evaluateAutoApprovalGate(record) {
  const issues = [];

  if (!record || !isNonEmptyString(record.story_id)) {
    return { eligible: false, issues: ["invalid_record"] };
  }

  // The state machine's own mutual exclusivity already makes this single
  // check equivalent to "not posted, not posting, not rejected, not
  // failed, not merged" — approval decisions are only ever legal from
  // exactly this one top-level state (see socialState.js's TRANSITIONS
  // table: awaiting_approval -> [approved, rejected] is the only outgoing
  // edge that decideApproval() can ever take). Checked explicitly anyway,
  // both for defense in depth and so a caller sees a precise reason.
  if (record.status !== "awaiting_approval") {
    issues.push(`not_awaiting_approval:${record.status ?? "none"}`);
  }
  if (record.approval?.status !== "pending") {
    issues.push(`approval_not_pending:${record.approval?.status ?? "none"}`);
  }
  if (record.merged_into) {
    issues.push("story_merged");
  }

  const destination = record.selection?.destination;
  if (!record.selection) {
    issues.push("no_selection");
  } else if (destination !== "feed" && destination !== "story") {
    issues.push(`invalid_destination:${destination ?? "none"}`);
  }

  // Required source-article fixture fields — the exact same two fields
  // process-one.js's own missingFixtureFields() requires before it will
  // ever attempt generation at all (REQUIRED_FIXTURE_FIELDS in
  // selectTarget.js), reused here rather than duplicated as a second list.
  const source = record.source_story ?? {};
  if (!isNonEmptyString(source.post_headline)) issues.push("headline_missing");
  if (!isNonEmptyString(source.base_image_url)) issues.push("base_image_url_missing");
  if (!isHttpsUrl(source.source_url)) issues.push("source_url_invalid");

  // Explicit, audited, exact-match allowlist — never the scoring-tier map.
  // See autoApprovalSourceAllowlist.js's own header for the exact audit.
  if (!isAutoApprovalAllowedSource(source.source_name)) {
    issues.push(`unrecognized_source:${source.source_name ?? "none"}`);
  }

  // The existing destination-aware artwork/caption readiness check —
  // reused verbatim, never re-implemented. Already covers: canonical
  // artwork field matches destination (record.artwork for feed,
  // record.story_artwork for story), artwork status="created", an HTTPS
  // image_url (implicitly, via the same validation that set
  // validation.passed), validation.passed===true (which itself already
  // encodes the destination's own aspect-ratio/dimension/mime/size
  // checks — see artworkValidation.js's validateArtwork/
  // validateArtworkForDestination), caption.status="ready", and non-empty
  // caption text.
  const readiness = assessApprovalReadiness(record);
  if (!readiness.ready) {
    for (const issue of readiness.issues) issues.push(`readiness:${issue}`);
  }

  // Content-fidelity: proves the generated caption's own CONTENT (named
  // players/teams, injury/transaction claims, quotes, numbers) is
  // consistent with the canonical, already-extracted source-article data —
  // see contentFidelityGate.js's own header for exactly what this checks
  // and its honest, disclosed limits (it is a deterministic heuristic, not
  // true NLP fact-checking, and never claims to verify source-image
  // subject relevance, which cannot be deterministically proven from data
  // this codebase persists today).
  const fidelity = evaluateContentFidelity(record);
  if (!fidelity.passed) {
    for (const issue of fidelity.issues) issues.push(`fidelity:${issue}`);
  }

  // Defense-in-depth: a record legitimately at awaiting_approval has never
  // begun a posting cycle — see assessPostingCleanState()'s own doc comment.
  issues.push(...assessPostingCleanState(record));

  return { eligible: issues.length === 0, issues };
}
