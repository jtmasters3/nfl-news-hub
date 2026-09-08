#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2I regression suite. Fully offline and
// deterministic: no network, no file reads, no live nflverse dependency.
// Every fixture is synthetic and hand-constructed to exercise a specific
// anti-lookahead invariant.
// Run with: node scripts/tests/nflverse-as-of-resolver-regression.mjs
import assert from "node:assert/strict";
import { resolveNflverseAsOfEvidence } from "../lib/nflverseAsOfResolver.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function rosterRow({ season = 2026, week = 1, gsis_id = "00-0000001", full_name = "Test Player", team = "KC" } = {}) {
  return { season, week, gsis_id, full_name, team };
}

function depthRow({ dt = "2026-08-26T07:15:43Z", gsis_id = "00-0000001", player_name = "Test Player", team = "KC", pos_abb = "QB", pos_rank = "1" } = {}) {
  return { dt, gsis_id, player_name, team, pos_abb, pos_rank };
}

// ---------------------------------------------------------------------------
// ROSTER ANTI-LOOKAHEAD TESTS (1-15)
// ---------------------------------------------------------------------------

test("1. exact eligible roster snapshot/week selected", () => {
  const rows = [rosterRow({ season: 2026, week: 3 }), rosterRow({ season: 2026, week: 4 })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 3 });
  assert.equal(result.roster.selection_basis, "exact");
  assert.equal(result.roster.selected_season, 2026);
  assert.equal(result.roster.selected_week, 3);
  assert.equal(result.roster.rows.length, 1);
});

test("2. nearest preceding roster selected when exact unavailable", () => {
  const rows = [rosterRow({ season: 2026, week: 2 }), rosterRow({ season: 2026, week: 5 })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 4 });
  assert.equal(result.roster.selection_basis, "nearest_preceding");
  assert.equal(result.roster.selected_week, 2);
});

test("3. future roster week never selected", () => {
  const rows = [rosterRow({ season: 2026, week: 2 }), rosterRow({ season: 2026, week: 10 })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 4 });
  assert.equal(result.roster.selected_week, 2);
  assert.notEqual(result.roster.selected_week, 10);
  assert.equal(result.diagnostics.future_roster_rejected, true);
});

test("4. only future roster evidence -> no roster", () => {
  const rows = [rosterRow({ season: 2026, week: 10 })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 4 });
  assert.equal(result.roster.selection_basis, "not_available");
  assert.equal(result.diagnostics.roster_found, false);
  assert.equal(result.diagnostics.future_roster_rejected, true);
  assert.ok(result.reason_codes.includes("roster_not_available"));
});

test("5. no roster rows -> neutral", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [], target_season: 2026, target_week: 4 });
  assert.equal(result.roster.selection_basis, "not_available");
  assert.equal(result.diagnostics.roster_found, false);
  assert.ok(result.reason_codes.includes("roster_not_available"));
});

test("6. malformed roster temporal fields rejected", () => {
  const rows = [{ season: "not-a-season", week: "not-a-week", gsis_id: "00-0000001" }, { season: 2026, week: 3 }];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 3 });
  assert.equal(result.roster.selected_week, 3);
  assert.equal(result.roster.rows.length, 1);
});

test("6b. ALL roster rows malformed -> distinct reason code from empty input", () => {
  const rows = [{ season: "x", week: "y" }];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 3 });
  assert.ok(result.reason_codes.includes("roster_temporal_field_invalid"));
});

test("7. input row order does not matter (roster)", () => {
  const rowsA = [rosterRow({ season: 2026, week: 2 }), rosterRow({ season: 2026, week: 5 }), rosterRow({ season: 2026, week: 3 })];
  const rowsB = [rosterRow({ season: 2026, week: 3 }), rosterRow({ season: 2026, week: 5 }), rosterRow({ season: 2026, week: 2 })];
  const a = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rowsA, target_season: 2026, target_week: 4 });
  const b = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rowsB, target_season: 2026, target_week: 4 });
  assert.equal(a.roster.selected_week, b.roster.selected_week);
  assert.equal(a.roster.selected_week, 3);
});

