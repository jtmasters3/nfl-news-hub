#!/usr/bin/env node
// Production NFL Data Infrastructure — Stage A regression suite: schedule
// cache. Fully offline: network access is injected via fetchImpl, so this
// suite never depends on live nflverse availability. Uses a temp cache file
// under the OS temp dir, never data/nflverse-schedule-cache.json, so running
// tests can never clobber a real cache.
// Run with: node scripts/tests/nflverse-schedule-cache-regression.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SCHEDULE_URL,
  SCHEDULE_REQUIRED_COLUMNS,
  validateSchedule,
  fetchAndValidateScheduleCsv,
  readScheduleCache,
  writeScheduleCacheAtomic,
  refreshScheduleCache,
  SCHEDULE_CACHE_SCHEMA_VERSION,
} from "../lib/nflverseScheduleCache.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const SCHEDULE_HEADER = "game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score";

function scheduleRow({ game_id = "2026_01_KC_LAC", season = "2026", game_type = "REG", week = "1", gameday = "2026-09-05", weekday = "Friday", gametime = "20:00" } = {}) {
  return [game_id, season, game_type, week, gameday, weekday, gametime, "KC", "", "LAC", ""].join(",");
}

// Real season sizes range 267-285 (confirmed by direct fetch across
// 2017-2026); default fixture size sits comfortably above the 200-row floor.
function makeScheduleCsv({ season = "2026", rowCount = 272, otherSeasonRows = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const week = String((i % 18) + 1);
    rows.push(scheduleRow({ game_id: `${season}_${week.padStart(2, "0")}_AAA_BBB_${i}`, season, week, gameday: `2026-09-${String(5 + (i % 20)).padStart(2, "0")}` }));
  }
  for (let i = 0; i < otherSeasonRows; i++) {
    rows.push(scheduleRow({ game_id: `2025_01_XXX_YYY_${i}`, season: "2025", gameday: "2025-09-05" }));
  }
  return SCHEDULE_HEADER + "\n" + rows.join("\n");
}

function fakeFetch(text, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, text: async () => text });
}

async function withTempCacheFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "nflverse-schedule-cache-test-"));
  const filePath = path.join(dir, "nflverse-schedule-cache.json");
  try {
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Canonical source
// ---------------------------------------------------------------------------

test("1. canonical schedule URL is exact", () => {
  assert.equal(SCHEDULE_URL, "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv");
});

test("2. required columns match what Phase 2I's schedule-as-of resolver consumes", () => {
  assert.deepEqual(SCHEDULE_REQUIRED_COLUMNS, ["season", "week", "game_type", "gameday", "gametime"]);
});

// ---------------------------------------------------------------------------
// validateSchedule
// ---------------------------------------------------------------------------

test("3. valid schedule (all required columns, sufficient rows) passes", () => {
  const { header, rows } = parseFixture(makeScheduleCsv());
  const { ok, errors } = validateSchedule({ header, rows });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("4. missing a required column fails validation", () => {
  const rows = [{ season: "2026", week: "1", game_type: "REG", gameday: "2026-09-05" }]; // no gametime column
  const { ok, errors } = validateSchedule({ header: ["season", "week", "game_type", "gameday"], rows });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("gametime")));
});

test("5. below the row-count floor fails validation", () => {
  const { header } = parseFixture(makeScheduleCsv());
  const { ok, errors } = validateSchedule({ header, rows: new Array(50).fill({ season: "2026", week: "1", game_type: "REG", gameday: "2026-09-05", gametime: "20:00" }) });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("plausibility floor")));
});

function parseFixture(csvText) {
  const [headerLine, ...lines] = csvText.split("\n");
  const header = headerLine.split(",");
  const rows = lines.map((line) => {
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i] ?? ""));
    return row;
  });
  return { header, rows };
}

// ---------------------------------------------------------------------------
// fetchAndValidateScheduleCsv — season filter, validation, shape
// ---------------------------------------------------------------------------

