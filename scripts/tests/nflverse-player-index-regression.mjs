#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2B regression suite. Pure, offline —
// no network, no live nflverse dependency, no story resolution (that's
// Phase 2C, not built yet).
// Run with: node scripts/tests/nflverse-player-index-regression.mjs
import assert from "node:assert/strict";
import { normalizeName, deriveStatusBucket, buildPlayerIndex, lookupByName, indexFingerprint } from "../lib/nflversePlayerIndex.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function row(overrides = {}) {
  return {
    season: "2026",
    week: "1",
    team: "KC",
    position: "QB",
    depth_chart_position: "QB",
    status: "ACT",
    status_description_abbr: "A01",
    full_name: "Test Player",
    football_name: "Test",
    gsis_id: "00-0000001",
    espn_id: "1",
    ...overrides,
  };
}

function rosterCache(rows) {
  return { rows };
}

// ---------------------------------------------------------------------------
// 13-14: gsis_id / espn_id lookup
// ---------------------------------------------------------------------------

test("13. gsis_id lookup returns the exact indexed player", () => {
  const idx = buildPlayerIndex(rosterCache([row({ gsis_id: "00-0033873", full_name: "Patrick Mahomes" })]));
  assert.equal(idx.by_gsis_id.get("00-0033873").full_name, "Patrick Mahomes");
});

test("14. espn_id lookup returns the exact indexed player", () => {
  const idx = buildPlayerIndex(rosterCache([row({ espn_id: "3139477", full_name: "Patrick Mahomes" })]));
  assert.equal(idx.by_espn_id.get("3139477").full_name, "Patrick Mahomes");
});

// ---------------------------------------------------------------------------
// 15-16: full_name / football_name normalization indexing
// ---------------------------------------------------------------------------

test("15. A player is findable by their normalized full_name", () => {
  const idx = buildPlayerIndex(rosterCache([row({ full_name: "Aaron Rodgers", football_name: "Aaron" })]));
  const found = lookupByName(idx, "Aaron Rodgers");
  assert.equal(found.length, 1);
  assert.equal(found[0].full_name, "Aaron Rodgers");
});

test("16. A player is ALSO findable by their normalized football_name (commonly-used name)", () => {
  const idx = buildPlayerIndex(rosterCache([row({ full_name: "Jeffrey Jansen", football_name: "J.J. Jansen" })]));
  const found = lookupByName(idx, "J.J. Jansen");
  assert.equal(found.length, 1);
  assert.equal(found[0].full_name, "Jeffrey Jansen");
});

// ---------------------------------------------------------------------------
// 17-20: name-normalization edge cases
// ---------------------------------------------------------------------------

test("17. Jr./Sr./II/III suffixes are stripped as whole-word tokens", () => {
  assert.equal(normalizeName("Robert Griffin III"), "robert griffin");
  assert.equal(normalizeName("Odell Beckham Jr."), "odell beckham");
  assert.equal(normalizeName("Marvin Harrison Jr"), "marvin harrison");
});

test("18. Apostrophe names normalize consistently (Ja'Marr Chase)", () => {
  assert.equal(normalizeName("Ja'Marr Chase"), normalizeName("Ja’Marr Chase")); // straight vs curly apostrophe
  assert.equal(normalizeName("Ja'Marr Chase"), "jamarr chase");
});

test("19. Hyphenated names normalize consistently (Amon-Ra St. Brown)", () => {
  assert.equal(normalizeName("Amon-Ra St. Brown"), "amon ra st brown");
});

test("20. Accented names normalize to their unaccented form", () => {
  assert.equal(normalizeName("André Rison"), "andre rison");
});

// ---------------------------------------------------------------------------
// 21-22: duplicate normalized names — the Josh-Allen class of problem
// (synthetic names, not real players, per licensing/simplicity preference)
// ---------------------------------------------------------------------------

test("21. Two different players sharing a normalized name BOTH remain indexed as separate candidates", () => {
  const idx = buildPlayerIndex(
    rosterCache([
      row({ gsis_id: "00-1000001", espn_id: "111", full_name: "Jordan Carter", football_name: "Jordan", team: "BUF", position: "QB" }),
      row({ gsis_id: "00-1000002", espn_id: "222", full_name: "Jordan Carter", football_name: "Jordan", team: "JAX", position: "EDGE" }),
    ])
  );
  const found = lookupByName(idx, "Jordan Carter");
  assert.equal(found.length, 2, "the Josh-Allen-class case: two real distinct players must both remain in the index");
  const teams = found.map((p) => p.team).sort();
  assert.deepEqual(teams, ["BUF", "JAX"]);
});

