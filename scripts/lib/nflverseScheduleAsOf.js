// Editorial Scoring Brain — Phase 2I: schedule-derived NFL week resolution.
// Pure, offline, deterministic, zero network/file access. Answers ONLY
// "which NFL (season, week) had its FINAL SCHEDULED KICKOFF reached at or
// before an explicit as_of timestamp" — a genuinely different, narrower
// question than "which week is this a story about," and a DELIBERATELY
// weaker claim than "which week's games had all finished." It never touches
// roster or depth-chart data (see nflverseAsOfResolver.js, which composes
// this module's result with that selection) and never resolves
// identity/position/role/star status.
//
// TERMINOLOGY — precise on purpose. This module's boundary is:
//
//     WEEK_FINAL_SCHEDULED_KICKOFF_REACHED
//
// i.e. every game in the week has, at minimum, STARTED (its scheduled
// kickoff instant has passed) by as_of. This is NOT the same claim as "the
// week's games have all FINISHED/CONCLUDED" — a kickoff timestamp marks the
// start of a game, not its end, and this dataset carries no game-end
// timestamp at all. Never describe this boundary as "week concluded,"
// "week completed," or "all games finished" anywhere in this codebase —
// those phrases claim something the data does not prove. See "WHY THIS IS
// SAFE" below for why "final scheduled kickoff reached" is still the
// correct, sufficient boundary for the actual risk this module exists to
// prevent.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS — inspected, not assumed. nflverse's roster and
// weekly-roster datasets (scripts/lib/nflverseAsOfResolver.js's own
// "ROSTER TEMPORAL LIMITATION" comment) carry only (season, week) — no
// calendar date. Mapping an arbitrary as_of timestamp to a (season, week)
// therefore requires a genuinely different nflverse dataset: `schedules`
// (games.csv, fetched live and inspected during this phase from
// https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv,
// 7,548 games, seasons 1999-2026). Its schema does carry real calendar
// dates and kickoff times, confirmed by direct inspection — see below.
//
// ---------------------------------------------------------------------------
// CONFIRMED SCHEDULE SCHEMA/SEMANTICS (from the official nflverse/nflreadr
// data dictionary, fetched from
// https://raw.githubusercontent.com/nflverse/nflreadr/main/data-raw/dictionary_schedules.csv,
// PLUS direct inspection of real 2018/2020/2021/2024/2025/2026 rows):
//
// - `gameday` (character): the calendar date the game occurred, "YYYY-MM-DD".
// - `gametime` (character): "The kickoff time of the game. This is
//   represented in 24-hour time and the Eastern time zone, REGARDLESS of
//   what time zone the game was being played in." — documented, not
//   assumed. Verified against 1,965 real games (2020-2026): converting
//   every (gameday, gametime) pair to UTC via IANA America/New_York rules
//   and back reproduces the original values with ZERO mismatches, correctly
//   spanning both EDT (e.g. 2025-09-07 13:00 -> 17:00Z, UTC-4) and EST
//   (e.g. 2025-12-07 13:00 -> 18:00Z, UTC-5) periods. Note: this is a
//   KICKOFF timestamp, not a final-whistle timestamp — no game-end time
//   exists anywhere in this dataset.
// - `week` (numeric): globally CONTINUOUS within a season across every
//   game_type — confirmed directly for 2018 (REG 1-17, WC=18, DIV=19,
//   CON=20, SB=21), 2020 (same pattern), 2021 (REG 1-18, WC=19, DIV=20,
//   CON=21, SB=22, matching the 2021 season-expansion the dictionary
//   itself documents), 2024, and 2025 (same as 2021's pattern). This
//   exactly matches weekly_rosters' own observed week range (1-22 for a
//   2021+ season) — the two datasets share one numbering scheme, no
//   translation table needed.
// - `game_type` (character): one of REG, WC, DIV, CON, SB. **No `PRE`
//   value exists anywhere in the 7,548 rows inspected, across all 1999-2026
//   seasons** — preseason games are not part of this dataset at all.
// - `result`/scores are blank for games not yet played (not used here —
//   this module only ever consults *scheduled kickoff* timing, never
//   outcomes or completion, so it can never leak "who won" information and
//   never claims to know when a game actually ended).
// - `gameday` is never blank in any row inspected (0/7548); `gametime` is
//   blank in 259 rows, all from legacy (pre-2020) seasons — handled below
//   via the same conservative date-only convention already locked for
//   depth-chart `dt`.
//
// ---------------------------------------------------------------------------
// THE CENTRAL SEMANTIC QUESTION — deliberately NOT assumed away. Does
// weekly_rosters' (season, week) represent "the roster as of the start of
// that week," "as of the end," or something else? The official
// nflverse/nflreadr dictionary for the season-level roster file
// (dictionary_rosters.csv, same fetch as above) documents `week` as: "The
// most recent week of that season that a player appeared on the roster."
// That is a TRAILING, last-seen-style marker — not a snapshot proven to be
// fixed at any specific instant relative to that week's games. No
// equivalent per-row publish timestamp exists anywhere in this dataset (not
// in dictionary_rosters, not in a weekly_rosters-specific dictionary — none
// was found; the weekly file shares the season-level file's exact schema).
//
// This means: NOTHING in nflverse's own documentation or data proves that a
// week-W-tagged roster row could not include information that only became
// knowable partway through, or even after, week W's games. Lining up
// season/week NUMBERS between schedules and weekly_rosters is therefore
// NOT, by itself, proof of temporal safety — and this module makes NO claim
// that it is. It answers a strictly narrower question (see below).
//
// ---------------------------------------------------------------------------
// LOCKED SCHEDULE ELIGIBILITY RULE (do not make this more aggressive):
//
//     schedule_anchor_timestamp(W)
//         = maximum SCHEDULED KICKOFF timestamp among all valid scheduled
//           games in week W
//
//     week W is schedule-eligible  <=>  schedule_anchor_timestamp(W) <= as_of
//
//     selected week = the GREATEST schedule-eligible (season, week)
//
// Concretely: before W's final scheduled kickoff, W is NOT eligible; at or
// after W's final scheduled kickoff, W IS schedule-eligible. This does NOT
// mean W's games have finished, and does NOT mean nflverse's weekly-roster
// snapshot for W was published by that instant — see below.
//
// WHY THIS IS SAFE (for the concrete failure mode this phase cares about):
// while even one game in week W has not yet STARTED, week W is unambiguously
// still in the future or in progress from a scheduling standpoint, so it can
// never be treated as a legitimate historical target. Once every game in W
// has at least started (its scheduled kickoff has passed), W is no longer a
// future week by any reasonable definition — this provably prevents ever
// selecting a week that is still entirely or partly in the future. That is
// the exact risk this module exists to close, and reaching it does not
// require claiming anything about when W's games actually ended.
//
// WHY THIS IS NOT A COMPLETE PROOF OF ROSTER SAFETY: reaching a week's final
// scheduled kickoff does NOT establish that nflverse's own weekly_rosters
// FILE was actually published/crawled by that instant, nor that the games
// themselves had finished by then — there is no game-end timestamp and no
// roster-file publish timestamp anywhere in this data source to check
// either against (see "VERY IMPORTANT CURRENT-DATA CHECK" in
// scripts/nflverse/README.md's Phase 2I section for the explicit comparison
// performed). This is the tightest defensible floor available from the
// actual documented data, not a claim of perfect safety against arbitrary
// ETL/crawl-latency or in-game-timing edge cases. Reported honestly rather
// than silently assumed — see `temporal_confidence: "indirect"` on the
// composed roster result in nflverseAsOfResolver.js.
//
// A direct, real consequence worth naming: this rule is conservative in a
// way that reduces usefulness for the most common real-world case — a story
// breaking MID-WEEK about that same week's roster move. Under this rule,
// such a story can only ever safely use the PRIOR schedule-eligible week's
// roster as historical evidence, never the in-progress week's own. That is
// the deliberate, reported cost of the anti-lookahead guarantee.
// ---------------------------------------------------------------------------

