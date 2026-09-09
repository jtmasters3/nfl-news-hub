// Production NFL Data Infrastructure — Stage A: the one production-facing
// entry point for nflverse supporting data. Composes the LOCKED Phase 2A
// roster/depth-chart cache (scripts/lib/nflverseCache.js, unmodified — used
// exactly as-is, not duplicated) with the new schedule cache
// (scripts/lib/nflverseScheduleCache.js) behind a single loader that a
// future scoring stage can call without knowing how any of it is fetched,
// cached, or kept fresh.
//
// THIS STAGE DOES NOT SCORE ANYTHING. Nothing in this file is imported by
// generate-content.js, editorialScoring.js, or editorialEnrichmentContext.js.
// It is called by refresh.js purely to make data available and diagnosed;
// the returned rows are not yet consumed by any decision.
//
// DESIGN PRINCIPLE (see task spec) — NFL news ingestion must never depend on
// nflverse. Every step here is wrapped so this function CANNOT throw: a
// nflverse outage, a GitHub outage, a malformed CSV, or a cache-write
// failure all degrade to `available: false` for the affected dataset,
// never an exception that could reach refresh.js's main().
import { readNflverseCache, refreshNflverseCache, defaultNflSeason, NFLVERSE_CACHE_PATH } from "./nflverseCache.js";
import { readScheduleCache, refreshScheduleCache, NFLVERSE_SCHEDULE_CACHE_PATH } from "./nflverseScheduleCache.js";

// ---------------------------------------------------------------------------
// FRESHNESS POLICY — chosen after inspecting nflverseCache.js: it has no
// staleness concept at all today (refreshNflverseCache() fetches
// unconditionally, every call). Refetching a GitHub-release CSV on every
// 10-minute production refresh (144x/day) is unnecessary: roster/depth-chart
// are live-updated snapshots that do not change on a 10-minute cadence, and
// the schedule file changes even less often (only flex-scheduling/result
// updates). Reuses this repository's own existing precedent for "how stale
// is too stale" — refresh.js already defines STALE_SOURCE_HOURS = 6 for its
// unrelated news-source-staleness warning — applying that same number here
// as a network-call-avoidance gate (a different purpose, same conservative
// order of magnitude, and a repository-consistent number rather than an
// arbitrary new one). A dataset with no cache yet (fetched_at absent) is
// always treated as maximally stale, so a first run always attempts a real
// fetch.
// ---------------------------------------------------------------------------
export const DEFAULT_STALE_AFTER_HOURS = 6;

// A hung network request must never hold up a production refresh — this is
// "operational metadata" (bounding how long we wait), never editorial as_of
// evidence, exactly as the task's own freshness-policy note distinguishes.
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

function isStale(fetchedAt, nowMs, staleAfterHours) {
  if (!fetchedAt) return true;
  const age = nowMs - Date.parse(fetchedAt);
  if (!Number.isFinite(age)) return true;
  return age > staleAfterHours * 3_600_000;
}