test("8. duplicate rows do not change selected temporal snapshot (roster)", () => {
  const rows = [rosterRow({ season: 2026, week: 3, gsis_id: "00-A" }), rosterRow({ season: 2026, week: 3, gsis_id: "00-B" }), rosterRow({ season: 2026, week: 3, gsis_id: "00-A" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 3 });
  assert.equal(result.roster.selected_week, 3);
  assert.equal(result.roster.rows.length, 3); // all rows for the selected week are returned, duplicates included verbatim
});

test("9. selected season exposed", () => {
  const rows = [rosterRow({ season: 2025, week: 18 })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2025, target_week: 18 });
  assert.equal(result.roster.selected_season, 2025);
});

test("10. selected week exposed", () => {
  const rows = [rosterRow({ season: 2025, week: 18 })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2025, target_week: 18 });
  assert.equal(result.roster.selected_week, 18);
});

test("11. roster selection basis exposed", () => {
  const exact = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [rosterRow({ season: 2026, week: 3 })], target_season: 2026, target_week: 3 });
  const preceding = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [rosterRow({ season: 2026, week: 2 })], target_season: 2026, target_week: 3 });
  const none = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [], target_season: 2026, target_week: 3 });
  assert.equal(exact.roster.selection_basis, "exact");
  assert.equal(preceding.roster.selection_basis, "nearest_preceding");
  assert.equal(none.roster.selection_basis, "not_available");
});

test("12. missing as_of -> neutral (roster side included)", () => {
  const result = resolveNflverseAsOfEvidence({ roster_rows: [rosterRow({ season: 2026, week: 3 })], target_season: 2026, target_week: 3 });
  assert.equal(result.roster.selection_basis, "not_available");
  assert.equal(result.diagnostics.roster_found, false);
  assert.ok(result.reason_codes.includes("as_of_missing"));
});

test("13. invalid as_of -> neutral (roster side included)", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "not-a-real-date", roster_rows: [rosterRow({ season: 2026, week: 3 })], target_season: 2026, target_week: 3 });
  assert.equal(result.roster.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("as_of_invalid"));
});

test("14. no Date.now dependency", () => {
  const original = Date.now;
  Date.now = () => {
    throw new Error("resolveNflverseAsOfEvidence must never call Date.now()");
  };
  try {
    const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [rosterRow({ season: 2026, week: 3 })], depth_chart_rows: [depthRow()], target_season: 2026, target_week: 3 });
    assert.equal(result.roster.selected_week, 3);
  } finally {
    Date.now = original;
  }
});

test("15. deterministic repeated invocation (roster)", () => {
  const rows = [rosterRow({ season: 2026, week: 2 }), rosterRow({ season: 2026, week: 5 })];
  const a = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 4 });
  const b = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rows, target_season: 2026, target_week: 4 });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// DEPTH ANTI-LOOKAHEAD TESTS (16-34)
// ---------------------------------------------------------------------------

