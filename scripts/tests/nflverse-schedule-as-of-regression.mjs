#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2I schedule-anchor regression suite.
// Fully offline and deterministic: no network, no live nflverse dependency.
// Every fixture is synthetic. Real-data validation (against actual
// nflverse-data games.csv) is reported separately, read-only, never as a
// test dependency here.
// Run with: node scripts/tests/nflverse-schedule-as-of-regression.mjs
import assert from "node:assert/strict";
import { resolveNflWeekAsOf } from "../lib/nflverseScheduleAsOf.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function game({ season = 2026, week = 1, game_type = "REG", gameday = "2026-09-13", gametime = "13:00" } = {}) {
  return { season, week, game_type, gameday, gametime };
}

// A realistic Week 1 spanning Wed/Thu/Sun/Mon (mirrors the real 2026 fixture
// inspected live during this phase) and a Week 2 the following week.
const WEEK1_GAMES = [
  game({ week: 1, gameday: "2026-09-09", gametime: "20:20" }), // Wed
  game({ week: 1, gameday: "2026-09-10", gametime: "20:35" }), // Thu
  game({ week: 1, gameday: "2026-09-13", gametime: "13:00" }), // Sun early
  game({ week: 1, gameday: "2026-09-13", gametime: "16:25" }), // Sun late
  game({ week: 1, gameday: "2026-09-14", gametime: "20:15" }), // Mon (last)
];
const WEEK2_GAMES = [
  game({ week: 2, gameday: "2026-09-17", gametime: "20:15" }),
  game({ week: 2, gameday: "2026-09-20", gametime: "13:00" }),
  game({ week: 2, gameday: "2026-09-21", gametime: "20:20" }), // Mon (last)
];

test("1. missing as_of neutral", () => {
  const result = resolveNflWeekAsOf({ schedule_rows: WEEK1_GAMES });
  assert.equal(result.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("as_of_missing"));
});

test("2. invalid as_of neutral", () => {
  const result = resolveNflWeekAsOf({ as_of: "not-a-date", schedule_rows: WEEK1_GAMES });
  assert.equal(result.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("as_of_invalid"));
});

test("3. empty schedule neutral", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: [] });
  assert.equal(result.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("schedule_not_available"));
});

test("4. malformed schedule timestamps ignored/rejected safely", () => {
  const rows = [{ season: 2026, week: 1, game_type: "REG", gameday: "not-a-date", gametime: "13:00" }, ...WEEK1_GAMES];
  const result = resolveNflWeekAsOf({ as_of: "2026-09-15T01:00:00Z", schedule_rows: rows });
  assert.equal(result.week, 1); // the one malformed row is excluded; the rest of week 1 still resolves
});

test("4b. ALL schedule rows malformed -> distinct reason code from empty input", () => {
  const rows = [{ season: 2026, week: 1, game_type: "REG", gameday: "garbage" }];
  const result = resolveNflWeekAsOf({ as_of: "2026-09-15T00:00:00Z", schedule_rows: rows });
  assert.ok(result.reason_codes.includes("schedule_temporal_field_invalid"));
});

test("5. row order irrelevant", () => {
  const shuffled = [...WEEK2_GAMES].reverse().concat(WEEK1_GAMES);
  const a = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  const b = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: shuffled });
  assert.equal(a.week, b.week);
  assert.equal(a.week, 2);
});

test("6. duplicate schedule rows irrelevant", () => {
  const rows = [...WEEK1_GAMES, ...WEEK1_GAMES];
  const result = resolveNflWeekAsOf({ as_of: "2026-09-15T01:00:00Z", schedule_rows: rows });
  assert.equal(result.week, 1);
});

test("7. future games never create an eligible roster week", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-09-16T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  assert.equal(result.week, 1); // week 2's final scheduled kickoff hasn't been reached; week 1's has
  assert.notEqual(result.week, 2);
});

test("8. prior completed/eligible week selected", () => {
  // as_of is mid-week-2 (after Thursday-equivalent game, before Sunday/Monday) — week 2's final scheduled kickoff has NOT yet been reached.
  const result = resolveNflWeekAsOf({ as_of: "2026-09-18T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  assert.equal(result.week, 1);
});

test("9. exact boundary timestamp deterministic", () => {
  const lastGameUtcIso = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES }).anchor_timestamp;
  const exactBoundary = resolveNflWeekAsOf({ as_of: lastGameUtcIso, schedule_rows: WEEK1_GAMES });
  assert.equal(exactBoundary.week, 1); // <= as_of includes equality
  assert.equal(exactBoundary.anchor_timestamp, lastGameUtcIso);
});

test("10. one millisecond before boundary does not select future week", () => {
  const week1Anchor = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES }).anchor_timestamp;
  const week2LastKickoff = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) }).anchor_timestamp;
  const oneMsBefore = new Date(Date.parse(week2LastKickoff) - 1).toISOString();
  const result = resolveNflWeekAsOf({ as_of: oneMsBefore, schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  assert.equal(result.week, 1);
  assert.notEqual(result.anchor_timestamp, week2LastKickoff);
  assert.equal(result.anchor_timestamp, week1Anchor);
});