test("6. fetches, filters to the requested season, and returns the expected shape", async () => {
  const csv = makeScheduleCsv({ season: "2026", rowCount: 272, otherSeasonRows: 30 });
  const result = await fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(csv) });
  assert.equal(result.row_count, 272);
  assert.equal(result.season, 2026);
  assert.equal(result.source_url, "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv");
  assert.ok(result.rows.every((r) => Number(r.season) === 2026));
  assert.ok(result.fetched_at);
  assert.ok(result.source_as_of);
  assert.ok(result.integrity_hash);
});

test("7. source_as_of is the newest gameday among the filtered season's rows (deterministic, not wall-clock)", async () => {
  const csv = makeScheduleCsv({ season: "2026" });
  const result = await fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(csv) });
  const maxGameday = result.rows.reduce((max, r) => (!max || r.gameday > max ? r.gameday : max), null);
  assert.equal(result.source_as_of, maxGameday);
});

test("8. HTTP failure throws with a clear message", async () => {
  await assert.rejects(
    () => fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch("", { ok: false, status: 500 }) }),
    /HTTP 500/
  );
});

test("9. missing required column throws before season-filtering", async () => {
  const badCsv = "season,week\n2026,1";
  await assert.rejects(() => fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(badCsv) }), /missing required column/);
});

test("10. a season with too few rows after filtering throws (a genuinely truncated/broken fetch)", async () => {
  const csv = makeScheduleCsv({ season: "2026", rowCount: 50 });
  await assert.rejects(() => fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(csv) }), /plausibility floor/);
});

test("11. an empty response (zero rows) is rejected, never treated as a valid empty schedule", async () => {
  await assert.rejects(() => fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(SCHEDULE_HEADER) }), /plausibility floor/);
});

// ---------------------------------------------------------------------------
// Cache read/write — atomic, schema-checked, malformed-file recovery
// ---------------------------------------------------------------------------

test("12. readScheduleCache on a missing file returns null, never throws", async () => {
  await withTempCacheFile(async (filePath) => {
    const cache = await readScheduleCache(filePath);
    assert.equal(cache, null);
  });
});

test("13. readScheduleCache on a corrupt file safely recovers to null", async () => {
  await withTempCacheFile(async (filePath) => {
    await fsWriteFile(filePath, "{ not valid json", "utf-8");
    const cache = await readScheduleCache(filePath);
    assert.equal(cache, null);
  });
});

test("14. readScheduleCache on an unrecognized schema_version safely recovers to null", async () => {
  await withTempCacheFile(async (filePath) => {
    await fsWriteFile(filePath, JSON.stringify({ schema_version: 999, schedule: {} }), "utf-8");
    const cache = await readScheduleCache(filePath);
    assert.equal(cache, null);
  });
});

test("15. writeScheduleCacheAtomic + readScheduleCache round-trip", async () => {
  await withTempCacheFile(async (filePath) => {
    const cache = { schema_version: SCHEDULE_CACHE_SCHEMA_VERSION, schedule: { fetched_at: "2026-01-01T00:00:00.000Z", rows: [{ season: "2026" }] } };
    await writeScheduleCacheAtomic(cache, filePath);
    const readBack = await readScheduleCache(filePath);
    assert.deepEqual(readBack, cache);
  });
});

// ---------------------------------------------------------------------------
// refreshScheduleCache — last-known-good, failure isolation
// ---------------------------------------------------------------------------

test("16. a valid fetch populates the cache with refreshed=true", async () => {
  await withTempCacheFile(async (filePath) => {
    const csv = makeScheduleCsv({ season: "2026" });
    const result = await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(csv), filePath });
    assert.equal(result.schedule.refreshed, true);
    assert.equal(result.schedule.error, null);
    assert.equal(result.cache.schedule.row_count, 272);
  });
});