function isPlainRow(r) {
  return r !== null && typeof r === "object" && !Array.isArray(r);
}

function validAsOf(as_of) {
  if (as_of === null || as_of === undefined || as_of === "") return { ok: false, code: "as_of_missing" };
  if (typeof as_of !== "string") return { ok: false, code: "as_of_invalid" };
  const t = Date.parse(as_of);
  if (!Number.isFinite(t)) return { ok: false, code: "as_of_invalid" };
  return { ok: true, time: t };
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY_RE = /^\d{2}:\d{2}$/;

/**
 * The UTC offset (milliseconds) of an IANA time zone at a given instant,
 * read directly from the JS runtime's IANA time zone database via Intl —
 * never a hand-coded DST rule. Two-pass callers (below) get this exactly
 * right across a DST transition; nflverse kickoff times never fall inside
 * the transition itself, so a single evaluation per pass is sufficient.
 */
function tzOffsetMillis(utcMillis, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset", hour: "2-digit", hourCycle: "h23" });
  const parts = dtf.formatToParts(new Date(utcMillis));
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(tzPart);
  if (!m) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2] ?? "0");
  const sign = hours < 0 ? -1 : 1;
  return hours * 3600000 + sign * minutes * 60000;
}

/**
 * Converts a documented Eastern-time wall-clock (gameday, gametime) pair to
 * a UTC millisecond instant, using the runtime's real America/New_York IANA
 * rules (so EDT/EST is always correct for the actual date) — never a
 * hard-coded "DST starts/ends on X" rule. Validated against 1,965 real
 * nflverse games (2020-2026) with zero round-trip mismatches; see the
 * module header comment.
 */
