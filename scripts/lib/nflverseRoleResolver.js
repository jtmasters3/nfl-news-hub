// Editorial Scoring Brain — Phase 2E: deterministic player role resolution.
// Answers ONLY: "what football role does this already-identified,
// already-position-normalized player currently hold, according to
// supplied structured roster/depth-chart evidence?" Phase 2C answers WHO,
// Phase 2D answers WHAT POSITION, this module answers WHAT ROLE. Pure,
// offline, no network, no file reads, no identity/position re-resolution.
//
// Grounded in a live read-only inspection of the real 2026 nflverse data
// (see the Phase 2E report): pos_rank is always a clean positive-integer
// string ("1".."9"), never blank/zero/negative/non-integer in current live
// data — so the invalid-rank handling below is a defensive/historical
// guard, not something real 2026 data currently exercises. DEV (practice
// squad) players carry ZERO current depth-chart rows (0 of 528 observed).
// RES (reserve) players overwhelmingly DO retain a real current
// depth-chart row (257 of 277 observed) — e.g. a real player tagged RES
// still shows an active ILB/OT/DL row — which is exactly why RES must
// never be treated as an automatic role and must instead defer to real
// depth evidence when present.
//
// The ONLY dependency on another Phase 2 module is a read-only import of
// the LOCKED, unmodified Phase 2D pure helper `normalizePlayerPosition`,
// used strictly to classify a single supplied depth-chart row's own
// position — never to re-derive the player's overall position (that
// value is always supplied by the caller). This is the explicitly
// sanctioned exception ("calling the locked Phase 2D pure helper is
// clearly necessary for filtering supplied depth rows") rather than a
// second, potentially-drifting position-mapping table.
import { normalizePlayerPosition } from "./nflversePositionNormalizer.js";

// ---------------------------------------------------------------------------
// Real observed nflverse special-teams-only depth-chart abbreviations
// (holder, kick returner, punt returner). These never independently
// determine a football role. This set exists only to make the
// "special_teams_row_ignored" reason code accurate/narratable — the actual
// filtering decision always comes from calling normalizePlayerPosition()
// above (which already treats these as position-less), never from this set.
// ---------------------------------------------------------------------------
const SPECIAL_TEAMS_ABBS = new Set(["H", "KR", "PR"]);

// ---------------------------------------------------------------------------
// Locked pos_rank -> role table, per Aggregate normalized position. Index 0
// is rank 1, index 1 is rank 2, etc.; any rank beyond the table's length is
// "fringe". This is the ONLY place role-per-rank is decided.
// ---------------------------------------------------------------------------
const RANK_TABLE = Object.freeze({
  QB: ["starter", "backup"],
  RB: ["starter", "backup"],
  WR: ["starter", "starter", "significant_rotation", "backup"],
  TE: ["starter", "backup"],
  OT: ["starter", "backup"],
  IOL: ["starter", "backup"],
  EDGE: ["starter", "significant_rotation"],
  DL: ["starter", "significant_rotation"],
  LB: ["starter", "backup"],
  CB: ["starter", "starter", "significant_rotation", "backup"],
  S: ["starter", "significant_rotation"],
  K: ["starter"],
  P: ["starter"],
  LS: ["starter"],
});

const SIGNIFICANCE = Object.freeze({ starter: 4, significant_rotation: 3, backup: 2, fringe: 1 });

const RANK_REASON_CODE = Object.freeze({
  starter: "starter_by_rank",
  significant_rotation: "significant_rotation_by_rank",
  backup: "backup_by_rank",
  fringe: "fringe_by_rank",
});

function roleForRank(position, rank) {
  const table = RANK_TABLE[position];
  if (!table) return null; // not one of the 14 real Aggregate positions — should not happen once normalized_position is a locked enum value
  if (rank <= table.length) return table[rank - 1];
  return "fringe";
}

// ---------------------------------------------------------------------------
// pos_rank validation. Real 2026 data confirms pos_rank is always a clean
// positive-integer string ("1" through "9") — never blank, "0", negative,
// non-numeric, or non-integer. This validator accepts exactly that
// canonical shape (also accepting a genuine JS integer >= 1 defensively,
// e.g. from a hand-built test fixture) and rejects everything else
// deterministically, without coercing or guessing at malformed input.
// ---------------------------------------------------------------------------
function parsePosRank(raw) {
  if (raw === undefined || raw === null || raw === "") return { valid: false, value: null };
  const str = String(raw);
  if (!/^[1-9][0-9]*$/.test(str)) return { valid: false, value: null };
  return { valid: true, value: Number(str) };
}