test("17. malformed CSV response does not replace a last-known-good cache", async () => {
  await withTempCacheFile(async (filePath) => {
    const goodCsv = makeScheduleCsv({ season: "2026" });
    const first = await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(goodCsv), filePath });
    const lkgRowCount = first.cache.schedule.row_count;

    const badCsv = "season,week\n2026,1"; // missing columns
    const second = await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(badCsv), filePath });
    assert.equal(second.schedule.refreshed, false);
    assert.ok(second.schedule.error);
    assert.equal(second.cache.schedule.row_count, lkgRowCount, "LKG data must be carried forward, never replaced by malformed data");
  });
});

test("18. an empty schedule response does not replace a last-known-good cache", async () => {
  await withTempCacheFile(async (filePath) => {
    const goodCsv = makeScheduleCsv({ season: "2026" });
    const first = await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(goodCsv), filePath });
    const lkgHash = first.cache.schedule.integrity_hash;

    const second = await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(SCHEDULE_HEADER), filePath });
    assert.equal(second.schedule.refreshed, false);
    assert.equal(second.cache.schedule.integrity_hash, lkgHash);
  });
});

test("19. a network exception does not replace a last-known-good cache, and is reported as an error, not thrown", async () => {
  await withTempCacheFile(async (filePath) => {
    const goodCsv = makeScheduleCsv({ season: "2026" });
    const first = await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(goodCsv), filePath });
    const lkgHash = first.cache.schedule.integrity_hash;

    const throwingFetch = async () => {
      throw new Error("simulated network failure");
    };
    const second = await refreshScheduleCache({ season: 2026, fetchImpl: throwingFetch, filePath });
    assert.equal(second.schedule.refreshed, false);
    assert.match(second.schedule.error, /simulated network failure/);
    assert.equal(second.cache.schedule.integrity_hash, lkgHash);
  });
});

test("20. first-ever run with a network failure and no prior cache leaves schedule null, but still writes a valid empty-shell cache file", async () => {
  await withTempCacheFile(async (filePath) => {
    const throwingFetch = async () => {
      throw new Error("simulated network failure");
    };
    const result = await refreshScheduleCache({ season: 2026, fetchImpl: throwingFetch, filePath });
    assert.equal(result.schedule.refreshed, false);
    assert.equal(result.cache.schedule, null);
    const readBack = await readScheduleCache(filePath);
    assert.equal(readBack.schedule, null);
  });
});

test("21. the cache file is always written exactly once per call, whether the fetch succeeded or failed", async () => {
  await withTempCacheFile(async (filePath) => {
    const csv = makeScheduleCsv({ season: "2026" });
    await refreshScheduleCache({ season: 2026, fetchImpl: fakeFetch(csv), filePath });
    const afterSuccess = await readScheduleCache(filePath);
    assert.ok(afterSuccess.schedule);

    const throwingFetch = async () => {
      throw new Error("boom");
    };
    await refreshScheduleCache({ season: 2026, fetchImpl: throwingFetch, filePath });
    const afterFailure = await readScheduleCache(filePath);
    assert.deepEqual(afterFailure, afterSuccess, "LKG cache content unchanged after a failed refresh attempt");
  });
});

test("22. deterministic: same CSV input produces an identical integrity_hash across separate fetches", async () => {
  const csv = makeScheduleCsv({ season: "2026" });
  const a = await fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(csv) });
  const b = await fetchAndValidateScheduleCsv({ season: 2026, fetchImpl: fakeFetch(csv) });
  assert.equal(a.integrity_hash, b.integrity_hash);
});

test("23. no Date.now dependency in schedule validation/filtering logic (fetched_at is the only wall-clock touchpoint)", async () => {
  const csv = makeScheduleCsv({ season: "2026" });
  const { header, rows } = parseFixture(csv);
  const original = Date.now;
  Date.now = () => {
    throw new Error("validateSchedule must never call Date.now()");
  };
  try {
    const { ok } = validateSchedule({ header, rows });
    assert.equal(ok, true);
  } finally {
    Date.now = original;
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