function easternWallClockToUtcMillis(gameday, gametime) {
  const naiveUtc = Date.parse(`${gameday}T${gametime}:00Z`);
  if (!Number.isFinite(naiveUtc)) return NaN;
  const offset1 = tzOffsetMillis(naiveUtc, "America/New_York");
  if (!Number.isFinite(offset1)) return NaN;
  const pass1 = naiveUtc - offset1;
  const offset2 = tzOffsetMillis(pass1, "America/New_York");
  if (!Number.isFinite(offset2)) return NaN;
  return naiveUtc - offset2;
}

/**
 * The scheduled KICKOFF instant of a single game — NOT its end, which this
 * dataset never records. Real gametime is present for every 2020+ game
 * inspected; the 259 legacy rows (all pre-2020) missing gametime fall back
 * to the same conservative date-only convention already locked for
 * depth-chart `dt` (scripts/lib/nflverseAsOfResolver.js) — treated as
 * knowable only from the START of the FOLLOWING UTC day, never "known all
 * day."
 */
function scheduledKickoffInstant(gameday, gametime) {
  if (typeof gameday !== "string" || !DATE_ONLY_RE.test(gameday)) return NaN;
  if (typeof gametime === "string" && TIME_ONLY_RE.test(gametime)) {
    return easternWallClockToUtcMillis(gameday, gametime);
  }
  const startOfDay = Date.parse(`${gameday}T00:00:00Z`);
  if (Number.isNaN(startOfDay)) return NaN;
  return startOfDay + 24 * 60 * 60 * 1000; // conservative: knowable only from D+1 UTC onward
}

function isAfter(a, b) {
  if (a.season !== b.season) return a.season > b.season;
  return a.week > b.week;
}

/**
 * Resolves the greatest (season, week) whose final SCHEDULED KICKOFF has
 * been reached at or before as_of — see the module header comment for the
 * exact rule, why "final scheduled kickoff reached" (not "week concluded")
 * is the honest and sufficient description, and its documented limitations.
 *
 * @param {{as_of: string|null, schedule_rows?: Array<{season: string|number, week: string|number, game_type?: string, gameday: string, gametime?: string|null}>}} input
 * @returns {{season: number|null, week: number|null, game_type: string|null, selection_basis: "final_scheduled_kickoff_reached"|"not_available", anchor_timestamp: string|null, anchor_type: "final_scheduled_kickoff"|null, reason_codes: string[]}}
 */
export function resolveNflWeekAsOf({ as_of = null, schedule_rows = [] } = {}) {
  const asOfCheck = validAsOf(as_of);
  if (!asOfCheck.ok) {
    return { season: null, week: null, game_type: null, selection_basis: "not_available", anchor_timestamp: null, anchor_type: null, reason_codes: [asOfCheck.code] };
  }

  const list = Array.isArray(schedule_rows) ? schedule_rows : [];
  const byWeek = new Map(); // "season-week" -> { season, week, game_type, maxKickoff }
  let sawAnyValid = false;

  for (const r of list) {
    if (!isPlainRow(r)) continue;
    const season = Number(r.season);
    const week = Number(r.week);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    const kickoff = scheduledKickoffInstant(r.gameday, r.gametime);
    if (!Number.isFinite(kickoff)) continue; // malformed schedule date — excluded, never guessed
    sawAnyValid = true;
    const key = `${season}-${week}`;
    if (!byWeek.has(key)) byWeek.set(key, { season, week, game_type: typeof r.game_type === "string" ? r.game_type : null, maxKickoff: -Infinity });
    const entry = byWeek.get(key);
    if (kickoff > entry.maxKickoff) entry.maxKickoff = kickoff;
    if (entry.game_type === null && typeof r.game_type === "string") entry.game_type = r.game_type;
  }

  if (!sawAnyValid) {
    return { season: null, week: null, game_type: null, selection_basis: "not_available", anchor_timestamp: null, anchor_type: null, reason_codes: [list.length > 0 ? "schedule_temporal_field_invalid" : "schedule_not_available"] };
  }

  let best = null;
  let sawFuture = false;
  for (const entry of byWeek.values()) {
    if (entry.maxKickoff > asOfCheck.time) {
      sawFuture = true; // week's final scheduled kickoff not yet reached — NEVER selected
      continue;
    }
    if (!best || isAfter(entry, best)) best = entry;
  }

  if (!best) {
    return { season: null, week: null, game_type: null, selection_basis: "not_available", anchor_timestamp: null, anchor_type: null, reason_codes: [sawFuture ? "no_eligible_schedule_week" : "schedule_not_available"] };
  }

  return {
    season: best.season,
    week: best.week,
    game_type: best.game_type,
    selection_basis: "final_scheduled_kickoff_reached",
    anchor_timestamp: new Date(best.maxKickoff).toISOString(),
    anchor_type: "final_scheduled_kickoff",
    reason_codes: sawFuture ? ["schedule_week_selected", "schedule_final_kickoff_anchor", "future_schedule_week_rejected"] : ["schedule_week_selected", "schedule_final_kickoff_anchor"],
  };
}
