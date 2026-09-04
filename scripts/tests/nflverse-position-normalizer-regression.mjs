#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2D regression suite. Fully offline, fully
// deterministic — no network, no live nflverse dependency. Every mapping
// under test is grounded in a live read-only inspection of the real 2026
// nflverse roster + depth-chart CSVs (see the Phase 2D report). Several
// cases mirror REAL players' actual field combinations even though the
// fixtures here are synthetic/offline, per the Phase 2A-2C precedent.
// Run with: node scripts/tests/nflverse-position-normalizer-regression.mjs
import assert from "node:assert/strict";
import { normalizePlayerPosition } from "../lib/nflversePositionNormalizer.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function norm(player, depth_chart_rows) {
  return normalizePlayerPosition({ player, depth_chart_rows });
}

// ---------------------------------------------------------------------------
// DIRECT (1-14)
// ---------------------------------------------------------------------------

test("1. QB -> QB HIGH", () => {
  const r = norm({ position: "QB" });
  assert.equal(r.normalized_position, "QB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("direct_roster_position"));
});

test("2. RB -> RB HIGH", () => {
  const r = norm({ position: "RB" });
  assert.equal(r.normalized_position, "RB");
  assert.equal(r.confidence, "high");
});

test("3. WR -> WR HIGH", () => {
  const r = norm({ position: "WR" });
  assert.equal(r.normalized_position, "WR");
  assert.equal(r.confidence, "high");
});

test("4. TE -> TE HIGH", () => {
  const r = norm({ position: "TE" });
  assert.equal(r.normalized_position, "TE");
  assert.equal(r.confidence, "high");
});

test("5. K -> K HIGH", () => {
  const r = norm({ position: "K" });
  assert.equal(r.normalized_position, "K");
  assert.equal(r.confidence, "high");
});

test("6. P -> P HIGH", () => {
  const r = norm({ position: "P" });
  assert.equal(r.normalized_position, "P");
  assert.equal(r.confidence, "high");
});

test("7. LS -> LS HIGH", () => {
  const r = norm({ position: "LS" });
  assert.equal(r.normalized_position, "LS");
  assert.equal(r.confidence, "high");
});

test("8. CB -> CB HIGH (via roster.depth_chart_position; CB is never a real roster.position value)", () => {
  const r = norm({ position: "DB", depth_chart_position: "CB" });
  assert.equal(r.normalized_position, "CB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("specific_roster_depth_chart_position"));
});

test("9. DT -> DL HIGH", () => {
  const r = norm({ position: "DL", depth_chart_position: "DT" });
  assert.equal(r.normalized_position, "DL");
  assert.equal(r.confidence, "high");
});

test("10. NT -> DL HIGH", () => {
  const r = norm({ position: "DL", depth_chart_position: "NT" });
  assert.equal(r.normalized_position, "DL");
  assert.equal(r.confidence, "high");
});

test("11. MLB -> LB HIGH", () => {
  const r = norm({ position: "LB", depth_chart_position: "MLB" });
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "high");
});

test("12. ILB -> LB HIGH", () => {
  const r = norm({ position: "LB", depth_chart_position: "ILB" });
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "high");
});

test("13. FS -> S HIGH", () => {
  const r = norm({ position: "DB", depth_chart_position: "FS" });
  assert.equal(r.normalized_position, "S");
  assert.equal(r.confidence, "high");
});

