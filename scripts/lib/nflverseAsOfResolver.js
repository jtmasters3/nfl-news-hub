// Editorial Scoring Brain — Phase 2I: historical/as-of nflverse evidence
// selection. Pure, offline, deterministic, zero network/file access. Answers
// ONLY "which roster/depth-chart evidence was actually available at or
// before an explicit as_of timestamp" — it never resolves identity,
// position, role, fresh-role phrases, QB/star status, or player-importance
// math (Phase 2C-2H's job, completely untouched here) and it never fetches
// or caches nflverse data itself (Phase 2A's job). This module selects WHICH
// already-supplied rows are temporally eligible, nothing more.
//
// HARD INVARIANT, non-negotiable: NO FUTURE INFORMATION MAY BE USED. Missing
// evidence is always preferred over future evidence. There is no "best
// effort" fallback to a later snapshot, a later week, or the current/latest
// data — every code path below either returns evidence that is provably
// at-or-before as_of, or returns no evidence at all.
//
// EXPLICIT as_of ONLY. This module never reads Date.now(), never
// constructs `new Date()` with no argument, and never substitutes any other
// "current" signal. A missing/invalid/unparseable as_of returns a
// deterministic neutral result — it never throws for ordinary missing input.
//
// ---------------------------------------------------------------------------
// DEPTH-CHART TEMPORAL SEMANTICS — inspected against real data before
// locking this. depth_charts_2025.csv and depth_charts_2026.csv (fetched
// live from nflverse-data and inspected directly during this phase) both
// show `dt` as a full UTC timestamp with second precision on every single
// row observed (e.g. "2026-09-08T11:56:57Z") — never a bare date. The
// conservative date-only convention below is therefore DEFENSIVE, not a
// reflection of how the real current data source actually behaves: a bare
// `YYYY-MM-DD` dt (if one is ever supplied — e.g. a different or future
// data source, or a hand-built fixture) is treated as eligible only from
// the START of the FOLLOWING UTC day, never "known all day," so an as_of
// occurring anywhere during that same calendar day can never consume it.
// This is strictly more conservative than treating it as known at
// 00:00:00 of the same day, which could introduce same-day lookahead nflverse
// itself gives no evidence to rule out.
//
// ---------------------------------------------------------------------------
// ROSTER TEMPORAL LIMITATION — inspected, not assumed. Both the current-
// season file (rosters/roster_<season>.csv) and the true historical file
// (weekly_rosters/roster_weekly_<season>.csv) were fetched live and
// inspected during this phase. Their schema is identical:
// season, team, position, ..., week, game_type, ... — there is NO calendar
// date or timestamp column anywhere in this dataset. A completed season's
// weekly file (2025) confirmed real per-player, per-week rows spanning
// weeks 1-22 across game_types REG/WC/DIV/CON/SB, but still with no date.
//
// This means an arbitrary as_of TIMESTAMP cannot be mapped to the correct
// (season, week) using roster/weekly-roster data ALONE. A follow-up
// investigation (this same phase) fetched and inspected the genuinely
// different nflverse `schedules` dataset (games.csv) and found it CAN
// supply that missing anchor, subject to a documented, conservative
// eligibility rule — see scripts/lib/nflverseScheduleAsOf.js's own header
// comment for the full investigation, the exact rule, why "final scheduled
// kickoff reached" (never "week concluded") is the honest description of
// that rule, and exactly what it does NOT prove.
//
// This module composes that schedule-derived result (when schedule_rows are
// supplied) with roster selection below. When schedule_rows are NOT
// supplied, the CALLER must already know which (target_season, target_week)
// applies (manual mode) — this module never invents one. The two modes are
// never mixed within one call: supplying schedule_rows always selects
// schedule-derived mode, and any manually-supplied target_season/
// target_week is then ignored (recorded via a reason code, never silently)
// to avoid ambiguous precedence. See resolveNflverseAsOfEvidence's own doc
// comment.
//
// ---------------------------------------------------------------------------
// TEMPORAL PROVENANCE — roster evidence NEVER carries a real source
// timestamp (see above), unlike depth-chart evidence, which always does
// (its own `dt`). To make that distinction mechanically checkable by any
// downstream caller, the composed `roster` result below always carries:
//
//   temporal_basis:      "schedule_final_kickoff" | "manual_target" | "unresolved"
//   temporal_confidence: "indirect" | "unverified" | null
//
// "schedule_final_kickoff"/"indirect" — schedule-derived mode succeeded in
//   establishing a target. The target is anti-lookahead safe in the sense
//   documented in nflverseScheduleAsOf.js (final scheduled kickoff of the
//   target week has been reached), but the roster snapshot itself still has
//   NO real timestamp — hence "indirect," never "verified" or a
//   high/medium/low style confidence (which would risk being confused with
//   Phase 2C-2G's own identity/position/role/star confidence fields).
// "manual_target"/"unverified" — the caller supplied target_season/
//   target_week directly, with no schedule cross-check at all. Useful for
//   tests/manual inspection, but NEVER anti-lookahead verified by this
//   module — see the `manual_roster_target_not_temporally_verified` reason
//   code, always present alongside this basis.
// "unresolved"/null — no target could be established by either mode.
//
// `roster_as_of` remains `null` in every case — it is never fabricated, and
// is NEVER set equal to the schedule anchor (a different, unrelated
// timestamp — see `schedule_anchor_timestamp`, exposed separately on the
// roster object only in schedule-derived mode).
// ---------------------------------------------------------------------------
import { resolveNflWeekAsOf } from "./nflverseScheduleAsOf.js";

