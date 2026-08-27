import { jaccardSimilarity, titleTokens } from "./text.js";
import { TEAMS, detectTeams } from "./teams.js";
import { detectEventTypes, UNSPECIFIC_TYPE, ESCALATION_TYPES } from "./eventType.js";

const CLUSTER_WINDOW_HOURS = 72;
const TEAM_AWARE_THRESHOLD = 0.32; // article and candidate share a team
const TEAM_AGNOSTIC_THRESHOLD = 0.5; // no shared team (e.g. league-wide news) — require a closer match

// Excerpt/description corroboration is a secondary, narrowly-scoped rescue
// for a candidate whose HEADLINE score falls short of the threshold above
// (see pickBestMatch) — a materially lower bar is fine specifically because
// it only ever fires after team + confident-subject + event-type
// compatibility have already been confirmed (see EXCERPT corroboration
// section of pickBestMatch). It is never used as a standalone merge signal.
const EXCERPT_CORROBORATION_THRESHOLD = 0.12;

// A leading "Outlet:"/"Report:"/"Sources:" attribution prefix is scaffolding
// for a news headline, not part of the actual fact — left in, it pollutes
// the token set with outlet-name noise ("nfl", "network") that dilutes the
// similarity score against every other outlet's un-prefixed headline for
// the same event. Same pattern already used in socialPayload.js for the
// same reason; duplicated here (rather than imported) to keep this module's
// only dependency on that file nonexistent — found live in production data:
// "NFL Network: Seahawks, DT Leonard Williams agree to three-year, $90M
// extension" was scoring just under threshold against FOX's un-prefixed
// "Seahawks Reportedly Extend Star DL Leonard Williams On 3-Year Deal"
// (0.308 vs. the 0.32 team-aware bar) for exactly this reason.
const SOURCE_PREFIX_PATTERN =
  /^(?:NFL Network|NFL\.com|ESPN|FOX Sports|Fox Sports|Pro Football Talk|PFT|NBC Sports|CBS Sports|Yahoo Sports|The Athletic|Report|Reports|Source|Sources|Breaking)\s*:\s*/i;

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
  // Generic scheduling/context words — found via a real-data replay to
  // create false "subject" overlap between two headlines about entirely
  // different people who just happen to share a day-of-week, phase-of-
  // season, or generic severity idiom ("Chiefs...Preseason Finale vs.
  // Seahawks Friday" vs. "Cam Ward's preseason struggles...vs. Seahawks" —
  // "preseason" alone made these look like the same subject; "Rejzohn
  // Wright...season-ending hip injury" vs. "Ty Chandler...season-ending
  // knee injury" — same issue via "ending"). None of these ever identify
  // WHO a headline is about.
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "preseason", "offseason", "finale", "opener", "ending", "week", "night", "game", "games",
  // Generic organizational/role words — "NFL owners..." never identifies a
  // specific subject any more than "the league" does (found via the same
  // replay: "Jed York...meeting of NFL owners" vs. "Owners approve sale of
  // Seahawks..." shared only the word "owners").
  "owner", "owners", "commissioner", "meeting", "nfl",
  // Function words that survive titleTokens()'s stopword filter (which
  // covers "is/are/was/were" but not "has/have/had"/"not", and not
  // pronouns) but are never a subject either way — found via the same
  // replay: "Todd Monken on Shedeur Sanders...excited...for HIM" and
  // "Dillon Gabriel will start...Taylen Green will back HIM up" shared
  // only the pronoun "him", nothing about either headline's actual subject.
  "has", "have", "had", "not",
  "he", "him", "himself", "she", "her", "herself", "it", "itself", "they", "them", "themselves",
]);

function stripPositionPhrases(text) {
  let out = text;
  for (const re of POSITION_PHRASES) out = out.replace(re, " ");
  return out;
}