test("14. SS -> S HIGH", () => {
  const r = norm({ position: "DB", depth_chart_position: "SS" });
  assert.equal(r.normalized_position, "S");
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------------------
// OFFENSIVE LINE (15-24)
// ---------------------------------------------------------------------------

test("15. T -> OT HIGH (roster.depth_chart_position)", () => {
  const r = norm({ position: "OL", depth_chart_position: "T" });
  assert.equal(r.normalized_position, "OT");
  assert.equal(r.confidence, "high");
});

test("16. LT -> OT HIGH (depth_chart pos_abb; LT only exists at that level in real data)", () => {
  const r = norm({ position: "OL", depth_chart_position: "T" }, [{ pos_abb: "LT" }]);
  assert.equal(r.normalized_position, "OT");
  assert.equal(r.confidence, "high");
});

test("17. RT -> OT HIGH", () => {
  const r = norm({ position: "OL", depth_chart_position: "T" }, [{ pos_abb: "RT" }]);
  assert.equal(r.normalized_position, "OT");
  assert.equal(r.confidence, "high");
});

test("18. G -> IOL HIGH", () => {
  const r = norm({ position: "OL", depth_chart_position: "G" });
  assert.equal(r.normalized_position, "IOL");
  assert.equal(r.confidence, "high");
});

test("19. LG -> IOL HIGH", () => {
  const r = norm({ position: "OL", depth_chart_position: "G" }, [{ pos_abb: "LG" }]);
  assert.equal(r.normalized_position, "IOL");
  assert.equal(r.confidence, "high");
});

test("20. RG -> IOL HIGH", () => {
  const r = norm({ position: "OL", depth_chart_position: "G" }, [{ pos_abb: "RG" }]);
  assert.equal(r.normalized_position, "IOL");
  assert.equal(r.confidence, "high");
});

test("21. C -> IOL HIGH", () => {
  const r = norm({ position: "OL", depth_chart_position: "C" });
  assert.equal(r.normalized_position, "IOL");
  assert.equal(r.confidence, "high");
});

test("22. generic OL + LT finer evidence -> OT HIGH (mirrors real Trent Williams: position=OL, depth_chart_position missing/blank, pos_abb=LT)", () => {
  const r = norm({ position: "OL" }, [{ pos_abb: "LT" }]);
  assert.equal(r.normalized_position, "OT");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("generic_ol_resolved_by_specific_field"));
  assert.ok(r.reason_codes.includes("generic_ol_resolved_ot"));
});

test("23. generic OL + RG finer evidence -> IOL HIGH", () => {
  const r = norm({ position: "OL" }, [{ pos_abb: "RG" }]);
  assert.equal(r.normalized_position, "IOL");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("generic_ol_resolved_iol"));
});

test("24. generic OL only, no finer evidence anywhere -> conservative unknown/LOW (real 2026 roster data never actually hits this: depth_chart_position is always populated for OL rows; this defends historical/malformed input)", () => {
  const r = norm({ position: "OL" });
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("generic_ol_ambiguous"));
});

// ---------------------------------------------------------------------------
// DEFENSIVE END / DL (25-29)
// ---------------------------------------------------------------------------

test("25. generic DE -> EDGE MEDIUM", () => {
  const r = norm({ position: "DL", depth_chart_position: "DE" });
  assert.equal(r.normalized_position, "EDGE");
  assert.equal(r.confidence, "medium");
  assert.ok(r.reason_codes.includes("generic_de_default_edge"));
});

test("26. DE + RDE finer evidence -> EDGE HIGH (mirrors real Jadeveon Clowney: depth_chart_position=DE, pos_abb=RDE)", () => {
  const r = norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "RDE" }]);
  assert.equal(r.normalized_position, "EDGE");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("de_resolved_edge"));
});

test("27. DE + LDE finer evidence -> EDGE HIGH", () => {
  const r = norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "LDE" }]);
  assert.equal(r.normalized_position, "EDGE");
  assert.equal(r.confidence, "high");
});

test("28. DE + RDT finer evidence -> DL HIGH (real data: some DE-tagged roster players currently align at RDT/LDT/NT)", () => {
  const r = norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "RDT" }]);
  assert.equal(r.normalized_position, "DL");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("de_resolved_dl"));
});

test("29. DE + LDT finer evidence -> DL HIGH", () => {
  const r = norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "LDT" }]);
  assert.equal(r.normalized_position, "DL");
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------------------
// LINEBACKER (30-33)
// ---------------------------------------------------------------------------

test("30. generic OLB -> LB MEDIUM", () => {
  const r = norm({ position: "LB", depth_chart_position: "OLB" });
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "medium");
  assert.ok(r.reason_codes.includes("generic_olb_default_lb"));
});

test("31. OLB + WLB evidence -> LB HIGH (mirrors real Khalil Mack pattern: depth_chart_position=OLB, pos_abb=SLB/WLB)", () => {
  const r = norm({ position: "LB", depth_chart_position: "OLB" }, [{ pos_abb: "WLB" }]);
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("olb_resolved_lb"));
});

test("32. OLB + SLB evidence -> LB HIGH", () => {
  const r = norm({ position: "LB", depth_chart_position: "OLB" }, [{ pos_abb: "SLB" }]);
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "high");
});