test("16. exact eligible prior depth snapshot selected", () => {
  const rows = [depthRow({ dt: "2026-08-20T10:00:00Z" }), depthRow({ dt: "2026-08-27T10:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-27T10:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-27T10:00:00Z");
});

test("17. largest eligible preceding dt selected", () => {
  const rows = [depthRow({ dt: "2026-08-01T00:00:00Z" }), depthRow({ dt: "2026-08-15T00:00:00Z" }), depthRow({ dt: "2026-08-20T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-25T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-20T00:00:00Z");
});

test("18. future dt never selected", () => {
  const rows = [depthRow({ dt: "2026-08-01T00:00:00Z" }), depthRow({ dt: "2026-09-01T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-01T00:00:00Z");
  assert.equal(result.diagnostics.future_depth_chart_rejected, true);
});

test("19. nearest absolute date is NOT used (a slightly-future snapshot is never preferred over a further-past one)", () => {
  // as_of sits between the two: the far-past snapshot is the only legal
  // choice even though the future one is numerically closer.
  const rows = [depthRow({ dt: "2026-01-01T00:00:00Z" }), depthRow({ dt: "2026-08-16T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-01-01T00:00:00Z");
});

test("20. only future depth snapshots -> no depth", () => {
  const rows = [depthRow({ dt: "2026-09-01T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selection_basis, "not_available");
  assert.equal(result.diagnostics.depth_chart_found, false);
  assert.equal(result.diagnostics.future_depth_chart_rejected, true);
  assert.ok(result.reason_codes.includes("future_depth_chart_rejected"));
});

test("21. no depth rows -> neutral", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: [] });
  assert.equal(result.depth_chart.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("depth_chart_not_available"));
});

test("22. malformed dt rejected", () => {
  const rows = [{ dt: "not-a-date", gsis_id: "00-X" }, depthRow({ dt: "2026-08-01T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-01T00:00:00Z");
});

test("22b. ALL depth rows malformed -> distinct reason code from empty input", () => {
  const rows = [{ dt: "garbage" }];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.ok(result.reason_codes.includes("depth_chart_dt_invalid"));
});

test("23. row order does not matter (depth)", () => {
  const a = [depthRow({ dt: "2026-08-01T00:00:00Z" }), depthRow({ dt: "2026-08-10T00:00:00Z" })];
  const b = [depthRow({ dt: "2026-08-10T00:00:00Z" }), depthRow({ dt: "2026-08-01T00:00:00Z" })];
  const ra = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: a });
  const rb = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: b });
  assert.equal(ra.depth_chart.selected_dt, rb.depth_chart.selected_dt);
  assert.equal(ra.depth_chart.selected_dt, "2026-08-10T00:00:00Z");
});

test("24. duplicate rows do not change selected snapshot (depth)", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z", gsis_id: "00-A" }), depthRow({ dt: "2026-08-10T00:00:00Z", gsis_id: "00-A" }), depthRow({ dt: "2026-08-01T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-10T00:00:00Z");
});

test("25. all rows for selected dt returned", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z", gsis_id: "00-A" }), depthRow({ dt: "2026-08-10T00:00:00Z", gsis_id: "00-B" }), depthRow({ dt: "2026-08-10T00:00:00Z", gsis_id: "00-C" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.rows.length, 3);
});

test("26. rows from other dt excluded", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z", gsis_id: "00-A" }), depthRow({ dt: "2026-08-01T00:00:00Z", gsis_id: "00-OLD" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.rows.length, 1);
  assert.equal(result.depth_chart.rows[0].gsis_id, "00-A");
});

test("27. selected_dt exposed", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-10T00:00:00Z");
});

test("28. depth_chart_as_of exposed", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.depth_chart_as_of, "2026-08-10T00:00:00Z");
});

test("29. selected_depth_chart_age_days correct", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_depth_chart_age_days, 5);
});

test("29b. selected_depth_chart_age_days handles sub-day precision", () => {
  const rows = [depthRow({ dt: "2026-08-10T00:00:00Z" })];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-10T12:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_depth_chart_age_days, 0.5);
});

test("30. no selected snapshot -> age null", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: [] });
  assert.equal(result.depth_chart.selected_depth_chart_age_days, null);
});

test("31. missing as_of -> neutral (depth side included)", () => {
  const result = resolveNflverseAsOfEvidence({ depth_chart_rows: [depthRow({ dt: "2026-08-10T00:00:00Z" })] });
  assert.equal(result.depth_chart.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("as_of_missing"));
});

test("32. invalid as_of -> neutral (depth side included)", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "not-a-real-date", depth_chart_rows: [depthRow({ dt: "2026-08-10T00:00:00Z" })] });
  assert.equal(result.depth_chart.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("as_of_invalid"));
});

test("33. deterministic repeated invocation (depth)", () => {
  const rows = [depthRow({ dt: "2026-08-01T00:00:00Z" }), depthRow({ dt: "2026-08-10T00:00:00Z" })];
  const a = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  const b = resolveNflverseAsOfEvidence({ as_of: "2026-08-15T00:00:00Z", depth_chart_rows: rows });
  assert.deepEqual(a, b);
});