// ---------------------------------------------------------------------------
// Builds the full, always-complete audit trail: every supplied row, each
// annotated with the role it maps to (or null if it doesn't belong to the
// already-established normalized_position, or its rank is unusable). This
// runs unconditionally — even under DEV precedence or an unknown position —
// so a stale/ignored row is never silently dropped from the record; it is
// only ever excluded from actually determining role.
// ---------------------------------------------------------------------------
function buildDepthEvidence(rows, normalized_position) {
  return rows.map((row) => {
    const pos_abb = row?.pos_abb ?? null;
    const pos_rank = row?.pos_rank ?? null;
    if (!normalized_position || normalized_position === "unknown") return { pos_abb, pos_rank, mapped_role: null };
    const perRow = normalizePlayerPosition({ player: {}, depth_chart_rows: [row] });
    if (perRow.normalized_position !== normalized_position) return { pos_abb, pos_rank, mapped_role: null };
    const parsed = parsePosRank(pos_rank);
    if (!parsed.valid) return { pos_abb, pos_rank, mapped_role: null };
    return { pos_abb, pos_rank, mapped_role: roleForRank(normalized_position, parsed.value) };
  });
}

/**
 * @param {{
 *   normalized_position: string|null,
 *   position_confidence: "high"|"medium"|"low"|null,
 *   player: {status?: string, status_description_abbr?: string}|null,
 *   depth_chart_rows?: Array<{pos_abb?: string, pos_rank?: string|number, dt?: string}>,
 *   roster_as_of?: string|null,
 *   depth_chart_as_of?: string|null,
 * }} input
 * @returns {{role: string, confidence: "high"|"medium"|"low", role_source: "roster_status"|"depth_chart"|"none", role_as_of: string|null, depth_chart_as_of: string|null, status_context: object, normalized_position: string, depth_evidence: Array<object>, reason_codes: string[]}}
 */
export function resolvePlayerRole({ normalized_position = null, position_confidence = null, player = null, depth_chart_rows = [], roster_as_of = null, depth_chart_as_of = null } = {}) {
  const rows = Array.isArray(depth_chart_rows) ? depth_chart_rows : [];
  const status_context = { roster_status: player?.status ?? null, status_description_abbr: player?.status_description_abbr ?? null };
  const depth_evidence = buildDepthEvidence(rows, normalized_position);
  const base = { normalized_position: normalized_position ?? "unknown", status_context, depth_chart_as_of: depth_chart_as_of ?? null, depth_evidence };

  // Identity boundary: Phase 2E never attempts identity resolution itself.
  if (!player) {
    return { ...base, role: "unknown", confidence: "low", role_source: "none", role_as_of: null, reason_codes: ["identity_unresolved"] };
  }

  // Practice-squad precedence: the ONE status that may directly set role,
  // independent of position/depth evidence entirely — checked first, ahead
  // of the position gates below, exactly because it does not depend on them.
  if (player.status === "DEV") {
    return { ...base, role: "practice_squad", confidence: "high", role_source: "roster_status", role_as_of: roster_as_of ?? null, reason_codes: ["practice_squad_status"] };
  }

  // Position boundary: never calculate a role from a low-confidence guess,
  // and never try to "fix" an unresolved/conflicting position via role logic.
  if (position_confidence === "low") {
    return { ...base, role: "unknown", confidence: "low", role_source: "none", role_as_of: null, reason_codes: ["position_confidence_low"] };
  }
  if (!normalized_position || normalized_position === "unknown") {
    return { ...base, role: "unknown", confidence: "low", role_source: "none", role_as_of: null, reason_codes: ["position_unknown"] };
  }

  const reason_codes = [];
  if (rows.some((r) => SPECIAL_TEAMS_ABBS.has(r?.pos_abb))) reason_codes.push("special_teams_row_ignored");

  const relevant = depth_evidence.filter((e) => e.mapped_role !== null);

  if (relevant.length === 0) {
    // Hard rule: absence of a usable row means unknown, never fringe.
    const anyPositionMatchingRow = rows.some((r) => normalizePlayerPosition({ player: {}, depth_chart_rows: [r] }).normalized_position === normalized_position);
    if (!anyPositionMatchingRow) {
      reason_codes.push("depth_chart_row_missing");
    } else {
      const anyRankSupplied = rows.some((r) => r?.pos_rank !== undefined && r?.pos_rank !== null && r?.pos_rank !== "");
      reason_codes.push(anyRankSupplied ? "pos_rank_invalid" : "pos_rank_missing");
    }
    return { ...base, role: "unknown", confidence: "low", role_source: "none", role_as_of: null, reason_codes };
  }

  // Multiple relevant rows: the player's role is the MOST SIGNIFICANT role
  // explicitly occupied among them — never "lowest pos_rank", never
  // "first row" — so the result never depends on input ordering.
  const winner = relevant.reduce((best, cur) => (SIGNIFICANCE[cur.mapped_role] > SIGNIFICANCE[best.mapped_role] ? cur : best));
  reason_codes.push(RANK_REASON_CODE[winner.mapped_role]);
  if (relevant.length > 1) {
    const uniqueRoles = new Set(relevant.map((r) => r.mapped_role));
    reason_codes.push(uniqueRoles.size === 1 ? "multiple_rows_same_role" : "multiple_rows_highest_role_selected");
  }
  reason_codes.push("depth_chart_role");
  if (position_confidence === "medium") reason_codes.push("position_confidence_medium_cap");

  return {
    ...base,
    role: winner.mapped_role,
    confidence: position_confidence === "high" ? "high" : "medium",
    role_source: "depth_chart",
    role_as_of: depth_chart_as_of ?? null,
    reason_codes,
  };
}