/**
 * Deterministic temporal-provenance labels for the composed roster result —
 * see the "TEMPORAL PROVENANCE" module comment above.
 */
function temporalProvenance(target_mode, hasTarget) {
  if (target_mode === "schedule_derived" && hasTarget) return { temporal_basis: "schedule_final_kickoff", temporal_confidence: "indirect" };
  if (target_mode === "manual" && hasTarget) return { temporal_basis: "manual_target", temporal_confidence: "unverified" };
  return { temporal_basis: "unresolved", temporal_confidence: null };
}

function isPlainRow(r) {
  return r !== null && typeof r === "object" && !Array.isArray(r);
}

function parseTimeOrNaN(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

// A bare calendar date, no time-of-day component.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant at which a depth-chart `dt` value becomes eligible for
 * historical selection. See the "DEPTH-CHART TEMPORAL SEMANTICS" module
 * comment above for why this exists and why it is conservative.
 */
function eligibilityInstant(dt) {
  if (DATE_ONLY_RE.test(dt)) {
    const startOfDay = Date.parse(`${dt}T00:00:00Z`);
    if (Number.isNaN(startOfDay)) return NaN;
    return startOfDay + 24 * 60 * 60 * 1000; // eligible only from D+1 00:00:00Z onward
  }
  return parseTimeOrNaN(dt);
}

function validAsOf(as_of) {
  if (as_of === null || as_of === undefined || as_of === "") return { ok: false, code: "as_of_missing" };
  if (typeof as_of !== "string") return { ok: false, code: "as_of_invalid" };
  const t = Date.parse(as_of);
  if (!Number.isFinite(t)) return { ok: false, code: "as_of_invalid" };
  return { ok: true, time: t };
}

function emptyRoster({ target_season = null, target_week = null, target_mode = null, schedule_anchor_timestamp = null } = {}) {
  const hasTarget = target_season !== null && target_week !== null;
  const { temporal_basis, temporal_confidence } = temporalProvenance(target_mode, hasTarget);
  return {
    rows: [],
    target_mode,
    target_season,
    target_week,
    selected_season: null,
    selected_week: null,
    roster_as_of: null,
    schedule_anchor_timestamp: target_mode === "schedule_derived" && hasTarget ? schedule_anchor_timestamp : null,
    temporal_basis,
    temporal_confidence,
    selection_basis: "not_available",
  };
}

function emptyDepthChart() {
  return { rows: [], selected_dt: null, depth_chart_as_of: null, selected_depth_chart_age_days: null, selection_basis: "not_available" };
}

// ---------------------------------------------------------------------------
// Roster selection — operates entirely in (season, week) integer space.
// Never consults as_of directly (see the module-level limitation comment).
// Never mutates the input array; never selects a (season, week) pair later
// than the supplied target.
// ---------------------------------------------------------------------------
function isAfter(a, b) {
  if (a.season !== b.season) return a.season > b.season;
  return a.week > b.week;
}

function resolveRoster({ target_season, target_week, target_mode, schedule_anchor_timestamp = null, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  // Reject null/undefined BEFORE Number() coercion — Number(null) is 0 (a
  // "valid" finite number), which would otherwise silently treat "no target
  // supplied at all" as a real target of season 0, week 0.
  const targetSupplied = target_season !== null && target_season !== undefined && target_week !== null && target_week !== undefined;
  const targetSeason = targetSupplied ? Number(target_season) : NaN;
  const targetWeek = targetSupplied ? Number(target_week) : NaN;
  const hasTarget = Number.isFinite(targetSeason) && Number.isFinite(targetWeek);
  const targetForOutput = { target_season: hasTarget ? targetSeason : null, target_week: hasTarget ? targetWeek : null, target_mode, schedule_anchor_timestamp: hasTarget ? schedule_anchor_timestamp : null };

  if (!hasTarget) {
    return { roster: emptyRoster(targetForOutput), found: false, futureRejected: false, reason: "roster_week_target_not_supplied" };
  }

  const bySeasonWeek = new Map(); // "season-week" -> { season, week, rows: [] }
  let sawAnyValid = false;
  for (const r of list) {
    if (!isPlainRow(r)) continue;
    const season = Number(r.season);
    const week = Number(r.week);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue; // malformed temporal field — excluded, never guessed
    sawAnyValid = true;
    const key = `${season}-${week}`;
    if (!bySeasonWeek.has(key)) bySeasonWeek.set(key, { season, week, rows: [] });
    bySeasonWeek.get(key).rows.push(r);
  }

  if (!sawAnyValid) {
    return { roster: emptyRoster(targetForOutput), found: false, futureRejected: false, reason: list.length > 0 ? "roster_temporal_field_invalid" : "roster_not_available" };
  }

  const target = { season: targetSeason, week: targetWeek };
  let exact = null;
  let bestPreceding = null;
  let sawFuture = false;
  for (const entry of bySeasonWeek.values()) {
    if (entry.season === targetSeason && entry.week === targetWeek) {
      exact = entry;
      continue;
    }
    if (isAfter(entry, target)) {
      sawFuture = true; // NEVER selected — recorded for diagnostics only
      continue;
    }
    if (!bestPreceding || isAfter(entry, bestPreceding)) bestPreceding = entry;
  }

  const chosen = exact ?? bestPreceding;
  if (!chosen) {
    return { roster: emptyRoster(targetForOutput), found: false, futureRejected: sawFuture, reason: "roster_not_available" };
  }

  const { temporal_basis, temporal_confidence } = temporalProvenance(target_mode, true);
  return {
    roster: {
      rows: chosen.rows.slice(),
      target_mode,
      target_season: targetSeason,
      target_week: targetWeek,
      selected_season: chosen.season,
      selected_week: chosen.week,
      // nflverse roster/weekly-roster data carries no source timestamp finer
      // than (season, week) — see the module-level limitation comment.
      // Never fabricated, and never set equal to schedule_anchor_timestamp
      // below (a different, unrelated timestamp — see "TEMPORAL PROVENANCE").
      roster_as_of: null,
      schedule_anchor_timestamp: target_mode === "schedule_derived" ? schedule_anchor_timestamp : null,
      temporal_basis,
      temporal_confidence,
      selection_basis: exact ? "exact" : "nearest_preceding",
    },
    found: true,
    futureRejected: sawFuture,
    reason: exact ? "roster_selected_exact" : "roster_selected_preceding",
  };
}

// ---------------------------------------------------------------------------
// Depth-chart selection — largest eligible dt <= as_of, subject to the
// conservative date-only convention above. Never mutates the input array;
// never selects a snapshot whose eligibility instant is after as_of.
// ---------------------------------------------------------------------------
function resolveDepthChart(asOfTime, rows) {
  const list = Array.isArray(rows) ? rows : [];

  const bySnapshot = new Map(); // raw dt string -> { dt, dtTime, eligibleAt, rows: [] }
  let sawAnyValid = false;
  for (const r of list) {
    if (!isPlainRow(r) || typeof r.dt !== "string") continue;
    const dtTime = parseTimeOrNaN(r.dt);
    const eligibleAt = eligibilityInstant(r.dt);
    if (!Number.isFinite(dtTime) || !Number.isFinite(eligibleAt)) continue; // malformed dt — excluded, never guessed
    sawAnyValid = true;
    if (!bySnapshot.has(r.dt)) bySnapshot.set(r.dt, { dt: r.dt, dtTime, eligibleAt, rows: [] });
    bySnapshot.get(r.dt).rows.push(r);
  }

  if (!sawAnyValid) {
    return { depth_chart: emptyDepthChart(), found: false, futureRejected: false, reason: list.length > 0 ? "depth_chart_dt_invalid" : "depth_chart_not_available" };
  }

  let best = null;
  let sawFuture = false;
  for (const snap of bySnapshot.values()) {
    if (snap.eligibleAt > asOfTime) {
      sawFuture = true; // NEVER selected — recorded for diagnostics only
      continue;
    }
    if (!best || snap.dtTime > best.dtTime) best = snap;
  }

  if (!best) {
    return { depth_chart: emptyDepthChart(), found: false, futureRejected: sawFuture, reason: sawFuture ? "future_depth_chart_rejected" : "depth_chart_not_available" };
  }

  const selectedDepthChartAgeDays = Math.round(((asOfTime - best.dtTime) / 86400000) * 10000) / 10000;
  return {
    depth_chart: {
      rows: best.rows.slice(),
      selected_dt: best.dt,
      depth_chart_as_of: best.dt,
      selected_depth_chart_age_days: selectedDepthChartAgeDays,
      selection_basis: "nearest_preceding_snapshot",
    },
    found: true,
    futureRejected: sawFuture,
    reason: "depth_chart_selected",
  };
}

/**
 * Resolves which roster and depth-chart evidence was actually available at
 * or before an explicit as_of timestamp. Pure and synchronous — the caller
 * is responsible for supplying the candidate rows (e.g. from Phase 2A's
 * cache, or from an explicit historical fetch); this module never fetches
 * or caches anything itself.
 *
 * TWO MUTUALLY EXCLUSIVE roster-targeting modes, never mixed in one call:
 *
 * - **schedule-derived mode** (normal operation): supply `schedule_rows`
 *   (non-empty). This module calls resolveNflWeekAsOf() internally to find
 *   the greatest (season, week) whose FINAL SCHEDULED KICKOFF has been
 *   reached at or before as_of (NOT "whose games have concluded" — see
 *   nflverseScheduleAsOf.js for the exact rule and its documented limits) —
 *   and uses that as the roster target. Any manually-supplied
 *   target_season/target_week is then IGNORED (never silently: recorded via
 *   the `manual_target_ignored_schedule_present` reason code) to avoid
 *   ambiguous precedence between the two modes.
 * - **manual mode** (no `schedule_rows` supplied): the CALLER supplies an
 *   explicit target_season/target_week directly — useful for deterministic
 *   tests/manual inspection, or any caller that already has its own
 *   schedule-derived mapping. This is the only mode Phase 2I originally
 *   shipped with, unchanged. NEVER anti-lookahead verified by this module —
 *   see the `manual_roster_target_not_temporally_verified` reason code.
 *
 * Depth-chart selection is unaffected by either mode — it always uses
 * as_of directly against each row's own real `dt` timestamp.
 *
 * @param {{
 *   as_of: string|null,
 *   roster_rows?: Array<{season: string|number, week: string|number, [key: string]: any}>,
 *   depth_chart_rows?: Array<{dt: string, [key: string]: any}>,
 *   schedule_rows?: Array<{season: string|number, week: string|number, game_type?: string, gameday: string, gametime?: string|null}>,
 *   target_season?: number|string|null,
 *   target_week?: number|string|null,
 * }} input
 * @returns {{
 *   as_of: string|null,
 *   schedule: {season: number, week: number, game_type: string|null, selection_basis: "final_scheduled_kickoff_reached", anchor_timestamp: string, anchor_type: "final_scheduled_kickoff"}|null,
 *   roster: {rows: Array<object>, target_mode: "schedule_derived"|"manual"|null, target_season: number|null, target_week: number|null, selected_season: number|null, selected_week: number|null, roster_as_of: null, schedule_anchor_timestamp: string|null, temporal_basis: "schedule_final_kickoff"|"manual_target"|"unresolved", temporal_confidence: "indirect"|"unverified"|null, selection_basis: "exact"|"nearest_preceding"|"not_available"},
 *   depth_chart: {rows: Array<object>, selected_dt: string|null, depth_chart_as_of: string|null, selected_depth_chart_age_days: number|null, selection_basis: "nearest_preceding_snapshot"|"not_available"},
 *   diagnostics: {roster_found: boolean, depth_chart_found: boolean, future_roster_rejected: boolean, future_depth_chart_rejected: boolean, schedule_found: boolean},
 *   reason_codes: string[],
 * }}
 */
export function resolveNflverseAsOfEvidence({ as_of = null, roster_rows = [], depth_chart_rows = [], schedule_rows = null, target_season = null, target_week = null } = {}) {
  const asOfCheck = validAsOf(as_of);
  if (!asOfCheck.ok) {
    return {
      as_of: typeof as_of === "string" ? as_of : null,
      schedule: null,
      roster: emptyRoster({ target_mode: null }),
      depth_chart: emptyDepthChart(),
      diagnostics: { roster_found: false, depth_chart_found: false, future_roster_rejected: false, future_depth_chart_rejected: false, schedule_found: false },
      reason_codes: [asOfCheck.code],
    };
  }

  const hasSchedule = Array.isArray(schedule_rows) && schedule_rows.length > 0;
  const targetMode = hasSchedule ? "schedule_derived" : "manual";
  const reasonCodes = [];

  let scheduleResult = null;
  let effectiveTargetSeason = target_season;
  let effectiveTargetWeek = target_week;

  if (hasSchedule) {
    scheduleResult = resolveNflWeekAsOf({ as_of, schedule_rows });
    reasonCodes.push(...scheduleResult.reason_codes);
    const scheduleGaveTarget = scheduleResult.selection_basis === "final_scheduled_kickoff_reached";
    effectiveTargetSeason = scheduleGaveTarget ? scheduleResult.season : null;
    effectiveTargetWeek = scheduleGaveTarget ? scheduleResult.week : null;
    if (target_season !== null && target_season !== undefined) reasonCodes.push("manual_target_ignored_schedule_present");
    if (target_week !== null && target_week !== undefined) reasonCodes.push("manual_target_ignored_schedule_present");
  }

  const scheduleAnchorTimestamp = scheduleResult && scheduleResult.selection_basis === "final_scheduled_kickoff_reached" ? scheduleResult.anchor_timestamp : null;

  const rosterResult =
    hasSchedule && effectiveTargetSeason === null
      ? { roster: emptyRoster({ target_mode: targetMode }), found: false, futureRejected: false, reason: "roster_not_available" }
      : resolveRoster({ target_season: effectiveTargetSeason, target_week: effectiveTargetWeek, target_mode: targetMode, schedule_anchor_timestamp: scheduleAnchorTimestamp, rows: roster_rows });
  const depthResult = resolveDepthChart(asOfCheck.time, depth_chart_rows);

  reasonCodes.push(rosterResult.reason, depthResult.reason);
  if (rosterResult.futureRejected) reasonCodes.push("future_roster_rejected");
  if (depthResult.futureRejected) reasonCodes.push("future_depth_chart_rejected");
  if (rosterResult.roster.temporal_basis === "schedule_final_kickoff") reasonCodes.push("roster_schedule_anchored");
  if (rosterResult.roster.temporal_basis === "manual_target") reasonCodes.push("roster_manual_target", "manual_roster_target_not_temporally_verified");

  return {
    as_of,
    schedule:
      scheduleResult && scheduleResult.selection_basis === "final_scheduled_kickoff_reached"
        ? { season: scheduleResult.season, week: scheduleResult.week, game_type: scheduleResult.game_type, selection_basis: scheduleResult.selection_basis, anchor_timestamp: scheduleResult.anchor_timestamp, anchor_type: scheduleResult.anchor_type }
        : null,
    roster: rosterResult.roster,
    depth_chart: depthResult.depth_chart,
    diagnostics: {
      roster_found: rosterResult.found,
      depth_chart_found: depthResult.found,
      future_roster_rejected: rosterResult.futureRejected,
      future_depth_chart_rejected: depthResult.futureRejected,
      schedule_found: Boolean(scheduleResult && scheduleResult.selection_basis === "final_scheduled_kickoff_reached"),
    },
    reason_codes: [...new Set(reasonCodes)],
  };
}
