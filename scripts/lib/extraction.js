import { TEAMS } from "./teams.js";

// ---------------------------------------------------------------------------
// Category classification — deterministic keyword rules. This is the only
// categorization path (no AI, $0 cost).
// ---------------------------------------------------------------------------

const CATEGORY_RULES = [
  { category: "suspension", patterns: [/\bsuspend(ed|s|ing)?\b/i, /\bbanned\b/i] },
  { category: "retirement", patterns: [/\bretir(e|es|ed|ement|ing)\b/i] },
  { category: "trade", patterns: [/\btrade[sd]?\b/i, /\btrading\b/i, /\bacquire[sd]?\b/i, /\bswap\b/i] },
  {
    category: "injury",
    patterns: [/\binjur(y|ies|ed)\b/i, /\bACL\b/, /\bMCL\b/, /\bconcussion\b/i, /\bIR\b/, /\bout for the season\b/i, /\bsurgery\b/i, /\bMRI\b/i],
  },
  {
    category: "contract",
    patterns: [/\bcontract\b/i, /\bextension\b/i, /\bdeal worth\b/i, /\bsigns?\b.*\$/i, /\bagrees? to terms\b/i],
    // Guards against "has NOT agreed to a contract extension" etc. matching
    // the contract category just because the word "contract" appears.
    negativePatterns: [
      /\b(has|have|had)\s+not\s+(yet\s+)?(agreed|reached|signed)\b/i,
      /\bno\s+(new\s+)?(contract|deal|extension)\b/i,
      /\bwithout\s+a\s+(new\s+)?(contract|deal)\b/i,
      /\bhasn'?t\s+(signed|agreed)\b/i,
    ],
  },
  { category: "free_agency", patterns: [/\bfree agen(t|cy)\b/i, /\bunrestricted\b/i, /\breleased\b/i, /\bwaived\b/i, /\bcut\b/i] },
  { category: "draft", patterns: [/\bdraft\b/i, /\bcombine\b/i, /\bmock draft\b/i, /\bprospect\b/i] },
  { category: "fantasy", patterns: [/\bfantasy\b/i, /\bwaiver wire\b/i, /\bstart.?sit\b/i, /\bDFS\b/] },
  { category: "coaching", patterns: [/\bcoach(ing)?\b/i, /\bcoordinator\b/i, /\bfired\b/i, /\bhead coach\b/i] },
  { category: "roster_move", patterns: [/\bsign(s|ed|ing)?\b/i, /\bpromote[sd]?\b/i, /\bactivat(e|ed|es)\b/i, /\bpractice squad\b/i] },
];

export function classifyCategory(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.negativePatterns?.some((p) => p.test(text))) continue;
    if (rule.patterns.some((p) => p.test(text))) return rule.category;
  }
  return "league_news";
}

const RUMOR_PATTERNS = [
  /\baccording to (a|one) source\b/i,
  /\breportedly\b/i,
  /\bper (a )?source\b/i,
  /\bcould (be|land|join)\b/i,
  /\bexpected to\b/i,
  /\bmulling\b/i,
  /\brumor(ed)?\b/i,
  /\bmay be (open|willing)\b/i,
  /\bhas (interest|been linked)\b/i,
];

