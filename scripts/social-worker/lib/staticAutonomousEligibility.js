// Pure, PRE-generation eligibility check for autonomous preparation —
// answers "could this record possibly reach automatic approval at all"
// using ONLY facts already known before any artwork/caption generation is
// attempted. Exists to fix a real, audited waste: the live artwork queue's
// FIFO front is dominated by a legacy backlog (~472 of 514 records,
// audited 2026-09-11) that predates Stage-3A selection/canonical entity
// extraction — these records structurally can never pass
// contentFidelityGate.js (missing_canonical_teams_list/
// missing_canonical_players_list) no matter how well artwork/caption
// generation goes, so spending a real Codex generation attempt on them is
// pure waste. This check lets the autonomous runner skip them BEFORE
// generation, never after.
//
// Deliberately reuses the same building blocks evaluateAutoApprovalGate()
// uses post-generation (isAutoApprovalAllowedSource, isHttpsUrl,
// assessPostingCleanState) rather than a second, drifting copy — this file
// checks everything determinable from record.source_story + lifecycle
// state alone; it never touches record.artwork/record.story_artwork/
// record.caption, since those don't exist yet for a fresh "queued" record.
//
// This module NEVER skips a record for having an EMPTY (but present)
// teams[]/players[] array — an empty array is the canonical extraction
// pipeline's own legitimate way of saying "no named entities extracted for
// this story" (e.g. a team-level story with no specific player), and
// contentFidelityGate.js already treats it the same way. Only the FIELD'S
// OUTRIGHT ABSENCE (not an array at all — the actual legacy-backlog shape)
// is treated as disqualifying.
//
// This module never mutates, deletes, reassigns, or backfills anything —
// it is a pure read-only classification. A record that fails this check
// is simply never selected by the autonomous runner; it remains exactly
// as it is, fully available to any existing human/manual workflow.
import { isAutoApprovalAllowedSource } from "../../lib/autoApprovalSourceAllowlist.js";
import { isNonEmptyString, isHttpsUrl, assessPostingCleanState } from "./autoApprovalGate.js";

// The only two lifecycle states the autonomous runner may ever act on:
// "queued" (fresh, needs full generation) or "awaiting_approval" (already
// fully prepared by a prior run — human or automated — needs only a
// decision, never regeneration). Every other status (posting, posted,
// rejected, failed, or any mid-pipeline artwork/caption-claim state) is
// left entirely alone by this pass — see this file's own header for why
// mid-pipeline recovery scanning is out of scope here, not silently
// dropped.
const AUTONOMOUS_ACTIONABLE_STATUSES = new Set(["queued", "awaiting_approval"]);

/**
 * @param {object} record - a data/social-state.json story record
 * @returns {{eligible: boolean, issues: string[]}}
 */
export function evaluateStaticAutonomousEligibility(record) {
  const issues = [];

  if (!record || !isNonEmptyString(record.story_id)) {
    return { eligible: false, issues: ["invalid_record"] };
  }

  if (record.merged_into) issues.push("story_merged");

  if (!AUTONOMOUS_ACTIONABLE_STATUSES.has(record.status)) {
    issues.push(`not_autonomous_actionable_status:${record.status ?? "none"}`);
  }

  if (record.approval?.status === "approved") issues.push("already_approved");
  if (record.approval?.status === "rejected") issues.push("already_rejected");

  if (!record.selection) {
    issues.push("no_selection");
  } else {
    const destination = record.selection.destination;
    if (destination !== "feed" && destination !== "story") {
      issues.push(`invalid_destination:${destination ?? "none"}`);
    }
  }

  const source = record.source_story ?? {};
  if (!isAutoApprovalAllowedSource(source.source_name)) {
    issues.push(`unrecognized_source:${source.source_name ?? "none"}`);
  }
  if (!isHttpsUrl(source.source_url)) issues.push("source_url_invalid");
  if (!isNonEmptyString(source.post_headline)) issues.push("headline_missing");
  if (!isNonEmptyString(source.description)) issues.push("description_missing");

  // Present-but-empty is legitimate (canonical "no entities extracted");
  // only outright absence (not an array at all — the real legacy shape) is
  // disqualifying. Never require non-empty.
  if (!Array.isArray(source.teams)) issues.push("teams_field_missing");
  if (!Array.isArray(source.players)) issues.push("players_field_missing");

  issues.push(...assessPostingCleanState(record));

  return { eligible: issues.length === 0, issues };
}
