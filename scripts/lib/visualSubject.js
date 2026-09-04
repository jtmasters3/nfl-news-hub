// Determines what a story's social-media visual should actually feature:
// the primary subject (player/coach/executive/team/event), their CURRENT
// team (derived from the newest source reporting, never a stale/historical
// assumption), and a fallback text search query built from both. Pure text
// analysis over already-extracted players/teams/sources — no network I/O,
// so this is cheap to recompute on every refresh (see generate-content.js).
import { TEAMS, detectTeams, teamName } from "./teams.js";
import { extractLikelyPlayerNames } from "./extraction.js";

const COACH_TITLES = ["Head Coach", "Coach", "Coordinator", "Defensive Coordinator", "Offensive Coordinator"];
const EXECUTIVE_TITLES = ["General Manager", "GM", "Owner", "Commissioner", "President", "Executive"];

// "<Title> <Name>" — e.g. "Head Coach Andy Reid", "Commissioner Roger
// Goodell". Deliberately requires a real capitalized 2-3 word name right
// after the title; a bare title with no name attached is left unmatched
// (see determineVisualSubject — no name means no confident subject).
function findTitledPerson(text, titles) {
  for (const title of titles) {
    const re = new RegExp(`\\b${title}\\b\\s+([A-Z][a-z]+(?:\\s[A-Z][a-z.]+){1,2})`, "");
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

// Same reason extraction.js never reads headlines for players[] in the
// first place: some outlets (FOX Sports, consistently) Title-Case every
// headline word. That defeats consecutive-capitalized-words-as-a-name
// detection two ways at once — a real name greedily glues onto trailing
// filler words ("Deshaun Watson Apologizes For" gets thrown out entirely
// because of "For"), while unrelated filler-word runs elsewhere in the
// same headline masquerade as a name ("Being Named" survives the filter).
// Both were reproduced against live FOX Sports headlines during testing.
// Detected by a normally-lowercase function word appearing capitalized
// anywhere but the very first word — a cheap, reliable style tell that
// doesn't require knowing the outlet.
const TITLE_CASE_TELLS = new Set([
  "For", "With", "To", "Of", "And", "Is", "Are", "The", "About", "After",
  "Being", "From", "At", "In", "On", "As", "By", "Or", "But", "That",
]);

function looksTitleCased(headline) {
  const words = headline.split(/\s+/).slice(1);
  return words.some((w) => TITLE_CASE_TELLS.has(w.replace(/[^A-Za-z]/g, "")));
}

// Even a normal sentence-case headline can start with a capitalized
// non-person noun phrase ("Everbank Stadium getting renovated", "Recovery
// Mode" from an "NFL Catchup: ..." listicle summary, "Being Named QB1")
// that still passes extraction.js's generic name filter, which wasn't
// designed to see headline-shaped text in the first place. This list is
// specific to the headline-fallback path only — it never touches
// extraction.js or what ends up in story.players — and is built from
// concrete false positives found while testing this feature against live
// data, the same way extraction.js's own filters were built.
const HEADLINE_FALLBACK_REJECT_WORDS = new Set([
  "Stadium", "Arena", "Field", "Mode", "Watch", "Cut", "Injured", "Being",
  "Named", "Reportedly", "Swap", "Gets", "Another", "Making", "Pack",
  "Top", "Recovery", "Odds", "Catchup", "Roundup", "Update", "Grades",
  "Takeaways", "Notebook", "Activated", "Stream", "Live", "Channel",
]);

// A real two-word person name essentially never has a team nickname/city
// as one of its two words ("Young Steelers" from "Young Steelers QBs Will
// Howard, Drew Allar subpar..." was a live false positive) — headline
// text just happens to put an adjective next to a team name often enough
// that this is worth guarding, headline-fallback-only, same as above.
const TEAM_WORDS_FOR_HEADLINE_GUARD = new Set(
  TEAMS.flatMap((t) => [t.name, t.city, t.nickname, ...t.aliases]).flatMap((s) => s.split(" "))
);

function looksLikeHeadlineFallbackGarbage(words) {
  return words.some((w) => HEADLINE_FALLBACK_REJECT_WORDS.has(w) || TEAM_WORDS_FOR_HEADLINE_GUARD.has(w));
}

/**
 * @param {{headline: string, combinedText: string, players: string[], teams: string[], category: string}} input
 * @returns {{visual_subject: string|null, visual_subject_type: string|null, subject_match_count: number}}
 */
export function determineVisualSubject({ headline, combinedText, players, teams, category }) {
  // 1. A specific player, when confidently the subject: exactly one
  // extracted player name that actually appears in the headline (not just
  // buried in a source description), OR — with multiple players detected —
  // whichever one appears earliest in the headline itself.
  //
  // players[] only ever comes from DESCRIPTION text (see extraction.js) —
  // several outlets Title-Case every headline word, which defeats that
  // heuristic there. But plenty of headlines ("Alec Pierce may return to
  // practice this week") are normal sentence case and name the player
  // outright while a terse description doesn't repeat the name at all —
  // that story's visual subject would otherwise wrongly fall back to a
  // team. So: fall back to running the SAME hardened extraction function
  // directly on the headline when the description-derived list has no
  // headline match. This reuses the existing name/entity/team/reporter
  // filtering as-is rather than weakening it — it never changes what goes
  // into story.players itself, only what this function is willing to
  // consider as a visual-subject candidate.
  const candidates =
    players.length > 0 || looksTitleCased(headline)
      ? players
      : extractLikelyPlayerNames(headline).filter((name) => !looksLikeHeadlineFallbackGarbage(name.split(" ")));
  if (candidates.length > 0) {
    const inHeadline = candidates.filter((p) => headline.includes(p));
    if (inHeadline.length === 1) {
      // subject_match_count: additive field, added for the Editorial
      // Scoring Brain's Phase 2C identity resolver — a confident, single
      // headline candidate is distinguishable from the weaker multi-
      // candidate "earliest in headline" fallback below, which this
      // function has always computed internally but never exposed. Purely
      // additive: this function's only production caller
      // (generate-content.js) destructures only { visual_subject,
      // visual_subject_type } and is unaffected by the extra field.
      return { visual_subject: inHeadline[0], visual_subject_type: "player", subject_match_count: 1 };
    }
    if (inHeadline.length > 1) {
      const earliest = inHeadline.reduce((best, p) =>
        headline.indexOf(p) < headline.indexOf(best) ? p : best
      );
      return { visual_subject: earliest, visual_subject_type: "player", subject_match_count: inHeadline.length };
    }
  }

  // 2. A named coach/executive who is the subject.
  const coach = findTitledPerson(combinedText, COACH_TITLES);
  if (coach) return { visual_subject: coach, visual_subject_type: "coach", subject_match_count: 0 };
  const exec = findTitledPerson(combinedText, EXECUTIVE_TITLES);
  if (exec) return { visual_subject: exec, visual_subject_type: "executive", subject_match_count: 0 };

  // 3. A single dominant team (team-wide news with no individual subject).
  if (teams.length === 1) {
    return { visual_subject: teamName(teams[0]), visual_subject_type: "team", subject_match_count: 0 };
  }

  // 4. League-wide event (draft, combine) with no single player/team focus.
  if (category === "draft" && /\bdraft\b/i.test(headline)) {
    return { visual_subject: "NFL Draft", visual_subject_type: "event", subject_match_count: 0 };
  }

  // 5. Nothing confident enough — leave empty rather than guess.
  return { visual_subject: null, visual_subject_type: null, subject_match_count: 0 };
}

// A team name/nickname is at most a handful of capitalized (or digit-led,
// for "49ers") tokens — "Kansas City Chiefs", "San Francisco 49ers", "New
// England Patriots". Bounding the token count (rather than scanning until
// the next punctuation mark) matters because a source's headline and
// description are concatenated with just a space, not a period — an
// unbounded capture would run straight through into a LATER, unrelated
// team mention later in the same string (e.g. an older team named in the
// rest of the sentence) with nothing to stop it.
const TEAM_NAME_CAPTURE = "([A-Z][A-Za-z0-9']*(?:\\s+[A-Z0-9][A-Za-z0-9']*){0,3})";

// No "i" (case-insensitive) flag on any of these, despite the trigger
// words below being hand-cased for both sentence-initial and mid-sentence
// use — verified during the social-payload audit that the "i" flag
// silently defeats TEAM_NAME_CAPTURE's own [A-Z0-9] "must start with a
// capital" guard on its continuation tokens (under /i, [A-Z0-9] matches
// lowercase too), letting the capture run on into ordinary lowercase
// words right after the real team name ("to the Texans this week"
// captured as "Texans this week", which then no longer matches exactly
// one known team and silently falls through to a stale-team fallback —
// reproduced live on a Kayshon Boutte/Texans story where a later source's
// phrasing happened to trigger it). Case-sensitivity here is the actual
// signal that separates a proper noun from a random word, so it must
// never be relaxed by a blanket flag.
const TEAM_JOIN_PATTERNS = [
  new RegExp(`\\b[Tt]rad(?:e[sd]?|ing)\\b[^.]{0,60}?\\b[Tt]o\\s+(?:[Tt]he\\s+)?${TEAM_NAME_CAPTURE}`),
  new RegExp(`\\b[Ss]ign(?:s|ed|ing)?\\b[^.]{0,60}?\\b[Ww]ith\\s+(?:[Tt]he\\s+)?${TEAM_NAME_CAPTURE}`),
  new RegExp(`\\b[Aa]grees?\\s+to\\s+terms\\s+with\\s+(?:[Tt]he\\s+)?${TEAM_NAME_CAPTURE}`),
  new RegExp(`\\b[Cc]laimed\\b[^.]{0,60}?\\b[Bb]y\\s+(?:[Tt]he\\s+)?${TEAM_NAME_CAPTURE}`),
  new RegExp(`\\b[Jj]oins?\\b[^.]{0,60}?\\b[Tt]he\\s+${TEAM_NAME_CAPTURE}`),
];

// Team-first phrasing: "Chiefs sign RB Kenneth Walker III", "Chiefs trade for WR ...".
// Same no-"i"-flag reasoning as above.
const TEAM_FIRST_PATTERN =
  /^([A-Z][A-Za-z0-9']*(?:\s+[A-Z0-9][A-Za-z0-9']*){0,3})\s+(?:sign|signs|trade for|trades for|acquire|acquires|claim|claims|agree to terms with|agrees to terms with)\b/;

/** Resolves free-text like "the Kansas City Chiefs" to exactly one known team, or null if ambiguous/unmatched. */
function resolveOneTeam(text) {
  const found = detectTeams(text);
  return found.length === 1 ? teamName(found[0]) : null;
}

// A team mentioned alongside a departure verb ("Jets cut Cade York", "...
// Set For College Return After Being Waived By Seahawks") is the team the
// player is LEAVING, not their current team — verified against live PFT/
// FOX data during testing, where the single-team-mention fallback below
// was otherwise assigning the releasing team as current_team. When this
// matches and no join-direction pattern matched anywhere in the cluster
// (checked first, in detectCurrentTeam), the honest answer is "unknown",
// not "the team that just cut him."
const DEPARTURE_PATTERN = /\b(cut|cuts|release[sd]?|releasing|waive[sd]?|waiving|parts? ways with)\b/i;

// Exported (previously module-private) for the Editorial Scoring Brain's
// Phase 2C identity resolver, which needs to know SPECIFICALLY whether a
// genuine transaction-direction match fired for a given source's text —
// detectCurrentTeam() below already uses this internally but only ever
// returns a plain team name/null, with no way for a caller to tell "found
// via transaction language" apart from "found via a passive single
// mention." No logic change; this is the exact same function
// detectCurrentTeam has always called, exported to avoid a second,
// duplicate transaction-direction implementation.
export function findTransactionTeam(text) {
  const headlineFirst = TEAM_FIRST_PATTERN.exec(text);
  if (headlineFirst) {
    const resolved = resolveOneTeam(headlineFirst[1]);
    if (resolved) return resolved;
  }
  for (const pattern of TEAM_JOIN_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const resolved = resolveOneTeam(m[1]);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Derives the CURRENT team for a player/coach/executive subject. Never
 * falls back to a static player->team dictionary (none exists in this
 * codebase) or to an old story's stale team mention — only ever from:
 * transaction-direction language in the newest source, then older sources
 * in the same cluster, then the newest source's own team mention, then
 * (only if unambiguous) the story-wide detected teams. Returns null the
 * moment two signals disagree rather than guessing.
 *
 * @param {{sources: Array<{headline: string, description: string, published_at: string|null, discovered_at: string}>, teams: string[]}} story
 */
export function detectCurrentTeam(story) {
  const bySource = [...story.sources].sort((a, b) => {
    const at = Date.parse(a.published_at ?? a.discovered_at ?? 0) || 0;
    const bt = Date.parse(b.published_at ?? b.discovered_at ?? 0) || 0;
    return bt - at; // newest first
  });

  // 1 & 2: transaction-direction language, newest source first, then each
  // older source in the cluster as corroboration.
  for (const source of bySource) {
    const text = `${source.headline} ${source.description || ""}`;
    const team = findTransactionTeam(text);
    if (team) return team;
  }

  // A departure verb with no matching join-direction pattern anywhere in
  // the cluster (checked above) means the player is leaving whatever team
  // is mentioned, not staying on it — stop here rather than let steps 3/4
  // below mistake the releasing team for the current one.
  if (bySource.length > 0) {
    const newestText = `${bySource[0].headline} ${bySource[0].description || ""}`;
    if (DEPARTURE_PATTERN.test(newestText)) return null;
  }

  // 3: the newest source's own single team mention (current structured
  // context), even with no explicit transaction verb.
  if (bySource.length > 0) {
    const newest = bySource[0];
    const team = resolveOneTeam(`${newest.headline} ${newest.description || ""}`);
    if (team) return team;
  }

  // 4: existing deterministic team detection, but only if it agrees with
  // itself (exactly one team across the whole story) — two-or-more means
  // an old and a new association are both present, which is precisely the
  // stale-team trap this function exists to avoid, so it stays unknown.
  if (story.teams.length === 1) return teamName(story.teams[0]);

  return null;
}

export function buildVisualSearchQuery({ visual_subject, visual_subject_type, current_team }) {
  if (!visual_subject) return null;
  const year = new Date().getFullYear();

  if (visual_subject_type === "player" || visual_subject_type === "coach" || visual_subject_type === "executive") {
    return current_team ? `${visual_subject} ${current_team} ${year}` : `${visual_subject} NFL ${year}`;
  }
  if (visual_subject_type === "team") {
    return `${visual_subject} ${year}`;
  }
  if (visual_subject_type === "event") {
    return visual_subject;
  }
  return `${visual_subject} ${year}`;
}
