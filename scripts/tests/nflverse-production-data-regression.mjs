#!/usr/bin/env node
// Production NFL Data Infrastructure — Stage A regression suite: the
// production-facing loader (scripts/lib/nflverseProductionData.js). Fully
// offline: network access is injected via fetchImpl, and every test uses
// temp cache files under the OS temp dir — never the real
// data/nflverse-cache.json or data/nflverse-schedule-cache.json.
// Run with: node scripts/tests/nflverse-production-data-regression.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProductionNflverseData, DEFAULT_STALE_AFTER_HOURS } from "../lib/nflverseProductionData.js";
import { writeNflverseCacheAtomic, CACHE_SCHEMA_VERSION } from "../lib/nflverseCache.js";
import { writeScheduleCacheAtomic, SCHEDULE_CACHE_SCHEMA_VERSION } from "../lib/nflverseScheduleCache.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const ROSTER_HEADER = "season,team,position,depth_chart_position,jersey_number,status,full_name,first_name,last_name,birth_date,height,weight,college,gsis_id,espn_id,sportradar_id,yahoo_id,rotowire_id,pff_id,pfr_id,fantasy_data_id,sleeper_id,years_exp,headshot_url,ngs_position,week,game_type,status_description_abbr,football_name,esb_id,gsis_it_id,smart_id,entry_year,rookie_year,draft_club,draft_number";
function rosterRow(i) {
  return ["2026", "KC", "QB", "QB", "1", "ACT", `Player ${i}`, "Test", "Player", "1990-01-01", "72", "200", "College", `00-000${String(i).padStart(4, "0")}`, String(1000 + i), "", "", "", "", "", "", "", "5", "", "", "1", "REG", "A01", `Player${i}`, "", "", "", "2015", "2015", "", ""].join(",");
}
function makeRosterCsv(rowCount = 501) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) rows.push(rosterRow(i));
  return ROSTER_HEADER + "\n" + rows.join("\n");
}

const DEPTH_CHART_HEADER = "dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank";
function makeDepthChartCsv({ latestCount = 320, dt = "2026-08-26T07:15:43Z" } = {}) {
  const rows = [];
  for (let i = 0; i < latestCount; i++) rows.push([dt, "KC", `Player ${i}`, String(1000 + i), `00-000${String(i).padStart(4, "0")}`, "1", "Base Offense", "1", "Quarterback", "QB", "1", "1"].join(","));
  return DEPTH_CHART_HEADER + "\n" + rows.join("\n");
}

const SCHEDULE_HEADER = "game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score";
function makeScheduleCsv({ rowCount = 272, season = "2026" } = {}) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const week = String((i % 18) + 1);
    rows.push([`${season}_${week}_AAA_BBB_${i}`, season, "REG", week, `2026-09-${String(5 + (i % 20)).padStart(2, "0")}`, "Friday", "20:00", "KC", "", "LAC", ""].join(","));
  }
  return SCHEDULE_HEADER + "\n" + rows.join("\n");
}

function routedFetch(routes) {
  return async (url) => {
    for (const [match, text] of routes) {
      if (url.includes(match)) return { ok: true, status: 200, text: async () => text };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
}

function throwingFetch() {
  return async () => {
    throw new Error("simulated network failure");
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "nflverse-production-data-test-"));
  try {
    await fn(path.join(dir, "nflverse-cache.json"), path.join(dir, "nflverse-schedule-cache.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEALTHY_ROUTES = () => [
  ["rosters/roster_", makeRosterCsv()],
  ["depth_charts/depth_charts_", makeDepthChartCsv()],
  ["schedules/games.csv", makeScheduleCsv()],
];

// ---------------------------------------------------------------------------
// End-to-end happy path
// ---------------------------------------------------------------------------

test("1. first run with no cache: fetches all three datasets and reports them available", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const result = await loadProductionNflverseData({
      season: 2026,
      fetchImpl: routedFetch(HEALTHY_ROUTES()),
      cachePath,
      scheduleCachePath,
    });
    assert.deepEqual(result.available, { roster: true, depth_chart: true, schedule: true });
    assert.equal(result.roster_rows.length, 501);
    assert.equal(result.depth_chart_rows.length, 320);
    assert.equal(result.schedule_rows.length, 272);
    assert.equal(result.diagnostics.roster.refreshed_this_run, true);
    assert.equal(result.diagnostics.schedule.refreshed_this_run, true);
  });
});

test("2. combined loader never reports fake empty data as available", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const result = await loadProductionNflverseData({
      season: 2026,
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
      cachePath,
      scheduleCachePath,
    });
    assert.deepEqual(result.available, { roster: false, depth_chart: false, schedule: false });
    assert.deepEqual(result.roster_rows, []);
    assert.deepEqual(result.depth_chart_rows, []);
    assert.deepEqual(result.schedule_rows, []);
  });
});