test("34. machine timezone does not alter selection", () => {
  const rows = [depthRow({ dt: "2026-08-10T23:30:00Z" })];
  const asOf = "2026-08-11T00:15:00Z";
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utcResult = resolveNflverseAsOfEvidence({ as_of: asOf, depth_chart_rows: rows });
    process.env.TZ = "America/Los_Angeles";
    const laResult = resolveNflverseAsOfEvidence({ as_of: asOf, depth_chart_rows: rows });
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, as far as timezones get
    const kiritimatiResult = resolveNflverseAsOfEvidence({ as_of: asOf, depth_chart_rows: rows });
    assert.deepEqual(utcResult, laResult);
    assert.deepEqual(utcResult, kiritimatiResult);
    assert.equal(utcResult.depth_chart.selected_dt, "2026-08-10T23:30:00Z");
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

// ---------------------------------------------------------------------------
// DATE-ONLY SAFETY TESTS (35-40)
// ---------------------------------------------------------------------------

test("35. story at midday on D does not accidentally consume an unknown-time D snapshot", () => {
  const rows = [{ dt: "2026-08-10", gsis_id: "00-A" }];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-10T12:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selection_basis, "not_available");
  assert.equal(result.diagnostics.future_depth_chart_rejected, true);
});

test("36. story on D+1 can consume D snapshot", () => {
  const rows = [{ dt: "2026-08-10", gsis_id: "00-A" }];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-11T00:00:00Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selected_dt, "2026-08-10");
});

test("37. same-day future-lookahead impossible under chosen convention (even at 23:59:59 on D)", () => {
  const rows = [{ dt: "2026-08-10", gsis_id: "00-A" }];
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-08-10T23:59:59Z", depth_chart_rows: rows });
  assert.equal(result.depth_chart.selection_basis, "not_available");
});

test("38. DST boundary does not change eligibility (US fall-back date, Nov 1 2026)", () => {
  const rows = [{ dt: "2026-11-01", gsis_id: "00-A" }];
  const beforeMidnight = resolveNflverseAsOfEvidence({ as_of: "2026-11-01T23:00:00Z", depth_chart_rows: rows });
  const afterMidnight = resolveNflverseAsOfEvidence({ as_of: "2026-11-02T00:00:01Z", depth_chart_rows: rows });
  assert.equal(beforeMidnight.depth_chart.selection_basis, "not_available");
  assert.equal(afterMidnight.depth_chart.selected_dt, "2026-11-01");
});

test("39. leap-day behavior deterministic (2028 is a leap year)", () => {
  const rows = [{ dt: "2028-02-29", gsis_id: "00-A" }];
  const onLeapDay = resolveNflverseAsOfEvidence({ as_of: "2028-02-29T18:00:00Z", depth_chart_rows: rows });
  const dayAfter = resolveNflverseAsOfEvidence({ as_of: "2028-03-01T00:00:00Z", depth_chart_rows: rows });
  assert.equal(onLeapDay.depth_chart.selection_basis, "not_available");
  assert.equal(dayAfter.depth_chart.selected_dt, "2028-02-29");
});

test("40. year boundary deterministic", () => {
  const rows = [{ dt: "2026-12-31", gsis_id: "00-A" }];
  const sameDayNextYearEve = resolveNflverseAsOfEvidence({ as_of: "2026-12-31T23:59:59Z", depth_chart_rows: rows });
  const newYearsDay = resolveNflverseAsOfEvidence({ as_of: "2027-01-01T00:00:00Z", depth_chart_rows: rows });
  assert.equal(sameDayNextYearEve.depth_chart.selection_basis, "not_available");
  assert.equal(newYearsDay.depth_chart.selected_dt, "2026-12-31");
});

// ---------------------------------------------------------------------------
// COMBINED EVIDENCE TESTS (41-50)
// ---------------------------------------------------------------------------

test("41. roster available + depth available", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [rosterRow({ season: 2026, week: 3 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })],
    target_season: 2026,
    target_week: 3,
  });
  assert.equal(result.diagnostics.roster_found, true);
  assert.equal(result.diagnostics.depth_chart_found, true);
});

