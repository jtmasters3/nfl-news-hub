// Production NFL Data Infrastructure — Stage A: nflverse schedule cache
// fetch + validation. Sibling to scripts/lib/nflverseCache.js (Phase 2A,
// LOCKED) — NOT a modification of it. Phase 2A's cache schema
// ({schema_version, roster, depth_chart}) is locked; adding a third block
// to that same file would alter a locked schema, so schedule data gets its
// own independent cache file with its own schema_version, following this
// repository's established convention that each subsystem owns its own
// small persistence module (see nflverseCache.js's own header comment, and
// nflRelevanceShadow.js which follows the same precedent).
//
// Reuses nflverseCache.js's generic, already-exported, domain-agnostic
// helpers (parseCsv, computeIntegrityHash) rather than duplicating them —
// those are pure utilities, not "the locked cache," so reusing them is not
// a modification of Phase 2A. The read/write-atomic pair below is NOT
// reused from nflverseCache.js: readNflverseCache()/writeNflverseCacheAtomic()
// are hardcoded to Phase 2A's own CACHE_SCHEMA_VERSION/NFLVERSE_CACHE_PATH,
// and coupling this independent cache's validity to that unrelated schema
// version would be accidental coupling, not reuse.
//
// CANONICAL SOURCE — locked by Phase 2I, confirmed still current by a real
// fetch performed during this stage's investigation:
//   https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv
// This is ONE file covering every season since 1999 (7,549 rows as of this
// writing) — a genuinely different shape from roster/depth-chart's
// per-season URLs. Real columns confirmed by direct fetch: game_id, season,
// game_type, week, gameday, weekday, gametime, away_team, ... — exactly
// covering the season/week/game_type/gameday/gametime fields
// nflverseScheduleAsOf.js (Phase 2I, LOCKED) consumes, confirmed by reading
// that module's own JSDoc type for schedule_rows.
//
// CURRENT-SEASON FILTER — mirrors nflverseCache.js's own CURRENT vs
// HISTORICAL split (see that file's header comment): caching all ~7,500
// historical rows forever is unnecessary for live "as of" resolution, which
// only ever needs the season a given story could plausibly reference.
// Filtering to one season (~267-285 rows, confirmed by direct fetch across
// 2017-2026) keeps this cache small and bounded, exactly like the
// depth-chart snapshot filter does for its own dataset.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, computeIntegrityHash, defaultNflSeason } from "./nflverseCache.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NFLVERSE_SCHEDULE_CACHE_PATH = path.join(ROOT, "data", "nflverse-schedule-cache.json");

export const SCHEDULE_CACHE_SCHEMA_VERSION = 1;

export const SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";

// Schema-level checks only (column must exist in the header) — mirrors
// nflverseCache.js's ROSTER_REQUIRED_COLUMNS/DEPTH_CHART_REQUIRED_COLUMNS
// philosophy exactly. gametime may be blank per-row (confirmed in real data
// for early-history/some playoff rows) — nflverseScheduleAsOf.js's own type
// signature already documents gametime as optional per row; only the
// column's existence is required here.
export const SCHEDULE_REQUIRED_COLUMNS = ["season", "week", "game_type", "gameday", "gametime"];

// The smallest real season on file (2017-2019) has 267 rows; this floor sits
// safely below that while still catching a genuinely truncated/broken fetch.
const SCHEDULE_MIN_ROW_COUNT = 200;

function validateScheduleColumns(header) {
  return SCHEDULE_REQUIRED_COLUMNS.filter((col) => !header.includes(col));
}

export function validateSchedule({ header, rows }) {
  const errors = [];
  const missing = validateScheduleColumns(header);
  if (missing.length) errors.push(`missing required column(s): ${missing.join(", ")}`);
  if (rows.length < SCHEDULE_MIN_ROW_COUNT) errors.push(`row count ${rows.length} is below the plausibility floor (${SCHEDULE_MIN_ROW_COUNT})`);
  return { ok: errors.length === 0, errors };
}