test("33. OLB + verified observed edge-slot evidence -> EDGE HIGH (mirrors a REAL 2026 player: Cameron Jordan is tagged roster.depth_chart_position=OLB but his current depth-chart row is pos_abb=LDE)", () => {
  const r = norm({ position: "LB", depth_chart_position: "OLB" }, [{ pos_abb: "LDE" }]);
  assert.equal(r.normalized_position, "EDGE");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("olb_resolved_edge"));
});

// ---------------------------------------------------------------------------
// DB (34-37)
// ---------------------------------------------------------------------------

test("34. generic DB only -> LOW (mirrors real inactive players Hudson Clark / Josh Minkins: position=DB, depth_chart_position=DB, no current depth-chart row)", () => {
  const r = norm({ position: "DB" });
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("generic_db_ambiguous"));
});

test("35. DB + CB evidence -> CB HIGH", () => {
  const r = norm({ position: "DB", depth_chart_position: "DB" }, [{ pos_abb: "LCB" }]);
  assert.equal(r.normalized_position, "CB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("db_resolved_cb"));
});

test("36. DB + FS evidence -> S HIGH", () => {
  const r = norm({ position: "DB", depth_chart_position: "DB" }, [{ pos_abb: "FS" }]);
  assert.equal(r.normalized_position, "S");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("db_resolved_s"));
});

test("37. DB + SS evidence -> S HIGH", () => {
  const r = norm({ position: "DB", depth_chart_position: "DB" }, [{ pos_abb: "SS" }]);
  assert.equal(r.normalized_position, "S");
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------------------
// CONFLICTS / MISSING (38-46)
// ---------------------------------------------------------------------------

test("38. equally-specific conflicting evidence -> LOW/unknown (mirrors a REAL 2026 player: Andrew Wylie has both an RG row and an LT row in the same current depth-chart snapshot)", () => {
  const r = norm({ position: "OL", depth_chart_position: "T" }, [{ pos_abb: "RG" }, { pos_abb: "LT" }]);
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("conflicting_position_evidence"));
});

test("39. completely missing position fields -> unknown LOW", () => {
  const r = norm({});
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("position_missing"));
});

test("40. unresolved/no player input -> unknown LOW", () => {
  const r = norm(null);
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("identity_unresolved"));
});

test("41. duplicate identical evidence does not change the result", () => {
  const a = norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "RDE" }]);
  const b = norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "RDE" }, { pos_abb: "RDE" }]);
  assert.deepEqual(a, b);
});

test("42. input row ordering does not change the result (also proves non-position special-teams rows are excluded regardless of order)", () => {
  const player = { position: "DB", depth_chart_position: "DB" };
  const a = norm(player, [{ pos_abb: "PR" }, { pos_abb: "FS" }]);
  const b = norm(player, [{ pos_abb: "FS" }, { pos_abb: "PR" }]);
  assert.deepEqual(a, b);
  assert.equal(a.normalized_position, "S");
});

test("43. output reason-code ordering is deterministic for identical input", () => {
  const player = { position: "OL" };
  const rows = [{ pos_abb: "LT" }];
  const a = norm(player, rows);
  const b = norm(player, rows);
  assert.deepEqual(a.reason_codes, b.reason_codes);
});

test("44. the normalizer performs no network calls (no fetch reference anywhere in the module)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflversePositionNormalizer.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(/.test(src), false, "the position normalizer must never call fetch()");
});

test("45. pos_rank changes alone do not alter the normalized position", () => {
  const player = { position: "DL", depth_chart_position: "DE" };
  const a = norm(player, [{ pos_abb: "RDE", pos_rank: "1" }]);
  const b = norm(player, [{ pos_abb: "RDE", pos_rank: "4" }]);
  assert.equal(a.normalized_position, b.normalized_position);
  assert.equal(a.confidence, b.confidence);
});