// Collapses verb-tense/inflection variants of the same transaction/status
// word down to one canonical token before scoring — same word families as
// GENERIC_EVENT_WORDS above, just mapped to a representative form instead
// of being dropped, since here they need to still COUNT toward similarity
// (dropping them would erase a real, meaningful signal that two headlines
// describe the same kind of event). Found live in production: PFT's
// "Report: Browns to release WR Cedric Tillman" ("release") scored 0.300
// against FOX's "Browns Reportedly Releasing Former 3rd-Round Pick Cedric
// Tillman" ("releasing") — just under the 0.32 team-aware threshold —
// purely because "release" and "releasing" tokenize as two unrelated words
// with no stemming, fragmenting what should have been a shared token.
const VERB_STEM_GROUPS = [
  ["trade", "trades", "traded", "trading"],
  ["acquire", "acquires", "acquired", "acquiring"],
  ["sign", "signs", "signed", "signing"],
  ["release", "releases", "released", "releasing"],
  ["waive", "waives", "waived", "waiving"],
  ["cut", "cuts", "cutting"],
  ["activate", "activates", "activated", "activating"],
  ["promote", "promotes", "promoted", "promoting"],
  ["injure", "injures", "injured", "injuring", "injury", "injuries"],
  ["suffer", "suffers", "suffered", "suffering"],
  ["diagnose", "diagnoses", "diagnosed", "diagnosis"],
  ["confirm", "confirms", "confirmed", "confirming"],
  ["fail", "fails", "failed", "failing"],
  ["retire", "retires", "retired", "retiring", "retirement"],
  ["fire", "fires", "fired", "firing"],
  ["hire", "hires", "hired", "hiring"],
  ["suspend", "suspends", "suspended", "suspending", "suspension"],
  ["clear", "clears", "cleared", "clearing"],
  ["return", "returns", "returned", "returning"],
  ["rule", "rules", "ruled", "ruling"],
  ["place", "places", "placed", "placing"],
  ["extend", "extends", "extended", "extending", "extension"],
  ["agree", "agrees", "agreed", "agreeing"],
];
const VERB_STEM_MAP = new Map();
for (const group of VERB_STEM_GROUPS) {
  for (const word of group) VERB_STEM_MAP.set(word, group[0]);
}
function stemToken(token) {
  return VERB_STEM_MAP.get(token) ?? token;
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
  const withoutPrefix = text.replace(SOURCE_PREFIX_PATTERN, "");
  const teams = detectTeams(withoutPrefix);
  const stripWords = new Set();
  for (const abbr of teams) {
    const team = TEAMS.find((t) => t.abbr === abbr);
    if (!team) continue;
    for (const phrase of [team.name, team.nickname, team.city, ...team.aliases]) {
      for (const w of phrase.toLowerCase().split(/\s+/)) stripWords.add(w);
    }
  }

  const tokens = titleTokens(stripPositionPhrases(withoutPrefix));
  const result = new Set();
  for (const t of tokens) {
    if (stripWords.has(t)) continue;
    if (POSITION_ABBR_TOKENS.has(t)) continue;
    if (SUFFIX_TOKENS.has(t)) continue;
    result.add(stemToken(t));
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
 * The subject a candidate's reporting CONFIDENTLY agrees on — a token must
 * appear in a strict majority of the candidate's own headlines to count,
 * not just any one of them. This exists specifically so a subject mentioned
 * only once, incidentally, alongside the story's real subject (e.g. "OT
 * Braden Smith, DL Ali Gaye carted off" — Gaye is a one-off co-mention, not
 * what the story is about) doesn't count as a confirmed subject once
 * later, Smith-only reporting has joined the same story. Used only to gate
 * the excerpt-corroboration rescue below — the primary per-headline
 * subject-disjoint hard block above is unaffected and still runs first.
 */
export function confidentSubjectTokens(headlines) {
  const perHeadline = headlines.map((h) => subjectTokens(normalizeHeadlineTokens(h)));
  const n = perHeadline.length;
  if (n === 0) return new Set();
  const minCount = n === 1 ? 1 : Math.ceil((n + 1) / 2);
  const counts = new Map();
  for (const set of perHeadline) {
    for (const t of set) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const result = new Set();
  for (const [t, c] of counts) {
    if (c >= minCount) result.add(t);
  }
  return result;
}

/**
 * Whether `articleTypes` introduces a type the candidate's `storyTypes`
 * don't already have, in a way that should block the match — see
 * ESCALATION_TYPES in eventType.js for the two-tier reasoning. An
 * escalation type (a diagnosis, a reversal, a status change) is ALWAYS a
 * conflict when new, even onto a story with no established type yet. A
 * base type (a plain classifyCategory bucket, or "release") is only a
 * conflict once the story has already committed to a different base type —
 * a vague, type-less first report (e.g. "Player carted off") can freely
 * pick up its first real characterization from a later source without that
 * counting as a contradiction.
 */
function introducesConflictingType(articleTypes, storyTypes) {
  const newEscalation = [...articleTypes].some((t) => ESCALATION_TYPES.has(t) && !storyTypes.has(t));
  if (newEscalation) return true;

  // The "free first characterization" leniency only applies to a story with
  // NO specific type at all yet (base or escalation) — a genuinely blank
  // slate like a bare "Player carted off" headline. A story whose only
  // established type is an ESCALATION one (e.g. "cleared_status" from
  // "Player returns to practice") is NOT blank — it already represents a
  // specific development, so a later article introducing an unrelated base
  // type (e.g. "contract") must still be treated as a conflict. Found via
  // a real-data replay: "Christian Gonzalez returns to Patriots practice"
  // (cleared_status only, no base type) was otherwise free to absorb the
  // unrelated "Christian Gonzalez: Contract talks are 'frustrating'" story
  // purely because it had no BASE type recorded, even though it clearly
  // wasn't a blank slate.
  const storyHasAnySpecificType = [...storyTypes].some((t) => t !== UNSPECIFIC_TYPE);
  if (!storyHasAnySpecificType) return false;

  const storyBaseTypes = new Set([...storyTypes].filter((t) => t !== UNSPECIFIC_TYPE && !ESCALATION_TYPES.has(t)));
  const articleBaseTypes = new Set([...articleTypes].filter((t) => t !== UNSPECIFIC_TYPE && !ESCALATION_TYPES.has(t)));
  return [...articleBaseTypes].some((t) => !storyBaseTypes.has(t));
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
 *      on its own, on EITHER side of the comparison — see
 *      introducesConflictingType/ESCALATION_TYPES above.
 *   6. Excerpt/description corroboration — a narrow rescue for a candidate
 *      that clears guards 4 and 5 but falls short of the headline-score
 *      threshold in step 3. Real example this exists for: "OT Braden
 *      Smith, DL Ali Gaye carted off for Texans" vs. "Source: Texans
 *      believe RT Smith has foot injury" score only 0.167 on headlines
 *      alone (an action-only headline and a diagnosis-only headline for
 *      the same practice injury just don't share much vocabulary), but
 *      both articles' descriptions independently reference the same
 *      practice/day/opponent/cart-off. This is corroborating EVIDENCE for
 *      an already-plausible same-event candidate, never a standalone
 *      signal: it only runs when (a) teams already match, (b) the
 *      candidate's CONFIDENT subject (see confidentSubjectTokens — a
 *      one-off co-mentioned player like Gaye above doesn't qualify once
 *      Smith-specific reporting has joined) overlaps the article's
 *      subject, and (c) the event-type gate in step 5 already passed —
 *      meaning a genuine new development (a diagnosis, a reversal) is
 *      blocked outright before excerpt text is ever consulted, exactly so
 *      a later article's boilerplate restatement of old background facts
 *      ("...was carted off during Wednesday's practice...") can never
 *      outweigh its own new escalation signal ("...tore his ACL...").
 * Guards 4 and 5 are hard blocks, not scored factors, and guard 6 is a
 * rescue only for an otherwise-plausible candidate, never a way around 4/5:
 * per spec, an ambiguous or conflicting case should default to a NEW story
 * rather than risk silently swallowing a real development, since missing an
 * occasional cross-outlet duplicate is far less costly than suppressing a
 * legitimate new social post.
 * Deterministic and free — no AI call needed to make the clustering
 * decision itself.
 *
 * `article` = { headline, teams, text?, excerpt? } — text (headline +
 * excerpt, when available) feeds the event-type check for a stronger
 * signal than the headline alone; excerpt (on its own, not concatenated
 * with the headline) feeds the corroboration check in step 6. Both fall
 * back to being skipped if omitted.
 * `candidates` is an array of { id, headline, sourceHeadlines, teams,
 * lastUpdatedAt, sourceDescriptions? }.
 */
export function pickBestMatch(article, candidates) {
  const now = Date.now();
  const articleText = article.text || article.headline;
  const articleTokens = normalizeHeadlineTokens(article.headline);
  const articleSubject = subjectTokens(articleTokens);
  const articleTypes = detectEventTypes(articleText);
  const articleExcerptTokens = article.excerpt ? normalizeHeadlineTokens(article.excerpt) : null;

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
    if (introducesConflictingType(articleTypes, storyTypes)) continue;

    const threshold = sharesTeam ? TEAM_AWARE_THRESHOLD : TEAM_AGNOSTIC_THRESHOLD;

    let candidateScore = null;
    if (normScore >= threshold) {
      candidateScore = normScore;
    } else if (sharesTeam && articleExcerptTokens && candidate.sourceDescriptions?.length) {
      const confidentSubject = confidentSubjectTokens(candidateHeadlines);
      const sharedIdentityTokens = new Set([...confidentSubject].filter((t) => articleSubject.has(t)));
      if (sharedIdentityTokens.size > 0) {
        let bestExcerptScore = 0;
        let bestContextOverlapCount = 0;
        for (const desc of candidate.sourceDescriptions) {
          if (!desc) continue;
          const descTokens = normalizeHeadlineTokens(desc);
          const score = jaccardSimilarity(articleExcerptTokens, descTokens);
          if (score > bestExcerptScore) {
            bestExcerptScore = score;
            // Counted separately from the score above: how many of the
            // overlapping tokens are CONTEXT (not a team: token, and not
            // part of the identity this candidate was already selected
            // on) — i.e., evidence beyond the subject/team match already
            // established. Restating the subject's own name and team in
            // both excerpts (which any two stories about the same
            // person/team will do, related or not) must never be enough
            // on its own; requiring >=2 real context overlaps means the
            // corroboration has to include something concrete shared
            // beyond identity — the same practice, the same day, the same
            // opponent (see the Braden Smith case this mechanism exists
            // for). Found via a real-data replay: "Jayden Daniels: I've
            // said everything about my LSU jersey number" cleared the
            // ratio threshold against an unrelated joint-practice story
            // purely because both excerpts restate "Commanders quarterback
            // Jayden Daniels" — zero real shared context, but 3 identity
            // tokens (first name, last name, team) were enough to pass a
            // ratio-only check.
            let contextOverlap = 0;
            for (const t of articleExcerptTokens) {
              if (t.startsWith("team:") || sharedIdentityTokens.has(t)) continue;
              if (descTokens.has(t)) contextOverlap++;
            }
            bestContextOverlapCount = contextOverlap;
          }
        }
        if (bestExcerptScore >= EXCERPT_CORROBORATION_THRESHOLD && bestContextOverlapCount >= 2) {
          candidateScore = normScore;
        }
      }
    }

    if (candidateScore !== null && (best === null || candidateScore > best.score)) {
      best = { storyId: candidate.id, score: candidateScore };
    }
  }

  return best;
}
