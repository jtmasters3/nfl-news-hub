#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2G (Part B) regression suite. Fully
// offline, fully deterministic — no network, no live nflverse dependency.
// All fixtures use invented synthetic gsis_ids/names, never real NFL
// player identities, per the locked "no real player calibration" rule.
// Run with: node scripts/tests/nflverse-star-registry-regression.mjs
import assert from "node:assert/strict";
import { validateStarRegistry, lookupPlayerStarStatus } from "../lib/nflverseStarRegistry.js";
import { classifyQbImportance } from "../lib/nflversePlayerImportance.js";
import { NFL_STAR_REGISTRY } from "../data/nfl-star-registry.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function record(overrides = {}) {
  return {
    gsis_id: "00-9000001",
    display_name: "Synthetic Player One",
    star_level: "elite",
    effective_from: "2026-01-01T00:00:00Z",
    effective_to: "2027-01-01T00:00:00Z",
    season: 2026,
    reason: "explicitly_reviewed_manual_classification",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// STAR LOOKUP (15-48)
// ---------------------------------------------------------------------------

test("15. missing gsis_id -> none", () => {
  const r = lookupPlayerStarStatus({ as_of: "2026-06-01T00:00:00Z", records: [record()] });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
  assert.ok(r.reason_codes.includes("canonical_gsis_missing"));
});

test("16. unknown gsis_id -> none", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-0000000", as_of: "2026-06-01T00:00:00Z", records: [record()] });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
  assert.ok(r.reason_codes.includes("star_record_not_found"));
});

test("17. elite record active at as_of -> elite", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ star_level: "elite" })] });
  assert.equal(r.star_level, "elite");
  assert.equal(r.matched, true);
});

test("18. notable record active at as_of -> notable", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ star_level: "notable" })] });
  assert.equal(r.star_level, "notable");
  assert.equal(r.matched, true);
});

test("19. before effective_from -> none", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2025-12-31T23:59:59Z", records: [record()] });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
});

test("20. after effective_to -> none", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2027-01-02T00:00:00Z", records: [record()] });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
});

test("21. exact lower boundary (as_of === effective_from) -> matched (half-open, inclusive lower bound)", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-01-01T00:00:00Z", records: [record()] });
  assert.equal(r.matched, true);
  assert.equal(r.star_level, "elite");
});

test("22. exact upper boundary (as_of === effective_to) -> NOT matched (half-open, exclusive upper bound)", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2027-01-01T00:00:00Z", records: [record()] });
  assert.equal(r.matched, false);
  assert.equal(r.star_level, "none");
});

test("23. missing as_of -> neutral/no match", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", records: [record()] });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
  assert.ok(r.reason_codes.includes("as_of_missing"));
});

test("24. invalid as_of -> neutral/no match", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "not-a-date", records: [record()] });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
  assert.ok(r.reason_codes.includes("as_of_invalid"));
});

test("25. name mismatch with same gsis_id does not matter (name is never part of matching)", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ display_name: "Totally Different Name" })] });
  assert.equal(r.matched, true);
  assert.equal(r.star_level, "elite");
});

test("26. same name with different gsis_id does not match", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000002", as_of: "2026-06-01T00:00:00Z", records: [record({ gsis_id: "00-9000001", display_name: "Same Name" })] });
  assert.equal(r.matched, false);
});

test("27. espn_id alone cannot match", () => {
  const r = lookupPlayerStarStatus({ gsis_id: undefined, as_of: "2026-06-01T00:00:00Z", records: [{ ...record(), espn_id: "12345" }] });
  assert.equal(r.matched, false);
  assert.equal(r.star_level, "none");
});

test("28. team cannot match", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [{ ...record(), team: "KC" }] });
  // team presence on the record has no bearing — matching is by gsis_id + interval only
  assert.equal(r.matched, true);
});

test("29. position cannot match (no position field is ever consulted)", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [{ ...record(), position: "QB" }] });
  assert.equal(r.matched, true);
  assert.equal(r.star_level, "elite");
});