test("46. player name changes alone do not alter the normalized position (name is not part of the input contract and must be ignored if present)", () => {
  const a = norm({ position: "QB", full_name: "Player One" });
  const b = norm({ position: "QB", full_name: "Player Two" });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// HISTORICAL / PURITY (47-48)
// ---------------------------------------------------------------------------

test("47. same supplied fields produce the same answer regardless of a current/historical label (an unused extra field must be ignored)", () => {
  const a = normalizePlayerPosition({ player: { position: "RB" }, depth_chart_rows: [], as_of: "current" });
  const b = normalizePlayerPosition({ player: { position: "RB" }, depth_chart_rows: [], as_of: "2023-11-01" });
  assert.equal(a.normalized_position, b.normalized_position);
  assert.equal(a.confidence, b.confidence);
});

test("48. the normalizer does not read cache/files internally (no fs read reference for cache/data paths anywhere in the module)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflversePositionNormalizer.js", import.meta.url), "utf-8"));
  assert.equal(/readFile|readFileSync|require\(['"]fs/.test(src), false, "the position normalizer must never read files itself");
});

// ---------------------------------------------------------------------------
// Additional coverage required by real observed nflverse values
// ---------------------------------------------------------------------------

test("Additional: NB (nickel back) depth-chart evidence -> CB HIGH (real observed value; mirrors real player Garrett Williams)", () => {
  const r = norm({ position: "DB", depth_chart_position: "CB" }, [{ pos_abb: "NB" }]);
  assert.equal(r.normalized_position, "CB");
  assert.equal(r.confidence, "high");
});

test("Additional: PK (depth-chart placekicker abbreviation) -> K HIGH", () => {
  const r = norm({ position: "K" }, [{ pos_abb: "PK" }]);
  assert.equal(r.normalized_position, "K");
  assert.equal(r.confidence, "high");
});

test("Additional: FB (roster depth_chart_position) -> RB HIGH (real combo: position=RB, depth_chart_position=FB), dedicated fullback_mapped_to_rb reason code", () => {
  const r = norm({ position: "RB", depth_chart_position: "FB" });
  assert.equal(r.normalized_position, "RB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("fullback_mapped_to_rb"));
});

test("Additional: bare depth_chart_position 'S' -> S HIGH (real, rare observed value)", () => {
  const r = norm({ position: "DB", depth_chart_position: "S" });
  assert.equal(r.normalized_position, "S");
  assert.equal(r.confidence, "high");
});

test("Additional: bare depth_chart_position 'LB' -> LB HIGH (real, rare observed value; more specific field, so HIGH not MEDIUM)", () => {
  const r = norm({ position: "LB", depth_chart_position: "LB" });
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "high");
});

test("Additional: bare roster.position 'LB' alone (no finer field) -> LB MEDIUM, not HIGH (coarsest field, default-converged rather than direct)", () => {
  const r = norm({ position: "LB" });
  assert.equal(r.normalized_position, "LB");
  assert.equal(r.confidence, "medium");
  assert.ok(r.reason_codes.includes("generic_roster_position_lb_default"));
});

test("Additional: generic roster.position 'DL' alone, no finer evidence -> unknown LOW (DL's real sub-cases, DE-defaults-EDGE vs DT/NT-is-DL, do not converge)", () => {
  const r = norm({ position: "DL" });
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("generic_dl_ambiguous"));
});

test("Additional: special-teams role rows alone (H/KR/PR only, no real position row) never independently produce a normalized_position", () => {
  const r = norm({}, [{ pos_abb: "KR" }, { pos_abb: "PR" }, { pos_abb: "H" }]);
  assert.equal(r.normalized_position, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("position_missing"));
});

test("Additional: a WR who also returns kicks (real pattern) -> WR HIGH, the KR row is excluded from evidence but retained in raw", () => {
  const r = norm({ position: "WR", depth_chart_position: "WR" }, [{ pos_abb: "KR", pos_slot: "5", pos_rank: "1" }, { pos_abb: "WR", pos_slot: "8", pos_rank: "6" }]);
  assert.equal(r.normalized_position, "WR");
  assert.equal(r.confidence, "high");
  assert.ok(r.raw.depth_chart_pos_abbs.includes("KR"), "raw must retain the excluded role row for diagnostics");
});