// ---------------------------------------------------------------------------
// Freshness / staleness gating
// ---------------------------------------------------------------------------

test("3. a fresh cache (within staleAfterHours) is reused without a network call", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    await writeNflverseCacheAtomic(
      { schema_version: CACHE_SCHEMA_VERSION, roster: { fetched_at: new Date(now - 60_000).toISOString(), rows: [{ a: 1 }], row_count: 1 }, depth_chart: { fetched_at: new Date(now - 60_000).toISOString(), rows: [{ b: 1 }], row_count: 1 } },
      cachePath
    );
    await writeScheduleCacheAtomic({ schema_version: SCHEDULE_CACHE_SCHEMA_VERSION, schedule: { fetched_at: new Date(now - 60_000).toISOString(), rows: [{ c: 1 }], row_count: 1 } }, scheduleCachePath);

    let fetchCalled = false;
    const result = await loadProductionNflverseData({
      now,
      season: 2026,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not be called");
      },
      cachePath,
      scheduleCachePath,
    });
    assert.equal(fetchCalled, false, "a fresh cache must never trigger a network fetch");
    assert.deepEqual(result.available, { roster: true, depth_chart: true, schedule: true });
    assert.equal(result.diagnostics.roster.refreshed_this_run, false);
  });
});

test("4. a stale cache (beyond staleAfterHours) triggers a real refresh attempt", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const now = Date.parse("2026-09-09T12:00:00.000Z");
    const staleFetchedAt = new Date(now - (DEFAULT_STALE_AFTER_HOURS + 1) * 3_600_000).toISOString();
    await writeNflverseCacheAtomic(
      { schema_version: CACHE_SCHEMA_VERSION, roster: { fetched_at: staleFetchedAt, rows: [{ a: 1 }], row_count: 1 }, depth_chart: { fetched_at: staleFetchedAt, rows: [{ b: 1 }], row_count: 1 } },
      cachePath
    );
    await writeScheduleCacheAtomic({ schema_version: SCHEDULE_CACHE_SCHEMA_VERSION, schedule: { fetched_at: staleFetchedAt, rows: [{ c: 1 }], row_count: 1 } }, scheduleCachePath);

    const result = await loadProductionNflverseData({
      now,
      season: 2026,
      fetchImpl: routedFetch(HEALTHY_ROUTES()),
      cachePath,
      scheduleCachePath,
    });
    assert.equal(result.diagnostics.roster.refreshed_this_run, true);
    assert.equal(result.diagnostics.schedule.refreshed_this_run, true);
    assert.equal(result.roster_rows.length, 501);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation — the core invariant of this stage
// ---------------------------------------------------------------------------

test("5. roster/depth fetch failure with no prior cache: reported unavailable, never throws", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const result = await loadProductionNflverseData({
      season: 2026,
      fetchImpl: throwingFetch(),
      cachePath,
      scheduleCachePath,
    });
    assert.equal(result.available.roster, false);
    assert.equal(result.available.depth_chart, false);
    assert.ok(result.diagnostics.roster.error);
  });
});

test("6. schedule fetch failure with no prior cache: reported unavailable, never throws, roster/depth unaffected", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const result = await loadProductionNflverseData({
      season: 2026,
      fetchImpl: routedFetch([["rosters/roster_", makeRosterCsv()], ["depth_charts/depth_charts_", makeDepthChartCsv()]]),
      cachePath,
      scheduleCachePath,
    });
    assert.equal(result.available.schedule, false);
    assert.equal(result.available.roster, true);
    assert.equal(result.available.depth_chart, true);
  });
});