test("42. roster available + depth unavailable", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [rosterRow({ season: 2026, week: 3 })],
    depth_chart_rows: [],
    target_season: 2026,
    target_week: 3,
  });
  assert.equal(result.diagnostics.roster_found, true);
  assert.equal(result.diagnostics.depth_chart_found, false);
});

test("43. roster unavailable + depth available", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })],
    target_season: 2026,
    target_week: 3,
  });
  assert.equal(result.diagnostics.roster_found, false);
  assert.equal(result.diagnostics.depth_chart_found, true);
});

test("44. neither available", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [], depth_chart_rows: [], target_season: 2026, target_week: 3 });
  assert.equal(result.diagnostics.roster_found, false);
  assert.equal(result.diagnostics.depth_chart_found, false);
});

test("45. future roster rejected while valid depth retained", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [rosterRow({ season: 2026, week: 3 }), rosterRow({ season: 2026, week: 10 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })],
    target_season: 2026,
    target_week: 3,
  });
  assert.equal(result.diagnostics.future_roster_rejected, true);
  assert.equal(result.diagnostics.depth_chart_found, true);
  assert.equal(result.depth_chart.selected_dt, "2026-09-20T00:00:00Z");
});

test("46. future depth rejected while valid roster retained", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [rosterRow({ season: 2026, week: 3 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" }), depthRow({ dt: "2026-10-01T00:00:00Z" })],
    target_season: 2026,
    target_week: 3,
  });
  assert.equal(result.diagnostics.future_depth_chart_rejected, true);
  assert.equal(result.diagnostics.roster_found, true);
  assert.equal(result.roster.selected_week, 3);
});

test("47. provenance fields correct", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [rosterRow({ season: 2026, week: 3 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })],
    target_season: 2026,
    target_week: 3,
  });
  assert.equal(result.as_of, "2026-09-25T00:00:00Z");
  assert.equal(result.roster.roster_as_of, null); // week-granular only, no finer source timestamp exists — never fabricated
  assert.equal(result.roster.selection_basis, "exact");
  assert.equal(result.depth_chart.depth_chart_as_of, "2026-09-20T00:00:00Z");
  assert.equal(result.depth_chart.selection_basis, "nearest_preceding_snapshot");
});

test("48. reason codes stable and deduplicated", () => {
  // No target_season/target_week AND no schedule_rows supplied at all — the
  // correct reason is "no target was ever supplied," distinct from "a
  // target was supplied but nothing matched it." (A prior version of this
  // test asserted "roster_not_available" here, which only happened to pass
  // because of a since-fixed bug: Number(null) === 0 made "no target
  // supplied" look identical to "target season 0, week 0 supplied.")
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [], depth_chart_rows: [] });
  const unique = new Set(result.reason_codes);
  assert.equal(unique.size, result.reason_codes.length);
  assert.ok(result.reason_codes.includes("roster_week_target_not_supplied"));
  assert.ok(result.reason_codes.includes("depth_chart_not_available"));
});

test("48b. reason codes stable and deduplicated when a manual target IS supplied but matches nothing", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: [], depth_chart_rows: [], target_season: 2026, target_week: 3 });
  const unique = new Set(result.reason_codes);
  assert.equal(unique.size, result.reason_codes.length);
  assert.ok(result.reason_codes.includes("roster_not_available"));
  assert.ok(result.reason_codes.includes("depth_chart_not_available"));
});

test("49. input arrays not mutated", () => {
  const rosterRows = [rosterRow({ season: 2026, week: 5 }), rosterRow({ season: 2026, week: 2 }), rosterRow({ season: 2026, week: 3 })];
  const depthRows = [depthRow({ dt: "2026-08-10T00:00:00Z" }), depthRow({ dt: "2026-08-01T00:00:00Z" })];
  const rosterSnapshot = JSON.stringify(rosterRows);
  const depthSnapshot = JSON.stringify(depthRows);
  resolveNflverseAsOfEvidence({ as_of: "2026-09-25T00:00:00Z", roster_rows: rosterRows, depth_chart_rows: depthRows, target_season: 2026, target_week: 4 });
  assert.equal(JSON.stringify(rosterRows), rosterSnapshot);
  assert.equal(JSON.stringify(depthRows), depthSnapshot);
});

