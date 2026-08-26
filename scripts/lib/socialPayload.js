// Builds the per-story social-media data payload: a concise graphic-ready
// headline, the base image (reused as-is from the existing image-matching
// layer), source attribution, and a one-sentence creative brief. Pure
// computation over fields the pipeline already has — no network I/O, no
// AI. Caption writing is explicitly NOT done here: see caption_generation
// below and the commit this shipped in for why that's a deliberate
// architecture decision, not a gap.
// Multi-topic recap headlines ("NFL Catchup: X, Y, Z") name several
// unrelated stories at once and make a poor single-story graphic headline
// even when short — excluded as headline candidates for THIS story.
const ROUNDUP_PATTERN = /catchup|round[\s-]?up|,\s*more$|&\s*more\b/i;

// A leading "Outlet:"/"Report:"/"Sources:" attribution prefix is scaffolding
// for a news headline, not part of the fact — strip it before compressing.
// Explicit outlet/wire-word list only, NOT a generic "any capitalized
// phrase followed by a colon" pattern — that first version was caught
// during the quality audit stripping a coach's own name off a
// quote-attribution headline ("Ben Johnson: Left tackle is still a hot
// spot for us" -> lost "Ben Johnson" entirely, leaving an anonymous-
// looking quote next to his photo). "PersonName: quote" is a normal NFL
// headline convention and must never be treated as a prefix to discard.
const SOURCE_PREFIX_PATTERN =
  /^(?:NFL Network|NFL\.com|ESPN|FOX Sports|Fox Sports|Pro Football Talk|PFT|NBC Sports|CBS Sports|Yahoo Sports|The Athletic|Report|Reports|Source|Sources|Breaking)\s*:\s*/i;

// Earliest of these marks the point where a headline moves from the core
// fact into a secondary clause (trade compensation, extra context, a
// second story tacked on with "and") — truncating there keeps the primary
// fact intact instead of chopping mid-sentence.
const CLAUSE_BOUNDARY_PATTERN = /,| and | in exchange for | after | amid | while | but | following /i;

const MIN_WORDS = 4;
const TARGET_MID = 7;
const TARGET_MAX = 10;
const HARD_MAX_WORDS = 12;

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalize(raw) {
  return raw
    .replace(SOURCE_PREFIX_PATTERN, "")
    // A literal "..." mid-headline (analyst/column headlines sometimes use
    // one before a trailing clause) looks broken on a graphic if it
    // survives truncation right after it — strip it and re-collapse
    // whitespace rather than let it become the last thing on the graphic.
    .replace(/\.{3}|…/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.:;]+$/, "")
    .trim();
}

function truncateAtClauseBoundary(text) {
  const m = CLAUSE_BOUNDARY_PATTERN.exec(text);
  if (!m) return text;
  return text.slice(0, m.index).trim();
}

/**
 * Scores a normalized headline candidate for graphic-headline fitness:
 * lower is better. Prefers landing near the 4-10 word target range;
 * tolerates up to 12 with a growing penalty rather than rejecting outright
 * — "shorter is generally better" without discarding meaning to force a
 * specific count.
 */
function scoreCandidate(wc) {
  const overTarget = wc > TARGET_MAX ? (wc - TARGET_MAX) * 1.5 : 0;
  return Math.abs(wc - TARGET_MID) + overTarget;
}

/**
 * Builds the graphic-ready post headline via truncation only — never word
 * substitution or rewording, so it can never introduce a fact that wasn't
 * already in a real source headline. Tries every source headline in the
 * cluster (clustered outlets often already phrased the same event more
 * tightly than whichever one was discovered first) and keeps the best-
 * scoring one that lands at or under the 12-word hard cap. Returns
 * confident:false — never a forced/awkward result — when nothing in the
 * cluster can be brought into range without mangling it.
 */
function buildPostHeadline(story) {
  const rawCandidates = story.sources
    .map((s) => s.headline)
    .filter((h) => h && !ROUNDUP_PATTERN.test(h));
  if (rawCandidates.length === 0) rawCandidates.push(story.headline);

  let best = null;
  const consider = (text) => {
    const wc = wordCount(text);
    if (wc < MIN_WORDS || wc > HARD_MAX_WORDS) return;
    const score = scoreCandidate(wc);
    if (!best || score < best.score) best = { text, wc, score };
  };

  for (const raw of rawCandidates) {
    const full = normalize(raw);
    consider(full);

    // Always try the boundary-truncated variant too, not only when the
    // full headline exceeds the hard cap — a headline can be within 12
    // words and still be two separate pieces of news stitched together
    // ("Broncos agree to terms with OLB Ron Stone, cut WR Hakeem Butler"),
    // which reads as ambiguous next to a single-subject photo even though
    // it technically fits. Scoring both and keeping whichever is closer to
    // the target range naturally favors the single-clause version without
    // ever discarding the full one if it was already the tighter choice.
    const cut = truncateAtClauseBoundary(full);
    if (cut && cut !== full) consider(cut);
  }

  if (!best) return { text: null, confident: false };
  return { text: best.text.toUpperCase(), confident: true };
}

