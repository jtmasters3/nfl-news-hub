#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2A regression suite. Fully offline:
// network access is injected via fetchImpl, so this suite never depends on
// live nflverse availability. Uses a temp cache file under the OS temp dir,
// never data/nflverse-cache.json, so running tests can never clobber a real
// cache.
// Run with: node scripts/tests/nflverse-cache-regression.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile as wf } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCsv,
  validateRoster,
  validateDepthChart,
  computeIntegrityHash,
  selectLatestDepthChartSnapshot,
  readNflverseCache,
  writeNflverseCacheAtomic,
  refreshNflverseCache,
  fetchAndValidateRosterCsv,
  fetchAndValidateDepthChartCsv,
  fetchDepthChartSeasonHistory,
  defaultNflSeason,
  rosterUrl,
  depthChartUrl,
  weeklyRosterUrl,
  CACHE_SCHEMA_VERSION,
} from "../lib/nflverseCache.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly like the real fetched headers/columns confirmed
// during Phase 2 research (including depth_chart_position,
// status_description_abbr, espn_id, pos_slot — all present in the real
// schemas).
// ---------------------------------------------------------------------------
const ROSTER_HEADER = "season,team,position,depth_chart_position,jersey_number,status,full_name,first_name,last_name,birth_date,height,weight,college,gsis_id,espn_id,sportradar_id,yahoo_id,rotowire_id,pff_id,pfr_id,fantasy_data_id,sleeper_id,years_exp,headshot_url,ngs_position,week,game_type,status_description_abbr,football_name,esb_id,gsis_it_id,smart_id,entry_year,rookie_year,draft_club,draft_number";

function rosterRow({ season = "2026", team = "KC", position = "QB", depth_chart_position = "QB", status = "ACT", status_description_abbr = "A01", full_name = "Test Player", football_name = "Test", gsis_id = "00-0000001", espn_id = "1", week = "1" } = {}) {
  // Deliberately sparse on supplementary IDs (sportradar_id etc.) — real
  // data shows these are frequently empty even for rostered players.
  return [season, team, position, depth_chart_position, "1", status, full_name, "Test", "Player", "1990-01-01", "72", "200", "College", gsis_id, espn_id, "", "", "", "", "", "", "", "5", "https://example.test/img.jpg", "", week, "REG", status_description_abbr, football_name, "", "", "", "2015", "2015", "", ""].join(",");
}

function makeRosterCsv(rowCount = 501, overrides = {}) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push(rosterRow({ gsis_id: `00-000${String(i).padStart(4, "0")}`, espn_id: String(1000 + i), full_name: `Player ${i}`, football_name: `Player${i}`, ...overrides }));
  }
  return ROSTER_HEADER + "\n" + rows.join("\n");
}

const DEPTH_CHART_HEADER = "dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank";

function depthChartRow({ dt = "2026-08-26T07:15:43Z", team = "KC", player_name = "Test Player", espn_id = "1", gsis_id = "00-0000001", pos_abb = "QB", pos_slot = "1", pos_rank = "1" } = {}) {
  return [dt, team, player_name, espn_id, gsis_id, "1", "Base Offense", "1", "Quarterback", pos_abb, pos_slot, pos_rank].join(",");
}

// Real snapshot-mode validation now requires 300+ rows AT the latest dt —
// this default generates a realistic-shaped fixture: a smaller OLDER
// snapshot plus a larger LATEST snapshot, exactly like the real file.
function makeDepthChartCsv({ latestCount = 320, olderCount = 40, latestDt = "2026-08-26T07:15:43Z", olderDt = "2026-08-03T10:09:07Z" } = {}) {
  const rows = [];
  for (let i = 0; i < olderCount; i++) rows.push(depthChartRow({ dt: olderDt, gsis_id: `00-OLD${String(i).padStart(4, "0")}`, player_name: `Older Player ${i}` }));
  for (let i = 0; i < latestCount; i++) rows.push(depthChartRow({ dt: latestDt, gsis_id: `00-NEW${String(i).padStart(4, "0")}`, player_name: `Latest Player ${i}` }));
  return DEPTH_CHART_HEADER + "\n" + rows.join("\n");
}