test("30. future classification does not look backward", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2025-06-01T00:00:00Z", records: [record({ effective_from: "2026-09-01T00:00:00Z", effective_to: null })] });
  assert.equal(r.matched, false, "a classification starting 2026-09-01 must not apply on 2025-06-01");
});

test("31. expired classification does not leak forward", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ effective_from: "2024-01-01T00:00:00Z", effective_to: "2025-01-01T00:00:00Z" })] });
  assert.equal(r.matched, false);
});

test("32. 2025 notable + 2026 elite selects the correct record by as_of", () => {
  const records = [
    record({ gsis_id: "00-9000003", star_level: "notable", effective_from: "2025-01-01T00:00:00Z", effective_to: "2026-01-01T00:00:00Z" }),
    record({ gsis_id: "00-9000003", star_level: "elite", effective_from: "2026-01-01T00:00:00Z", effective_to: "2027-01-01T00:00:00Z" }),
  ];
  const r2025 = lookupPlayerStarStatus({ gsis_id: "00-9000003", as_of: "2025-06-01T00:00:00Z", records });
  const r2026 = lookupPlayerStarStatus({ gsis_id: "00-9000003", as_of: "2026-06-01T00:00:00Z", records });
  assert.equal(r2025.star_level, "notable");
  assert.equal(r2026.star_level, "elite");
});

test("33. input record ordering does not change the lookup", () => {
  const records = [
    record({ gsis_id: "00-9000003", star_level: "notable", effective_from: "2025-01-01T00:00:00Z", effective_to: "2026-01-01T00:00:00Z" }),
    record({ gsis_id: "00-9000003", star_level: "elite", effective_from: "2026-01-01T00:00:00Z", effective_to: "2027-01-01T00:00:00Z" }),
  ];
  const a = lookupPlayerStarStatus({ gsis_id: "00-9000003", as_of: "2026-06-01T00:00:00Z", records });
  const b = lookupPlayerStarStatus({ gsis_id: "00-9000003", as_of: "2026-06-01T00:00:00Z", records: [...records].reverse() });
  assert.deepEqual(a, b);
});

test("34. duplicate exact interval rejected", () => {
  const result = validateStarRegistry([record(), record()]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("duplicate_interval")));
});

test("35. overlapping intervals for the same gsis_id rejected", () => {
  const result = validateStarRegistry([
    record({ effective_from: "2026-01-01T00:00:00Z", effective_to: "2026-07-01T00:00:00Z" }),
    record({ effective_from: "2026-06-01T00:00:00Z", effective_to: "2027-01-01T00:00:00Z" }),
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("overlapping_interval")));
});

test("36. adjacent non-overlapping intervals accepted (half-open convention meets cleanly)", () => {
  const result = validateStarRegistry([
    record({ star_level: "notable", effective_from: "2025-01-01T00:00:00Z", effective_to: "2026-01-01T00:00:00Z" }),
    record({ star_level: "elite", effective_from: "2026-01-01T00:00:00Z", effective_to: "2027-01-01T00:00:00Z" }),
  ]);
  assert.equal(result.valid, true);
});

test("37. invalid star_level rejected", () => {
  const result = validateStarRegistry([record({ star_level: "superstar" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("invalid_star_level")));
});

test("38. missing gsis_id record rejected", () => {
  const result = validateStarRegistry([record({ gsis_id: undefined })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("missing_gsis_id")));
});

test("39. invalid effective_from rejected", () => {
  const result = validateStarRegistry([record({ effective_from: "not-a-date" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("invalid_effective_from")));
});

test("40. invalid effective_to rejected", () => {
  const result = validateStarRegistry([record({ effective_to: "not-a-date" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("invalid_effective_to")));
});

test("41. invalid interval ordering rejected (effective_to <= effective_from)", () => {
  const result = validateStarRegistry([record({ effective_from: "2026-06-01T00:00:00Z", effective_to: "2026-01-01T00:00:00Z" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("invalid_interval")));
});

test("42. malformed records container rejected", () => {
  const result = validateStarRegistry("not an array");
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("malformed_registry")));
});

test("42b. a malformed individual record (not an object) is rejected without crashing", () => {
  const result = validateStarRegistry([record(), "garbage", null]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.reason_codes.includes("malformed_record")));
});

test("43. lookup does not mutate records", () => {
  const records = Object.freeze([Object.freeze(record())]);
  assert.doesNotThrow(() => lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records }));
});

test("44. lookup performs no network", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseStarRegistry.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(/.test(src), false);
});

test("45. lookup performs no filesystem read", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseStarRegistry.js", import.meta.url), "utf-8"));
  assert.equal(/readFileSync|require\(['"]fs/.test(src), false);
});

test("46. result contains no numeric score/boost", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record()] });
  for (const forbidden of ["star_boost", "star_weight", "score", "multiplier"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, forbidden), false, `must never contain: ${forbidden}`);
  }
});