/**
 * Picks the source that best supports the social payload: the one whose
 * image was actually selected as primary_image_url, but only when that
 * same source also carries real reporting (not just a bare image with a
 * thin/empty description) — otherwise a newest-first source in the
 * cluster, otherwise the original source. Lets the payload point to
 * wherever both the reporting AND the image actually came from, per
 * source_url/source_name below.
 */
function selectSocialSource(story) {
  const sources = story.sources;
  if (!sources.length) return null;

  const hasRealReporting = (s) => Boolean(s?.description && s.description.trim().length >= 30);

  if (story.primary_image_url) {
    const imageSource = sources.find((s) => s.image_url === story.primary_image_url);
    if (imageSource && hasRealReporting(imageSource)) return imageSource;
  }

  const byNewest = [...sources].sort((a, b) => {
    const at = Date.parse(a.published_at ?? a.discovered_at ?? 0) || 0;
    const bt = Date.parse(b.published_at ?? b.discovered_at ?? 0) || 0;
    return bt - at;
  });

  return byNewest[0] ?? sources[0];
}

// A small phrase set dedicated to this one-sentence brief, independent of
// munch.js's display-label casing (which is Title Case, built for UI
// badges — reusing it here would need extra un-Title-Casing logic for no
// real benefit over just writing the phrase directly).
const CREATIVE_BRIEF_CATEGORY_PHRASES = {
  breaking: "NFL breaking news",
  trade: "NFL trade news",
  rumor: "NFL rumor",
  injury: "NFL injury update",
  contract: "NFL contract news",
  free_agency: "NFL free agency news",
  draft: "NFL Draft news",
  fantasy: "NFL fantasy football news",
  team_news: "NFL team news",
  player_news: "NFL player news",
  league_news: "NFL news",
  roster_move: "NFL roster move",
  suspension: "NFL suspension news",
  coaching: "NFL coaching news",
  retirement: "NFL retirement news",
  other: "NFL news",
};

/** One factual sentence of context for a downstream creative system — deliberately not a summary. */
function buildCreativeBrief(story) {
  const base = CREATIVE_BRIEF_CATEGORY_PHRASES[story.category] || "NFL news";
  const { visual_subject: subject, visual_subject_type: type, current_team: team, teams } = story;

  let clause = "";
  if (subject && type === "player" && team) {
    clause = ` involving ${subject} and the ${team}`;
  } else if (subject && (type === "player" || type === "coach" || type === "executive")) {
    clause = ` involving ${subject}`;
  } else if (subject && type === "team") {
    clause = ` involving the ${subject}`;
  } else if (subject && type === "event") {
    clause = ` about the ${subject}`;
  } else if (teams.length === 1) {
    clause = ` involving the ${teams[0]}`;
  } else if (teams.length === 2) {
    clause = ` involving the ${teams[0]} and ${teams[1]}`;
  }

  return `${base}${clause}.`;
}

function buildSocialStatus({ post_headline, base_image_url, source_url }) {
  if (!source_url || !post_headline) return "needs_review";
  if (!base_image_url) return "needs_media";
  return "ready";
}

/**
 * @param {object} story a fully-computed story record (category, visual_subject,
 *   current_team, the primary_image_ fields, and sources must already be set
 *   — see generate-content.js, which calls this after applyVisualMedia)
 */
export function buildSocialPayload(story) {
  const { text: post_headline, confident } = buildPostHeadline(story);
  const chosenSource = selectSocialSource(story);
  const source_url = chosenSource?.url ?? story.sources[0]?.url ?? null;
  const source_name = chosenSource?.name ?? story.sources[0]?.name ?? null;
  const source_urls = Array.from(new Set(story.sources.map((s) => s.url)));

  const headline = confident ? post_headline : null;

  return {
    post_headline: headline,
    base_image_url: story.primary_image_url ?? null,
    base_image_source: story.primary_image_source ?? null,
    base_image_credit: story.primary_image_credit ?? null,
    // Deliberately null — a real caption requires generative writing, which
    // this $0 deterministic pipeline does not do. Munch (or whatever
    // downstream creative system consumes social-feed.json) generates it
    // from these facts on its own side; nothing is round-tripped back here.
    caption: null,
    caption_generation: "downstream",
    creative_brief: buildCreativeBrief(story),
    source_url,
    source_name,
    source_urls,
    category: story.category,
    social_status: buildSocialStatus({ post_headline: headline, base_image_url: story.primary_image_url, source_url }),
  };
}
