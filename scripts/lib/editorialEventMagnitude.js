// Editorial Scoring Brain — Phase 1: deterministic event-magnitude ladder.
// Extends (never modifies) eventType.js's existing, production-proven
// classifyCategory()/detectEventTypes() machinery — clustering's behavior is
// completely untouched by this file. This module only ADDS a finer-grained
// magnitude ranking on top, for editorial scoring purposes only.
//
// Deliberately narrow and conservative per the Editorial Scoring Brain
// architecture lock: a handful of well-tested rungs per category, not a
// giant brittle regex collection. New rungs get added when real dry-run
// data shows a gap, not preemptively.
import { classifyCategory } from "./extraction.js";
import { detectEventTypes, ESCALATION_TYPES } from "./eventType.js";

// Coarse per-category base magnitude (0-100 conceptual scale), used only
// when no finer ladder below applies. OBSERVE_ONLY_CALIBRATION_DEFAULTS —
// see editorialScoring.js's doc comment; not final editorial weights.
const CATEGORY_BASE_MAGNITUDE = {
  suspension: 55,
  retirement: 50,
  trade: 45,
  // NOT a blanket high value — classifyCategory's "coaching" bucket matches
  // any mention of "coach"/"head coach"/"coordinator", including a plain
  // quote ("Head coach praises effort"), not just a real coaching change.
  // A real firing/hiring gets ORGANIZATIONAL_MAGNITUDE below via an
  // explicit change-pattern check; this is only the fallback for
  // coaching-adjacent text with no such signal.
  coaching: 12,
  injury: 20,
  contract: 28,
  free_agency: 25,
  draft: 12,
  fantasy: 4,
  roster_move: 14,
  league_news: 8,
};
const DEFAULT_BASE_MAGNITUDE = 8;

// ---------------------------------------------------------------------------
// Injury ladder — LOW to HIGH. Checked independently of classifyCategory's
// own "injury" bucket (real headlines routinely describe an injury without
// the literal word "injury" — "ankle issue", "hamstring tightness" — which
// would otherwise fall through to the category catch-all and lose the
// signal entirely; found while building this exact module).
//
// The top rung uses its OWN explicit season-ending/IR/named-structure
// pattern set rather than eventType.js's `injury_diagnosis` flag directly —
// that flag deliberately treats "torn ACL" and "expected to miss multiple
// weeks" as equally significant for CLUSTERING purposes (both are a real,
// new diagnosis, which is all clustering needs to know). Magnitude scoring
// needs a finer distinction than clustering does, so this ladder keeps its
// own top-tier check instead of inheriting that coarser boolean.
// ---------------------------------------------------------------------------
const SEASON_ENDING_MAGNITUDE = 70;
const SEASON_ENDING_PATTERNS = [
  /\bout\s+for\s+(?:the\s+)?season\b/i, /\bseason-ending\b/i,
  /\bplaced\s+on\s+(?:injured\s+reserve|IR)\b/i,
  /\bACL\b/i, /\bMCL\b/i, /\bachilles\b/i, /\bmeniscus\b/i,
  /\bcareer-threatening\b/i,
];
const INJURY_RUNGS = [
  { rung: "multi_week", magnitude: 40, patterns: [/\b(?:will|to|expected to)\s+miss\s+(?:\d+\+?|multiple|several|some)\s+(?:games?|weeks?)\b/i, /\bmiss(?:es|ed)?\s+(?:\d+\+?\s+)?(?:games?|weeks?)\b/i] },
  { rung: "ruled_out_one_game", magnitude: 22, patterns: [/\bruled out\b/i, /\binactive\b/i] },
  { rung: "questionable", magnitude: 14, patterns: [/\bquestionable\b/i, /\bgame-time decision\b/i, /\bday-to-day\b/i] },
  { rung: "limited_practice", magnitude: 8, patterns: [/\blimited\b[^.]{0,20}\bpractice\b/i, /\bdid not (?:practice|participate)\b/i, /\bdnp\b/i] },
];

