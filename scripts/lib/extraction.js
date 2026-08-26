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
  // Government titles — "Pennsylvania Governor Josh Shapiro says..." should
  // recover "Josh Shapiro", not truncate to "Pennsylvania Governor Josh".
  // See STATE_PREFIXES below for the companion fix (a US state name
  // directly before one of these) — this set alone handles the title
  // appearing at the true leading position ("Governor Josh Shapiro...").
  "Governor", "Senator", "Mayor", "President", "Congressman",
  "Congresswoman", "Representative",
]);

// Single-word US state names, used ONLY to peel a leading "<State>
// <government title>" pair off together (see STRIPPABLE_LEADING below) —
// "Pennsylvania Governor Josh Shapiro" needs both "Pennsylvania" AND
// "Governor" gone to recover "Josh Shapiro", but the state name alone
// isn't in STRIPPABLE_TITLES/GRAMMAR_WORDS so the existing single-word
// strip loop never reaches "Governor" in the first place. Multi-word
// states (New York, North Carolina, ...) aren't needed here: their first
// word ("New") is already in NON_STRIPPABLE_REJECT_WORDS and rejects the
// candidate outright, which is the correct conservative outcome when a
// government title's state prefix can't be cleanly identified as exactly
// one word.
const STATE_NAMES = new Set([
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "Wisconsin", "Wyoming",
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
  // Weekday/time words — a terse wire-style description routinely opens
  // "Asked Tuesday about...", "Speaking Wednesday, the coach said...",
  // where the sentence-initial capital on the verb plus the always-
  // capitalized weekday forms a spurious 2-word "name" ("Asked Tuesday").
  // No real NFL name is a weekday/generic time word, so reject-anywhere
  // is safe with no stripping ambiguity to worry about.
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  "Sunday", "Yesterday", "Today", "Tomorrow", "Weekend", "Tonight",
  "Morning", "Afternoon", "Evening", "Night",
  // "Player"/"Players" is never part of a real name but is extremely
  // common in generic award/role phrases directly after STRIPPABLE_TITLES
  // words like "Defensive"/"Offensive" ("...three-time Defensive Player of
  // the Year..." — "of the Year" is lowercase and breaks the match, so
  // "Defensive Player" alone is what gets captured, and at only 2 words
  // the strip loop's `length > 2` guard never even gets a chance to peel
  // "Defensive" off). Found during the 75-story validation for this fix.
  "Player", "Players",
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
// "Stadium"/"Arena"/"Field" added alongside initials-name support below —
// "C.J."/"T.J."-style two-letter-initials matching also matches plain
// abbreviations like "U.S.", and "U.S. Bank Stadium" would otherwise be a
// new false-positive shape that couldn't occur before that support existed.
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
  // Venues — see comment above
  "Stadium", "Arena", "Field",
  // Equipment/product terms — "Guardian Cap" (NFL-mandated helmet padding)
  // found during the 75-story validation for the person-name-extraction
  // cleanup pass.
  "Guardian", "Cap",
  // Generic descriptors that showed up in garbage matches
  "World", "Game", "Fame", "Football", "Brothers", "Count", "Physically",
  "Unable", "Medical", "British",
]);

// A name immediately followed by one of these verbs is structurally a
// byline, not a player-does-something sentence — "Gennaro Filice
// spotlights 10 things to watch", "Chad Reuter ranks the top prospects".
// This is the PRIMARY byline defense; KNOWN_REPORTERS below only exists
// for names that show up in a phrasing this can't catch. Deliberately
// picked verbs a columnist/analyst is described as doing, not verbs a
// player could just as easily be the real subject of ("explains",
// "writes", "says", "predicts" are common in legitimate player-quote
// sentences too and are excluded for that reason).
const BYLINE_FOLLOWING_VERBS = new Set([
  "spotlights", "ranks", "grades", "previews", "unveils", "unpacks",
  "counts", "breaks", "examines", "surveys",
]);

// Full US state list (all 50, including multi-word ones) — used only to
// detect a "<Place>, <State>" location suffix right after a candidate
// match ("Brook Park, Ohio"), never for per-word stripping (see
// STATE_NAMES above for that narrower, single-word use).
const STATE_NAMES_FOR_LOCATION_SUFFIX = [
  ...STATE_NAMES,
  "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina",
  "North Dakota", "Rhode Island", "South Carolina", "South Dakota",
  "West Virginia",
];
const LOCATION_SUFFIX_PATTERN = new RegExp(
  `^,\\s*(?:${STATE_NAMES_FOR_LOCATION_SUFFIX.join("|")})\\b`
);

// Well-known NFL reporters, insiders, and staff analysts/columnists/media
// personalities whose names constantly appear as the subject of analysis
// pieces ("Chad Reuter grades...", "Mike Clay provides his draft
// blueprint..."), which is structurally identical to a player being the
// subject of a news sentence. Not exhaustive — new bylines will still slip
// through occasionally; this list only covers names actually observed in
// testing that BYLINE_FOLLOWING_VERBS/the "'s "/"By " context checks don't
// already catch. Prefer extending those context clues over adding more
// names here when a byline recurs.
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

