// Editorial Scoring Brain — Phase 2H-A: observe-only player-importance
// scoring math. Combines Phase 2D (position), Phase 2E/2F (effective
// role), and Phase 2G (QB importance, star/notable) into the ROLE_MULTIPLIER
// and STAR_BOOST factors Phase 1's own scoreStory() has always reserved
// (OBSERVE_ONLY_CALIBRATION_DEFAULTS.ROLE_MULTIPLIER/STAR_BOOST, both
// hardcoded neutral 1.0 there today — see editorialScoring.js and
// scripts/editorial/README.md's "What Phase 2 will add" section, which
// names exactly this).
//
// Pure, offline, no network, no file reads. Zero production/pipeline
// importers by design — this is calibration math only. Phase 2H-B will
// decide, separately, whether/how to wire this into scoreStory() itself;
// this module does not import or call scoreStory(), editorialScoring.js,
// or editorialEventMagnitude.js, and changes nothing about Phase 1's
// existing (always-neutral) behavior.
//
// This module never re-derives identity, position, role, QB status, or
// star status — every one of those is consumed as an already-resolved
// value from the caller (Phase 2C/2D/2E/2F/2G). In particular, "do not
// infer QB status independently" is honored literally: QB routing is
// driven ONLY by the supplied `qb_importance` value (Phase 2G's own
// locked output), never by re-checking `normalized_position === "QB"`.

// ---------------------------------------------------------------------------
// POSITION_WEIGHT — QB branch, keyed by Phase 2G's locked qb_importance.
// Restrained per the locked guardrail (position alone: 0.85-1.25). QB
// starter/backup/significant_rotation all map to Phase 2G's "elevated" —
// they get the SAME position weight; the starter>backup>fringe ordering
// among QBs comes entirely from ROLE_WEIGHT below, layered multiplicatively
// on top. This is deliberate: position_weight answers "how much does being
// a QB matter given how rotation-relevant this QB currently is", role_weight
// separately answers "how central is this role", and the two compound.
// ---------------------------------------------------------------------------
const QB_POSITION_WEIGHT = Object.freeze({
  elevated: 1.2, // starter / backup / significant_rotation QB
  standard: 1.1, // unknown-role QB — still a QB, just unresolved role
  low: 0.95, // fringe / practice_squad QB — a real depth-chart QB, but not rotation-relevant
});
const QB_POSITION_WEIGHT_FALLBACK = QB_POSITION_WEIGHT.standard; // malformed input (QB signal present but no importance value) never guesses low or high

// ---------------------------------------------------------------------------
// POSITION_WEIGHT — non-QB branch, keyed by Phase 2D's locked normalized
// position enum. Restrained, modest grouping — position is a MODIFIER, not
// destiny: an elite WR injury or a star EDGE trade must still be able to
// outrank a QB the same way real football stories do; nothing here comes
// close to crushing a non-QB position. WR/EDGE/CB carry the ball or make
// the splash play most often and sit slightly above neutral; interior/
// grind positions sit at or just under neutral; specialists sit lowest but
// still comfortably within the 0.85 floor guardrail; "unknown" sits close
// to neutral so an unresolved position is only ever mildly damped, never
// crushed — the real protection against collapse is ROLE_MULTIPLIER_FLOOR
// below, not this table.
// ---------------------------------------------------------------------------
const NON_QB_POSITION_WEIGHT = Object.freeze({
  WR: 1.05,
  EDGE: 1.05,
  CB: 1.03,
  RB: 1.0,
  S: 1.0,
  TE: 0.98,
  OT: 0.98,
  DL: 0.98,
  LB: 0.98,
  IOL: 0.95,
  K: 0.9,
  P: 0.88,
  LS: 0.87,
  unknown: 0.95,
});
const UNKNOWN_POSITION_WEIGHT = NON_QB_POSITION_WEIGHT.unknown;

// ---------------------------------------------------------------------------
// ROLE_WEIGHT — keyed by the caller-supplied EFFECTIVE role (Phase 2E's
// structured role, or Phase 2F's fresher role when its override applies —
// this module never decides that precedence itself, it only ever consumes
// one resolved role string). Starter carries the most editorial weight;
// each step down the depth chart carries measurably less, but "unknown"
// is deliberately kept mild (near backup) rather than punitive, since an
// unresolved role is a metadata gap, not evidence of low importance.
// ---------------------------------------------------------------------------
const ROLE_WEIGHT = Object.freeze({
  starter: 1.15,
  significant_rotation: 1.05,
  backup: 0.9,
  fringe: 0.8,
  practice_squad: 0.7,
  unknown: 0.9,
});
const UNKNOWN_ROLE_WEIGHT = ROLE_WEIGHT.unknown;

// ---------------------------------------------------------------------------
// ROLE_MULTIPLIER floor/ceiling. Floor is meaningfully above zero per the
// locked calibration principle: even the worst realistic combination
// (a specialist position on the practice squad) only damps by roughly
// three-tenths, never 80-90%. Ceiling caps the most extreme realistic
// combination (an "elevated" QB starting) at a restrained amplification —
// see the calibration matrix in the regression suite for the exact
// worst/best-case numbers this floor/ceiling were chosen against.
// ---------------------------------------------------------------------------
export const ROLE_MULTIPLIER_FLOOR = 0.7;
export const ROLE_MULTIPLIER_CEILING = 1.35;

