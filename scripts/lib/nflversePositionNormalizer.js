// Editorial Scoring Brain — Phase 2D: deterministic position normalization.
// Answers ONLY: "what Aggregate position group does this already-resolved
// player belong to?" Phase 2C answers WHO; this module never re-derives
// identity, never touches role/starter/rotation semantics (Phase 2E), and
// never computes a scoring weight (Phase 2H). Pure, offline, no network,
// no file reads — the caller supplies every field.
//
// Every mapping below is grounded in a live, read-only inspection of the
// real 2026 nflverse roster + depth-chart CSVs (see the Phase 2D report for
// the full field-by-field findings), not nflverse documentation or
// assumption. Two findings shaped this design materially:
//
// 1. depth_chart.pos_abb is ALREADY fully left/right-specific for every
//    position that needs it (LDE/RDE, LDT/RDT, LG/RG, LT/RT, LILB/RILB,
//    LCB/RCB, WLB/SLB) — there is no bare "DE"/"OLB"/"DB"/"OL" at that
//    level in real data. The genuinely ambiguous generic codes (DE, OLB,
//    DB, OL, DL) only ever appear in the coarser roster.position /
//    roster.depth_chart_position fields.
//
// 2. depth_chart.pos_slot is a purely numeric column-index (1-12) that
//    correlates with pos_grp/formation display layout, not a semantic
//    disambiguator independent of pos_abb — using it to resolve ambiguity
//    would be inventing meaning the data doesn't support. It is kept in
//    `raw` for diagnostics only and never drives a decision, exactly like
//    pos_rank.
//
// A real, structurally-confirmed example proves the CONFLICT PRECEDENCE
// rule (a current, specific depth-chart row overrides a coarser roster
// tag) is not just defensively correct but necessary: Cameron Jordan is
// tagged roster.depth_chart_position = "OLB", but his current depth-chart
// row is pos_abb = "LDE" — a real player whose season-level roster tag and
// current depth-chart alignment categorically disagree (LB-shaped vs.
// EDGE-shaped). The precedence rule below resolves this correctly to
// EDGE/high using only structured fields, no player knowledge.

// ---------------------------------------------------------------------------
// Depth-chart pos_abb values that identify a SPECIAL-TEAMS ROLE, not a
// primary position — confirmed real 2026 values. A player can hold one of
// these alongside their real position row (e.g. a WR who also returns
// punts has both a WR row and a PR row in the same snapshot). These never
// contribute position evidence on their own.
// ---------------------------------------------------------------------------
const NON_POSITION_ROLE_ABBS = new Set(["H", "KR", "PR"]);

// ---------------------------------------------------------------------------
// Token -> locked Aggregate position: direct, unambiguous mappings. The
// same token strings recur with the same meaning across roster.position,
// roster.depth_chart_position, and depth_chart.pos_abb, so one shared table
// serves all three fields. "DL" is deliberately NOT a key here — see
// AMBIGUOUS_NO_DEFAULT below.
// ---------------------------------------------------------------------------
const DIRECT_MAP = Object.freeze({
  QB: "QB",
  RB: "RB",
  // Fullback: a specific structured offensive-backfield position: the
  // locked Aggregate taxonomy intentionally has one RB/backfield bucket
  // rather than a separate FB category, so this is a direct HIGH mapping,
  // never "unknown" — confirmed by the real roster combo "RB|FB"
  // (position=RB, depth_chart_position=FB). Gets its own reason code
  // (fullback_mapped_to_rb, added below in resolveEvidence) rather than
  // silently reusing the generic "specific_*" codes, so FB is always
  // individually auditable in reason_codes.
  FB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  PK: "K", // depth-chart's placekicker abbreviation, distinct from its own "P" (punter)
  P: "P",
  LS: "LS",
  CB: "CB",
  LCB: "CB",
  RCB: "CB",
  NB: "CB", // nickel back / slot corner — real observed depth-chart value
  S: "S",
  FS: "S",
  SS: "S",
  DT: "DL",
  NT: "DL",
  LDT: "DL",
  RDT: "DL",
  MLB: "LB",
  ILB: "LB",
  LILB: "LB",
  RILB: "LB",
  SLB: "LB",
  WLB: "LB",
  LB: "LB",
  T: "OT",
  LT: "OT",
  RT: "OT",
  OT: "OT",
  G: "IOL",
  LG: "IOL",
  RG: "IOL",
  C: "IOL",
  IOL: "IOL",
  LDE: "EDGE",
  RDE: "EDGE",
  EDGE: "EDGE",
});