test("50. output deterministic across repeated invocation with combined evidence", () => {
  const input = {
    as_of: "2026-09-25T00:00:00Z",
    roster_rows: [rosterRow({ season: 2026, week: 3 }), rosterRow({ season: 2026, week: 10 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" }), depthRow({ dt: "2026-10-01T00:00:00Z" })],
    target_season: 2026,
    target_week: 3,
  };
  const a = resolveNflverseAsOfEvidence(input);
  const b = resolveNflverseAsOfEvidence(input);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// ROSTER COMPOSITION TESTS (29-46) — schedule-derived roster targeting,
// composed via resolveNflverseAsOfEvidence({ schedule_rows, ... }). See
// scripts/lib/nflverseScheduleAsOf.js for the schedule-anchor rule itself
// (covered exhaustively by nflverse-schedule-as-of-regression.mjs); these
// tests cover only the COMPOSITION with roster/depth selection.
// ---------------------------------------------------------------------------

function scheduleGame({ season = 2026, week = 1, game_type = "REG", gameday = "2026-09-13", gametime = "13:00" } = {}) {
  return { season, week, game_type, gameday, gametime };
}

// Week 1 (Sun-only, for simplicity) reaches its final scheduled kickoff at 2026-09-13T17:00:00Z (13:00 ET/EDT).
const SCHEDULE_WEEK1 = [scheduleGame({ week: 1, gameday: "2026-09-13", gametime: "13:00" })];
// Week 2 reaches its final scheduled kickoff at 2026-09-22T00:15:00Z (Mon 2026-09-21 20:15 ET/EDT).
const SCHEDULE_WEEK2 = [scheduleGame({ week: 2, gameday: "2026-09-20", gametime: "13:00" }), scheduleGame({ week: 2, gameday: "2026-09-21", gametime: "20:15" })];
const SCHEDULE_ALL = SCHEDULE_WEEK1.concat(SCHEDULE_WEEK2);
const AS_OF_MID_WEEK2 = "2026-09-25T00:00:00Z"; // at/after week 2's final scheduled kickoff

test("29. schedule-derived exact roster week", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 2 })],
  });
  assert.equal(result.schedule.week, 2);
  assert.equal(result.roster.selection_basis, "exact");
  assert.equal(result.roster.selected_week, 2);
  assert.equal(result.roster.target_mode, "schedule_derived");
});

test("30. schedule-derived preceding roster fallback", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 1 })], // week 2 roster not available; week 1 is
  });
  assert.equal(result.schedule.week, 2); // schedule anchor is still week 2
  assert.equal(result.roster.selection_basis, "nearest_preceding");
  assert.equal(result.roster.selected_week, 1);
});

test("31. no eligible schedule week -> no roster", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: "2026-09-01T00:00:00Z", // before week 1 even starts
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 1 })],
  });
  assert.equal(result.schedule, null);
  assert.equal(result.roster.selection_basis, "not_available");
  assert.equal(result.diagnostics.roster_found, false);
});

test("32. future roster never selected (schedule-derived mode)", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 1 }), rosterRow({ season: 2026, week: 10 })],
  });
  assert.equal(result.roster.selected_week, 1);
  assert.equal(result.diagnostics.future_roster_rejected, true);
});

test("33. future schedule week never causes roster lookahead", () => {
  // as_of sits between week 1 and week 2's conclusion — schedule anchor must be week 1, never week 2.
  const midWeek2 = "2026-09-20T18:00:00Z"; // after week 2's Sunday game, before Monday's
  const result = resolveNflverseAsOfEvidence({
    as_of: midWeek2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 1 }), rosterRow({ season: 2026, week: 2 })],
  });
  assert.equal(result.schedule.week, 1);
  assert.equal(result.roster.selected_week, 1);
  assert.notEqual(result.roster.selected_week, 2);
});

test("34. roster available + depth available (schedule-derived)", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 2 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })],
  });
  assert.equal(result.diagnostics.roster_found, true);
  assert.equal(result.diagnostics.depth_chart_found, true);
});