// ---------------------------------------------------------------------------
// STAR_BOOST — a bonus, never a replacement for role/position. "none" is
// exactly neutral; "notable" and "elite" are restrained per the locked
// guardrail (do not exceed ~1.25).
// ---------------------------------------------------------------------------
const STAR_BOOST = Object.freeze({ none: 1.0, notable: 1.1, elite: 1.2 });

function computePositionWeight(qb_importance, normalized_position) {
  if (qb_importance && qb_importance !== "none") {
    const weight = QB_POSITION_WEIGHT[qb_importance];
    if (weight !== undefined) return { weight, is_qb: true, reason: `qb_position_weight_${qb_importance}` };
    return { weight: QB_POSITION_WEIGHT_FALLBACK, is_qb: true, reason: "qb_position_weight_standard" };
  }
  const weight = NON_QB_POSITION_WEIGHT[normalized_position];
  if (weight !== undefined) return { weight, is_qb: false, reason: normalized_position === "unknown" ? "unknown_position_weight" : "non_qb_position_weight" };
  return { weight: UNKNOWN_POSITION_WEIGHT, is_qb: false, reason: "unknown_position_weight" };
}

function computeRoleWeight(effective_role) {
  const weight = ROLE_WEIGHT[effective_role];
  if (weight !== undefined) return { weight, reason: `role_weight_${effective_role}` };
  return { weight: UNKNOWN_ROLE_WEIGHT, reason: "role_weight_unknown" };
}

/**
 * Star-boost eligibility gate. "Shaky identity must not receive star boost" —
 * requires ALL of: a present canonical player_id, an identity confidence of
 * "high" or "medium" (never "low", never missing), AND the star lookup
 * itself having actually matched a record (Phase 2G's own `matched` field).
 * A malformed caller supplying a star_level without these never gets a boost.
 */
function computeStarBoost({ player_id, identity_confidence, star_level, star_matched }) {
  const hasIdentity = Boolean(player_id);
  const confidenceOk = identity_confidence === "high" || identity_confidence === "medium";
  const gatePassed = hasIdentity && confidenceOk && star_matched === true;

  if (!gatePassed) {
    const reason = !hasIdentity ? "star_boost_blocked_missing_identity" : !confidenceOk ? "star_boost_blocked_low_confidence" : "star_boost_blocked_not_matched";
    return { boost: 1.0, applied: false, gate_passed: false, reason };
  }
  if (star_level === "elite") return { boost: STAR_BOOST.elite, applied: true, gate_passed: true, reason: "star_boost_elite" };
  if (star_level === "notable") return { boost: STAR_BOOST.notable, applied: true, gate_passed: true, reason: "star_boost_notable" };
  return { boost: STAR_BOOST.none, applied: false, gate_passed: true, reason: "star_boost_none" };
}

function neutralResult(reason) {
  return {
    position_weight: 1.0,
    role_weight: 1.0,
    raw_role_multiplier: 1.0,
    combined_role_multiplier: 1.0,
    star_boost: 1.0,
    combined_player_multiplier: 1.0,
    diagnostics: { role_multiplier_floor_applied: false, role_multiplier_ceiling_applied: false, star_boost_applied: false, star_gate_passed: false, is_qb: false },
    reason_codes: [reason],
  };
}

/**
 * @param {{
 *   has_player_subject?: boolean,
 *   normalized_position?: string|null,
 *   effective_role?: string|null,
 *   qb_importance?: "elevated"|"standard"|"low"|"none"|null,
 *   player_id?: string|null,
 *   identity_confidence?: "high"|"medium"|"low"|null,
 *   star_level?: "elite"|"notable"|"none"|null,
 *   star_matched?: boolean,
 * }} input
 * @returns {object} deterministic, JSON-serializable, explainable multiplier breakdown
 */
export function computePlayerImportanceMultipliers({
  has_player_subject = true,
  normalized_position = null,
  effective_role = null,
  qb_importance = null,
  player_id = null,
  identity_confidence = null,
  star_level = null,
  star_matched = false,
} = {}) {
  if (has_player_subject === false) {
    return neutralResult("non_player_neutral");
  }

  const position = computePositionWeight(qb_importance, normalized_position);
  const role = computeRoleWeight(effective_role);

  const raw_role_multiplier = position.weight * role.weight;
  let combined_role_multiplier = raw_role_multiplier;
  let floorApplied = false;
  let ceilingApplied = false;
  if (combined_role_multiplier < ROLE_MULTIPLIER_FLOOR) {
    combined_role_multiplier = ROLE_MULTIPLIER_FLOOR;
    floorApplied = true;
  } else if (combined_role_multiplier > ROLE_MULTIPLIER_CEILING) {
    combined_role_multiplier = ROLE_MULTIPLIER_CEILING;
    ceilingApplied = true;
  }

  const star = computeStarBoost({ player_id, identity_confidence, star_level, star_matched });
  const combined_player_multiplier = combined_role_multiplier * star.boost;

  return {
    position_weight: position.weight,
    role_weight: role.weight,
    raw_role_multiplier,
    combined_role_multiplier,
    star_boost: star.boost,
    combined_player_multiplier,
    diagnostics: {
      role_multiplier_floor_applied: floorApplied,
      role_multiplier_ceiling_applied: ceilingApplied,
      star_boost_applied: star.applied,
      star_gate_passed: star.gate_passed,
      is_qb: position.is_qb,
    },
    reason_codes: [position.reason, role.reason, star.reason],
  };
}