test("Additional: pos_slot is never used to decide (real data shows it is a non-semantic column index) — identical pos_abb, differing pos_slot, same decision (raw diagnostics legitimately still differ)", () => {
  const player = { position: "OL", depth_chart_position: "T" };
  const a = norm(player, [{ pos_abb: "LT", pos_slot: "3" }]);
  const b = norm(player, [{ pos_abb: "LT", pos_slot: "9" }]);
  assert.equal(a.normalized_position, b.normalized_position);
  assert.equal(a.confidence, b.confidence);
  assert.deepEqual(a.reason_codes, b.reason_codes);
  assert.deepEqual(a.evidence, b.evidence);
  assert.notDeepEqual(a.raw.depth_chart_pos_slots, b.raw.depth_chart_pos_slots, "raw diagnostics are expected to differ even though the decision does not");
});

test("Additional: raw always retains every supplied pos_slot/pos_rank value diagnostically, even though they never drive the decision", () => {
  const r = norm({ position: "QB" }, [{ pos_abb: "QB", pos_slot: "9", pos_rank: "1" }]);
  assert.deepEqual(r.raw.depth_chart_pos_slots, ["9"]);
  assert.deepEqual(r.raw.depth_chart_pos_ranks, ["1"]);
});

test("Additional: no scoring, role, or star fields anywhere in the output shape", () => {
  const r = norm({ position: "QB" });
  for (const forbidden of ["position_weight", "role_weight", "role", "role_multiplier", "star_boost", "total_score", "starter", "significant_rotation", "backup", "fringe", "practice_squad"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, forbidden), false, `output must never contain a scoring/role field: ${forbidden}`);
  }
});

test("Additional: only the 15 locked enum values (14 positions + unknown) are ever returned, across a broad sample of real and synthetic inputs", () => {
  const LOCKED_ENUM = new Set(["QB", "RB", "WR", "TE", "OT", "IOL", "EDGE", "DL", "LB", "CB", "S", "K", "P", "LS", "unknown"]);
  const samples = [
    norm({ position: "QB" }),
    norm({ position: "OL", depth_chart_position: "T" }, [{ pos_abb: "RG" }, { pos_abb: "LT" }]),
    norm({ position: "DL", depth_chart_position: "DE" }, [{ pos_abb: "LDT" }]),
    norm({ position: "LB", depth_chart_position: "OLB" }, [{ pos_abb: "LDE" }]),
    norm({ position: "DB", depth_chart_position: "DB" }, [{ pos_abb: "NB" }]),
    norm(null),
    norm({}),
  ];
  for (const s of samples) assert.ok(LOCKED_ENUM.has(s.normalized_position), `unexpected non-locked value: ${s.normalized_position}`);
});

// ---------------------------------------------------------------------------
// FB / vocabulary-completeness hardening pass
// ---------------------------------------------------------------------------

test("H1. depth_chart.pos_abb FB -> RB HIGH with fullback_mapped_to_rb", () => {
  const r = normalizePlayerPosition({ player: { position: "RB" }, depth_chart_rows: [{ pos_abb: "FB" }] });
  assert.equal(r.normalized_position, "RB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("fullback_mapped_to_rb"));
});

test("H2. roster.depth_chart_position FB -> RB HIGH with fullback_mapped_to_rb", () => {
  const r = norm({ position: "RB", depth_chart_position: "FB" });
  assert.equal(r.normalized_position, "RB");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("fullback_mapped_to_rb"));
});

test("H3. FB remains RB regardless of player name", () => {
  const a = norm({ position: "RB", depth_chart_position: "FB", full_name: "Player One" });
  const b = norm({ position: "RB", depth_chart_position: "FB", full_name: "Player Two" });
  assert.deepEqual(a, b);
  assert.equal(a.normalized_position, "RB");
});

test("H4. NB -> CB HIGH (reconfirmed)", () => {
  const r = normalizePlayerPosition({ player: { position: "DB", depth_chart_position: "CB" }, depth_chart_rows: [{ pos_abb: "NB" }] });
  assert.equal(r.normalized_position, "CB");
  assert.equal(r.confidence, "high");
});

test("H5. PK -> K HIGH (reconfirmed)", () => {
  const r = normalizePlayerPosition({ player: { position: "K" }, depth_chart_rows: [{ pos_abb: "PK" }] });
  assert.equal(r.normalized_position, "K");
  assert.equal(r.confidence, "high");
});

test("H6. H-only depth-chart row is ignored; falls back to roster.position", () => {
  const r = normalizePlayerPosition({ player: { position: "P" }, depth_chart_rows: [{ pos_abb: "H" }] });
  assert.equal(r.normalized_position, "P");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("direct_roster_position"));
});