test("35. roster unavailable + depth available (schedule-derived)", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [],
    depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })],
  });
  assert.equal(result.diagnostics.roster_found, false);
  assert.equal(result.diagnostics.depth_chart_found, true);
});

test("36. roster available + depth unavailable (schedule-derived)", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 2 })],
    depth_chart_rows: [],
  });
  assert.equal(result.diagnostics.roster_found, true);
  assert.equal(result.diagnostics.depth_chart_found, false);
});

test("37. neither available (schedule-derived)", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [], depth_chart_rows: [] });
  assert.equal(result.diagnostics.roster_found, false);
  assert.equal(result.diagnostics.depth_chart_found, false);
});

test("38. provenance identifies schedule-derived target", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.roster.target_mode, "schedule_derived");
  assert.equal(result.roster.target_season, 2026);
  assert.equal(result.roster.target_week, 2);
});

test("39. provenance identifies manual target when manual mode is used (no schedule_rows supplied)", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, roster_rows: [rosterRow({ season: 2026, week: 2 })], target_season: 2026, target_week: 2 });
  assert.equal(result.roster.target_mode, "manual");
  assert.equal(result.schedule, null);
});

test("40. reason codes distinguish missing schedule from missing roster", () => {
  const missingSchedule = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: [], roster_rows: [rosterRow({ season: 2026, week: 2 })], target_season: 2026, target_week: 2 });
  assert.ok(missingSchedule.reason_codes.includes("roster_selected_exact")); // no schedule_rows -> manual mode, unaffected
  const missingRoster = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [] });
  assert.ok(missingRoster.reason_codes.includes("roster_not_available"));
  assert.ok(missingRoster.reason_codes.includes("schedule_week_selected"));
});

test("41. target season/week exposed", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 1 })] });
  assert.equal(result.roster.target_season, 2026);
  assert.equal(result.roster.target_week, 2);
  assert.equal(result.roster.selected_week, 1); // preceding fallback — target and selected legitimately differ
});

test("42. game_type exposed if meaningful", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.schedule.game_type, "REG");
});

test("43. schedule anchor timestamp exposed", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.schedule.anchor_timestamp, "2026-09-22T00:15:00.000Z");
});

test("44. story as_of preserved", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.as_of, AS_OF_MID_WEEK2);
});

test("45. no input mutation (schedule_rows)", () => {
  const snapshot = JSON.stringify(SCHEDULE_ALL);
  resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(JSON.stringify(SCHEDULE_ALL), snapshot);
});

test("46. deterministic output (schedule-derived)", () => {
  const input = { as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })], depth_chart_rows: [depthRow({ dt: "2026-09-20T00:00:00Z" })] };
  const a = resolveNflverseAsOfEvidence(input);
  const b = resolveNflverseAsOfEvidence(input);
  assert.deepEqual(a, b);
});

test("46b. manual target is ignored (never silently) when schedule_rows is also supplied", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2020, week: 99 }), rosterRow({ season: 2026, week: 2 })],
    target_season: 2020, // deliberately wrong/stale manual target
    target_week: 99,
  });
  assert.equal(result.roster.selected_week, 2); // schedule-derived target wins, not the manual one
  assert.ok(result.reason_codes.includes("manual_target_ignored_schedule_present"));
});

// ---------------------------------------------------------------------------
// TEMPORAL PROVENANCE HARDENING (47-56) — roster evidence never carries a
// real source timestamp, unlike depth-chart evidence (which always does).
// These tests prove that distinction is mechanically checkable via
// temporal_basis/temporal_confidence, and that the schedule anchor (an
// eligibility BOUNDARY, not a snapshot timestamp) is never confused with
// roster_as_of or with depth-chart's own real dt.
// ---------------------------------------------------------------------------

test("H5. schedule-derived roster exposes indirect/schedule temporal provenance", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.roster.temporal_basis, "schedule_final_kickoff");
  assert.equal(result.roster.temporal_confidence, "indirect");
});

test("H6. roster_as_of remains null in schedule-derived mode", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.roster.roster_as_of, null);
});