// Ambiguous tokens with a locked, deterministic DEFAULT when no finer
// evidence resolves them (still overridable by more specific evidence).
const AMBIGUOUS_DEFAULT = Object.freeze({
  DE: { target: "EDGE", confidence: "medium", reason: "generic_de_default_edge" },
  OLB: { target: "LB", confidence: "medium", reason: "generic_olb_default_lb" },
});

// Ambiguous tokens with NO safe default — their real sub-cases lead to
// DIFFERENT Aggregate buckets (DB -> CB or S; OL -> OT or IOL; DL -> EDGE
// or DL, since roster.position "DL" covers DE-which-defaults-EDGE as well
// as DT/NT-which-is-DL), so guessing one would sometimes be wrong.
const AMBIGUOUS_NO_DEFAULT = Object.freeze({
  DB: "generic_db_ambiguous",
  OL: "generic_ol_ambiguous",
  DL: "generic_dl_ambiguous",
});

// How resolving an ambiguous lower-precedence token via finer evidence is
// narrated in reason_codes, keyed by [ambiguous group][resolved target].
const RESOLUTION_CODES = Object.freeze({
  DE: { EDGE: ["de_resolved_edge"], DL: ["de_resolved_dl"], LB: ["de_resolved_lb"] },
  OLB: { EDGE: ["olb_resolved_edge"], LB: ["olb_resolved_lb"] },
  DB: { CB: ["db_resolved_cb"], S: ["db_resolved_s"] },
  OL: { OT: ["generic_ol_resolved_by_specific_field", "generic_ol_resolved_ot"], IOL: ["generic_ol_resolved_by_specific_field", "generic_ol_resolved_iol"] },
  DL: {},
});

function describeResolution(ambiguousGroup, resolvedTarget) {
  if (!ambiguousGroup) return [];
  return RESOLUTION_CODES[ambiguousGroup]?.[resolvedTarget] ?? [];
}

