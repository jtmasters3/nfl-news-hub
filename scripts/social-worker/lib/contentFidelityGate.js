// Fail-closed content-fidelity checks for automatic approval — the piece
// audited and found missing on 2026-09-11: assessApprovalReadiness(),
// artworkValidation.js, and captionValidation.js all verify STRUCTURAL
// correctness (artwork exists/valid dimensions, caption exists/non-empty/
// correctly formatted) but nothing previously verified that the generated
// caption's own CONTENT is actually consistent with the canonical,
// already-extracted source-article data (record.source_story).
//
// Deliberately reuses existing extracted/canonical data rather than
// inventing new pipeline stages or a second validation standard:
//   - record.source_story.teams / .players — the ALREADY-extracted entity
//     lists for this story (populated at selection time), never
//     regenerated or re-derived here.
//   - record.source_story.post_headline / .description — the same
//     canonical fixture text captionValidation.js's own unsupported_number/
//     unsupported_quote checks already validate against.
//   - record.source_story.category — the already-extracted editorial
//     category (e.g. "injury", "transaction", "rumor").
//   - captionValidation.js's validateCaption() itself — RE-RUN here
//     against the record's current canonical source_story fixture (not
//     merely trusted from whatever fixture generation time used), so a
//     caption is proven consistent with the record's OWN current data,
//     not just whatever it was checked against when first generated.
//
// Honest limits, stated plainly (matching captionValidation.js's own
// documented honesty about proxy checks, not invented certainty):
//   - Named-entity consistency is a deterministic HEURISTIC (capitalized
//     token matching against canonical vocabulary), not true NLP entity
//     resolution. It can false-positive on an unusual but legitimate proper
//     noun the source data doesn't happen to repeat verbatim, and it fails
//     CLOSED in that case (rejects, never guesses safe) — see this file's
//     own tests for exactly what it does and doesn't catch.
//   - Source-image SUBJECT relevance (is the photo actually of the
//     correct player/team) is NOT verified here and cannot be
//     deterministically verified anywhere in this codebase today — no
//     vision-model analysis exists, and the specific image URL used at
//     generation time is not persisted in the record (only the resulting
//     generated artwork is), so there is nothing to deterministically
//     check post-hoc beyond "the source article's own base_image_url is a
//     genuine HTTPS URL," which autoApprovalGate.js already verifies
//     separately. This is a real, disclosed gap, not a solved one.
import { validateCaption } from "../../lib/captionValidation.js";

// Words that are capitalized in ordinary English prose (sentence starts,
// pronouns, common connectors) and must never be treated as unsupported
// named entities on their own, regardless of position or vocabulary match.
const STOP_WORDS = new Set(
  [
    "the", "a", "an", "he", "she", "it", "they", "his", "her", "their", "its",
    "this", "that", "these", "those", "after", "before", "during", "following",
    "in", "on", "at", "with", "for", "despite", "amid", "according", "per",
    "source", "week", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    "nfl", "afc", "nfc", "instagram",
  ].map((w) => w.toLowerCase())
);

const INJURY_KEYWORDS = ["out", "questionable", "doubtful", "injured reserve", "ir", "ruled out", "day-to-day"];
const TRANSACTION_KEYWORDS = ["signed", "traded", "released", "waived", "cut", "activated", "claimed off waivers", "re-signed"];

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stripPunctuation(word) {
  return word.replace(/^[^a-zA-Z0-9.']+|[^a-zA-Z0-9.']+$/g, "");
}

/**
 * Builds the flat, lowercase word vocabulary a candidate named entity is
 * allowed to be drawn from — every word appearing anywhere in the
 * record's own canonical, already-extracted source data.
 */
function buildAllowedVocabulary(source) {
  const parts = [
    ...(Array.isArray(source.teams) ? source.teams : []),
    ...(Array.isArray(source.players) ? source.players : []),
    source.post_headline,
    source.description,
    source.source_name,
  ].filter(Boolean);
  const vocab = new Set();
  for (const part of parts) {
    for (const rawWord of String(part).split(/\s+/)) {
      const word = normalize(stripPunctuation(rawWord));
      if (word) vocab.add(word);
    }
  }
  return vocab;
}

/**
 * Extracts candidate proper-noun-like phrases from caption text: any
 * multi-word capitalized sequence (very likely a real name — "New England
 * Patriots", "A.J. Brown"), plus any single capitalized word that is NOT
 * the first word of its sentence/line (reduces false positives from
 * ordinary sentence-initial capitalization) and is not a known stop word.
 */