function withTimeout(fetchImpl, timeoutMs) {
  return (url) => fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Loads roster/depth-chart/schedule rows for production use, refreshing
 * each underlying cache only when stale (or missing), and NEVER throwing.
 *
 * @param {{
 *   now?: number,
 *   season?: number,
 *   staleAfterHours?: number,
 *   fetchTimeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   cachePath?: string,
 *   scheduleCachePath?: string,
 * }} [options]
 * @returns {Promise<{
 *   available: {roster: boolean, depth_chart: boolean, schedule: boolean},
 *   roster_rows: Array<object>,
 *   depth_chart_rows: Array<object>,
 *   schedule_rows: Array<object>,
 *   diagnostics: object,
 * }>}
 */
export async function loadProductionNflverseData({
  now = Date.now(),
  season = null,
  staleAfterHours = DEFAULT_STALE_AFTER_HOURS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl = fetch,
  cachePath = NFLVERSE_CACHE_PATH,
  scheduleCachePath = NFLVERSE_SCHEDULE_CACHE_PATH,
} = {}) {
  const resolvedSeason = season ?? defaultNflSeason(new Date(now));
  const timedFetch = withTimeout(fetchImpl, fetchTimeoutMs);

  const diagnostics = {
    season: resolvedSeason,
    stale_after_hours: staleAfterHours,
    fetch_timeout_ms: fetchTimeoutMs,
    roster: { available: false, refreshed_this_run: false, fetched_at: null, source_as_of: null, row_count: 0, error: null },
    depth_chart: { available: false, refreshed_this_run: false, fetched_at: null, source_as_of: null, row_count: 0, error: null },
    schedule: { available: false, refreshed_this_run: false, fetched_at: null, source_as_of: null, row_count: 0, error: null },
  };

  let rosterDepthCache = null;
  try {
    rosterDepthCache = await readNflverseCache(cachePath);
  } catch (err) {
    diagnostics.roster.error = `cache read failed: ${err instanceof Error ? err.message : String(err)}`;
    diagnostics.depth_chart.error = diagnostics.roster.error;
  }

  const rosterStale = isStale(rosterDepthCache?.roster?.fetched_at, now, staleAfterHours);
  const depthStale = isStale(rosterDepthCache?.depth_chart?.fetched_at, now, staleAfterHours);
  if (rosterStale || depthStale) {
    try {
      const result = await refreshNflverseCache({ season: resolvedSeason, fetchImpl: timedFetch, filePath: cachePath });
      rosterDepthCache = result.cache;
      diagnostics.roster.refreshed_this_run = result.roster.refreshed;
      diagnostics.roster.error = result.roster.error;
      diagnostics.depth_chart.refreshed_this_run = result.depth_chart.refreshed;
      diagnostics.depth_chart.error = result.depth_chart.error;
    } catch (err) {
      // refreshNflverseCache() can throw on a cache-write failure (its own
      // fetch calls are already internally guarded, but the final atomic
      // write is not) — caught here so a disk/permission problem can never
      // reach refresh.js. Whatever cache we already read above (possibly
      // still null) remains what we fall back to.
      const message = `cache refresh failed: ${err instanceof Error ? err.message : String(err)}`;
      diagnostics.roster.error = diagnostics.roster.error ?? message;
      diagnostics.depth_chart.error = diagnostics.depth_chart.error ?? message;
    }
  }

  let scheduleCache = null;
  try {
    scheduleCache = await readScheduleCache(scheduleCachePath);
  } catch (err) {
    diagnostics.schedule.error = `cache read failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const scheduleStale = isStale(scheduleCache?.schedule?.fetched_at, now, staleAfterHours);
  if (scheduleStale) {
    try {
      const result = await refreshScheduleCache({ season: resolvedSeason, fetchImpl: timedFetch, filePath: scheduleCachePath });
      scheduleCache = result.cache;
      diagnostics.schedule.refreshed_this_run = result.schedule.refreshed;
      diagnostics.schedule.error = result.schedule.error;
    } catch (err) {
      const message = `cache refresh failed: ${err instanceof Error ? err.message : String(err)}`;
      diagnostics.schedule.error = diagnostics.schedule.error ?? message;
    }
  }

  // Availability is derived ONLY from what actually landed in the cache —
  // never set true merely because a refresh was attempted, and never paired
  // with a fabricated non-empty array. An empty rows array is always
  // reported as unavailable, so a consumer never needs to distinguish
  // "empty but available" from "unavailable" — they are the same thing here.
  const roster = rosterDepthCache?.roster ?? null;
  const depthChart = rosterDepthCache?.depth_chart ?? null;
  const schedule = scheduleCache?.schedule ?? null;

  diagnostics.roster.available = Boolean(roster?.rows?.length);
  diagnostics.roster.fetched_at = roster?.fetched_at ?? null;
  diagnostics.roster.source_as_of = roster?.source_as_of ?? null;
  diagnostics.roster.row_count = roster?.row_count ?? 0;

  diagnostics.depth_chart.available = Boolean(depthChart?.rows?.length);
  diagnostics.depth_chart.fetched_at = depthChart?.fetched_at ?? null;
  diagnostics.depth_chart.source_as_of = depthChart?.source_as_of ?? null;
  diagnostics.depth_chart.row_count = depthChart?.row_count ?? 0;

  diagnostics.schedule.available = Boolean(schedule?.rows?.length);
  diagnostics.schedule.fetched_at = schedule?.fetched_at ?? null;
  diagnostics.schedule.source_as_of = schedule?.source_as_of ?? null;
  diagnostics.schedule.row_count = schedule?.row_count ?? 0;

  return {
    available: {
      roster: diagnostics.roster.available,
      depth_chart: diagnostics.depth_chart.available,
      schedule: diagnostics.schedule.available,
    },
    roster_rows: roster?.rows ?? [],
    depth_chart_rows: depthChart?.rows ?? [],
    schedule_rows: schedule?.rows ?? [],
    diagnostics,
  };
}
