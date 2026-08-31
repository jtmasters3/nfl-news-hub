// Deterministic (no AI) validation for a caption produced by the local
// Codex worker. ONE shared module — imported by both the local processor
// (drives the bounded local retry loop, with feedback fed into the next
// attempt) and scripts/social/apply-artwork-event.js (the final,
// authoritative, never-trust-the-client gate before caption.text can ever
// become publishable) — unlike the artwork/image case, both callers live
// in this same repo, so there is no reason to maintain two copies of the
// ruleset.
//
// Honest limit, stated plainly rather than implied: these checks catch
// structural violations and a handful of specific, checkable hallucination
// PROXIES (invented numbers, invented quotes, invented URLs/handles,
// leakage/refusal text, formatting). They cannot verify that an unquoted,
// number-free prose claim is factually accurate — e.g. a vague unsupported
// claim like "the move surprised the locker room" would pass every check
// below. The actual anti-hallucination guarantee for that class of error
// rests on the prompt instruction and the model's own track record in
// this project, not on this validator. Do not treat a "passed" result as
// proof every sentence is true — only as proof it's structurally sound
// and free of the specific hallucination patterns below.
const MIN_LENGTH = 20;
const MAX_LENGTH = 900;
const MAX_HASHTAGS = 3;

const URL_PATTERN = /https?:\/\/|www\./i;
const HANDLE_PATTERN = /@\w+/;
const HASHTAG_PATTERN = /#\w+/g;
const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s/m;
const MARKDOWN_CODE_FENCE_PATTERN = /```/;
const MARKDOWN_EMPHASIS_PATTERN = /\*\*[^*]+\*\*|__[^_]+__/;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/;
const QUOTED_STRING_PATTERN = /"([^"]{4,})"/g;
const STANDALONE_NUMBER_PATTERN = /\b\d[\d,]*(?:\.\d+)?\b/g;

const META_COMMENTARY_PHRASES = [
  "as an ai",
  "as a language model",
  "i cannot",
  "i can't",
  "i'm unable",
  "i am unable",
  "here is your caption",
  "here's your caption",
  "here is the caption",
  "here's the caption",
  "no caption available",
  "unable to generate",
  "i apologize",
  "sure!",
  "certainly!",
];

function normalizeForSubstringCheck(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text - the candidate caption
 * @param {{post_headline: string, source_name: string, description?: string|null}} fixture
 * @returns {{ passed: boolean, issues: string[] }}
 */
export function validateCaption(text, fixture) {
  const issues = [];

  if (!text || typeof text !== "string" || !text.trim()) {
    return { passed: false, issues: ["empty_caption"] };
  }

  const trimmed = text.trim();

  if (trimmed.length < MIN_LENGTH) issues.push(`too_short:${trimmed.length}`);
  if (trimmed.length > MAX_LENGTH) issues.push(`too_long:${trimmed.length}`);

  const sourceName = fixture?.source_name;
  if (!sourceName || !trimmed.includes(`Source: ${sourceName}`)) {
    issues.push("missing_or_incorrect_attribution");
  }

  if (URL_PATTERN.test(trimmed)) issues.push("contains_url");
  if (HANDLE_PATTERN.test(trimmed)) issues.push("contains_unsupported_handle");

  const hashtagCount = (trimmed.match(HASHTAG_PATTERN) || []).length;
  if (hashtagCount > MAX_HASHTAGS) issues.push(`excessive_hashtags:${hashtagCount}`);

  if (MARKDOWN_HEADING_PATTERN.test(trimmed)) issues.push("contains_markdown_heading");
  if (MARKDOWN_CODE_FENCE_PATTERN.test(trimmed)) issues.push("contains_code_fence");
  if (MARKDOWN_EMPHASIS_PATTERN.test(trimmed)) issues.push("contains_markdown_emphasis");
  if (MARKDOWN_LINK_PATTERN.test(trimmed)) issues.push("contains_markdown_link");

  const lower = trimmed.toLowerCase();
  const leakedPhrase = META_COMMENTARY_PHRASES.find((p) => lower.includes(p));
  if (leakedPhrase) issues.push(`meta_commentary:${leakedPhrase}`);

  // Anti-hallucination proxy 1: every standalone number in the caption
  // must also appear somewhere in the supplied, verified fixture text
  // (headline + description) — catches invented stats/contract
  // figures/injury timelines without needing to parse prose meaning.
  const fixtureText = normalizeForSubstringCheck(`${fixture?.post_headline || ""} ${fixture?.description || ""}`);
  const numbers = trimmed.match(STANDALONE_NUMBER_PATTERN) || [];
  const unsupportedNumbers = numbers.filter((n) => !fixtureText.includes(n.toLowerCase()));
  if (unsupportedNumbers.length) issues.push(`unsupported_number:${unsupportedNumbers.join(",")}`);

  // Anti-hallucination proxy 2: any quoted string must appear verbatim in
  // the supplied description — catches invented quotes.
  const descriptionNormalized = normalizeForSubstringCheck(fixture?.description);
  let quoteMatch;
  QUOTED_STRING_PATTERN.lastIndex = 0;
  while ((quoteMatch = QUOTED_STRING_PATTERN.exec(trimmed))) {
    const quoted = normalizeForSubstringCheck(quoteMatch[1]);
    if (!descriptionNormalized || !descriptionNormalized.includes(quoted)) {
      issues.push(`unsupported_quote:${quoteMatch[1].slice(0, 40)}`);
    }
  }

  return { passed: issues.length === 0, issues };
}

export { MIN_LENGTH, MAX_LENGTH, MAX_HASHTAGS };