function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, text: async () => text });
}

async function withTempCacheFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "nflverse-cache-test-"));
  const filePath = path.join(dir, "nflverse-cache.json");
  try {
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

test("parseCsv handles quoted fields containing commas (real nflverse headshot_url shape)", () => {
  const csv = 'a,b,c\n1,"quoted, with comma",3';
  const { header, rows } = parseCsv(csv);
  assert.deepEqual(header, ["a", "b", "c"]);
  assert.equal(rows[0].b, "quoted, with comma");
});

// ---------------------------------------------------------------------------
// 1-2: valid fixtures accepted
// ---------------------------------------------------------------------------

test("1. A valid roster fixture is accepted", () => {
  const { header, rows } = parseCsv(makeRosterCsv());
  const { ok, errors } = validateRoster({ header, rows });
  assert.equal(ok, true, errors.join("; "));
});

test("2. A valid depth-chart fixture is accepted (historical/full-season validator)", () => {
  const { header, rows } = parseCsv(makeDepthChartCsv());
  const { ok, errors } = validateDepthChart({ header, rows });
  assert.equal(ok, true, errors.join("; "));
});

// ---------------------------------------------------------------------------
// 3-4: missing required column rejected
// ---------------------------------------------------------------------------

test("3. A roster fixture missing a required column (gsis_id) is rejected", () => {
  const csv = makeRosterCsv().replace(",gsis_id,", ",not_gsis_id,");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateRoster({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("gsis_id")));
});

test("4. A depth-chart fixture missing a required column (pos_rank) is rejected", () => {
  const csv = makeDepthChartCsv().replace(",pos_rank", ",not_pos_rank");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateDepthChart({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("pos_rank")));
});

// ---------------------------------------------------------------------------
// 5: empty/malformed dataset rejected
// ---------------------------------------------------------------------------

test("5. An empty/near-empty roster dataset is rejected on row-count plausibility", () => {
  const { header, rows } = parseCsv(makeRosterCsv(3));
  const { ok, errors } = validateRoster({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("row count")));
});

// ---------------------------------------------------------------------------
// 6: optional sparse IDs do not reject a valid row
// ---------------------------------------------------------------------------

test("6. Sparse OPTIONAL supplementary IDs (sportradar_id, yahoo_id, pff_id, ...) never reject an otherwise-valid roster", () => {
  const { header, rows } = parseCsv(makeRosterCsv());
  assert.equal(rows[0].sportradar_id, "");
  assert.equal(rows[0].yahoo_id, "");
  assert.equal(rows[0].pff_id, "");
  const { ok } = validateRoster({ header, rows });
  assert.equal(ok, true);
});

// ---------------------------------------------------------------------------
// 7: deterministic integrity hash
// ---------------------------------------------------------------------------

test("7. Integrity hash is deterministic for identical row content", () => {
  const { rows: rowsA } = parseCsv(makeRosterCsv(501));
  const { rows: rowsB } = parseCsv(makeRosterCsv(501));
  assert.equal(computeIntegrityHash(rowsA), computeIntegrityHash(rowsB));
});

test("7b. Integrity hash changes when content changes", () => {
  const { rows: rowsA } = parseCsv(makeRosterCsv(501));
  const { rows: rowsB } = parseCsv(makeRosterCsv(502));
  assert.notEqual(computeIntegrityHash(rowsA), computeIntegrityHash(rowsB));
});

// ---------------------------------------------------------------------------
// 8: fetched_at and source_as_of remain distinct
// ---------------------------------------------------------------------------

test("8a. Roster fetch: fetched_at (our pull time) and source_as_of (upstream data currency) are distinct fields", async () => {
  const result = await fetchAndValidateRosterCsv({ season: 2026, fetchImpl: fakeFetch(makeRosterCsv(501, { season: "2026", week: "3" })) });
  assert.ok(result.fetched_at);
  assert.equal(result.source_as_of, "2026-W03");
  assert.notEqual(result.fetched_at, result.source_as_of);
});

test("8b. Depth-chart fetch (current mode): source_as_of equals the selected latest snapshot's dt, distinct from fetched_at", async () => {
  const result = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(makeDepthChartCsv({ latestDt: "2026-08-26T07:15:43Z" })) });
  assert.equal(result.source_as_of, "2026-08-26T07:15:43Z");
  assert.notEqual(result.fetched_at, result.source_as_of);
});