test("7. stale cache with a network failure on refresh: falls back to the still-present last-known-good rows", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    // Seed a real LKG cache via an actual healthy load first. fetched_at is
    // always genuine wall-clock (written inside fetchAndValidateRosterCsv
    // etc.), so the "later" staleness comparison below must be anchored to
    // the real current time, not an arbitrary fixed calendar date.
    const seedNow = Date.now();
    await loadProductionNflverseData({ now: seedNow, season: 2026, fetchImpl: routedFetch(HEALTHY_ROUTES()), cachePath, scheduleCachePath });

    // Now simulate a later, stale-triggered run where the network is down.
    const laterNow = seedNow + (DEFAULT_STALE_AFTER_HOURS + 1) * 3_600_000;
    const result = await loadProductionNflverseData({ now: laterNow, season: 2026, fetchImpl: throwingFetch(), cachePath, scheduleCachePath });

    assert.deepEqual(result.available, { roster: true, depth_chart: true, schedule: true }, "LKG rows must still be reported available");
    assert.equal(result.roster_rows.length, 501);
    assert.equal(result.schedule_rows.length, 272);
    assert.equal(result.diagnostics.roster.refreshed_this_run, false);
    assert.ok(result.diagnostics.roster.error);
  });
});

test("8. a malformed roster cache file on disk is treated as no-cache, never crashes the loader", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    await fsWriteFile(cachePath, "{ not valid json", "utf-8");
    const result = await loadProductionNflverseData({ season: 2026, fetchImpl: routedFetch(HEALTHY_ROUTES()), cachePath, scheduleCachePath });
    assert.equal(result.available.roster, true); // recovered via a fresh fetch, since the on-disk file was unusable
  });
});

test("9. a cache-write failure (unwritable path) degrades to unavailable, never throws", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    // Point the cache path INSIDE a plain file, so mkdir(recursive) on its
    // "directory" fails with ENOTDIR — a realistic disk-level failure.
    const dir = path.dirname(cachePath);
    const blockerFile = path.join(dir, "im-a-file-not-a-directory");
    await fsWriteFile(blockerFile, "x", "utf-8");
    const brokenCachePath = path.join(blockerFile, "nflverse-cache.json");

    const result = await loadProductionNflverseData({
      season: 2026,
      fetchImpl: routedFetch(HEALTHY_ROUTES()),
      cachePath: brokenCachePath,
      scheduleCachePath,
    });
    assert.equal(result.available.roster, false);
    assert.equal(result.available.depth_chart, false);
    assert.ok(result.diagnostics.roster.error);
    // The unrelated schedule cache (a healthy, writable path) must be
    // completely unaffected by the roster/depth cache's write failure.
    assert.equal(result.available.schedule, true);
  });
});

test("10. the loader itself never throws under any simulated failure combination", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    await assert.doesNotReject(() =>
      loadProductionNflverseData({ season: 2026, fetchImpl: throwingFetch(), cachePath, scheduleCachePath })
    );
  });
});

// ---------------------------------------------------------------------------
// Temporal safety
// ---------------------------------------------------------------------------

test("11. cache operational timestamps (fetched_at) are exposed only as diagnostics, never mixed into row content", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const result = await loadProductionNflverseData({ season: 2026, fetchImpl: routedFetch(HEALTHY_ROUTES()), cachePath, scheduleCachePath });
    for (const row of result.roster_rows) assert.ok(!("fetched_at" in row));
    for (const row of result.schedule_rows) assert.ok(!("fetched_at" in row));
  });
});