test("11. one millisecond after boundary behaves correctly", () => {
  const week2LastKickoff = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) }).anchor_timestamp;
  const oneMsAfter = new Date(Date.parse(week2LastKickoff) + 1).toISOString();
  const result = resolveNflWeekAsOf({ as_of: oneMsAfter, schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  assert.equal(result.week, 2);
});

test("12. preseason behavior (no PRE game_type exists in nflverse schedules — before any REG game, no eligible week)", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-09-01T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  assert.equal(result.selection_basis, "not_available");
  assert.ok(result.reason_codes.includes("no_eligible_schedule_week"));
});

test("13. regular-season behavior", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) });
  assert.equal(result.game_type, "REG");
  assert.equal(result.week, 2);
});

const POSTSEASON_GAMES = [
  game({ season: 2025, week: 18, game_type: "REG", gameday: "2026-01-04", gametime: "13:00" }),
  game({ season: 2025, week: 19, game_type: "WC", gameday: "2026-01-10", gametime: "13:00" }),
  game({ season: 2025, week: 19, game_type: "WC", gameday: "2026-01-12", gametime: "20:15" }), // last WC game (Mon)
  game({ season: 2025, week: 20, game_type: "DIV", gameday: "2026-01-17", gametime: "13:00" }),
  game({ season: 2025, week: 20, game_type: "DIV", gameday: "2026-01-18", gametime: "18:30" }), // last DIV game
  game({ season: 2025, week: 21, game_type: "CON", gameday: "2026-01-25", gametime: "15:00" }),
  game({ season: 2025, week: 21, game_type: "CON", gameday: "2026-01-25", gametime: "18:30" }), // last CON game
  game({ season: 2025, week: 22, game_type: "SB", gameday: "2026-02-08", gametime: "18:30" }),
];

test("14. Wild Card behavior", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-01-15T00:00:00Z", schedule_rows: POSTSEASON_GAMES });
  assert.equal(result.game_type, "WC");
  assert.equal(result.week, 19);
});

test("15. Divisional behavior", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-01-22T00:00:00Z", schedule_rows: POSTSEASON_GAMES });
  assert.equal(result.game_type, "DIV");
  assert.equal(result.week, 20);
});

test("16. Conference behavior", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-01-30T00:00:00Z", schedule_rows: POSTSEASON_GAMES });
  assert.equal(result.game_type, "CON");
  assert.equal(result.week, 21);
});

test("17. Super Bowl behavior", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-03-01T00:00:00Z", schedule_rows: POSTSEASON_GAMES });
  assert.equal(result.game_type, "SB");
  assert.equal(result.week, 22);
});

test("18. offseason before season (nothing eligible yet)", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-08-01T00:00:00Z", schedule_rows: WEEK1_GAMES });
  assert.equal(result.selection_basis, "not_available");
});

test("19. offseason after Super Bowl (SB remains the latest eligible week indefinitely)", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-06-01T00:00:00Z", schedule_rows: POSTSEASON_GAMES });
  assert.equal(result.game_type, "SB");
  assert.equal(result.week, 22);
});

test("20. year boundary (season 2025's games occurring in calendar January 2026 resolve correctly)", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-01-05T00:00:00Z", schedule_rows: POSTSEASON_GAMES });
  assert.equal(result.season, 2025);
  assert.equal(result.week, 18);
});

test("21. DST boundary (Nov 1 2026 US fall-back Sunday) does not misplace eligibility", () => {
  const dstRows = [game({ season: 2026, week: 8, gameday: "2026-11-01", gametime: "13:00" }), game({ season: 2026, week: 8, gameday: "2026-11-02", gametime: "20:15" })];
  // Last game (Monday) kicks off at 20:15 ET the day AFTER the US DST fall-back — must resolve to the correct UTC instant either way.
  const anchorIso = resolveNflWeekAsOf({ as_of: "2026-11-05T00:00:00Z", schedule_rows: dstRows }).anchor_timestamp;
  assert.equal(anchorIso, "2026-11-03T01:15:00.000Z"); // 20:15 EST (UTC-5, post-fallback) = 01:15Z next day
  const before = resolveNflWeekAsOf({ as_of: new Date(Date.parse(anchorIso) - 1).toISOString(), schedule_rows: dstRows });
  assert.equal(before.selection_basis, "not_available");
  const after = resolveNflWeekAsOf({ as_of: anchorIso, schedule_rows: dstRows });
  assert.equal(after.week, 8);
});

