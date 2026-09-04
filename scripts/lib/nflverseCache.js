// Editorial Scoring Brain — Phase 2A: nflverse roster/depth-chart cache
// fetch + validation. Pure and testable — network access is fully
// injectable (fetchImpl), so the automated test suite never depends on
// live nflverse availability. No cloud scheduling here; this module is
// only the fetch/validate/cache-read/cache-write mechanics themselves.
//
// Data source: nflverse-data (https://github.com/nflverse/nflverse-data),
// code MIT-licensed, data CC-BY 4.0 (commercial use permitted, attribution
// required — see scripts/nflverse/README.md). The underlying NFL data
// remains subject to the NFL's own terms.
//
// CURRENT vs. HISTORICAL — a hard architectural split, added after a live
// demonstration showed the naive "cache the whole season file" approach
// produces a ~182MB cache (nflverse's depth-chart file accumulates every
// snapshot for the season, not just the latest — confirmed empirically:
// 496,713 rows across 168 distinct snapshots for the current season alone).
// CURRENT scoring only ever needs the LATEST snapshot (2,189 rows) — the
// full history is HISTORICAL data, fetched only by explicitly-named
// functions this module's normal refresh path never calls. See
// fetchDepthChartSeasonHistory / weeklyRosterUrl below.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NFLVERSE_CACHE_PATH = path.join(ROOT, "data", "nflverse-cache.json");

export const CACHE_SCHEMA_VERSION = 1;

const NFLVERSE_DATA_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

// ---------------------------------------------------------------------------
// Season default — nflverse's own convention (per nflreadr) flips to the new
// season around Labor Day; this is a documented approximation, not a claim
// of precision, and is always overridable via an explicit `season` argument.
// ---------------------------------------------------------------------------
export function defaultNflSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed; 8 = September
  return month >= 8 ? year : year - 1;
}