function dedupeSorted(rows, field) {
  const set = new Set();
  for (const row of rows) {
    const v = row?.[field];
    if (v !== undefined && v !== null && v !== "") set.add(String(v));
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Level 1 (highest precedence): current/as-of depth-chart pos_abb rows.
// ---------------------------------------------------------------------------
function resolvePosAbbLevel(depth_chart_rows) {
  const rows = Array.isArray(depth_chart_rows) ? depth_chart_rows : [];
  const abbs = dedupeSorted(
    rows.filter((r) => r?.pos_abb && !NON_POSITION_ROLE_ABBS.has(r.pos_abb)),
    "pos_abb"
  );
  if (abbs.length === 0) return null;
  const targets = abbs.map((a) => DIRECT_MAP[a]).filter(Boolean);
  if (targets.length === 0) return null; // none recognized (ambiguous-shaped or unrecognized pos_abb never observed in real data — no guessing)
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length > 1) {
    return { conflict: true, abbs };
  }
  return { normalized_position: uniqueTargets[0], reason: "specific_depth_chart_position", abbs, usedFb: abbs.includes("FB") };
}

// ---------------------------------------------------------------------------
// Level 2: roster.depth_chart_position (season-level, finer than
// roster.position but not left/right-specific).
// ---------------------------------------------------------------------------
function resolveRosterDcpLevel(token) {
  if (!token) return null;
  if (DIRECT_MAP[token]) return { normalized_position: DIRECT_MAP[token], confidence: "high", reason: "specific_roster_depth_chart_position", usedFb: token === "FB" };
  if (AMBIGUOUS_DEFAULT[token]) {
    const d = AMBIGUOUS_DEFAULT[token];
    return { normalized_position: d.target, confidence: d.confidence, reason: d.reason, ambiguous_group: token };
  }
  if (AMBIGUOUS_NO_DEFAULT[token]) {
    return { normalized_position: "unknown", confidence: "low", reason: AMBIGUOUS_NO_DEFAULT[token], ambiguous_group: token };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Level 3 (lowest precedence): roster.position (coarsest, 11 real values).
// "LB" is handled specially here (not via DIRECT_MAP): at this coarsest
// field it is a broad category that happens to converge safely (its real
// sub-cases — ILB, MLB, OLB-default — all resolve to LB), so it earns a
// deterministic default rather than a direct match, at MEDIUM not HIGH.
// "DB"/"OL"/"DL" do NOT converge (their sub-cases lead to different
// buckets), so they get no default — see AMBIGUOUS_NO_DEFAULT.
// ---------------------------------------------------------------------------
function resolveRosterPositionLevel(token) {
  if (!token) return null;
  if (token === "LB") return { normalized_position: "LB", confidence: "medium", reason: "generic_roster_position_lb_default", ambiguous_group: "LB" };
  if (DIRECT_MAP[token]) return { normalized_position: DIRECT_MAP[token], confidence: "high", reason: "direct_roster_position" };
  if (AMBIGUOUS_NO_DEFAULT[token]) return { normalized_position: "unknown", confidence: "low", reason: AMBIGUOUS_NO_DEFAULT[token], ambiguous_group: token };
  return null;
}

function resolveEvidence(position, depth_chart_position, depth_chart_rows) {
  const posAbb = resolvePosAbbLevel(depth_chart_rows);
  const rdcp = resolveRosterDcpLevel(depth_chart_position);
  const rp = resolveRosterPositionLevel(position);

  const contextEvidence = [];
  if (rdcp) contextEvidence.push({ source: "roster_depth_chart_position", value: depth_chart_position, normalized_to: rdcp.normalized_position });
  if (rp) contextEvidence.push({ source: "roster_position", value: position, normalized_to: rp.normalized_position });

  if (posAbb?.conflict) {
    const abbEvidence = posAbb.abbs.map((abb) => ({ source: "depth_chart_pos_abb", value: abb, normalized_to: DIRECT_MAP[abb] ?? null }));
    return { normalized_position: "unknown", confidence: "low", evidence: [...abbEvidence, ...contextEvidence], reason_codes: ["conflicting_position_evidence"] };
  }

  if (posAbb) {
    const abbEvidence = posAbb.abbs.map((abb) => ({ source: "depth_chart_pos_abb", value: abb, normalized_to: DIRECT_MAP[abb] }));
    const ambiguousGroup = rdcp?.ambiguous_group ?? rp?.ambiguous_group;
    const resolvedCodes = describeResolution(ambiguousGroup, posAbb.normalized_position);
    const fbCodes = posAbb.usedFb ? ["fullback_mapped_to_rb"] : [];
    return { normalized_position: posAbb.normalized_position, confidence: "high", evidence: [...abbEvidence, ...contextEvidence], reason_codes: [posAbb.reason, ...resolvedCodes, ...fbCodes] };
  }

  if (rdcp) {
    const resolvedCodes = rdcp.ambiguous_group ? [] : describeResolution(rp?.ambiguous_group, rdcp.normalized_position);
    const fbCodes = rdcp.usedFb ? ["fullback_mapped_to_rb"] : [];
    return { normalized_position: rdcp.normalized_position, confidence: rdcp.confidence, evidence: contextEvidence, reason_codes: [rdcp.reason, ...resolvedCodes, ...fbCodes] };
  }

  if (rp) {
    return { normalized_position: rp.normalized_position, confidence: rp.confidence, evidence: contextEvidence, reason_codes: [rp.reason] };
  }

  return { normalized_position: "unknown", confidence: "low", evidence: contextEvidence, reason_codes: ["position_missing"] };
}

/**
 * @param {{player: {gsis_id?: string, position?: string, depth_chart_position?: string}|null|undefined, depth_chart_rows?: Array<{pos_abb?: string, pos_slot?: string, pos_rank?: string, dt?: string}>}} input
 * @returns {{normalized_position: string, confidence: "high"|"medium"|"low", raw: object, evidence: Array<object>, reason_codes: string[]}}
 */
export function normalizePlayerPosition({ player, depth_chart_rows } = {}) {
  const rows = Array.isArray(depth_chart_rows) ? depth_chart_rows : [];
  const raw = {
    roster_position: player?.position ?? null,
    roster_depth_chart_position: player?.depth_chart_position ?? null,
    depth_chart_pos_abbs: dedupeSorted(rows, "pos_abb"),
    depth_chart_pos_slots: dedupeSorted(rows, "pos_slot"), // diagnostic only — real data shows this is a non-semantic column index, never used to decide
    depth_chart_pos_ranks: dedupeSorted(rows, "pos_rank"), // diagnostic only — pos_rank is never interpreted into role/starter status in this phase
  };

  if (!player) {
    return { normalized_position: "unknown", confidence: "low", raw, evidence: [], reason_codes: ["identity_unresolved"] };
  }

  const result = resolveEvidence(player.position ?? null, player.depth_chart_position ?? null, rows);
  return {
    normalized_position: result.normalized_position,
    confidence: result.confidence,
    raw,
    evidence: result.evidence,
    reason_codes: [...new Set(result.reason_codes)],
  };
}