test("47. the empty production registry validates", () => {
  const result = validateStarRegistry(NFL_STAR_REGISTRY);
  assert.equal(result.valid, true);
  assert.deepEqual(NFL_STAR_REGISTRY, []);
});

test("48. the empty production registry returns none for an arbitrary real-shaped gsis_id", () => {
  const r = lookupPlayerStarStatus({ gsis_id: "00-0023459", as_of: "2026-09-01T00:00:00Z", records: NFL_STAR_REGISTRY });
  assert.equal(r.star_level, "none");
  assert.equal(r.matched, false);
});

// ---------------------------------------------------------------------------
// COMBINED SIGNAL TESTS (49-55) — no combined helper module; both pure
// functions are simply called side by side to prove they never interfere.
// ---------------------------------------------------------------------------

test("49. elite WR -> QB none + elite star (independent axes)", () => {
  const qb = classifyQbImportance({ normalized_position: "WR", resolved_role: "starter" });
  const star = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ star_level: "elite" })] });
  assert.equal(qb.is_qb, false);
  assert.equal(qb.qb_importance, "none");
  assert.equal(star.star_level, "elite");
});

test("50. non-star backup QB -> elevated QB + star none", () => {
  const qb = classifyQbImportance({ normalized_position: "QB", resolved_role: "backup" });
  const star = lookupPlayerStarStatus({ gsis_id: "00-9000099", as_of: "2026-06-01T00:00:00Z", records: [record()] });
  assert.equal(qb.qb_importance, "elevated");
  assert.equal(star.star_level, "none");
});

test("51. elite QB synthetic fixture -> elevated + elite", () => {
  const qb = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter" });
  const star = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ star_level: "elite" })] });
  assert.equal(qb.qb_importance, "elevated");
  assert.equal(star.star_level, "elite");
});

test("52. fringe elite QB synthetic fixture -> low QB class + elite star, independently", () => {
  const qb = classifyQbImportance({ normalized_position: "QB", resolved_role: "fringe" });
  const star = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ star_level: "elite" })] });
  assert.equal(qb.qb_importance, "low", "QB role classification must not be upgraded merely because the player is also elite");
  assert.equal(star.star_level, "elite", "star classification must not be affected by the QB's low role importance");
});

test("53. missing identity but QB normalized position -> QB metadata may exist, star none", () => {
  const qb = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter" });
  const star = lookupPlayerStarStatus({ gsis_id: null, as_of: "2026-06-01T00:00:00Z", records: [record()] });
  assert.equal(qb.is_qb, true);
  assert.equal(star.star_level, "none");
  assert.ok(star.reason_codes.includes("canonical_gsis_missing"));
});

test("54. star lookup does not alter role (the two functions never share or mutate common state)", () => {
  const before = record();
  lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [before] });
  const roleBefore = "starter";
  const qb = classifyQbImportance({ normalized_position: "QB", resolved_role: roleBefore });
  assert.equal(qb.qb_importance, "elevated");
  assert.deepEqual(before, record());
});

test("55. the QB helper does not alter star classification (calling it first changes nothing about a subsequent lookup)", () => {
  classifyQbImportance({ normalized_position: "QB", resolved_role: "fringe" });
  const star = lookupPlayerStarStatus({ gsis_id: "00-9000001", as_of: "2026-06-01T00:00:00Z", records: [record({ star_level: "notable" })] });
  assert.equal(star.star_level, "notable");
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