function extractCandidateEntities(text) {
  const candidates = [];

  // Multi-word capitalized runs (2+ consecutive capitalized tokens).
  const multiWordPattern = /\b[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)+\b/g;
  let match;
  while ((match = multiWordPattern.exec(text))) {
    candidates.push(match[0]);
  }

  // Single capitalized words not at a sentence/line start.
  const segments = text.split(/(?<=[.!?\n])\s+|\n+/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = stripPunctuation(words[i]);
      if (/^[A-Z][a-z'.-]*$/.test(word) && !STOP_WORDS.has(word.toLowerCase())) {
        candidates.push(word);
      }
    }
  }

  return candidates;
}

/**
 * @param {string} phrase
 * @param {Set<string>} vocab
 * @returns {boolean} true if EVERY word in the phrase is present in vocab
 */
function isPhraseSupported(phrase, vocab) {
  const words = phrase.split(/\s+/).map((w) => normalize(stripPunctuation(w))).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => vocab.has(w));
}

/**
 * Deterministic, conservative check for status-keywords (injury/
 * transaction) that appear in the caption but were never present anywhere
 * in the canonical headline/description AND don't match the record's own
 * extracted editorial category — a keyword the source data itself already
 * uses is never flagged, regardless of category, since it's then
 * source-supported by definition.
 */
function findUnsupportedCategoryKeywords(captionLower, fixtureTextLower, category) {
  const issues = [];
  if (category !== "injury") {
    for (const kw of INJURY_KEYWORDS) {
      if (captionLower.includes(kw) && !fixtureTextLower.includes(kw)) {
        issues.push(`unsupported_injury_claim:${kw}`);
      }
    }
  }
  if (category !== "transaction") {
    for (const kw of TRANSACTION_KEYWORDS) {
      if (captionLower.includes(kw) && !fixtureTextLower.includes(kw)) {
        issues.push(`unsupported_transaction_claim:${kw}`);
      }
    }
  }
  return issues;
}

/**
 * @param {object} record - a data/social-state.json story record
 * @returns {{passed: boolean, issues: string[]}}
 */
export function evaluateContentFidelity(record) {
  const issues = [];
  const source = record?.source_story ?? {};
  const captionText = record?.caption?.text;

  // 1. Canonical source data must actually be present — never guess
  // fidelity against missing data.
  if (typeof source.post_headline !== "string" || !source.post_headline.trim()) {
    issues.push("missing_canonical_headline");
  }
  if (!Array.isArray(source.teams)) issues.push("missing_canonical_teams_list");
  if (!Array.isArray(source.players)) issues.push("missing_canonical_players_list");
  if (typeof captionText !== "string" || !captionText.trim()) {
    issues.push("missing_caption_text");
  }

  if (issues.length > 0) {
    // Cannot proceed to content checks without the canonical data they
    // depend on — fail closed immediately rather than checking against
    // partial/missing data.
    return { passed: false, issues };
  }

  // 2. Re-run the existing deterministic caption validator against the
  // record's OWN current canonical fixture — proves the caption is STILL
  // consistent with source_story as it stands now, not merely whatever it
  // was checked against at generation time.
  const captionCheck = validateCaption(captionText, {
    post_headline: source.post_headline,
    source_name: source.source_name,
    description: source.description,
  });
  for (const issue of captionCheck.issues) issues.push(`caption_validation:${issue}`);

  // 3. Named-entity (team/player) consistency — every proper-noun-like
  // phrase in the caption must trace back to the canonical teams/players/
  // headline/description/source_name vocabulary.
  const vocab = buildAllowedVocabulary(source);
  const candidates = extractCandidateEntities(captionText);
  const unsupportedEntities = new Set();
  for (const candidate of candidates) {
    if (!isPhraseSupported(candidate, vocab)) unsupportedEntities.add(candidate);
  }
  for (const entity of unsupportedEntities) issues.push(`unsupported_named_entity:${entity}`);

  // 4. Category-aware status-keyword consistency (injury/transaction).
  const fixtureTextLower = normalize(`${source.post_headline} ${source.description ?? ""}`);
  const captionLower = normalize(captionText);
  for (const issue of findUnsupportedCategoryKeywords(captionLower, fixtureTextLower, source.category)) {
    issues.push(issue);
  }

  return { passed: issues.length === 0, issues };
}