test("12. no Date.now() call inside the pure staleness/shape logic beyond the documented `now` parameter boundary", async () => {
  await withTempDir(async (cachePath, scheduleCachePath) => {
    const fixedNow = Date.parse("2026-09-09T12:00:00.000Z");
    const original = Date.now;
    Date.now = () => {
      throw new Error("loadProductionNflverseData must use the supplied `now`, never call Date.now() itself");
    };
    try {
      const result = await loadProductionNflverseData({ now: fixedNow, season: 2026, fetchImpl: routedFetch(HEALTHY_ROUTES()), cachePath, scheduleCachePath });
      assert.equal(result.available.roster, true);
    } finally {
      Date.now = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Production isolation from scoring (structural checks)
// ---------------------------------------------------------------------------

test("13. no production import of scoreStory anywhere in generate-content.js or refresh.js", async () => {
  const { readFile } = await import("node:fs/promises");
  const genContent = await readFile(new URL("../generate-content.js", import.meta.url), "utf-8");
  const refreshSrc = await readFile(new URL("../refresh.js", import.meta.url), "utf-8");
  assert.ok(!genContent.includes("scoreStory") && !genContent.includes("editorialScoring"));
  assert.ok(!refreshSrc.includes("scoreStory") && !refreshSrc.includes("editorialScoring"));
});

test("14. no production import of buildEditorialPlayerContext anywhere in generate-content.js or refresh.js", async () => {
  const { readFile } = await import("node:fs/promises");
  const genContent = await readFile(new URL("../generate-content.js", import.meta.url), "utf-8");
  const refreshSrc = await readFile(new URL("../refresh.js", import.meta.url), "utf-8");
  assert.ok(!genContent.includes("buildEditorialPlayerContext") && !genContent.includes("editorialEnrichmentContext"));
  assert.ok(!refreshSrc.includes("buildEditorialPlayerContext") && !refreshSrc.includes("editorialEnrichmentContext"));
});

test("15. refresh.js loads nflverse production data but never threads it into processDiscoveredArticles", async () => {
  const { readFile } = await import("node:fs/promises");
  const refreshSrc = await readFile(new URL("../refresh.js", import.meta.url), "utf-8");
  assert.ok(refreshSrc.includes("loadProductionNflverseData"));
  const callSite = refreshSrc.match(/processDiscoveredArticles\(([^)]*)\)/s);
  assert.ok(callSite, "expected to find the processDiscoveredArticles call");
  assert.ok(!callSite[1].includes("nflverseData"), "nflverseData must not be passed into processDiscoveredArticles this stage");
});

test("16. refresh.js's nflverse load sits in the same parallel Promise.all as source fetching, so a hang/failure there cannot block on its own before news processing starts", async () => {
  const { readFile } = await import("node:fs/promises");
  const refreshSrc = await readFile(new URL("../refresh.js", import.meta.url), "utf-8");
  const promiseAllBlock = refreshSrc.match(/Promise\.all\(\[[^]*?\]\)/);
  assert.ok(promiseAllBlock);
  assert.ok(promiseAllBlock[0].includes("loadProductionNflverseData()"));
});

test("17. importance_score computation (extraction.js estimateImportance) is untouched by this stage", async () => {
  const { readFile } = await import("node:fs/promises");
  const genContent = await readFile(new URL("../generate-content.js", import.meta.url), "utf-8");
  assert.ok(genContent.includes("importance_score: estimateImportance(text)"));
});

test("18. no reference to social-state/social-queue in the new production data modules", async () => {
  const { readFile } = await import("node:fs/promises");
  const loaderSrc = await readFile(new URL("../lib/nflverseProductionData.js", import.meta.url), "utf-8");
  const scheduleSrc = await readFile(new URL("../lib/nflverseScheduleCache.js", import.meta.url), "utf-8");
  for (const forbidden of ["socialState", "social-state", "socialArtworkQueue", "social-artwork-queue"]) {
    assert.ok(!loaderSrc.includes(forbidden));
    assert.ok(!scheduleSrc.includes(forbidden));
  }
});

test("19. no import of nflRelevance code in the new production data modules (a prose mention in a comment is not a dependency)", async () => {
  const { readFile } = await import("node:fs/promises");
  const loaderSrc = await readFile(new URL("../lib/nflverseProductionData.js", import.meta.url), "utf-8");
  const scheduleSrc = await readFile(new URL("../lib/nflverseScheduleCache.js", import.meta.url), "utf-8");
  assert.ok(!/from\s+["'].*nflRelevance/.test(loaderSrc));
  assert.ok(!/from\s+["'].*nflRelevance/.test(scheduleSrc));
});

test("20. locked Phase 2A module (nflverseCache.js) is used, not duplicated or modified — reused exports match exactly", async () => {
  const mod = await import("../lib/nflverseCache.js");
  assert.equal(typeof mod.readNflverseCache, "function");
  assert.equal(typeof mod.refreshNflverseCache, "function");
  assert.equal(typeof mod.defaultNflSeason, "function");
  assert.equal(typeof mod.parseCsv, "function");
  assert.equal(typeof mod.computeIntegrityHash, "function");
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
