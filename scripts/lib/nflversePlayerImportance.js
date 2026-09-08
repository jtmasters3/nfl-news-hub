// Editorial Scoring Brain — Phase 2G (Part A): QB importance classification.
// Answers ONLY: "is this player a QB, and how editorially important is that
// specific QB role?" Pure, offline, no network, no file reads, no identity/
// position/role re-resolution — the caller supplies the already-resolved
// Phase 2D normalized_position and the effective role (Phase 2E's
// structured role, or Phase 2F's fresher role when its override applies;
// this module never imports Phase 2F itself, it only ever consumes a role
// string, keeping the two phases decoupled).
//
// This is metadata only — no numeric weight, no scoring integration.
// Phase 1's own OBSERVE_ONLY_CALIBRATION_DEFAULTS already reserves
// ROLE_MULTIPLIER/STAR_BOOST constants (both always neutral 1.0 today,
// documented there as "no position/depth-chart data exists yet" /
// "no star-exception list exists yet") — deciding the actual numbers that
// consume this module's output is explicitly Phase 2H's job, not this one.

const QB_ROLE_IMPORTANCE = Object.freeze({
  starter: { qb_importance: "elevated", reason: "qb_role_elevated" },
  backup: { qb_importance: "elevated", reason: "qb_role_elevated" },
  significant_rotation: { qb_importance: "elevated", reason: "qb_role_elevated" },
  fringe: { qb_importance: "low", reason: "qb_role_low" },
  practice_squad: { qb_importance: "low", reason: "qb_role_low" },
});

/**
 * @param {{normalized_position: string|null, resolved_role: string|null}} input
 * @returns {{is_qb: boolean, qb_importance: "elevated"|"standard"|"low"|"none", reason_codes: string[]}}
 */
export function classifyQbImportance({ normalized_position = null, resolved_role = null } = {}) {
  if (normalized_position !== "QB") {
    return { is_qb: false, qb_importance: "none", reason_codes: ["not_qb"] };
  }
  const mapped = QB_ROLE_IMPORTANCE[resolved_role];
  if (mapped) return { is_qb: true, qb_importance: mapped.qb_importance, reason_codes: [mapped.reason] };
  // "unknown" role, or any other value this module doesn't recognize —
  // never guess elevated/low without a locked mapping.
  return { is_qb: true, qb_importance: "standard", reason_codes: ["qb_role_unknown_standard"] };
}