test("22. postponed/rescheduled game handling — source has no separate 'original date' field, so a corrected gameday/gametime for a game_id is simply treated as authoritative for that game", () => {
  const rescheduled = game({ week: 5, gameday: "2026-10-13", gametime: "20:15" }); // moved from a Sunday to a Tuesday, as the row now stands
  const result = resolveNflWeekAsOf({ as_of: "2026-10-14T02:00:00Z", schedule_rows: [rescheduled] });
  assert.equal(result.week, 5); // resolved from whatever the row currently says, no special-casing needed or available
});

test("23. multiple games in one week", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-09-15T01:00:00Z", schedule_rows: WEEK1_GAMES });
  assert.equal(result.week, 1);
  assert.equal(WEEK1_GAMES.length, 5); // sanity: the fixture itself has multiple games in the week
});

test("24. Thursday-to-Monday span — week is eligible only once the LAST (Monday) game's scheduled kickoff is reached, not the earliest", () => {
  const beforeMonday = resolveNflWeekAsOf({ as_of: "2026-09-13T20:00:00Z", schedule_rows: WEEK1_GAMES }); // after Sunday games, before Monday's
  assert.equal(beforeMonday.selection_basis, "not_available");
  const afterMonday = resolveNflWeekAsOf({ as_of: "2026-09-15T05:00:00Z", schedule_rows: WEEK1_GAMES });
  assert.equal(afterMonday.week, 1);
});

test("25. no Date.now dependency", () => {
  const original = Date.now;
  Date.now = () => {
    throw new Error("resolveNflWeekAsOf must never call Date.now()");
  };
  try {
    const result = resolveNflWeekAsOf({ as_of: "2026-09-15T01:00:00Z", schedule_rows: WEEK1_GAMES });
    assert.equal(result.week, 1);
  } finally {
    Date.now = original;
  }
});

test("26. machine timezone irrelevant", () => {
  const asOf = "2026-09-15T01:00:00Z";
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utcResult = resolveNflWeekAsOf({ as_of: asOf, schedule_rows: WEEK1_GAMES });
    process.env.TZ = "Pacific/Kiritimati";
    const farResult = resolveNflWeekAsOf({ as_of: asOf, schedule_rows: WEEK1_GAMES });
    assert.deepEqual(utcResult, farResult);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("27. deterministic repeated invocation", () => {
  const input = { as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES.concat(WEEK2_GAMES) };
  const a = resolveNflWeekAsOf(input);
  const b = resolveNflWeekAsOf(input);
  assert.deepEqual(a, b);
});

test("28. input schedule rows not mutated", () => {
  const rows = WEEK1_GAMES.concat(WEEK2_GAMES);
  const snapshot = JSON.stringify(rows);
  resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: rows });
  assert.equal(JSON.stringify(rows), snapshot);
});

// ---------------------------------------------------------------------------
// SEMANTIC HARDENING PASS — explicit boundary + terminology tests. The rule
// is WEEK_FINAL_SCHEDULED_KICKOFF_REACHED, not "week concluded": before a
// week's LAST scheduled kickoff, it is not eligible; at or after it, it is —
// regardless of whether that (or any other) game in the week has actually
// finished, which this dataset has no way to know.
// ---------------------------------------------------------------------------

test("H1. one millisecond before final scheduled kickoff: week W not schedule-eligible", () => {
  const finalKickoffIso = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES }).anchor_timestamp;
  const oneMsBefore = new Date(Date.parse(finalKickoffIso) - 1).toISOString();
  const result = resolveNflWeekAsOf({ as_of: oneMsBefore, schedule_rows: WEEK1_GAMES });
  assert.equal(result.selection_basis, "not_available");
});

test("H2. exactly at final scheduled kickoff: week W schedule-eligible", () => {
  const finalKickoffIso = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES }).anchor_timestamp;
  const result = resolveNflWeekAsOf({ as_of: finalKickoffIso, schedule_rows: WEEK1_GAMES });
  assert.equal(result.week, 1);
  assert.equal(result.anchor_timestamp, finalKickoffIso);
});

test("H3. one millisecond after final scheduled kickoff: week W schedule-eligible", () => {
  const finalKickoffIso = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES }).anchor_timestamp;
  const oneMsAfter = new Date(Date.parse(finalKickoffIso) + 1).toISOString();
  const result = resolveNflWeekAsOf({ as_of: oneMsAfter, schedule_rows: WEEK1_GAMES });
  assert.equal(result.week, 1);
});

test("H4. output labels the boundary a KICKOFF anchor, never game completion", () => {
  const result = resolveNflWeekAsOf({ as_of: "2026-09-25T00:00:00Z", schedule_rows: WEEK1_GAMES });
  assert.equal(result.selection_basis, "final_scheduled_kickoff_reached");
  assert.equal(result.anchor_type, "final_scheduled_kickoff");
  assert.notEqual(result.selection_basis, "latest_completed_week");
  assert.ok(!/complet|conclud|finish/i.test(result.selection_basis));
  assert.ok(!/complet|conclud|finish/i.test(result.anchor_type));
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