test("H7. KR-only depth-chart row is ignored; falls back to roster.position", () => {
  const r = normalizePlayerPosition({ player: { position: "WR" }, depth_chart_rows: [{ pos_abb: "KR" }] });
  assert.equal(r.normalized_position, "WR");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("direct_roster_position"));
});

test("H8. PR-only depth-chart row is ignored; falls back to roster.position", () => {
  const r = normalizePlayerPosition({ player: { position: "WR" }, depth_chart_rows: [{ pos_abb: "PR" }] });
  assert.equal(r.normalized_position, "WR");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("direct_roster_position"));
});

test("H9. H + KR + PR (no base-position row) plus WR roster evidence -> WR HIGH, never unknown", () => {
  const r = normalizePlayerPosition({ player: { position: "WR", depth_chart_position: "WR" }, depth_chart_rows: [{ pos_abb: "H" }, { pos_abb: "KR" }, { pos_abb: "PR" }] });
  assert.equal(r.normalized_position, "WR");
  assert.equal(r.confidence, "high");
  assert.notEqual(r.normalized_position, "unknown");
});

test("H10. special-teams rows alongside a valid base-position depth-chart row -> the valid base row wins (mirrors real Devin Duvernay: PR + KR + WR rows)", () => {
  const r = normalizePlayerPosition({ player: { position: "WR", depth_chart_position: "WR" }, depth_chart_rows: [{ pos_abb: "PR" }, { pos_abb: "KR" }, { pos_abb: "WR" }] });
  assert.equal(r.normalized_position, "WR");
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("specific_depth_chart_position"));
});

