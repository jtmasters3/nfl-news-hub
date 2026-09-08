#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2H-A regression suite. Fully offline,
// fully deterministic — no network, no live nflverse dependency, no
// production scoring import. Includes the required synthetic calibration
// matrix (scenarios A-O) and illustrative event-level examples (never
// calling scoreStory() itself — those numbers are computed by hand here
// against the real, unmodified Phase 1 event magnitudes for illustration
// only).
// Run with: node scripts/tests/editorial-player-importance-regression.mjs
import assert from "node:assert/strict";
import { computePlayerImportanceMultipliers, ROLE_MULTIPLIER_FLOOR, ROLE_MULTIPLIER_CEILING } from "../lib/editorialPlayerImportance.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function compute(overrides = {}) {
  return computePlayerImportanceMultipliers(overrides);
}

const STAR = { player_id: "00-9000001", identity_confidence: "high", star_matched: true };

// ---------------------------------------------------------------------------
// 1-13: mapping tables
// ---------------------------------------------------------------------------

test("1. non-player -> all neutral", () => {
  const r = compute({ has_player_subject: false, normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR });
  assert.equal(r.position_weight, 1.0);
  assert.equal(r.role_weight, 1.0);
  assert.equal(r.combined_role_multiplier, 1.0);
  assert.equal(r.star_boost, 1.0);
  assert.equal(r.combined_player_multiplier, 1.0);
  assert.ok(r.reason_codes.includes("non_player_neutral"));
});

test("2. starter elevated QB mapping", () => {
  const r = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(r.position_weight, 1.2);
});

test("3. backup elevated QB mapping", () => {
  const r = compute({ normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" });
  assert.equal(r.position_weight, 1.2);
});

test("4. fringe low QB mapping", () => {
  const r = compute({ normalized_position: "QB", effective_role: "fringe", qb_importance: "low" });
  assert.equal(r.position_weight, 0.95);
});

test("5. practice-squad low QB mapping", () => {
  const r = compute({ normalized_position: "QB", effective_role: "practice_squad", qb_importance: "low" });
  assert.equal(r.position_weight, 0.95);
});

test("6. unknown-role standard QB mapping", () => {
  const r = compute({ normalized_position: "QB", effective_role: "unknown", qb_importance: "standard" });
  assert.equal(r.position_weight, 1.1);
});

test("7. starter WR mapping", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" });
  assert.equal(r.position_weight, 1.05);
});

test("8. backup WR mapping", () => {
  const r = compute({ normalized_position: "WR", effective_role: "backup", qb_importance: "none" });
  assert.equal(r.position_weight, 1.05);
});

test("9. starter EDGE mapping", () => {
  const r = compute({ normalized_position: "EDGE", effective_role: "starter", qb_importance: "none" });
  assert.equal(r.position_weight, 1.05);
});

test("10. starter IOL mapping", () => {
  const r = compute({ normalized_position: "IOL", effective_role: "starter", qb_importance: "none" });
  assert.equal(r.position_weight, 0.95);
});

test("11. backup IOL mapping", () => {
  const r = compute({ normalized_position: "IOL", effective_role: "backup", qb_importance: "none" });
  assert.equal(r.position_weight, 0.95);
});

test("12. K/P/LS mapping", () => {
  assert.equal(compute({ normalized_position: "K", qb_importance: "none" }).position_weight, 0.9);
  assert.equal(compute({ normalized_position: "P", qb_importance: "none" }).position_weight, 0.88);
  assert.equal(compute({ normalized_position: "LS", qb_importance: "none" }).position_weight, 0.87);
});

test("13. unknown position mapping", () => {
  const r = compute({ normalized_position: "unknown", qb_importance: "none" });
  assert.equal(r.position_weight, 0.95);
});

// ---------------------------------------------------------------------------
// 14-19: role weight table
// ---------------------------------------------------------------------------
test("14. starter role weight", () => { assert.equal(compute({ effective_role: "starter" }).role_weight, 1.15); });
test("15. significant_rotation role weight", () => { assert.equal(compute({ effective_role: "significant_rotation" }).role_weight, 1.05); });
test("16. backup role weight", () => { assert.equal(compute({ effective_role: "backup" }).role_weight, 0.9); });
test("17. fringe role weight", () => { assert.equal(compute({ effective_role: "fringe" }).role_weight, 0.8); });
test("18. practice_squad role weight", () => { assert.equal(compute({ effective_role: "practice_squad" }).role_weight, 0.7); });
test("19. unknown role weight", () => { assert.equal(compute({ effective_role: "unknown" }).role_weight, 0.9); });

// ---------------------------------------------------------------------------
// 20-24: raw multiplier / floor / ceiling
// ---------------------------------------------------------------------------
test("20. raw role multiplier calculation", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" });
  assert.ok(Math.abs(r.raw_role_multiplier - 1.05 * 1.15) < 1e-9);
});