/** Latest `gameday` among the filtered season's rows — deterministic, derived only from fetched data, never wall-clock. */
function newestScheduleGameday(rows) {
  let best = null;
  for (const r of rows) {
    if (!r.gameday) continue;
    if (!best || Date.parse(r.gameday) > Date.parse(best)) best = r.gameday;
  }
  return best;
}

/**
 * Fetches the canonical schedule file and filters to one season. No
 * row-count validation beyond schema columns until after filtering — the
 * full multi-season file is always large, so the plausibility floor only
 * makes sense applied to the single season actually being cached.
 */
export async function fetchAndValidateScheduleCsv({ season, fetchImpl = fetch } = {}) {
  const resolvedSeason = season ?? defaultNflSeason();
  const res = await fetchImpl(SCHEDULE_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${SCHEDULE_URL}: HTTP ${res.status}`);
  const text = await res.text();
  const { header, rows: allRows } = parseCsv(text);

  const missingColumns = validateScheduleColumns(header);
  if (missingColumns.length) throw new Error(`Validation failed for ${SCHEDULE_URL}: missing required column(s): ${missingColumns.join(", ")}`);

  const seasonRows = allRows.filter((r) => Number(r.season) === Number(resolvedSeason));
  const { ok, errors } = validateSchedule({ header, rows: seasonRows });
  if (!ok) throw new Error(`Validation failed for ${SCHEDULE_URL} (season ${resolvedSeason}): ${errors.join("; ")}`);

  return {
    fetched_at: new Date().toISOString(),
    source_as_of: newestScheduleGameday(seasonRows),
    source_url: SCHEDULE_URL,
    season: resolvedSeason,
    row_count: seasonRows.length,
    integrity_hash: computeIntegrityHash(seasonRows),
    rows: seasonRows,
  };
}

// ---------------------------------------------------------------------------
// Cache read/write — atomic, schema-version-checked, never trusts a corrupt
// or unversioned file. Independent implementation of the same pattern
// nflverseCache.js and nflRelevanceShadow.js each already use — see this
// file's header comment for why this is not reused directly.
// ---------------------------------------------------------------------------
export async function readScheduleCache(filePath = NFLVERSE_SCHEDULE_CACHE_PATH) {
  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt file on disk — treated exactly like "no cache", never trusted
  }
  if (parsed?.schema_version !== SCHEDULE_CACHE_SCHEMA_VERSION) return null;
  return parsed;
}

export async function writeScheduleCacheAtomic(cache, filePath = NFLVERSE_SCHEDULE_CACHE_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(cache, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Refreshes the schedule cache for one season. Malformed/invalid new data
 * never replaces the last-known-good cache — on failure, the previous
 * `schedule` value (if any) is carried forward unchanged, mirroring
 * refreshNflverseCache()'s own LKG philosophy exactly. The file is always
 * written atomically, exactly once, whether the fetch succeeded or not.
 *
 * @returns {{cache: object, schedule: {refreshed: boolean, error: string|null}}}
 */
export async function refreshScheduleCache({ season, fetchImpl = fetch, filePath = NFLVERSE_SCHEDULE_CACHE_PATH } = {}) {
  const resolvedSeason = season ?? defaultNflSeason();
  const existing = (await readScheduleCache(filePath)) ?? { schema_version: SCHEDULE_CACHE_SCHEMA_VERSION, schedule: null };

  const result = { schedule: { refreshed: false, error: null } };
  let schedule = existing.schedule;

  try {
    schedule = await fetchAndValidateScheduleCsv({ season: resolvedSeason, fetchImpl });
    result.schedule.refreshed = true;
  } catch (err) {
    result.schedule.error = err.message;
  }

  const cache = { schema_version: SCHEDULE_CACHE_SCHEMA_VERSION, schedule };
  await writeScheduleCacheAtomic(cache, filePath);
  return { cache, ...result };
}