export function looksLikeRumor(text) {
  return RUMOR_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Importance scoring — deterministic keyword tiers. This is the only
// scoring path (no AI, $0 cost).
// ---------------------------------------------------------------------------

export function estimateImportance(text) {
  const t = text.toLowerCase();

  const tier10 = [
    "traded", "trade for", "fires", "fired", "retires", "retirement",
    "torn acl", "out for the season", "suspended", "wins the super bowl",
    "super bowl", "champion",
  ];
  const tier89 = [
    "signs", "agrees to terms", "extension", "starting quarterback",
    "season-ending", "mri", "surgery", "activates", "released", "waived",
  ];
  const tier67 = ["injury", "questionable", "promoted", "practice squad", "returns from"];

  if (tier10.some((k) => t.includes(k))) return 10;
  if (tier89.some((k) => t.includes(k))) return 8;
  if (tier67.some((k) => t.includes(k))) return 6;
  return 4;
}

// ---------------------------------------------------------------------------
// Player name extraction — deterministic, deliberately conservative. This is
// the only player-detection path (no AI). It only looks at description text
// (never headlines, which are often Title Case and defeat the heuristic),
// and rejects any candidate touching a common non-name word. Better to leave
// a story's players empty than to guess wrong.
// ---------------------------------------------------------------------------

const TEAM_WORDS = new Set(
  TEAMS.flatMap((t) => [t.name, t.city, t.nickname, ...t.aliases]).flatMap((s) => s.split(" "))
);

const NON_NAME_PHRASES = new Set([
  "NFL", "NFL Draft", "Pro Bowl", "Super Bowl", "Week", "Monday Night",
  "Sunday Night", "Thursday Night", "Free Agency", "Training Camp",
  "Mock Draft", "Player Health", "Chief Medical", "Roster Cuts",
  "Hall Of Fame", "Hall of Fame", "Hall of Fame Game",
]);

// Pure function words — articles, pronouns, conjunctions, prepositions,
// auxiliary/copula verbs, question words. These get capitalized purely by
// sentence-position ("Is Patrick Mahomes still...", "The Cowboys...",
// "After being booed...") and are NEVER part of an actual person's name,
// so they're safe to both strip from the leading position (see
// STRIPPABLE below) and reject outright if one somehow survives in a
// non-leading position.
const GRAMMAR_WORDS = new Set([
  "The", "A", "An", "This", "That", "These", "Those", "His", "Her", "Their",
  "Its", "Our", "Your", "He", "She", "They", "It", "We", "You", "I",
  "But", "And", "Or", "So", "If", "When", "While", "Since", "As", "On",
  "In", "At", "For", "With", "To", "From", "After", "Before", "Over",
  "Into", "About", "During", "Following", "Amid", "Per", "According",
  "There", "Here", "What", "Who", "How", "Why", "Despite",
  "Is", "Are", "Was", "Were", "Be", "Been", "Has", "Have", "Had", "Does",
  "Do", "Did", "Will", "Would", "Should", "Could", "Can", "May", "Might",
]);

// Role/title words that precede a reporter's/coach's/executive's name in an
// attribution or title clause ("NFL Network Insider Ian Rapoport",
// "Cornerback Christian Gonzalez has...", "Commissioner Roger Goodell
// said...", "Coach Mike Tomlin..."). Legitimately followed by a real name,
// so — like GRAMMAR_WORDS — these are STRIPPED from the leading position
// rather than causing the whole match to be discarded.
const STRIPPABLE_TITLES = new Set([
  "Insider", "Network", "Reporter", "Analyst", "Correspondent",
  "Contributor", "Columnist", "Writer", "Commissioner", "Owner",
  "Cornerback", "Quarterback", "Linebacker", "Fullback", "Kicker", "Punter",
  "Safety", "Guard", "Tackle", "Center", "Receiver", "Running", "Wide",
  "Tight", "Defensive", "Offensive", "Rookie", "Veteran", "Star", "Pro",
  "Free", "Edge", "Nose", "Strong", "Long", "Punt", "Kick", "Returner",
  "Snapper", "Coach", "Coaches",
]);

// The word combining GRAMMAR_WORDS and STRIPPABLE_TITLES — everything
// that's safe to peel off the front of a candidate.
const STRIPPABLE_LEADING = new Set([...GRAMMAR_WORDS, ...STRIPPABLE_TITLES]);

// Content words that are ambiguous enough to be common in non-name
// contexts (numbers/ordinals, "New"/"Old", generic wire-copy prefixes like
// "Report:"/"Sources say") — ONLY ever cause outright rejection, never get
// stripped. Stripping these is what previously turned "New York Times"
// into the false positive "York Times": treating a content word like a
// disposable title/grammar word left a garbage remainder standing in for
// a whole organization's name.
const NON_STRIPPABLE_REJECT_WORDS = new Set([
  "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "First", "Second", "Third", "Last", "Next", "New", "Old",
  "Report", "Reports", "Sources", "Source", "Team", "Teams",
]);

// Words that mean the candidate is an organization, publication, government
// body, geographic/tribal entity, generic descriptor, or job title rather
// than a person — reject the WHOLE candidate if any of these appear
// anywhere in it (not just leading, unlike STRIPPABLE_TITLES above). Built
// from concrete false positives seen in production (British Medical
// Journal, Navajo Nation, Harris County Sheriff, Flag Football World,
// Football Operations, Jaguars Executive, Physically Unable, Brothers
// Matt, Hall of Fame Game) generalized into categories, not just those
// exact strings, so the same class of mistake elsewhere gets caught too.
const ENTITY_WORDS = new Set([
  // Organizations / institutions
  "Nation", "County", "State", "City", "District", "Territory", "Republic",
  "Committee", "Department", "Office", "Agency", "Association", "Council",
  "Bureau", "Authority", "Commission", "Corporation", "Company", "Group",
  "Board", "Union", "League", "University", "College", "Hospital",
  "Foundation", "Institute", "Society", "Academy", "School", "Center",
  "Centre", "Operations", "Executive",
  // Government / law enforcement
  "Sheriff", "Police", "Court", "Attorney", "Prosecutor",
  // Publications / media outlets
  "Journal", "Times", "Post", "Tribune", "Herald", "Gazette", "News",
  "Press", "Magazine", "Chronicle",
  // Generic descriptors that showed up in garbage matches
  "World", "Game", "Fame", "Football", "Brothers", "Count", "Physically",
  "Unable", "Medical", "British",
]);

// Well-known NFL reporters, insiders, and staff analysts/columnists/media
// personalities whose names constantly appear as the subject of analysis
// pieces ("Chad Reuter grades...", "Mike Clay provides his draft
// blueprint..."), which is structurally identical to a player being the
// subject of a news sentence. Not exhaustive — new bylines will still slip
// through occasionally; this list only covers names actually observed in
// testing. Filtered out explicitly since there's no reliable syntactic
// marker separating a columnist byline from real player-does-something
// news.
const KNOWN_REPORTERS = new Set([
  "Adam Schefter", "Ian Rapoport", "Tom Pelissero", "Jordan Schultz",
  "Mike Garafolo", "Jay Glazer", "Josina Anderson", "Field Yates",
  "Dianna Russini", "Jeremy Fowler", "Ben Fennell", "Chris Mortensen",
  "Peter Schrager", "Aaron Wilson", "Ari Meirov", "Josh Alper",
  "Mike Florio", "Charean Williams", "Michael David Smith",
  "Kevin Patra", "Chad Reuter", "Geoff Schwartz", "Mike Clay",
  "Jordan Reid", "Grant Gordon", "Bill Barnwell", "Dan Graziano",
  "Bucky Brooks", "Colin Cowherd", "Lance Zierlein",
]);

export function extractLikelyPlayerNames(text) {
  // Capture up to 4 words so a leading position/role word ("Cornerback
  // Christian Gonzalez", "Receiver Odell Beckham Jr.") can be stripped
  // below without losing the name entirely.
  const regex = /\b[A-Z][a-z]+(?:\s[A-Z][a-z.]+){1,3}\b/g;
  const found = new Set();

  for (const m of text.matchAll(regex)) {
    const match = m[0];
    if (NON_NAME_PHRASES.has(match)) continue;

    // Staff-writer bylines are almost always phrased "<Outlet>'s <Name>"
    // ("Around The NFL's Kevin Patra dives deep...", "ESPN's Adam
    // Schefter reports..."). If the match is immediately preceded by
    // "'s ", it's an attribution, not a player.
    const precedingText = text.slice(Math.max(0, m.index - 4), m.index);
    if (/'s\s*$/.test(precedingText)) continue;

    let words = match.split(" ");
    while (words.length > 2 && STRIPPABLE_LEADING.has(words[0])) {
      words = words.slice(1); // drop a leading grammar word or position/role/title word
    }
    if (words.length < 2) continue;
    if (words.some((w) => GRAMMAR_WORDS.has(w) || NON_STRIPPABLE_REJECT_WORDS.has(w) || ENTITY_WORDS.has(w))) continue; // hits a stoplisted word anywhere
    // Trim to a plausible First [Middle] Last shape BEFORE checking
    // against team words — checking on the untrimmed array let a team
    // name followed by an extra word (e.g. "Las Vegas Raiders Sign")
    // survive, because not *all* of the untrimmed words were team words,
    // even though the trimmed-down phrase (the part actually kept) was.
    if (words.length > 3) words = words.slice(0, 3);
    if (words.every((w) => TEAM_WORDS.has(w))) continue; // whole (trimmed) phrase is a team name

    const name = words.join(" ");
    if (KNOWN_REPORTERS.has(name)) continue;
    found.add(name);
  }

  return Array.from(found).slice(0, 8);
}