// ---------------------------------------------------------------------------
// CURRENT vs HISTORICAL split — new this pass
// ---------------------------------------------------------------------------

test("H1. Current depth-chart cache contains ONLY the latest dt snapshot", async () => {
  const result = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(makeDepthChartCsv({ latestCount: 320, olderCount: 40, latestDt: "2026-08-26T07:15:43Z", olderDt: "2026-08-03T10:09:07Z" })) });
  assert.equal(result.row_count, 320, "must contain exactly the latest-snapshot rows, not latest+older combined");
  assert.ok(result.rows.every((r) => r.dt === "2026-08-26T07:15:43Z"));
});

test("H2. Older dt snapshots are explicitly excluded from current-mode rows", async () => {
  const result = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(makeDepthChartCsv({ olderDt: "2026-08-03T10:09:07Z" })) });
  assert.equal(result.rows.some((r) => r.dt === "2026-08-03T10:09:07Z"), false);
});

test("H3. source_as_of exactly equals the selected latest dt (selectLatestDepthChartSnapshot, unit-level)", () => {
  const { rows } = parseCsv(makeDepthChartCsv({ latestDt: "2026-08-26T07:15:43Z", olderDt: "2026-08-03T10:09:07Z" }));
  const { dt, rows: filtered } = selectLatestDepthChartSnapshot(rows);
  assert.equal(dt, "2026-08-26T07:15:43Z");
  assert.equal(filtered.length, 320);
});

test("H4. The historical fetch path is separate and explicit — it returns the FULL season, never called by the current refresh flow", async () => {
  const csv = makeDepthChartCsv({ latestCount: 320, olderCount: 40 });
  const result = await fetchDepthChartSeasonHistory({ season: 2026, fetchImpl: fakeFetch(csv) });
  assert.equal(result.row_count, 360, "historical mode returns latest + older combined, unfiltered");
});

test("H5. The current cache (via refreshNflverseCache) never contains full-season depth-chart history", async () => {
  await withTempCacheFile(async (filePath) => {
    const csv = makeDepthChartCsv({ latestCount: 320, olderCount: 40 });
    const combinedFetch = async (url) => {
      if (url.includes("depth_charts")) return { ok: true, status: 200, text: async () => csv };
      return { ok: true, status: 200, text: async () => makeRosterCsv(501) };
    };
    const result = await refreshNflverseCache({ season: 2026, fetchImpl: combinedFetch, filePath });
    assert.equal(result.cache.depth_chart.row_count, 320, "must be the filtered current snapshot, not the 360-row full history");
  });
});

test("weeklyRosterUrl points at the separate historical release tag, not the current-season one", () => {
  assert.equal(weeklyRosterUrl(2025), "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2025.csv");
});

// ---------------------------------------------------------------------------
// Required-column additions from this hardening pass
// ---------------------------------------------------------------------------

test("6b. Missing depth_chart_position column rejects the roster dataset", () => {
  const csv = makeRosterCsv().replace(",depth_chart_position,", ",not_dcp,");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateRoster({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("depth_chart_position")));
});

test("6c. Missing status_description_abbr column rejects the roster dataset", () => {
  const csv = makeRosterCsv().replace(",status_description_abbr,", ",not_sda,");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateRoster({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("status_description_abbr")));
});

