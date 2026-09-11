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
//   - sourceTier() (editorialSourceConfidence.js) — the only existing
//     source-categorization concept in this codebase. There is no
//     dedicated "allowed sources" allowlist anywhere in the repo (audited
//     2026-09-11); this gate treats "known" (tier A or B) as the closest
//     existing stand-in for "currently allowed NFL news sources," and
//     rejects "unknown" outlets rather than guessing. If a true allowlist
//     is ever introduced, swap the check below for it — do not silently
//     loosen this in the meantime.
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
import { sourceTier, UNKNOWN_SOURCE_TIER } from "../../lib/editorialSourceConfidence.js";
import { channelKeyFor } from "../../lib/postingEvents.js";

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

  // No existing allowlist of trusted sources exists anywhere in this
  // codebase (audited 2026-09-11) — sourceTier() is the closest existing
  // categorization. An "unknown" outlet is rejected here, never guessed as
  // safe; see this file's header for why this specific substitution was
  // made rather than inventing a new list.
  const tier = sourceTier(source.source_name);
  if (tier === UNKNOWN_SOURCE_TIER) {
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

  // Defense-in-depth: a record legitimately at awaiting_approval has never
  // begun a posting cycle (approved -> posting is the only edge into
  // posting, and approval hasn't happened yet), so these should already be
  // structurally guaranteed — checked explicitly anyway so a bug elsewhere
  // can never silently slip an in-flight/ambiguous record through this gate.
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

  return { eligible: issues.length === 0, issues };
}