// A capitalized name word, in the two shapes real NFL names actually take:
//   - normal: capital + 1+ lowercase, e.g. "Marr", "Chase", "Andre"
//   - apostrophe-led: capital + apostrophe + letters with zero lowercase
//     before the apostrophe, e.g. "D'" in "D'Andre", "O'" in "O'Brien"
// Either shape may then take an internal apostrophe-continuation
// ("Ja" + "'Marr") and/or a hyphenated second capitalized chunk
// ("Amon" + "-Ra", "Gardner" + "-Johnson"). Never matches a bare single
// capital letter with nothing else — that would start matching stray
// list markers/grades ("Tier A") as if they were names, which the
// apostrophe/hyphen requirement on the short branch avoids.
//
// The apostrophe-continuation is deliberately restricted to an UPPERCASE
// letter right after the apostrophe (['’][A-Z][a-z]*), never a general
// [A-Za-z]+ — a real internal-name apostrophe is always followed by a
// capitalized syllable (Ja'Marr, O'Brien), while a possessive marker is
// always a lowercase "s" (Jeanty's, Watson's). A generic class matched
// both, so every legitimately-extracted name immediately followed by its
// own possessive in the source text ("Ashton Jeanty's ankle...") was
// coming out as "Ashton Jeanty's" instead of "Ashton Jeanty" — caught
// during the 50-story validation for this exact fix.
// A compound surname where a short lowercase prefix is immediately
// followed by a second capitalized chunk with NO separator at all — no
// apostrophe, no hyphen, no space — "LaPorta", "McCaffrey", "LeVeon",
// "DeVonta". Found missing entirely during the 75-story validation (real
// current player "Sam LaPorta" never matched anything): the other two
// NAME_WORD branches both require either a lowercase run or an apostrophe
// between the two capitals, and this shape has neither. The prefix list
// is short and closed (common Irish/Scottish/Dutch name-prefix patterns),
// not a general loosening — an unbroken lowercase-then-uppercase
// transition mid-word essentially never occurs in ordinary English prose
// outside of exactly this naming convention.
const COMPOUND_SURNAME_WORD = "(?:Mc|Mac|La|Le|De|Di|Da|Van|Von)[A-Z][a-z]+";

const NAME_WORD =
  `(?:[A-Z][a-z]+(?:['’][A-Z][a-z]*)?|[A-Z]['’][A-Z][a-z]*|${COMPOUND_SURNAME_WORD})(?:-[A-Z][a-z]+(?:['’][A-Z][a-z]*)?)?`;

// Two-letter initials used as a first name — "C.J.", "T.J.", "A.J.",
// "D.J." — always exactly two capital-letter+period pairs, no space
// between them, immediately followed by a real surname.
const INITIALS_WORD = "[A-Z]\\.[A-Z]\\.";

const FIRST_TOKEN = `(?:${INITIALS_WORD}|${NAME_WORD})`;
// Continuation tokens may additionally end in a trailing period — suffix
// abbreviations like "Jr." — same allowance the previous pattern had.
const CONTINUATION_TOKEN = `(?:${INITIALS_WORD}|${NAME_WORD}\\.?)`;

export function extractLikelyPlayerNames(text) {
  // Capture up to 4 words so a leading position/role word ("Cornerback
  // Christian Gonzalez", "Receiver Odell Beckham Jr.") can be stripped
  // below without losing the name entirely.
  const regex = new RegExp(`\\b${FIRST_TOKEN}(?:\\s${CONTINUATION_TOKEN}){1,3}\\b`, "g");
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

    // A name immediately followed by a columnist/analyst-only verb
    // ("Gennaro Filice spotlights...", "Chad Reuter ranks...") is a
    // byline, not the story's subject — see BYLINE_FOLLOWING_VERBS.
    const followingText = text.slice(m.index + match.length, m.index + match.length + 24);
    const followingWordMatch = /^\s+([a-z]+)/.exec(followingText);
    if (followingWordMatch && BYLINE_FOLLOWING_VERBS.has(followingWordMatch[1])) continue;

    // "<Place>, <State>" right after the match means the candidate is a
    // city/place name, not a person — "Brook Park, Ohio" (checked on the
    // untrimmed match, since a place name is never itself a stripped-down
    // government title/grammar prefix).
    if (LOCATION_SUFFIX_PATTERN.test(followingText)) continue;

    let words = match.split(" ");

    // "By <Name>" wire-byline convention — "By Ian Rapoport, NFL.com" —
    // gets captured as ONE match starting with "By" itself ("By" is a
    // valid capitalized word, so nothing stops the regex from attaching
    // it to the name that follows), which means a preceding-text
    // lookbehind can never see it: by the time the match exists, "By" is
    // already inside it, not before it. Checked positionally instead, and
    // rejected outright rather than stripped — stripping "By" and keeping
    // the name would defeat the whole point when the byline names someone
    // not in KNOWN_REPORTERS and there's no trailing verb clue either.
    if (words[0] === "By" && words.length >= 2) continue;

    // "<State> <government title>" ("Pennsylvania Governor Josh
    // Shapiro") needs both words gone together — the state name alone
    // isn't in STRIPPABLE_LEADING (a bare state name is otherwise never
    // safe to strip), so the loop below would never reach "Governor" on
    // its own. See STATE_NAMES.
    if (words.length > 3 && STATE_NAMES.has(words[0]) && STRIPPABLE_LEADING.has(words[1])) {
      words = words.slice(2);
    }
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