test("H11. bare roster.depth_chart_position 'S' -> S HIGH (reconfirmed)", () => {
  const r = norm({ position: "DB", depth_chart_position: "S" });
  assert.equal(r.normalized_position, "S");
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------------------
// H12-H14: table-driven observed-vocabulary completeness audits. Each table
// is the EXACT live-observed value list from the Phase 2D report — not a
// re-derivation — so future vocabulary drift (a new value nflverse starts
// emitting) shows up as a missing table entry, not a silent gap.
//
// classification: "A" = direct HIGH mapping, "B" = contextual/default
// MEDIUM mapping, "C" = ambiguous LOW/unknown without finer evidence,
// "D" = deliberately ignored as non-base-position evidence.
// ---------------------------------------------------------------------------

const ROSTER_POSITION_TABLE = [
  ["DB", "C", "unknown", "low"],
  ["DL", "C", "unknown", "low"],
  ["K", "A", "K", "high"],
  ["LB", "B", "LB", "medium"],
  ["LS", "A", "LS", "high"],
  ["OL", "C", "unknown", "low"],
  ["P", "A", "P", "high"],
  ["QB", "A", "QB", "high"],
  ["RB", "A", "RB", "high"],
  ["TE", "A", "TE", "high"],
  ["WR", "A", "WR", "high"],
];

const ROSTER_DEPTH_CHART_POSITION_TABLE = [
  ["C", "A", "IOL", "high"],
  ["CB", "A", "CB", "high"],
  ["DB", "C", "unknown", "low"],
  ["DE", "B", "EDGE", "medium"],
  ["DT", "A", "DL", "high"],
  ["FB", "A", "RB", "high"],
  ["FS", "A", "S", "high"],
  ["G", "A", "IOL", "high"],
  ["ILB", "A", "LB", "high"],
  ["K", "A", "K", "high"],
  ["LB", "A", "LB", "high"],
  ["LS", "A", "LS", "high"],
  ["MLB", "A", "LB", "high"],
  ["NT", "A", "DL", "high"],
  ["OLB", "B", "LB", "medium"],
  ["P", "A", "P", "high"],
  ["QB", "A", "QB", "high"],
  ["RB", "A", "RB", "high"],
  ["S", "A", "S", "high"],
  ["SS", "A", "S", "high"],
  ["T", "A", "OT", "high"],
  ["TE", "A", "TE", "high"],
  ["WR", "A", "WR", "high"],
];

const DEPTH_CHART_POS_ABB_TABLE = [
  ["C", "A", "IOL", "high"],
  ["FB", "A", "RB", "high"],
  ["FS", "A", "S", "high"],
  ["H", "D", null, null],
  ["KR", "D", null, null],
  ["LCB", "A", "CB", "high"],
  ["LDE", "A", "EDGE", "high"],
  ["LDT", "A", "DL", "high"],
  ["LG", "A", "IOL", "high"],
  ["LILB", "A", "LB", "high"],
  ["LS", "A", "LS", "high"],
  ["LT", "A", "OT", "high"],
  ["MLB", "A", "LB", "high"],
  ["NB", "A", "CB", "high"],
  ["NT", "A", "DL", "high"],
  ["P", "A", "P", "high"],
  ["PK", "A", "K", "high"],
  ["PR", "D", null, null],
  ["QB", "A", "QB", "high"],
  ["RB", "A", "RB", "high"],
  ["RCB", "A", "CB", "high"],
  ["RDE", "A", "EDGE", "high"],
  ["RDT", "A", "DL", "high"],
  ["RG", "A", "IOL", "high"],
  ["RILB", "A", "LB", "high"],
  ["RT", "A", "OT", "high"],
  ["SLB", "A", "LB", "high"],
  ["SS", "A", "S", "high"],
  ["TE", "A", "TE", "high"],
  ["WLB", "A", "LB", "high"],
  ["WR", "A", "WR", "high"],
];

test("H12. every observed depth_chart.pos_abb token is either mapped or explicitly ignored (table-driven)", () => {
  for (const [token, classification, expectedPosition, expectedConfidence] of DEPTH_CHART_POS_ABB_TABLE) {
    const r = normalizePlayerPosition({ player: {}, depth_chart_rows: [{ pos_abb: token }] });
    if (classification === "D") {
      assert.equal(r.normalized_position, "unknown", `${token}: a solitary ignored role token must never independently resolve a position`);
      assert.ok(r.reason_codes.includes("position_missing"), `${token}: expected to be ignored, contributing no evidence`);
    } else {
      assert.equal(r.normalized_position, expectedPosition, `${token}: expected ${expectedPosition}, got ${r.normalized_position}`);
      assert.equal(r.confidence, expectedConfidence, `${token}: expected confidence ${expectedConfidence}`);
    }
  }
});

test("H13. every observed roster.depth_chart_position token is explicitly handled (table-driven)", () => {
  for (const [token, classification, expectedPosition, expectedConfidence] of ROSTER_DEPTH_CHART_POSITION_TABLE) {
    const r = norm({ depth_chart_position: token });
    assert.equal(r.normalized_position, expectedPosition, `${token}: expected ${expectedPosition}, got ${r.normalized_position}`);
    assert.equal(r.confidence, expectedConfidence, `${token}: expected confidence ${expectedConfidence}, got ${r.confidence}`);
    if (classification === "C") assert.equal(r.normalized_position, "unknown");
  }
});

test("H14. every observed roster.position token is explicitly handled (table-driven)", () => {
  for (const [token, classification, expectedPosition, expectedConfidence] of ROSTER_POSITION_TABLE) {
    const r = norm({ position: token });
    assert.equal(r.normalized_position, expectedPosition, `${token}: expected ${expectedPosition}, got ${r.normalized_position}`);
    assert.equal(r.confidence, expectedConfidence, `${token}: expected confidence ${expectedConfidence}, got ${r.confidence}`);
    if (classification === "C") assert.equal(r.normalized_position, "unknown");
  }
});

test("H15. no observed token across all three tables is left without an explicit classification (structural self-check)", () => {
  const allTables = [ROSTER_POSITION_TABLE, ROSTER_DEPTH_CHART_POSITION_TABLE, DEPTH_CHART_POS_ABB_TABLE];
  for (const table of allTables) {
    assert.ok(table.length > 0);
    for (const row of table) {
      assert.ok(["A", "B", "C", "D"].includes(row[1]), `row ${JSON.stringify(row)} must carry a valid classification`);
    }
  }
  // Exact observed vocabulary sizes, from the live inspection (Phase 2D report) — a
  // change in these counts means nflverse's vocabulary drifted and this table needs updating.
  assert.equal(ROSTER_POSITION_TABLE.length, 11);
  assert.equal(ROSTER_DEPTH_CHART_POSITION_TABLE.length, 23);
  assert.equal(DEPTH_CHART_POS_ABB_TABLE.length, 31);
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