function injuryMagnitude(text) {
  if (SEASON_ENDING_PATTERNS.some((p) => p.test(text))) return { rung: "season_ending", magnitude: SEASON_ENDING_MAGNITUDE };
  for (const { rung, magnitude, patterns } of INJURY_RUNGS) {
    if (patterns.some((p) => p.test(text))) return { rung, magnitude };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transaction ladder. "Starter" vs "backup" is determined from explicit
// article language only (Phase 1 has no roster/depth-chart data — see the
// Editorial Scoring Brain's Phase 2) — a plain, unqualified "signs" is the
// conservative default (backup-tier), never assumed to be a starter.
// ---------------------------------------------------------------------------
const TRANSACTION_RUNGS = [
  { rung: "blockbuster_trade", magnitude: 65, patterns: [/\bblockbuster\b/i, /\b(?:first|1st)-round pick\b/i, /\bmultiple (?:first|second|1st|2nd)-round picks\b/i, /\bfranchise-altering\b/i] },
  { rung: "starter_signing", magnitude: 30, patterns: [/\b(?:named|as|the)\s+(?:the\s+)?(?:new\s+)?starting\b/i, /\bstarter\b/i, /\bstarting (?:quarterback|running back|receiver|tackle|cornerback)\b/i] },
  { rung: "practice_squad", magnitude: 6, patterns: [/\bpractice squad\b/i] },
];
const BACKUP_SIGNING_MAGNITUDE = 16; // conservative default for a plain "signs"/"agrees to terms" with no elevating or practice-squad language

function transactionMagnitude(text) {
  for (const { rung, magnitude, patterns } of TRANSACTION_RUNGS) {
    if (patterns.some((p) => p.test(text))) return { rung, magnitude };
  }
  return { rung: "backup_signing", magnitude: BACKUP_SIGNING_MAGNITUDE };
}

// ---------------------------------------------------------------------------
// Depth-chart / backup-designation events — the Anthony-Richardson shape.
// Distinct from a real "signing" transaction: nobody was signed or traded,
// a roster/depth-chart POSITION was merely announced. classifyCategory has
// no dedicated bucket for this (it falls to the league_news catch-all), so
// it needs its own narrow detector rather than living in the transaction
// ladder above.
// ---------------------------------------------------------------------------
const DEPTH_CHART_PATTERNS = [
  /\bno\.\s*[123]\s+quarterback\b/i,
  /\bQB[123]\b/,
  /\bnamed\s+(?:the\s+)?backup\b/i,
  /\bwins?\s+(?:the\s+)?backup\b/i,
  /\bdepth chart\b/i,
  /\bnamed\s+(?:the\s+)?(?:starter|starting)\b.*\bdepth chart\b/i,
];
// Set so a real, concretely-named depth-chart development (unlike idle
// coach chatter or a bottom-of-ladder practice-participation note) clears
// the provisional Story bar with ordinary single-source corroboration —
// matching the Editorial Scoring Brain's own anchor example (Anthony
// Richardson named the Colts' QB2: Story, not Feed, not Neither). Provisional
// like every other number here — see OBSERVE_ONLY_CALIBRATION_DEFAULTS.
const DEPTH_CHART_MAGNITUDE = 24;

function depthChartMagnitude(text) {
  return DEPTH_CHART_PATTERNS.some((p) => p.test(text)) ? { rung: "depth_chart_designation", magnitude: DEPTH_CHART_MAGNITUDE } : null;
}

// ---------------------------------------------------------------------------
// Organizational / game-level events — carry a story WITHOUT any player
// multiplier (see editorialScoring.js's ROLE_MULTIPLIER routing). Detected
// by explicit CHANGE/EVENT language, never by classifyCategory's broad
// "coaching" bucket alone (which also matches an ordinary coach quote).
// ---------------------------------------------------------------------------
const ORGANIZATIONAL_MAGNITUDE = 55;
const ORGANIZATIONAL_PATTERNS = [
  // Real coaching changes only — not every sentence mentioning "coach".
  /\bfires?\b/i, /\bfired\b/i, /\bhires?\b/i, /\bhired\b/i,
  /\bnamed\s+(?:the\s+)?(?:new\s+)?head coach\b/i, /\bsteps? down (?:as|from)\b/i,
  /\bresigns?\s+as\s+head coach\b/i, /\bparts? ways with\b.*\bhead coach\b/i,
  // League/organizational/game-level events with no natural player subject.
  /\bclinche[sd]?\b/i,
  /\beliminated from playoff contention\b/i,
  /\bNFL (?:announces|approves|adopts)\b/i,
  /\brule change\b/i,
  /\bnew (?:overtime|kickoff|replay) rule\b/i,
  /\bteam sale\b/i,
  /\bsale (?:of|to) the .*(?:complete|approved|finalized)\b/i,
  /\bowners? approve/i,
];

export function isOrganizationalEvent(text) {
  return ORGANIZATIONAL_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {string} text - headline + description/excerpt, concatenated
 * @returns {{
 *   category: string,
 *   event_types: string[],
 *   escalation_types_present: string[],
 *   rung: string,
 *   magnitude: number,
 *   is_organizational: boolean
 * }}
 */
export function computeEventMagnitude(text) {
  const category = classifyCategory(text);
  const eventTypeSet = detectEventTypes(text);
  const eventTypes = Array.from(eventTypeSet);
  const escalationTypesPresent = eventTypes.filter((t) => ESCALATION_TYPES.has(t));

  const base = { category, event_types: eventTypes, escalation_types_present: escalationTypesPresent };

  // Depth-chart designations are checked before everything else — a "named
  // the Colts' No. 2 quarterback" headline would otherwise just fall
  // through to the league_news default, losing the (deliberately low, but
  // non-zero and distinct) depth-chart signal entirely.
  const depthChart = depthChartMagnitude(text);
  if (depthChart) {
    return { ...base, rung: depthChart.rung, magnitude: depthChart.magnitude, is_organizational: false };
  }

  // Checked independent of classifyCategory's own "injury" bucket — see the
  // doc comment on injuryMagnitude above for why the category gate was
  // dropped.
  const injury = injuryMagnitude(text);
  if (injury) return { ...base, rung: injury.rung, magnitude: injury.magnitude, is_organizational: false };

  if (category === "trade" || category === "free_agency" || category === "roster_move") {
    const txn = transactionMagnitude(text);
    return { ...base, rung: txn.rung, magnitude: txn.magnitude, is_organizational: false };
  }

  // Organizational/game-level events are checked by explicit change/event
  // language ONLY (never classifyCategory's broad "coaching" bucket alone,
  // which also matches an ordinary coach quote) — see isOrganizationalEvent.
  if (isOrganizationalEvent(text)) {
    return { ...base, rung: "organizational_change", magnitude: ORGANIZATIONAL_MAGNITUDE, is_organizational: true };
  }

  const categoryBase = CATEGORY_BASE_MAGNITUDE[category] ?? DEFAULT_BASE_MAGNITUDE;
  return { ...base, rung: `category:${category}`, magnitude: categoryBase, is_organizational: false };
}
