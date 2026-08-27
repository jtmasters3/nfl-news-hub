import { jaccardSimilarity, titleTokens } from "./text.js";
import { TEAMS, detectTeams } from "./teams.js";
import { detectEventTypes, UNSPECIFIC_TYPE } from "./eventType.js";

const CLUSTER_WINDOW_HOURS = 72;
const TEAM_AWARE_THRESHOLD = 0.32; // article and candidate share a team
const TEAM_AGNOSTIC_THRESHOLD = 0.5; // no shared team (e.g. league-wide news) — require a closer match

// Multi-word position phrases, stripped as whole phrases from the raw text
// before tokenizing — deliberately NOT a per-word stopword list, so generic
// words like "back"/"end"/"line" are never dropped except as part of an
// actual position phrase ("running back", "tight end", "offensive line").
const POSITION_PHRASES = [
  /\brunning back(s)?\b/gi,
  /\bwide receiver(s)?\b/gi,
  /\btight end(s)?\b/gi,
  /\boffensive (?:tackle|lineman|linemen|line)\b/gi,
  /\bdefensive (?:tackle|end|lineman|linemen|line|back(?:s)?)\b/gi,
  /\bcornerback(s)?\b/gi,
  /\blinebacker(s)?\b/gi,
  /\bquarterback(s)?\b/gi,
  /\bkicker(s)?\b/gi,
  /\bpunter(s)?\b/gi,
  /\bsafet(?:y|ies)\b/gi,
];
// Single-token position abbreviations — safe to filter post-tokenization
// since titleTokens() already drops length<=1 tokens (so "S"/"K"/"P" never
// survive as tokens in the first place; only the 2-3 letter abbreviations
// need listing here).
const POSITION_ABBR_TOKENS = new Set(["qb", "rb", "wr", "te", "ot", "ol", "dl", "dt", "de", "lb", "cb", "db"]);

// Name-suffix tokens — dropped outright (never canonicalized to anything)
// so "Kenneth Walker" and "Kenneth Walker III" tokenize to the same name.
const SUFFIX_TOKENS = new Set(["ii", "iii", "iv", "jr", "sr"]);

// Words that describe the ACT of a transaction/development rather than WHO
// or WHAT it's about — stripped when isolating a headline's subject (see
// subjectTokens) so two headlines that share a team + verb but describe two
// different players/transactions ("Chiefs trade for Kenneth Walker III" vs
// "Chiefs trade for Isiah Pacheco") are never mistaken for the same event.
const GENERIC_EVENT_WORDS = new Set([
  "trade", "trades", "traded", "trading", "acquire", "acquires", "acquired", "acquiring", "swap",
  "sign", "signs", "signed", "signing", "release", "releases", "released", "releasing",
  "waive", "waives", "waived", "waiving", "cut", "cuts", "cutting",
  "activate", "activates", "activated", "activating", "promote", "promotes", "promoted", "promoting",
  "injure", "injures", "injured", "injuring", "injury", "injuries", "suffer", "suffers", "suffered", "suffering",
  "diagnose", "diagnoses", "diagnosed", "diagnosis", "confirm", "confirms", "confirmed", "confirming",
  "fail", "fails", "failed", "failing", "physical",
  "retire", "retires", "retired", "retiring", "retirement",
  "fire", "fires", "fired", "firing", "hire", "hires", "hired", "hiring",
  "suspend", "suspends", "suspended", "suspending", "suspension",
  "clear", "clears", "cleared", "clearing", "return", "returns", "returned", "returning",
  "rule", "rules", "ruled", "ruling", "place", "places", "placed", "placing",
  "extend", "extends", "extended", "extending", "extension",
  "agree", "agrees", "agreed", "agreeing", "terms", "deal", "deals", "contract",
  "questionable", "out", "season", "practice", "reserve", "ir", "mri", "acl", "mcl",
  "rescinded", "voided", "nixed", "cancelled", "canceled", "falls", "through",
]);

function stripPositionPhrases(text) {
  let out = text;
  for (const re of POSITION_PHRASES) out = out.replace(re, " ");
  return out;
}

/**
 * Tokenizes a headline for clustering comparison. Strips multi-word
 * position phrases first, then collapses every team mention (city,
 * nickname, full name, alias) down to one shared `team:ABBR` token and
 * drops position abbreviations + name suffixes — so outlet-to-outlet
 * differences in how they refer to the same team/position/player never
 * move the similarity score. Exported for the live-data audit script.
 */
export function normalizeHeadlineTokens(text) {
  const teams = detectTeams(text);
  const stripWords = new Set();
  for (const abbr of teams) {
    const team = TEAMS.find((t) => t.abbr === abbr);
    if (!team) continue;
    for (const phrase of [team.name, team.nickname, team.city, ...team.aliases]) {
      for (const w of phrase.toLowerCase().split(/\s+/)) stripWords.add(w);
    }
  }

  const tokens = titleTokens(stripPositionPhrases(text));
  const result = new Set();
  for (const t of tokens) {
    if (stripWords.has(t)) continue;
    if (POSITION_ABBR_TOKENS.has(t)) continue;
    if (SUFFIX_TOKENS.has(t)) continue;
    result.add(t);
  }
  for (const abbr of teams) result.add(`team:${abbr}`);
  return result;
}