test("6d. Missing espn_id column rejects the roster dataset (present in the real fetched schema, so required)", () => {
  const csv = makeRosterCsv().replace(",espn_id,", ",not_espn,");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateRoster({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("espn_id")));
});

test("6e. Missing pos_slot column rejects the depth-chart dataset", () => {
  const csv = makeDepthChartCsv().replace(",pos_slot,", ",not_pos_slot,");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateDepthChart({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("pos_slot")));
});

test("6f. Missing espn_id column rejects the depth-chart dataset (present in the real fetched schema, so required)", () => {
  const csv = makeDepthChartCsv().replace(",espn_id,", ",not_espn,");
  const { header, rows } = parseCsv(csv);
  const { ok, errors } = validateDepthChart({ header, rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("espn_id")));
});

test("6g. A BLANK per-row depth_chart_position value is tolerated (column exists, individual value may be empty)", () => {
  const csv = makeRosterCsv(501, { depth_chart_position: "" });
  const { header, rows } = parseCsv(csv);
  const { ok } = validateRoster({ header, rows });
  assert.equal(ok, true);
  assert.equal(rows[0].depth_chart_position, "");
});

test("6h. A BLANK per-row status_description_abbr value is tolerated", () => {
  const csv = makeRosterCsv(501, { status_description_abbr: "" });
  const { header, rows } = parseCsv(csv);
  const { ok } = validateRoster({ header, rows });
  assert.equal(ok, true);
  assert.equal(rows[0].status_description_abbr, "");
});

test("6i. A BLANK per-row pos_slot value is tolerated when the column itself exists", () => {
  const csv = makeDepthChartCsv().replace(/,1,1$/gm, ",,1"); // blank out pos_slot on every row, keep pos_rank
  const { header, rows } = parseCsv(csv);
  const { ok } = validateDepthChart({ header, rows });
  assert.equal(ok, true);
});

// ---------------------------------------------------------------------------
// 9-10: malformed replacement / fetch failure preserves last-known-good
// ---------------------------------------------------------------------------

test("9. Malformed new roster data does NOT replace a last-known-good cache", async () => {
  await withTempCacheFile(async (filePath) => {
    const good = fakeFetch(makeRosterCsv(501));
    const first = await refreshNflverseCache({ season: 2026, fetchImpl: good, filePath });
    assert.equal(first.roster.refreshed, true);
    const goodHash = first.cache.roster.integrity_hash;

    const bad = fakeFetch(makeRosterCsv(2)); // too few rows -> fails validation
    const second = await refreshNflverseCache({ season: 2026, fetchImpl: bad, filePath });
    assert.equal(second.roster.refreshed, false);
    assert.ok(second.roster.error);
    assert.equal(second.cache.roster.integrity_hash, goodHash, "the last known-good roster block must be preserved unchanged");
  });
});

test("10. A fetch failure (HTTP error) preserves the last known-good cache", async () => {
  await withTempCacheFile(async (filePath) => {
    const good = fakeFetch(makeRosterCsv(501));
    const first = await refreshNflverseCache({ season: 2026, fetchImpl: good, filePath });
    const goodHash = first.cache.roster.integrity_hash;

    const failing = fakeFetch("", { ok: false, status: 503 });
    const second = await refreshNflverseCache({ season: 2026, fetchImpl: failing, filePath });
    assert.equal(second.roster.refreshed, false);
    assert.equal(second.cache.roster.integrity_hash, goodHash);
  });
});

test("10b. Roster and depth-chart blocks fail/succeed independently", async () => {
  await withTempCacheFile(async (filePath) => {
    const rosterOnly = async (url) => {
      if (url.includes("depth_charts")) return { ok: false, status: 503, text: async () => "" };
      return { ok: true, status: 200, text: async () => makeRosterCsv(501) };
    };
    const result = await refreshNflverseCache({ season: 2026, fetchImpl: rosterOnly, filePath });
    assert.equal(result.roster.refreshed, true);
    assert.equal(result.depth_chart.refreshed, false);
    assert.ok(result.cache.roster);
    assert.equal(result.cache.depth_chart, null, "no prior depth-chart data existed, so it stays null rather than being fabricated");
  });
});

