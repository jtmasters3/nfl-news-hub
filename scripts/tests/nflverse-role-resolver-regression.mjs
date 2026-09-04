#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2E regression suite. Fully offline, fully
// deterministic — no network, no live nflverse dependency. Several cases
// mirror REAL players' actual field combinations discovered during the
// Phase 2E live inspection, even though the fixtures here are synthetic.
// Run with: node scripts/tests/nflverse-role-resolver-regression.mjs
import assert from "node:assert/strict";
import { resolvePlayerRole } from "../lib/nflverseRoleResolver.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function resolve(overrides = {}) {
  return resolvePlayerRole({ normalized_position: "QB", position_confidence: "high", player: { status: "ACT" }, depth_chart_rows: [], ...overrides });
}

// ---------------------------------------------------------------------------
// PRACTICE SQUAD / STATUS (1-11)
// ---------------------------------------------------------------------------

test("1. DEV + no depth row -> practice_squad HIGH", () => {
  const r = resolve({ player: { status: "DEV" } });
  assert.equal(r.role, "practice_squad");
  assert.equal(r.confidence, "high");
  assert.equal(r.role_source, "roster_status");
  assert.ok(r.reason_codes.includes("practice_squad_status"));
});

test("2. DEV + stale starter row -> practice_squad HIGH, not starter", () => {
  const r = resolve({ player: { status: "DEV" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "practice_squad");
  assert.equal(r.confidence, "high");
  assert.notEqual(r.role, "starter");
  assert.ok(r.depth_evidence.some((e) => e.pos_abb === "QB"), "the stale row must remain diagnostic in depth_evidence");
});

test("3. RES + no depth row -> unknown", () => {
  const r = resolve({ player: { status: "RES" } });
  assert.equal(r.role, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("depth_chart_row_missing"));
});

test("4. RES + rank-1 valid row -> role derived from depth row, not reserve-derived (mirrors real Denzel Perryman-style RES+active-row players)", () => {
  const r = resolve({ normalized_position: "LB", player: { status: "RES" }, depth_chart_rows: [{ pos_abb: "MLB", pos_rank: "1" }] });
  assert.equal(r.role, "starter");
  assert.equal(r.role_source, "depth_chart");
  assert.ok(r.reason_codes.includes("starter_by_rank"));
});

test("5. INA + no row -> unknown", () => {
  const r = resolve({ player: { status: "INA" } });
  assert.equal(r.role, "unknown");
});

test("6. CUT + no row -> unknown", () => {
  const r = resolve({ player: { status: "CUT" } });
  assert.equal(r.role, "unknown");
});

test("7. TRD + no row -> unknown", () => {
  const r = resolve({ player: { status: "TRD" } });
  assert.equal(r.role, "unknown");
});

test("8. RET + no row -> unknown", () => {
  const r = resolve({ player: { status: "RET" } });
  assert.equal(r.role, "unknown");
});

test("9. EXE + no row -> unknown", () => {
  const r = resolve({ player: { status: "EXE" } });
  assert.equal(r.role, "unknown");
});

test("10. status_description_abbr alone never assigns role", () => {
  const r = resolve({ player: { status: "ACT", status_description_abbr: "A01" } });
  assert.equal(r.role, "unknown", "no depth row supplied, so ACT+A01 alone must not produce a role");
  assert.equal(r.status_context.status_description_abbr, "A01", "raw abbr must still be preserved for audit");
});

test("11. changing an unknown fine status_description_abbr code alone never changes the role", () => {
  const a = resolve({ normalized_position: "LB", player: { status: "RES", status_description_abbr: "R01" }, depth_chart_rows: [{ pos_abb: "MLB", pos_rank: "1" }] });
  const b = resolve({ normalized_position: "LB", player: { status: "RES", status_description_abbr: "R49" }, depth_chart_rows: [{ pos_abb: "MLB", pos_rank: "1" }] });
  assert.equal(a.role, b.role);
  assert.equal(a.confidence, b.confidence);
});

// ---------------------------------------------------------------------------
// QB (12-15)
// ---------------------------------------------------------------------------
test("12. QB rank1 -> starter", () => { const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("13. QB rank2 -> backup", () => { const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "2" }] }); assert.equal(r.role, "backup"); });
test("14. QB rank3 -> fringe", () => { const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });
test("15. QB rank4 -> fringe", () => { const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "4" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// RB (16-18)
// ---------------------------------------------------------------------------
test("16. RB rank1 -> starter", () => { const r = resolve({ normalized_position: "RB", depth_chart_rows: [{ pos_abb: "RB", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("17. RB rank2 -> backup", () => { const r = resolve({ normalized_position: "RB", depth_chart_rows: [{ pos_abb: "RB", pos_rank: "2" }] }); assert.equal(r.role, "backup"); });
test("18. RB rank3 -> fringe", () => { const r = resolve({ normalized_position: "RB", depth_chart_rows: [{ pos_abb: "RB", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// WR (19-23)
// ---------------------------------------------------------------------------
test("19. WR rank1 -> starter", () => { const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("20. WR rank2 -> starter", () => { const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "2" }] }); assert.equal(r.role, "starter"); });
test("21. WR rank3 -> significant_rotation", () => { const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "3" }] }); assert.equal(r.role, "significant_rotation"); });
test("22. WR rank4 -> backup", () => { const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "4" }] }); assert.equal(r.role, "backup"); });
test("23. WR rank5 -> fringe", () => { const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "5" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// TE (24-26)
// ---------------------------------------------------------------------------
test("24. TE rank1 -> starter", () => { const r = resolve({ normalized_position: "TE", depth_chart_rows: [{ pos_abb: "TE", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("25. TE rank2 -> backup", () => { const r = resolve({ normalized_position: "TE", depth_chart_rows: [{ pos_abb: "TE", pos_rank: "2" }] }); assert.equal(r.role, "backup"); });
test("26. TE rank3 -> fringe", () => { const r = resolve({ normalized_position: "TE", depth_chart_rows: [{ pos_abb: "TE", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// OT (27-29) — rank interpreted within the specific supplied tackle slot
// ---------------------------------------------------------------------------
test("27. OT rank1 -> starter (via LT)", () => { const r = resolve({ normalized_position: "OT", depth_chart_rows: [{ pos_abb: "LT", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("28. OT rank2 -> backup (via RT)", () => { const r = resolve({ normalized_position: "OT", depth_chart_rows: [{ pos_abb: "RT", pos_rank: "2" }] }); assert.equal(r.role, "backup"); });
test("29. OT rank3 -> fringe", () => { const r = resolve({ normalized_position: "OT", depth_chart_rows: [{ pos_abb: "LT", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// IOL (30-32) — rank interpreted within the specific supplied line slot
// ---------------------------------------------------------------------------
test("30. IOL rank1 -> starter (via RG)", () => { const r = resolve({ normalized_position: "IOL", depth_chart_rows: [{ pos_abb: "RG", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("31. IOL rank2 -> backup (via C)", () => { const r = resolve({ normalized_position: "IOL", depth_chart_rows: [{ pos_abb: "C", pos_rank: "2" }] }); assert.equal(r.role, "backup"); });
test("32. IOL rank3 -> fringe", () => { const r = resolve({ normalized_position: "IOL", depth_chart_rows: [{ pos_abb: "LG", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// EDGE (33-35)
// ---------------------------------------------------------------------------
test("33. EDGE rank1 -> starter", () => { const r = resolve({ normalized_position: "EDGE", depth_chart_rows: [{ pos_abb: "RDE", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("34. EDGE rank2 -> significant_rotation", () => { const r = resolve({ normalized_position: "EDGE", depth_chart_rows: [{ pos_abb: "LDE", pos_rank: "2" }] }); assert.equal(r.role, "significant_rotation"); });
test("35. EDGE rank3 -> fringe", () => { const r = resolve({ normalized_position: "EDGE", depth_chart_rows: [{ pos_abb: "RDE", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// DL (36-38)
// ---------------------------------------------------------------------------
test("36. DL rank1 -> starter", () => { const r = resolve({ normalized_position: "DL", depth_chart_rows: [{ pos_abb: "NT", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("37. DL rank2 -> significant_rotation", () => { const r = resolve({ normalized_position: "DL", depth_chart_rows: [{ pos_abb: "LDT", pos_rank: "2" }] }); assert.equal(r.role, "significant_rotation"); });
test("38. DL rank3 -> fringe", () => { const r = resolve({ normalized_position: "DL", depth_chart_rows: [{ pos_abb: "RDT", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// LB (39-41)
// ---------------------------------------------------------------------------
test("39. LB rank1 -> starter", () => { const r = resolve({ normalized_position: "LB", depth_chart_rows: [{ pos_abb: "MLB", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("40. LB rank2 -> backup", () => { const r = resolve({ normalized_position: "LB", depth_chart_rows: [{ pos_abb: "WLB", pos_rank: "2" }] }); assert.equal(r.role, "backup"); });
test("41. LB rank3 -> fringe", () => { const r = resolve({ normalized_position: "LB", depth_chart_rows: [{ pos_abb: "SLB", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// CB (42-46)
// ---------------------------------------------------------------------------
test("42. CB rank1 -> starter", () => { const r = resolve({ normalized_position: "CB", depth_chart_rows: [{ pos_abb: "LCB", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("43. CB rank2 -> starter", () => { const r = resolve({ normalized_position: "CB", depth_chart_rows: [{ pos_abb: "RCB", pos_rank: "2" }] }); assert.equal(r.role, "starter"); });
test("44. CB rank3 -> significant_rotation", () => { const r = resolve({ normalized_position: "CB", depth_chart_rows: [{ pos_abb: "NB", pos_rank: "3" }] }); assert.equal(r.role, "significant_rotation"); });
test("45. CB rank4 -> backup", () => { const r = resolve({ normalized_position: "CB", depth_chart_rows: [{ pos_abb: "LCB", pos_rank: "4" }] }); assert.equal(r.role, "backup"); });
test("46. CB rank5 -> fringe", () => { const r = resolve({ normalized_position: "CB", depth_chart_rows: [{ pos_abb: "RCB", pos_rank: "5" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// S (47-49)
// ---------------------------------------------------------------------------
test("47. S rank1 -> starter", () => { const r = resolve({ normalized_position: "S", depth_chart_rows: [{ pos_abb: "FS", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("48. S rank2 -> significant_rotation", () => { const r = resolve({ normalized_position: "S", depth_chart_rows: [{ pos_abb: "SS", pos_rank: "2" }] }); assert.equal(r.role, "significant_rotation"); });
test("49. S rank3 -> fringe", () => { const r = resolve({ normalized_position: "S", depth_chart_rows: [{ pos_abb: "FS", pos_rank: "3" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// SPECIALISTS (50-55)
// ---------------------------------------------------------------------------
test("50. K rank1 -> starter", () => { const r = resolve({ normalized_position: "K", depth_chart_rows: [{ pos_abb: "PK", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("51. K rank2 -> fringe", () => { const r = resolve({ normalized_position: "K", depth_chart_rows: [{ pos_abb: "PK", pos_rank: "2" }] }); assert.equal(r.role, "fringe"); });
test("52. P rank1 -> starter", () => { const r = resolve({ normalized_position: "P", depth_chart_rows: [{ pos_abb: "P", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("53. P rank2 -> fringe", () => { const r = resolve({ normalized_position: "P", depth_chart_rows: [{ pos_abb: "P", pos_rank: "2" }] }); assert.equal(r.role, "fringe"); });
test("54. LS rank1 -> starter", () => { const r = resolve({ normalized_position: "LS", depth_chart_rows: [{ pos_abb: "LS", pos_rank: "1" }] }); assert.equal(r.role, "starter"); });
test("55. LS rank2 -> fringe", () => { const r = resolve({ normalized_position: "LS", depth_chart_rows: [{ pos_abb: "LS", pos_rank: "2" }] }); assert.equal(r.role, "fringe"); });

// ---------------------------------------------------------------------------
// MISSING / INVALID (56-62)
// ---------------------------------------------------------------------------
test("56. no relevant depth row -> unknown, never fringe", () => {
  const r = resolve({ depth_chart_rows: [] });
  assert.equal(r.role, "unknown");
  assert.notEqual(r.role, "fringe");
  assert.ok(r.reason_codes.includes("depth_chart_row_missing"));
});

test("57. null pos_rank -> unknown", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: null }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("pos_rank_missing"));
});

test("58. zero pos_rank -> unknown", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "0" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("pos_rank_invalid"));
});

test("59. negative pos_rank -> unknown", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "-1" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("pos_rank_invalid"));
});

test("60. nonnumeric pos_rank -> unknown", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "abc" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("pos_rank_invalid"));
});

test("61. noninteger rank -> unknown", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1.5" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("pos_rank_invalid"));
});

test("62. valid numeric-string rank works (real nflverse format: clean positive-integer strings like '1'-'9')", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "starter");
});

// ---------------------------------------------------------------------------
// SPECIAL TEAMS (63-66)
// ---------------------------------------------------------------------------
test("63. WR rank2 + KR rank1 -> WR starter (KR never used)", () => {
  const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "2" }, { pos_abb: "KR", pos_rank: "1" }] });
  assert.equal(r.role, "starter");
  assert.ok(r.reason_codes.includes("special_teams_row_ignored"));
});

test("64. WR rank3 + PR rank1 -> significant_rotation (PR never used)", () => {
  const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "3" }, { pos_abb: "PR", pos_rank: "1" }] });
  assert.equal(r.role, "significant_rotation");
});

test("65. base-position row missing, only KR/PR present -> unknown", () => {
  const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "KR", pos_rank: "1" }, { pos_abb: "PR", pos_rank: "1" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("depth_chart_row_missing"));
});

test("66. H row alone does not determine role", () => {
  const r = resolve({ normalized_position: "P", depth_chart_rows: [{ pos_abb: "H", pos_rank: "1" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("special_teams_row_ignored"));
});

// ---------------------------------------------------------------------------
// MULTIPLE ROWS (67-73)
// ---------------------------------------------------------------------------
test("67. same-position rows both starter -> starter (mirrors real Michael Jerrell: LT rank2 + RT rank2, both OT)", () => {
  const r = resolve({ normalized_position: "OT", depth_chart_rows: [{ pos_abb: "LT", pos_rank: "1" }, { pos_abb: "RT", pos_rank: "1" }] });
  assert.equal(r.role, "starter");
  assert.ok(r.reason_codes.includes("multiple_rows_same_role"));
});

test("68. starter + significant_rotation -> starter", () => {
  const r = resolve({ normalized_position: "EDGE", depth_chart_rows: [{ pos_abb: "LDE", pos_rank: "1" }, { pos_abb: "RDE", pos_rank: "2" }] });
  assert.equal(r.role, "starter");
  assert.ok(r.reason_codes.includes("multiple_rows_highest_role_selected"));
});

test("69. significant_rotation + backup -> significant_rotation (mirrors real Theo Benedet: RT rank2 + LT rank3, both OT)", () => {
  const r = resolve({ normalized_position: "OT", depth_chart_rows: [{ pos_abb: "RT", pos_rank: "2" }, { pos_abb: "LT", pos_rank: "3" }] });
  assert.equal(r.role, "backup");
});

test("70. backup + fringe -> backup", () => {
  const r = resolve({ normalized_position: "LB", depth_chart_rows: [{ pos_abb: "MLB", pos_rank: "2" }, { pos_abb: "WLB", pos_rank: "3" }] });
  assert.equal(r.role, "backup");
});

test("71. row input ordering does not change the output", () => {
  const rowsA = [{ pos_abb: "LDE", pos_rank: "1" }, { pos_abb: "RDE", pos_rank: "2" }];
  const rowsB = [{ pos_abb: "RDE", pos_rank: "2" }, { pos_abb: "LDE", pos_rank: "1" }];
  const a = resolve({ normalized_position: "EDGE", depth_chart_rows: rowsA });
  const b = resolve({ normalized_position: "EDGE", depth_chart_rows: rowsB });
  assert.equal(a.role, b.role);
  assert.equal(a.confidence, b.confidence);
  assert.deepEqual(a.reason_codes, b.reason_codes);
});

test("72. duplicated identical row does not change the output", () => {
  const a = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  const b = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }, { pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(a.role, b.role);
  assert.equal(a.confidence, b.confidence);
});

test("73. all depth evidence remains auditable, including excluded rows", () => {
  const r = resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "1" }, { pos_abb: "KR", pos_rank: "1" }] });
  assert.equal(r.depth_evidence.length, 2, "every supplied row must appear in depth_evidence, including the ignored KR row");
  const kr = r.depth_evidence.find((e) => e.pos_abb === "KR");
  assert.equal(kr.mapped_role, null);
});

// ---------------------------------------------------------------------------
// POSITION CONFIDENCE (74-77)
// ---------------------------------------------------------------------------
test("74. normalized_position unknown -> role unknown", () => {
  const r = resolve({ normalized_position: "unknown", depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("position_unknown"));
});

test("75. low position confidence -> role unknown even with a valid rank present", () => {
  const r = resolve({ position_confidence: "low", depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "unknown");
  assert.ok(r.reason_codes.includes("position_confidence_low"));
});

test("76. medium position confidence + valid rank -> role assigned but confidence capped at medium", () => {
  const r = resolve({ position_confidence: "medium", depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "starter");
  assert.equal(r.confidence, "medium");
  assert.ok(r.reason_codes.includes("position_confidence_medium_cap"));
});

test("77. high position confidence + valid rank -> role confidence high", () => {
  const r = resolve({ position_confidence: "high", depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "starter");
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------------------
// PURITY / BOUNDARIES (78-86)
// ---------------------------------------------------------------------------
test("78. player name changes do not alter role", () => {
  const a = resolve({ player: { status: "ACT", full_name: "Player One" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  const b = resolve({ player: { status: "ACT", full_name: "Player Two" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(a.role, b.role);
  assert.equal(a.confidence, b.confidence);
});

test("79. team changes do not alter role", () => {
  const a = resolve({ player: { status: "ACT", team: "KC" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  const b = resolve({ player: { status: "ACT", team: "BUF" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(a.role, b.role);
});

test("80. unknown fine status_description_abbr code changes do not alter role", () => {
  const a = resolve({ player: { status: "ACT", status_description_abbr: "A01" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  const b = resolve({ player: { status: "ACT", status_description_abbr: "W03" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(a.role, b.role);
  assert.equal(a.confidence, b.confidence);
});

test("81. the resolver performs no network calls", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseRoleResolver.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(/.test(src), false);
});

test("82. the resolver performs no file/cache reads", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseRoleResolver.js", import.meta.url), "utf-8"));
  assert.equal(/readFile|readFileSync|require\(['"]fs/.test(src), false);
});

test("83. the resolver does not parse article text (no headline/description/combinedText field is read anywhere; status_description_abbr is a distinct, legitimate roster field and must not false-positive this check)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseRoleResolver.js", import.meta.url), "utf-8"));
  assert.equal(/\bheadline\b|\bdescription\b|\bcombinedText\b/i.test(src), false);
});

test("84. the role result never includes a numeric scoring weight or role multiplier", () => {
  const r = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  for (const forbidden of ["role_weight", "position_weight", "role_multiplier", "ROLE_MULTIPLIER", "star_boost", "total_score", "score"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, forbidden), false, `output must never contain: ${forbidden}`);
  }
});

test("85. pos_rank does not alter normalized_position (2E only reuses Phase 2D's own pure per-row classification for filtering, never for deciding position)", () => {
  const a = resolve({ normalized_position: "EDGE", depth_chart_rows: [{ pos_abb: "RDE", pos_rank: "1" }] });
  const b = resolve({ normalized_position: "EDGE", depth_chart_rows: [{ pos_abb: "RDE", pos_rank: "9" }] });
  assert.equal(a.normalized_position, b.normalized_position);
  assert.equal(a.normalized_position, "EDGE");
});

test("86. the role resolver does not mutate input rows/player", () => {
  const player = Object.freeze({ status: "ACT" });
  const rows = Object.freeze([Object.freeze({ pos_abb: "QB", pos_rank: "1" })]);
  assert.doesNotThrow(() => resolvePlayerRole({ normalized_position: "QB", position_confidence: "high", player, depth_chart_rows: rows }));
});

// ---------------------------------------------------------------------------
// Additional coverage required by real observed nflverse values / boundaries
// ---------------------------------------------------------------------------

test("Additional: no player supplied (identity unresolved) -> unknown LOW, identity_unresolved", () => {
  const r = resolvePlayerRole({ normalized_position: "QB", position_confidence: "high", player: null, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r.role, "unknown");
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("identity_unresolved"));
});

test("Additional: role_source is 'none' for every unknown outcome (never a stale depth_chart/roster_status label)", () => {
  assert.equal(resolvePlayerRole({}).role_source, "none");
  assert.equal(resolve({ player: { status: "RES" } }).role_source, "none");
});

test("Additional: status_context always preserves raw roster_status and status_description_abbr, even under DEV precedence and unknown outcomes", () => {
  const r = resolve({ player: { status: "DEV", status_description_abbr: "P03" }, depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.deepEqual(r.status_context, { roster_status: "DEV", status_description_abbr: "P03" });
});

test("Additional: non-DEV statuses (RES/INA/CUT/TRD/TRC/RET/EXE) never themselves become practice_squad (status/role separation holds in both directions)", () => {
  for (const status of ["RES", "INA", "CUT", "TRD", "TRC", "RET", "EXE"]) {
    const r = resolve({ player: { status }, depth_chart_rows: [] });
    assert.notEqual(r.role, "practice_squad", `${status} must never itself become practice_squad`);
  }
});

test("Additional: role_as_of is null when no as-of value is supplied, never a manufactured current time", () => {
  const r = resolve({ player: { status: "DEV" } });
  assert.equal(r.role_as_of, null);
  const r2 = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] });
  assert.equal(r2.role_as_of, null);
});

test("Additional: supplied roster_as_of / depth_chart_as_of pass through verbatim, never Date.now()", () => {
  const r1 = resolve({ player: { status: "DEV" }, roster_as_of: "2026-09-01T00:00:00Z" });
  assert.equal(r1.role_as_of, "2026-09-01T00:00:00Z");
  const r2 = resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }], depth_chart_as_of: "2026-09-04T11:57:41Z" });
  assert.equal(r2.role_as_of, "2026-09-04T11:57:41Z");
  assert.equal(r2.depth_chart_as_of, "2026-09-04T11:57:41Z");
});

test("Additional: a genuinely different-position row (e.g. IOL row supplied while overall normalized_position is OT) is excluded, never blended in (mirrors real Brady Christensen/Jalon Kilgore-style multi-bucket players, which Phase 2D itself already flags as unknown before reaching 2E)", () => {
  const r = resolve({ normalized_position: "OT", depth_chart_rows: [{ pos_abb: "RG", pos_rank: "1" }] });
  assert.equal(r.role, "unknown", "an IOL-shaped row must never be used to compute an OT role");
  assert.ok(r.reason_codes.includes("depth_chart_row_missing"));
});

test("Additional: source enum sanity — role_source is always one of roster_status | depth_chart | none", () => {
  const sources = new Set();
  sources.add(resolve({ player: { status: "DEV" } }).role_source);
  sources.add(resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] }).role_source);
  sources.add(resolve({ player: { status: "RES" } }).role_source);
  for (const s of sources) assert.ok(["roster_status", "depth_chart", "none"].includes(s));
});

test("Additional: only the 6 locked role enum values are ever returned across a broad sample", () => {
  const LOCKED_ROLES = new Set(["starter", "significant_rotation", "backup", "fringe", "practice_squad", "unknown"]);
  const samples = [
    resolve({ player: { status: "DEV" } }),
    resolve({ depth_chart_rows: [{ pos_abb: "QB", pos_rank: "1" }] }),
    resolve({ normalized_position: "WR", depth_chart_rows: [{ pos_abb: "WR", pos_rank: "3" }] }),
    resolve({ player: { status: "RES" } }),
    resolvePlayerRole({}),
  ];
  for (const s of samples) assert.ok(LOCKED_ROLES.has(s.role), `unexpected non-locked role: ${s.role}`);
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
