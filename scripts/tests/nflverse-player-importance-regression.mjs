#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2G (Part A) regression suite. Fully
// offline, fully deterministic — no network, no live nflverse dependency.
// Run with: node scripts/tests/nflverse-player-importance-regression.mjs
import assert from "node:assert/strict";
import { classifyQbImportance } from "../lib/nflversePlayerImportance.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("1. non-QB starter -> is_qb false / none", () => {
  const r = classifyQbImportance({ normalized_position: "WR", resolved_role: "starter" });
  assert.equal(r.is_qb, false);
  assert.equal(r.qb_importance, "none");
  assert.ok(r.reason_codes.includes("not_qb"));
});

test("2. non-QB backup -> none", () => {
  const r = classifyQbImportance({ normalized_position: "RB", resolved_role: "backup" });
  assert.equal(r.is_qb, false);
  assert.equal(r.qb_importance, "none");
});

test("3. QB starter -> elevated", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter" });
  assert.equal(r.is_qb, true);
  assert.equal(r.qb_importance, "elevated");
  assert.ok(r.reason_codes.includes("qb_role_elevated"));
});

test("4. QB backup -> elevated", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "backup" });
  assert.equal(r.qb_importance, "elevated");
});

test("5. QB significant_rotation -> elevated", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "significant_rotation" });
  assert.equal(r.qb_importance, "elevated");
});

test("6. QB fringe -> low", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "fringe" });
  assert.equal(r.qb_importance, "low");
  assert.ok(r.reason_codes.includes("qb_role_low"));
});

test("7. QB practice_squad -> low", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "practice_squad" });
  assert.equal(r.qb_importance, "low");
});

test("8. QB unknown -> standard", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "unknown" });
  assert.equal(r.qb_importance, "standard");
  assert.ok(r.reason_codes.includes("qb_role_unknown_standard"));
});

test("9. role input ordering / irrelevant extra fields do not matter", () => {
  const a = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter" });
  const b = classifyQbImportance({ resolved_role: "starter", normalized_position: "QB", extra_unused_field: 123 });
  assert.deepEqual(a, b);
});

test("10. fame/name does not affect QB class", () => {
  const a = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter", full_name: "Random Player" });
  const b = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter", full_name: "Famous Player" });
  assert.deepEqual(a, b);
});

test("11. team does not affect QB class", () => {
  const a = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter", team: "KC" });
  const b = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter", team: "BUF" });
  assert.deepEqual(a, b);
});

test("12. no numeric weight returned", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "starter" });
  for (const forbidden of ["qb_weight", "position_weight", "role_weight", "star_weight", "role_multiplier", "star_boost", "score"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, forbidden), false, `must never contain: ${forbidden}`);
  }
});

test("13. helper does not mutate input", () => {
  const input = Object.freeze({ normalized_position: "QB", resolved_role: "starter" });
  assert.doesNotThrow(() => classifyQbImportance(input));
});

test("14. no network/filesystem reads", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflversePlayerImportance.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(|readFileSync|require\(['"]fs/.test(src), false);
});

// ---------------------------------------------------------------------------
// Additional coverage
// ---------------------------------------------------------------------------

test("Additional: missing normalized_position -> not a QB", () => {
  const r = classifyQbImportance({ resolved_role: "starter" });
  assert.equal(r.is_qb, false);
  assert.equal(r.qb_importance, "none");
});

test("Additional: missing resolved_role for a QB -> standard (never guessed elevated/low)", () => {
  const r = classifyQbImportance({ normalized_position: "QB" });
  assert.equal(r.is_qb, true);
  assert.equal(r.qb_importance, "standard");
});

test("Additional: an unrecognized role value for a QB -> standard, never guessed", () => {
  const r = classifyQbImportance({ normalized_position: "QB", resolved_role: "some_future_role" });
  assert.equal(r.qb_importance, "standard");
});

test("Additional: only the 4 locked qb_importance values are ever returned", () => {
  const LOCKED = new Set(["elevated", "standard", "low", "none"]);
  for (const resolved_role of ["starter", "backup", "significant_rotation", "fringe", "practice_squad", "unknown", undefined]) {
    for (const normalized_position of ["QB", "WR", null]) {
      const r = classifyQbImportance({ normalized_position, resolved_role });
      assert.ok(LOCKED.has(r.qb_importance), `unexpected value: ${r.qb_importance}`);
    }
  }
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