// ---------------------------------------------------------------------------
// 11: atomic-write behavior
// ---------------------------------------------------------------------------

test("11. Cache write is atomic — no partial file is ever left on disk", async () => {
  await withTempCacheFile(async (filePath) => {
    const cache = { schema_version: CACHE_SCHEMA_VERSION, roster: { fetched_at: "t", source_as_of: "s", source_url: "u", row_count: 1, integrity_hash: "h", rows: [] }, depth_chart: null };
    await writeNflverseCacheAtomic(cache, filePath);
    const onDisk = JSON.parse(await readFile(filePath, "utf-8"));
    assert.equal(onDisk.schema_version, CACHE_SCHEMA_VERSION);
    const dirEntries = await readdir(path.dirname(filePath));
    assert.ok(!dirEntries.some((f) => f.includes(".tmp-")), "no leftover temp file");
  });
});

// ---------------------------------------------------------------------------
// 12: cache schema/version validation
// ---------------------------------------------------------------------------

test("12a. readNflverseCache returns null for a missing file (never throws)", async () => {
  await withTempCacheFile(async (filePath) => {
    const result = await readNflverseCache(filePath);
    assert.equal(result, null);
  });
});

test("12b. readNflverseCache returns null for a corrupt/unparseable file", async () => {
  await withTempCacheFile(async (filePath) => {
    await wf(filePath, "{ this is not valid json", "utf-8");
    const result = await readNflverseCache(filePath);
    assert.equal(result, null);
  });
});

test("12c. readNflverseCache rejects an unrecognized/mismatched schema_version", async () => {
  await withTempCacheFile(async (filePath) => {
    await writeNflverseCacheAtomic({ schema_version: 999, roster: null, depth_chart: null }, filePath);
    const result = await readNflverseCache(filePath);
    assert.equal(result, null, "a future/foreign schema version must never be trusted as current");
  });
});

// ---------------------------------------------------------------------------
// 14-15: current-cache hash / output determinism
// ---------------------------------------------------------------------------

test("14. Current-cache (post-filter) hash is deterministic across repeated fetches of identical data", async () => {
  const csv = makeDepthChartCsv();
  const a = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(csv) });
  const b = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(csv) });
  assert.equal(a.integrity_hash, b.integrity_hash);
});

test("15. Current-cache output is deterministic regardless of the SOURCE file's row ordering", async () => {
  const rowsA = [];
  const rowsB = [];
  for (let i = 0; i < 320; i++) {
    const r = depthChartRow({ dt: "2026-08-26T07:15:43Z", gsis_id: `00-NEW${String(i).padStart(4, "0")}`, player_name: `Latest Player ${i}` });
    rowsA.push(r);
    rowsB.unshift(r); // reversed order in the source CSV
  }
  const csvA = DEPTH_CHART_HEADER + "\n" + rowsA.join("\n");
  const csvB = DEPTH_CHART_HEADER + "\n" + rowsB.join("\n");
  const a = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(csvA) });
  const b = await fetchAndValidateDepthChartCsv({ season: 2026, fetchImpl: fakeFetch(csvB) });
  assert.equal(a.row_count, b.row_count);
  assert.equal(a.integrity_hash, b.integrity_hash, "identical row sets in different source order must hash identically");
});

// ---------------------------------------------------------------------------
// Supporting behavior
// ---------------------------------------------------------------------------

test("defaultNflSeason: flips to the new season around September, matching nflverse's own convention", () => {
  assert.equal(defaultNflSeason(new Date("2026-09-04T00:00:00Z")), 2026);
  assert.equal(defaultNflSeason(new Date("2026-03-01T00:00:00Z")), 2025);
});

test("rosterUrl/depthChartUrl produce the exact confirmed-working nflverse-data URL pattern", () => {
  assert.equal(rosterUrl(2026), "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv");
  assert.equal(depthChartUrl(2026), "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv");
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