test("21. floor behavior (a genuinely low combination is floored, not left raw)", () => {
  const r = compute({ normalized_position: "LS", effective_role: "practice_squad", qb_importance: "none" });
  assert.ok(r.raw_role_multiplier < ROLE_MULTIPLIER_FLOOR, "the raw value must actually be below the floor for this to be a real test");
  assert.equal(r.combined_role_multiplier, ROLE_MULTIPLIER_FLOOR);
  assert.equal(r.diagnostics.role_multiplier_floor_applied, true);
});

test("22. ceiling behavior (starter elevated QB exceeds raw ceiling)", () => {
  const r = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.ok(r.raw_role_multiplier > ROLE_MULTIPLIER_CEILING, "the raw value must actually exceed the ceiling for this to be a real test");
  assert.equal(r.combined_role_multiplier, ROLE_MULTIPLIER_CEILING);
  assert.equal(r.diagnostics.role_multiplier_ceiling_applied, true);
});

test("23. floor is above zero and within the approved guardrail (0.65-0.75)", () => {
  assert.ok(ROLE_MULTIPLIER_FLOOR > 0);
  assert.ok(ROLE_MULTIPLIER_FLOOR >= 0.65 && ROLE_MULTIPLIER_FLOOR <= 0.75);
});

test("24. ceiling within the approved guardrail (1.30-1.40)", () => {
  assert.ok(ROLE_MULTIPLIER_CEILING >= 1.3 && ROLE_MULTIPLIER_CEILING <= 1.4);
});

// ---------------------------------------------------------------------------
// 25-31: star boost
// ---------------------------------------------------------------------------
test("25. none star = 1.0", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "none" });
  assert.equal(r.star_boost, 1.0);
});

test("26. notable star boost", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "notable" });
  assert.ok(r.star_boost > 1.0 && r.star_boost <= 1.15);
});

test("27. elite star boost", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" });
  assert.ok(r.star_boost > 1.0 && r.star_boost <= 1.25);
});

test("28. elite > notable > none", () => {
  const base = { normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR };
  const elite = compute({ ...base, star_level: "elite" }).star_boost;
  const notable = compute({ ...base, star_level: "notable" }).star_boost;
  const none = compute({ ...base, star_level: "none" }).star_boost;
  assert.ok(elite > notable && notable > none);
});

test("29. missing player_id blocks star boost", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", player_id: null, identity_confidence: "high", star_matched: true, star_level: "elite" });
  assert.equal(r.star_boost, 1.0);
  assert.ok(r.reason_codes.includes("star_boost_blocked_missing_identity"));
});

test("30. low/unresolved identity blocks star boost", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", player_id: "00-9000001", identity_confidence: "low", star_matched: true, star_level: "elite" });
  assert.equal(r.star_boost, 1.0);
  assert.ok(r.reason_codes.includes("star_boost_blocked_low_confidence"));
});