/**
 * Narrows an already-normalized token set down to the tokens likely to
 * identify WHO/WHAT a headline is actually about (mostly player/team-scoped
 * proper nouns) by dropping team tokens and generic transaction/status
 * verbs. Used only as a guard against merging two headlines that share a
 * team + verb but are actually about two different subjects.
 */
export function subjectTokens(normalizedTokens) {
  const result = new Set();
  for (const t of normalizedTokens) {
    if (t.startsWith("team:")) continue;
    if (GENERIC_EVENT_WORDS.has(t)) continue;
    result.add(t);
  }
  return result;
}

/** True only when both sets are non-empty and share no token — an empty set on either side is "unknown", not "conflicting". */
function hasDisjointSubjects(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) {
    if (b.has(t)) return false;
  }
  return true;
}

/**
 * Decides whether a newly discovered article is reporting the same event as
 * an existing recent story. Combines:
 *   1. Recency window (72h, unchanged).
 *   2. Team overlap (unchanged) — sets the similarity bar.
 *   3. Normalized headline similarity (Jaccard over team/position/suffix-
 *      normalized tokens) against the story's headline and every source
 *      headline already attached to it.
 *   4. Same-subject guard — rejects a match outright if the headlines are
 *      clearly about two different people/subjects (shared team + verb
 *      alone is not enough), regardless of how high the raw score is.
 *   5. Event-type gate — rejects a match if the new article carries an
 *      event-type signal (e.g. "fails physical", "torn ACL", "placed on
 *      IR", a rescinded trade) that no source on the candidate story has
 *      reported yet. That's treated as a materially new development, not a
 *      duplicate, even when the wording otherwise overlaps a lot (a trade
 *      announcement and that trade's medical fallout share most of their
 *      nouns). A plain "league_news" catch-all never counts as a new type
 *      on its own — see eventType.js.
 * Guards 4 and 5 are intentionally hard blocks, not scored factors: per
 * spec, an ambiguous or conflicting case should default to a NEW story
 * rather than risk silently swallowing a real development, since missing an
 * occasional cross-outlet duplicate is far less costly than suppressing a
 * legitimate new social post.
 * Deterministic and free — no AI call needed to make the clustering
 * decision itself.
 *
 * `article` = { headline, teams, text? } — text (headline + excerpt, when
 * available) feeds the event-type check for a stronger signal than the
 * headline alone; falls back to headline if omitted.
 * `candidates` is an array of { id, headline, sourceHeadlines, teams, lastUpdatedAt }.
 */
export function pickBestMatch(article, candidates) {
  const now = Date.now();
  const articleText = article.text || article.headline;
  const articleTokens = normalizeHeadlineTokens(article.headline);
  const articleSubject = subjectTokens(articleTokens);
  const articleTypes = detectEventTypes(articleText);

  let best = null;

  for (const candidate of candidates) {
    const ageHours = (now - Date.parse(candidate.lastUpdatedAt)) / 3_600_000;
    if (ageHours > CLUSTER_WINDOW_HOURS) continue;

    const sharesTeam =
      article.teams.length > 0 &&
      candidate.teams.length > 0 &&
      article.teams.some((t) => candidate.teams.includes(t));

    const candidateHeadlines = [candidate.headline, ...candidate.sourceHeadlines];

    // Best-matching individual headline in the cluster — used both for the
    // score itself and for the subject guard below, so the guard is judged
    // against the specific headline the score actually came from.
    let bestHeadline = null;
    for (const h of candidateHeadlines) {
      const hTokens = normalizeHeadlineTokens(h);
      const score = jaccardSimilarity(articleTokens, hTokens);
      if (!bestHeadline || score > bestHeadline.score) bestHeadline = { score, hTokens };
    }
    const normScore = bestHeadline.score;

    if (hasDisjointSubjects(articleSubject, subjectTokens(bestHeadline.hTokens))) continue;

    // A story's known event-type set is the union across every source
    // headline attached so far, not just the best-matching one — a later
    // article should be compared against everything already known about
    // the story, not just its closest-worded source.
    const storyTypes = new Set();
    for (const h of candidateHeadlines) {
      for (const t of detectEventTypes(h)) storyTypes.add(t);
    }
    const introducesNewType = [...articleTypes].some((t) => t !== UNSPECIFIC_TYPE && !storyTypes.has(t));
    if (introducesNewType) continue;

    const threshold = sharesTeam ? TEAM_AWARE_THRESHOLD : TEAM_AGNOSTIC_THRESHOLD;
    if (normScore >= threshold && (best === null || normScore > best.score)) {
      best = { storyId: candidate.id, score: normScore };
    }
  }

  return best;
}