export function rosterUrl(season) {
  return `${NFLVERSE_DATA_BASE}/rosters/roster_${season}.csv`;
}
export function depthChartUrl(season) {
  return `${NFLVERSE_DATA_BASE}/depth_charts/depth_charts_${season}.csv`;
}
// Historical path (Phase 2I, not called anywhere in this module today) —
// true per-week roster snapshots, a completely separate nflverse release
// tag from the season-level "current" file above.
export function weeklyRosterUrl(season) {
  return `${NFLVERSE_DATA_BASE}/weekly_rosters/roster_weekly_${season}.csv`;
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free CSV parser — handles quoted fields (nflverse's
// own headshot_url column embeds commas inside quotes), which a naive
// String.split(",") does not. No external dependency needed for this.
// ---------------------------------------------------------------------------
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };

  function parseLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (c === "," && !inQuotes) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  const header = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cols[c] ?? "";
    rows.push(row);
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------
// Validation — required columns are SCHEMA-level checks only (the column
// must exist in the header); individual rows may still have a blank value
// for any of these, which is normal and tolerated (e.g. a long-snapper with
// no espn_id on file). Optional supplementary ID columns not consumed
// anywhere in this project (sportradar_id, yahoo_id, rotowire_id, pff_id,
// pfr_id, fantasy_data_id, sleeper_id, esb_id, ...) are never required.
//
// depth_chart_position, status_description_abbr, pos_slot, and espn_id were
// added after the locked Phase 2 architecture review confirmed each is
// actually consumed by a specific, already-locked downstream design:
// depth_chart_position/pos_abb by Phase 2D's position mapping,
// status_description_abbr by the status-preservation architecture, pos_slot
// by Phase 2E's "rank is interpreted within a slot" role model, and espn_id
// (confirmed present in BOTH real fetched schemas) as the locked secondary
// cross-reference ID.
// ---------------------------------------------------------------------------
export const ROSTER_REQUIRED_COLUMNS = ["season", "week", "team", "position", "depth_chart_position", "status", "status_description_abbr", "full_name", "football_name", "gsis_id", "espn_id"];
export const DEPTH_CHART_REQUIRED_COLUMNS = ["dt", "team", "player_name", "gsis_id", "espn_id", "pos_abb", "pos_slot", "pos_rank"];

const ROSTER_MIN_ROW_COUNT = 500; // real files run 1500-3000+ rows; this only catches a genuinely broken/truncated fetch
// A single depth-chart SNAPSHOT (current mode, post-filter) — real data: 2,189 rows for the latest snapshot.
const DEPTH_CHART_SNAPSHOT_MIN_ROW_COUNT = 300;
// The FULL season file (historical mode, pre-filter) — may legitimately be small very early in a season.
const DEPTH_CHART_SEASON_MIN_ROW_COUNT = 10;

function validateColumns(header, required) {
  return required.filter((col) => !header.includes(col));
}

export function validateRoster({ header, rows }) {
  const errors = [];
  const missing = validateColumns(header, ROSTER_REQUIRED_COLUMNS);
  if (missing.length) errors.push(`missing required column(s): ${missing.join(", ")}`);
  if (rows.length < ROSTER_MIN_ROW_COUNT) errors.push(`row count ${rows.length} is below the plausibility floor (${ROSTER_MIN_ROW_COUNT})`);
  return { ok: errors.length === 0, errors };
}

/** Column-existence check only — used for both the full-season (historical) and post-filter (current) row-count checks, which use different floors. */
function validateDepthChartColumns(header) {
  return validateColumns(header, DEPTH_CHART_REQUIRED_COLUMNS);
}

export function validateDepthChart({ header, rows }) {
  const errors = [];
  const missing = validateDepthChartColumns(header);
  if (missing.length) errors.push(`missing required column(s): ${missing.join(", ")}`);
  if (rows.length < DEPTH_CHART_SEASON_MIN_ROW_COUNT) errors.push(`row count ${rows.length} is below the plausibility floor (${DEPTH_CHART_SEASON_MIN_ROW_COUNT})`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Integrity hash — deterministic regardless of row ORDER (rows are
// serialized individually and sorted before hashing), so the same
// underlying dataset always hashes identically even if the source CSV
// happened to list the same rows in a different order. Still fully
// sensitive to actual content changes.
// ---------------------------------------------------------------------------
export function computeIntegrityHash(rows) {
  const hash = createHash("sha256");
  const serializedSorted = rows.map((r) => JSON.stringify(r)).sort();
  hash.update(JSON.stringify(serializedSorted));
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Latest-snapshot selection — the core of the current/historical split for
// depth-chart data. Pure function: given ALL rows from the season file,
// find the newest `dt` and return only the rows carrying that exact value.
// ---------------------------------------------------------------------------
export function selectLatestDepthChartSnapshot(rows) {
  let latestDt = null;
  for (const r of rows) {
    if (!r.dt) continue;
    if (!latestDt || Date.parse(r.dt) > Date.parse(latestDt)) latestDt = r.dt;
  }
  if (!latestDt) return { dt: null, rows: [] };
  return { dt: latestDt, rows: rows.filter((r) => r.dt === latestDt) };
}

function newestRosterWeek(rows) {
  let best = null;
  for (const r of rows) {
    const season = Number(r.season);
    const week = Number(r.week);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    if (!best || season > best.season || (season === best.season && week > best.week)) best = { season, week };
  }
  return best ? `${best.season}-W${String(best.week).padStart(2, "0")}` : null;
}

// ---------------------------------------------------------------------------
// Raw fetch helpers — no filtering, no row-count validation beyond schema
// columns. Internal building blocks for both the CURRENT and HISTORICAL
// paths below, so the actual HTTP fetch + CSV parse is never duplicated.
// ---------------------------------------------------------------------------
async function fetchCsv(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}

// ---------------------------------------------------------------------------
// CURRENT path — what refreshNflverseCache() actually calls. Roster is
// already a "current" file at the source (nflverse's own season-level
// roster_<season>.csv is a live-updated snapshot, not an accumulating log —
// confirmed empirically: every row shares the same, latest week). Depth
// chart is NOT — it accumulates every snapshot for the season, so current
// mode explicitly filters to the latest `dt` before this function returns.
// ---------------------------------------------------------------------------
export async function fetchAndValidateRosterCsv({ season, fetchImpl = fetch } = {}) {
  const url = rosterUrl(season);
  const { header, rows } = await fetchCsv(url, fetchImpl);
  const { ok, errors } = validateRoster({ header, rows });
  if (!ok) throw new Error(`Validation failed for ${url}: ${errors.join("; ")}`);
  return {
    fetched_at: new Date().toISOString(),
    // The roster dataset carries no single "as of" timestamp of its own —
    // its own currency is best represented by the season/week values
    // actually present in the fetched rows (the newest week seen).
    source_as_of: newestRosterWeek(rows),
    source_url: url,
    row_count: rows.length,
    integrity_hash: computeIntegrityHash(rows),
    rows,
  };
}

export async function fetchAndValidateDepthChartCsv({ season, fetchImpl = fetch } = {}) {
  const url = depthChartUrl(season);
  const { header, rows: allRows } = await fetchCsv(url, fetchImpl);

  const missingColumns = validateDepthChartColumns(header);
  if (missingColumns.length) throw new Error(`Validation failed for ${url}: missing required column(s): ${missingColumns.join(", ")}`);

  const { dt, rows } = selectLatestDepthChartSnapshot(allRows);
  if (rows.length < DEPTH_CHART_SNAPSHOT_MIN_ROW_COUNT) {
    throw new Error(`Validation failed for ${url}: latest-snapshot row count ${rows.length} is below the plausibility floor (${DEPTH_CHART_SNAPSHOT_MIN_ROW_COUNT})`);
  }

  return {
    fetched_at: new Date().toISOString(),
    // Exactly the selected snapshot's own dt — every row in `rows` shares
    // this value by construction.
    source_as_of: dt,
    source_url: url,
    row_count: rows.length,
    integrity_hash: computeIntegrityHash(rows),
    rows,
  };
}

// ---------------------------------------------------------------------------
// HISTORICAL path — explicit, separate, NOT called by refreshNflverseCache
// or anything else in this module's normal flow. Reserved for Phase 2I.
// Returns the FULL, unfiltered season file — deliberately not written into
// the small "current" cache. weeklyRosterUrl (above) is the roster-side
// equivalent — a genuinely different nflverse release, not a filter over
// the current one.
// ---------------------------------------------------------------------------
export async function fetchDepthChartSeasonHistory({ season, fetchImpl = fetch } = {}) {
  const url = depthChartUrl(season);
  const { header, rows } = await fetchCsv(url, fetchImpl);
  const { ok, errors } = validateDepthChart({ header, rows });
  if (!ok) throw new Error(`Validation failed for ${url}: ${errors.join("; ")}`);
  return {
    fetched_at: new Date().toISOString(),
    source_as_of: selectLatestDepthChartSnapshot(rows).dt,
    source_url: url,
    row_count: rows.length,
    integrity_hash: computeIntegrityHash(rows),
    rows, // the FULL season history — every snapshot, not just the latest
  };
}

// ---------------------------------------------------------------------------
// Cache read/write — atomic, schema-version-checked, never trusts a corrupt
// or unversioned file.
// ---------------------------------------------------------------------------
export async function readNflverseCache(filePath = NFLVERSE_CACHE_PATH) {
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
  if (parsed?.schema_version !== CACHE_SCHEMA_VERSION) return null;
  return parsed;
}

export async function writeNflverseCacheAtomic(cache, filePath = NFLVERSE_CACHE_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(cache, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Refreshes the CURRENT cache only (never historical), one block at a time,
 * each with independent success/failure handling — a roster fetch failure
 * never blocks a successful depth-chart update, and vice versa. Malformed
 * new data for a block never replaces that block's last known-good data;
 * it's simply skipped, and the previous value (if any) is carried forward.
 * The file itself is always written atomically, exactly once, whether zero,
 * one, or both blocks actually changed this run.
 *
 * @returns {{cache: object, roster: {refreshed: boolean, error: string|null}, depth_chart: {refreshed: boolean, error: string|null}}}
 */
export async function refreshNflverseCache({ season, fetchImpl = fetch, filePath = NFLVERSE_CACHE_PATH } = {}) {
  const resolvedSeason = season ?? defaultNflSeason();
  const existing = (await readNflverseCache(filePath)) ?? { schema_version: CACHE_SCHEMA_VERSION, roster: null, depth_chart: null };

  const result = { roster: { refreshed: false, error: null }, depth_chart: { refreshed: false, error: null } };
  let roster = existing.roster;
  let depthChart = existing.depth_chart;

  try {
    roster = await fetchAndValidateRosterCsv({ season: resolvedSeason, fetchImpl });
    result.roster.refreshed = true;
  } catch (err) {
    result.roster.error = err.message;
  }

  try {
    depthChart = await fetchAndValidateDepthChartCsv({ season: resolvedSeason, fetchImpl });
    result.depth_chart.refreshed = true;
  } catch (err) {
    result.depth_chart.error = err.message;
  }

  const cache = { schema_version: CACHE_SCHEMA_VERSION, roster, depth_chart: depthChart };
  await writeNflverseCacheAtomic(cache, filePath);
  return { cache, ...result };
}