test("31. matched canonical elite permits boost", () => {
  const r = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" });
  assert.equal(r.diagnostics.star_gate_passed, true);
  assert.equal(r.diagnostics.star_boost_applied, true);
  assert.ok(r.star_boost > 1.0);
});

// ---------------------------------------------------------------------------
// 32-42: boundaries
// ---------------------------------------------------------------------------
test("32. fame/name/team irrelevant (not part of the input contract at all)", () => {
  const a = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", full_name: "Player One", team: "KC" });
  const b = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", full_name: "Player Two", team: "BUF" });
  assert.deepEqual(a, b);
});

test("33. combined player multiplier deterministic", () => {
  const input = { normalized_position: "EDGE", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" };
  const a = compute(input);
  const b = compute(input);
  assert.deepEqual(a, b);
});

test("34. no Date.now", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/editorialPlayerImportance.js", import.meta.url), "utf-8"));
  assert.equal(/Date\.now\s*\(/.test(src), false);
});

test("35. no network", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/editorialPlayerImportance.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(/.test(src), false);
});

test("36. no filesystem read", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/editorialPlayerImportance.js", import.meta.url), "utf-8"));
  assert.equal(/readFileSync|require\(['"]fs/.test(src), false);
});

test("37. no input mutation", () => {
  const input = Object.freeze({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.doesNotThrow(() => compute(input));
});

test("38. no PIPELINE production import — generate-content.js and the live news/social pipeline never import this module. (Phase 2H-B, separately authorized, wires it into editorialScoring.js's own dual-score calibration; editorialScoring.js itself remains non-load-bearing — see scripts/editorial/README.md — so this still holds the line that matters: nothing in the actual production pipeline consumes player-importance math yet.)", async () => {
  const content = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../generate-content.js", import.meta.url), "utf-8"));
  assert.equal(/editorialPlayerImportance/.test(content), false);
});

test("39. no Feed/Story threshold logic", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/editorialPlayerImportance.js", import.meta.url), "utf-8"));
  assert.equal(/FEED_THRESHOLD|STORY_THRESHOLD|feed_fit|story_fit/.test(src), false);
});

test("40. no game-performance logic", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/editorialPlayerImportance.js", import.meta.url), "utf-8"));
  assert.equal(/GAME_PERFORMANCE|touchdown|interception|yards\b/i.test(src), false);
});

test("41. non-player neutral even with garbage player fields", () => {
  const r = compute({ has_player_subject: false, normalized_position: "not-a-real-position", effective_role: 12345, qb_importance: "bogus", player_id: "x", identity_confidence: "high", star_matched: true, star_level: "elite" });
  assert.equal(r.combined_player_multiplier, 1.0);
});

test("42. unresolved player distinct from non-player", () => {
  const nonPlayer = compute({ has_player_subject: false });
  const unresolvedPlayer = compute({ has_player_subject: true, normalized_position: "unknown", effective_role: "unknown", qb_importance: "none" });
  assert.equal(nonPlayer.combined_role_multiplier, 1.0);
  assert.notEqual(unresolvedPlayer.combined_role_multiplier, 1.0, "an unresolved PLAYER must be distinguishable from a genuine non-player, even though both avoid catastrophic suppression");
});

// ---------------------------------------------------------------------------
// 43-53: relative ordering
// ---------------------------------------------------------------------------
test("43. starter QB > backup QB", () => {
  const starter = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" }).combined_role_multiplier;
  const backup = compute({ normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" }).combined_role_multiplier;
  assert.ok(starter > backup);
});

test("44. backup QB > fringe QB", () => {
  const backup = compute({ normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" }).combined_role_multiplier;
  const fringe = compute({ normalized_position: "QB", effective_role: "fringe", qb_importance: "low" }).combined_role_multiplier;
  assert.ok(backup > fringe);
});

test("45. starter WR > backup WR", () => {
  const starter = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" }).combined_role_multiplier;
  const backup = compute({ normalized_position: "WR", effective_role: "backup", qb_importance: "none" }).combined_role_multiplier;
  assert.ok(starter > backup);
});

test("46. elite starter WR > notable starter WR", () => {
  const base = { normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR };
  const elite = compute({ ...base, star_level: "elite" }).combined_player_multiplier;
  const notable = compute({ ...base, star_level: "notable" }).combined_player_multiplier;
  assert.ok(elite > notable);
});

test("47. notable starter WR > plain starter WR", () => {
  const base = { normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR };
  const notable = compute({ ...base, star_level: "notable" }).combined_player_multiplier;
  const plain = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" }).combined_player_multiplier;
  assert.ok(notable > plain);
});

test("48. elite starter EDGE > plain starter EDGE", () => {
  const elite = compute({ normalized_position: "EDGE", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" }).combined_player_multiplier;
  const plain = compute({ normalized_position: "EDGE", effective_role: "starter", qb_importance: "none" }).combined_player_multiplier;
  assert.ok(elite > plain);
});

test("49. starter IOL > backup IOL", () => {
  const starter = compute({ normalized_position: "IOL", effective_role: "starter", qb_importance: "none" }).combined_role_multiplier;
  const backup = compute({ normalized_position: "IOL", effective_role: "backup", qb_importance: "none" }).combined_role_multiplier;
  assert.ok(starter > backup);
});

test("50. practice-squad QB < ordinary starter WR", () => {
  const psQb = compute({ normalized_position: "QB", effective_role: "practice_squad", qb_importance: "low" }).combined_role_multiplier;
  const starterWr = compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" }).combined_role_multiplier;
  assert.ok(psQb < starterWr);
});

test("51. unknown-player multiplier protected by floor (never collapses toward catastrophic suppression)", () => {
  const r = compute({ normalized_position: "unknown", effective_role: "unknown", qb_importance: "none" });
  assert.ok(r.combined_role_multiplier >= ROLE_MULTIPLIER_FLOOR);
  assert.ok(r.combined_role_multiplier > 0.5, "an unresolved player must land well above a catastrophic-suppression range");
});

test("52. star boost alone cannot create an extreme multiplier", () => {
  const r = compute({ normalized_position: "LS", effective_role: "practice_squad", qb_importance: "none", ...STAR, star_level: "elite" });
  assert.ok(r.combined_player_multiplier < 1.0, "star boost on a floored low-importance combination must not manufacture a high multiplier out of a trivial role");
});

test("53. the highest plausible combination remains bounded/reasonable", () => {
  const r = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", ...STAR, star_level: "elite" });
  assert.equal(r.combined_role_multiplier, ROLE_MULTIPLIER_CEILING);
  const theoreticalMax = ROLE_MULTIPLIER_CEILING * 1.25; // star boost is itself guardrailed to <= ~1.25
  assert.ok(r.combined_player_multiplier <= theoreticalMax + 1e-9);
  assert.ok(r.combined_player_multiplier < 2.0, "the single highest realistic combination must stay well short of doubling the base event magnitude");
});

// ---------------------------------------------------------------------------
// 54-55
// ---------------------------------------------------------------------------
test("54. output contains component diagnostics", () => {
  const r = compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.ok("position_weight" in r);
  assert.ok("role_weight" in r);
  assert.ok("raw_role_multiplier" in r);
  assert.ok("combined_role_multiplier" in r);
  assert.ok("star_boost" in r);
  assert.ok("combined_player_multiplier" in r);
  assert.ok("diagnostics" in r);
  assert.ok("role_multiplier_floor_applied" in r.diagnostics);
  assert.ok("role_multiplier_ceiling_applied" in r.diagnostics);
});

test("55. reason codes deterministic", () => {
  const input = { normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" };
  const a = compute(input);
  const b = compute(input);
  assert.deepEqual(a.reason_codes, b.reason_codes);
});

// ---------------------------------------------------------------------------
// SYNTHETIC CALIBRATION MATRIX (A-O) — printed for the record, not just
// asserted individually (several individual assertions above already cover
// the ordering; this block is the single source of the full matrix).
// ---------------------------------------------------------------------------
test("Calibration matrix A-O prints and every ordering requirement holds simultaneously", () => {
  const scenarios = {
    A_starter_elevated_QB: compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" }),
    B_backup_elevated_QB: compute({ normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" }),
    C_fringe_low_QB: compute({ normalized_position: "QB", effective_role: "fringe", qb_importance: "low" }),
    D_practice_squad_low_QB: compute({ normalized_position: "QB", effective_role: "practice_squad", qb_importance: "low" }),
    E_starter_WR: compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" }),
    F_starter_WR_notable: compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "notable" }),
    G_starter_WR_elite: compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" }),
    H_backup_WR_elite: compute({ normalized_position: "WR", effective_role: "backup", qb_importance: "none", ...STAR, star_level: "elite" }),
    I_starter_EDGE_elite: compute({ normalized_position: "EDGE", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" }),
    J_starter_IOL: compute({ normalized_position: "IOL", effective_role: "starter", qb_importance: "none" }),
    K_backup_IOL: compute({ normalized_position: "IOL", effective_role: "backup", qb_importance: "none" }),
    L_starter_K: compute({ normalized_position: "K", effective_role: "starter", qb_importance: "none" }),
    M_unknown_unknown: compute({ normalized_position: "unknown", effective_role: "unknown", qb_importance: "none" }),
    N_missing_identity_elite: compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", player_id: null, identity_confidence: null, star_matched: true, star_level: "elite" }),
    O_elite_QB_starter: compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", ...STAR, star_level: "elite" }),
  };

  console.log("\n  --- Calibration matrix (combined_player_multiplier) ---");
  for (const [name, r] of Object.entries(scenarios)) {
    console.log(`  ${name.padEnd(30)} ${r.combined_player_multiplier.toFixed(4)}`);
  }
  console.log("  --------------------------------------------------------\n");

  assert.ok(scenarios.A_starter_elevated_QB.combined_player_multiplier > scenarios.B_backup_elevated_QB.combined_player_multiplier);
  assert.ok(scenarios.B_backup_elevated_QB.combined_player_multiplier > scenarios.C_fringe_low_QB.combined_player_multiplier);
  assert.ok(scenarios.E_starter_WR.combined_player_multiplier > scenarios.K_backup_IOL.combined_player_multiplier);
  assert.ok(scenarios.G_starter_WR_elite.combined_player_multiplier > scenarios.F_starter_WR_notable.combined_player_multiplier);
  assert.ok(scenarios.F_starter_WR_notable.combined_player_multiplier > scenarios.E_starter_WR.combined_player_multiplier);
  assert.ok(scenarios.I_starter_EDGE_elite.combined_player_multiplier > scenarios.J_starter_IOL.combined_player_multiplier);
  assert.ok(scenarios.J_starter_IOL.combined_player_multiplier > scenarios.K_backup_IOL.combined_player_multiplier);
  assert.ok(scenarios.D_practice_squad_low_QB.combined_player_multiplier < scenarios.E_starter_WR.combined_player_multiplier);
  assert.ok(scenarios.B_backup_elevated_QB.combined_player_multiplier >= scenarios.K_backup_IOL.combined_player_multiplier);
  assert.ok(scenarios.M_unknown_unknown.combined_player_multiplier > 0.5);
  assert.equal(scenarios.N_missing_identity_elite.star_boost, 1.0);
  assert.ok(scenarios.O_elite_QB_starter.combined_player_multiplier < 2.0);
});

// ---------------------------------------------------------------------------
// ILLUSTRATIVE EVENT-LEVEL CALIBRATION — using the real, unmodified Phase 1
// event magnitudes (editorialEventMagnitude.js), computed BY HAND here for
// illustration only. scoreStory() itself is never called or imported.
// ---------------------------------------------------------------------------
test("Event-level illustrative calibration (real Phase 1 magnitudes x this module's multipliers)", () => {
  const FEED_THRESHOLD = 55;
  const STORY_THRESHOLD = 25;
  function rung(name) {
    return name === "meets_feed" ? "Feed-scale" : "below Feed-scale";
  }

  const examples = [
    { label: "1. elite starter QB season-ending injury", magnitude: 70, mult: compute({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", ...STAR, star_level: "elite" }) },
    { label: "2. non-star backup QB limited injury", magnitude: 8, mult: compute({ normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" }) },
    { label: "3. non-star starter WR multi-week injury", magnitude: 40, mult: compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none" }) },
    { label: "4. elite starter WR multi-week injury", magnitude: 40, mult: compute({ normalized_position: "WR", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" }) },
    { label: "5. non-star backup IOL limited injury", magnitude: 8, mult: compute({ normalized_position: "IOL", effective_role: "backup", qb_importance: "none" }) },
    { label: "6. elite starter EDGE blockbuster transaction", magnitude: 65, mult: compute({ normalized_position: "EDGE", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "elite" }) },
    { label: "7. practice-squad QB practice-squad transaction", magnitude: 6, mult: compute({ normalized_position: "QB", effective_role: "practice_squad", qb_importance: "low" }) },
    { label: "8. unknown-player season-ending injury", magnitude: 70, mult: compute({ normalized_position: "unknown", effective_role: "unknown", qb_importance: "none" }) },
    { label: "9. notable starter K signing", magnitude: 30, mult: compute({ normalized_position: "K", effective_role: "starter", qb_importance: "none", ...STAR, star_level: "notable" }) },
    { label: "10. fringe QB depth-chart story", magnitude: 24, mult: compute({ normalized_position: "QB", effective_role: "fringe", qb_importance: "low" }) },
  ];

  console.log("\n  --- Illustrative event-level magnitude (never fed into scoreStory()) ---");
  for (const ex of examples) {
    const illustrative = ex.magnitude * ex.mult.combined_player_multiplier;
    const bucket = illustrative >= FEED_THRESHOLD ? "Feed-scale" : illustrative >= STORY_THRESHOLD ? "Story-scale" : "below Story";
    console.log(`  ${ex.label.padEnd(48)} ${ex.magnitude} x ${ex.mult.combined_player_multiplier.toFixed(4)} = ${illustrative.toFixed(2).padStart(7)}  (${bucket})`);
  }
  console.log("  --------------------------------------------------------------------------\n");

  // Guardrail checks matching the locked "important outcome guardrails" section.
  const [eliteQb, backupQbLimited, starterWr, eliteWr, backupIol, eliteEdge, psQbTxn, unknownSeasonEnding] = examples.map((e) => e.magnitude * e.mult.combined_player_multiplier);
  assert.ok(eliteQb >= FEED_THRESHOLD, "elite QB season-ending must remain clearly Feed-scale");
  assert.ok(backupQbLimited < STORY_THRESHOLD, "backup QB limited injury must remain low, likely Neither before bonuses");
  assert.ok(backupIol < STORY_THRESHOLD, "backup OL limited injury must remain low");
  assert.ok(unknownSeasonEnding >= FEED_THRESHOLD, "an unknown-player season-ending injury must remain important, not crushed");
  assert.ok(psQbTxn < STORY_THRESHOLD, "a practice-squad transaction must remain low");
  assert.ok(eliteEdge >= FEED_THRESHOLD, "an elite non-QB major transaction can still be Feed-scale");
  assert.ok(eliteWr > starterWr, "star boost must help, ordering-wise, without being asserted to single-handedly cross a threshold by itself");
  void rung;
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
