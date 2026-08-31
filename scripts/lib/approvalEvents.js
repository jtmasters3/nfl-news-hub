// Pure state-transition handlers for the approval-bridge events
// (approval-approved / approval-rejected) fired by the Cloudflare Worker
// via repository_dispatch and applied by scripts/social/apply-artwork-event.js.
// Built entirely on top of scripts/lib/socialState.js's existing
// transition() — this is NOT a second state machine; "approved" and
// "rejected" are already legal edges from "awaiting_approval" in its
// TRANSITIONS table.
//
// Unlike artworkEvents.js/captionEvents.js, there is no claim_id to match
// here: the Durable Object's approval:{story_id} claim record is
// intentionally never mirrored into data/social-state.json (see the
// Approval reliability design) — it exists purely to make the Worker's
// dispatch decision atomic and first-decision-wins. transition()'s own
// status guard is what makes a replayed event safe: once a story has
// already moved to "approved" or "rejected", a duplicate/late event for
// the same or opposite decision hits `invalid_transition:*->*` and is
// treated as a harmless skip by apply-artwork-event.js's existing
// SKIPPABLE_ERRORS handling — the exact same mechanism already proven for
// artwork/caption event replay.
import { transition } from "./socialState.js";

/**
 * @param {object} state
 * @param {{story_id: string, decision: "approved"|"rejected", request_id: string, actor: string, decision_source: string, decided_at: string, rejection_reason?: string|null}} payload
 * @param {"approved"|"rejected"} toStatus
 */
function applyApprovalDecisionEvent(state, payload, toStatus) {
  const { story_id, request_id, actor, decision_source, decided_at, rejection_reason } = payload;
  const now = decided_at || new Date().toISOString();

  const approvalPatch = {
    status: toStatus,
    decided_at: now,
    approved_at: toStatus === "approved" ? now : null,
    rejected_at: toStatus === "rejected" ? now : null,
    rejection_reason: toStatus === "rejected" ? rejection_reason ?? null : null,
    actor: actor ?? null,
    request_id: request_id ?? null,
    decision_source: decision_source ?? null,
  };

  // transition() shallow-merges patch AFTER the status change and rejects
  // (ok: false, error: invalid_transition:*) if storyId isn't currently
  // "awaiting_approval" — never touches artwork, caption, or last_error.
  return transition(state, story_id, toStatus, { approval: approvalPatch });
}

/** awaiting_approval -> approved. Artwork and caption are untouched (transition() only patches `approval`). */
export function applyApprovalApprovedEvent(state, payload) {
  return applyApprovalDecisionEvent(state, payload, "approved");
}

/**
 * awaiting_approval -> rejected. Artwork and caption remain fully
 * preserved — nothing is deleted, nothing is regenerated, and last_error
 * is deliberately NOT touched: a rejection is a human decision, not a
 * failure. "rejected" has no outgoing edges in TRANSITIONS — it's a
 * deliberate dead end for this phase; a future explicit reopen/
 * change-decision workflow is the documented (not yet built) extension
 * point if that's ever needed.
 */
export function applyApprovalRejectedEvent(state, payload) {
  return applyApprovalDecisionEvent(state, payload, "rejected");
}