test("H7. schedule_anchor_timestamp is NOT copied into roster_as_of", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.roster.roster_as_of, null);
  assert.equal(result.roster.schedule_anchor_timestamp, "2026-09-22T00:15:00.000Z");
  assert.notEqual(result.roster.roster_as_of, result.roster.schedule_anchor_timestamp);
});

test("H8. manual target mode exposes manual provenance", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, roster_rows: [rosterRow({ season: 2026, week: 2 })], target_season: 2026, target_week: 2 });
  assert.equal(result.roster.temporal_basis, "manual_target");
  assert.equal(result.roster.temporal_confidence, "unverified");
  assert.equal(result.roster.schedule_anchor_timestamp, null); // no schedule was ever consulted
});

test("H9. manual target mode is not represented as temporally verified", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, roster_rows: [rosterRow({ season: 2026, week: 2 })], target_season: 2026, target_week: 2 });
  assert.ok(result.reason_codes.includes("manual_roster_target_not_temporally_verified"));
  assert.notEqual(result.roster.temporal_confidence, "verified");
  assert.notEqual(result.roster.temporal_basis, "schedule_final_kickoff");
});

test("H10. no-roster result (no schedule, no manual target) exposes unresolved provenance", () => {
  const result = resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, roster_rows: [rosterRow({ season: 2026, week: 2 })] });
  assert.equal(result.roster.temporal_basis, "unresolved");
  assert.equal(result.roster.temporal_confidence, null);
  assert.equal(result.diagnostics.roster_found, false);
});

test("H11. depth evidence continues to expose its real dt timestamp separately from roster provenance", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 2 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-19T12:00:00Z" })],
  });
  assert.equal(result.depth_chart.depth_chart_as_of, "2026-09-19T12:00:00Z");
  assert.equal(result.depth_chart.selected_dt, "2026-09-19T12:00:00Z");
});

test("H12. depth timestamp is never conflated with the schedule anchor", () => {
  const result = resolveNflverseAsOfEvidence({
    as_of: AS_OF_MID_WEEK2,
    schedule_rows: SCHEDULE_ALL,
    roster_rows: [rosterRow({ season: 2026, week: 2 })],
    depth_chart_rows: [depthRow({ dt: "2026-09-19T12:00:00Z" })],
  });
  assert.equal(result.schedule.anchor_timestamp, "2026-09-22T00:15:00.000Z");
  assert.equal(result.depth_chart.depth_chart_as_of, "2026-09-19T12:00:00Z");
  assert.notEqual(result.depth_chart.depth_chart_as_of, result.schedule.anchor_timestamp);
  assert.notEqual(result.depth_chart.depth_chart_as_of, result.roster.schedule_anchor_timestamp);
});

test("H13. input arrays remain unmodified across a full combined call (roster + depth + schedule)", () => {
  const rosterRows = [rosterRow({ season: 2026, week: 2 })];
  const depthRows = [depthRow({ dt: "2026-09-19T12:00:00Z" })];
  const rosterSnapshot = JSON.stringify(rosterRows);
  const depthSnapshot = JSON.stringify(depthRows);
  const scheduleSnapshot = JSON.stringify(SCHEDULE_ALL);
  resolveNflverseAsOfEvidence({ as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: rosterRows, depth_chart_rows: depthRows });
  assert.equal(JSON.stringify(rosterRows), rosterSnapshot);
  assert.equal(JSON.stringify(depthRows), depthSnapshot);
  assert.equal(JSON.stringify(SCHEDULE_ALL), scheduleSnapshot);
});

test("H14. repeated invocation deterministic, including all new provenance fields", () => {
  const input = { as_of: AS_OF_MID_WEEK2, schedule_rows: SCHEDULE_ALL, roster_rows: [rosterRow({ season: 2026, week: 2 })], depth_chart_rows: [depthRow({ dt: "2026-09-19T12:00:00Z" })] };
  const a = resolveNflverseAsOfEvidence(input);
  const b = resolveNflverseAsOfEvidence(input);
  assert.deepEqual(a, b);
  assert.equal(a.roster.temporal_basis, "schedule_final_kickoff");
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