test("22. Duplicate-name resolution is never silent — the index itself makes no choice between candidates", () => {
  const idx = buildPlayerIndex(
    rosterCache([
      row({ gsis_id: "00-1000001", full_name: "Jordan Carter", team: "BUF" }),
      row({ gsis_id: "00-1000002", full_name: "Jordan Carter", team: "JAX" }),
    ])
  );
  const found = lookupByName(idx, "Jordan Carter");
  // The index provides candidates; it never picks a "best" one. Any
  // resolution logic belongs to Phase 2C, not here.
  assert.equal(Array.isArray(found), true);
  assert.equal(found.length, 2);
  assert.equal(found[0].gsis_id !== found[1].gsis_id, true);
});

// ---------------------------------------------------------------------------
// 23: missing optional ID tolerated
// ---------------------------------------------------------------------------

test("23. A player missing espn_id is still fully indexed by gsis_id and name", () => {
  const idx = buildPlayerIndex(rosterCache([row({ gsis_id: "00-2000001", espn_id: "", full_name: "Sparse Player", football_name: "Sparse" })]));
  assert.equal(idx.by_gsis_id.get("00-2000001").full_name, "Sparse Player");
  assert.equal(idx.by_espn_id.has(""), false, "an empty espn_id must never be indexed as a real key");
  assert.equal(lookupByName(idx, "Sparse Player").length, 1);
});

// ---------------------------------------------------------------------------
// 24-25: raw status preserved, Practice Squad distinguishable from IR-type
// ---------------------------------------------------------------------------

test("24. Raw status and status_description_abbr are preserved verbatim on every indexed record", () => {
  const idx = buildPlayerIndex(rosterCache([row({ gsis_id: "00-3000001", status: "RES", status_description_abbr: "R01" })]));
  const p = idx.by_gsis_id.get("00-3000001");
  assert.equal(p.raw_status, "RES");
  assert.equal(p.raw_status_description_abbr, "R01");
});

test("25. Practice Squad (DEV) and Reserve/IR-type (RES) statuses are NEVER collapsed into the same bucket — the architecture correction", () => {
  const idx = buildPlayerIndex(
    rosterCache([
      row({ gsis_id: "00-4000001", status: "DEV", full_name: "Practice Squad Player" }),
      row({ gsis_id: "00-4000002", status: "RES", full_name: "Reserve Player" }),
    ])
  );
  assert.equal(idx.by_gsis_id.get("00-4000001").status_bucket, "practice_squad");
  assert.equal(idx.by_gsis_id.get("00-4000002").status_bucket, "reserve");
  assert.notEqual(idx.by_gsis_id.get("00-4000001").status_bucket, idx.by_gsis_id.get("00-4000002").status_bucket);
});

test("25b. deriveStatusBucket covers every real observed status value from live nflverse data, plus a safe unknown fallback", () => {
  assert.equal(deriveStatusBucket("ACT"), "active");
  assert.equal(deriveStatusBucket("DEV"), "practice_squad");
  assert.equal(deriveStatusBucket("RES"), "reserve");
  assert.equal(deriveStatusBucket("RET"), "retired");
  assert.equal(deriveStatusBucket("CUT"), "cut");
  assert.equal(deriveStatusBucket("EXE"), "exempt");
  assert.equal(deriveStatusBucket("INA"), "inactive");
  assert.equal(deriveStatusBucket("TRD"), "transitional");
  assert.equal(deriveStatusBucket("TRC"), "transitional");
  assert.equal(deriveStatusBucket("SOME_FUTURE_CODE"), "unknown");
});

test("25c. A starting QB placed on Reserve must NOT be reclassified as practice_squad or fringe by the status bucket alone", () => {
  const idx = buildPlayerIndex(rosterCache([row({ gsis_id: "00-5000001", status: "RES", position: "QB", full_name: "Starter On IR" })]));
  const p = idx.by_gsis_id.get("00-5000001");
  assert.equal(p.status_bucket, "reserve");
  assert.notEqual(p.status_bucket, "practice_squad");
  // "fringe" is a ROLE value (Phase 2E), not a status_bucket value at all —
  // this index never produces role, confirming the dimensions stay separate.
  assert.equal(p.role, undefined, "Phase 2B must never compute role — that is Phase 2E's job");
});

// ---------------------------------------------------------------------------
// 26: index deterministic regardless of input row ordering
// ---------------------------------------------------------------------------

test("26. The index is deterministic regardless of input row order", () => {
  const rows = [
    row({ gsis_id: "00-6000001", full_name: "Player One" }),
    row({ gsis_id: "00-6000002", full_name: "Player Two" }),
    row({ gsis_id: "00-6000003", full_name: "Player Three", espn_id: "3" }),
  ];
  const forward = buildPlayerIndex(rosterCache(rows));
  const reversed = buildPlayerIndex(rosterCache([...rows].reverse()));
  assert.equal(indexFingerprint(forward), indexFingerprint(reversed));
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
