// Deterministic caption composer — the 2026-09-14 cloud-safe replacement
// for the local codex.exe caption-writing call (see artworkRenderer.js's
// own header for the full incident this closes).
//
// Builds a caption using ONLY verbatim canonical fixture fields — never an
// AI call, never paraphrasing, never any wording beyond a single fixed
// connective phrase for is_rumor framing (mirroring caption-prompt.template.md's
// own rule 5). Because every word traces back to post_headline/description/
// source_name verbatim, this is safe against captionValidation.js's
// unsupported_number/unsupported_quote checks and contentFidelityGate.js's
// named-entity check BY CONSTRUCTION — it can never introduce a fact,
// number, quote, or name the canonical source data doesn't already contain.
// hashtags are returned as a SEPARATE field, never concatenated into the
// caption text, matching the existing production shape (buildHashtags()
// already builds them independently of whatever wrote the caption body —
// see captionFormatting.js and process-one.js's own completeCaption() call).
import { buildHashtags } from "./captionFormatting.js";

const MAX_CAPTION_LENGTH = 900;
const SAFETY_MARGIN = 60; // headroom below captionValidation.js's own hard cap

function ensureTerminalPunctuation(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * True when `description` adds nothing beyond what `headline` already
 * says — a simple, conservative substring check (never a similarity
 * score) so an ambiguous case always keeps the description rather than
 * silently dropping real context.
 */
function isRedundant(description, headline) {
  const normDescription = description.trim().toLowerCase();
  const normHeadline = (headline || "").trim().toLowerCase();
  if (!normDescription) return true;
  return normHeadline.includes(normDescription) || normDescription.includes(normHeadline);
}

/**
 * @param {{post_headline: string, description?: string|null, source_name: string, teams?: string[], is_rumor?: boolean}} fixture
 * @returns {{text: string, hashtags: string[]}}
 */
export function buildDeterministicCaption({ post_headline, description, source_name, teams, is_rumor }) {
  const rumorPrefix = is_rumor ? "Report: " : "";
  let body = `${rumorPrefix}${ensureTerminalPunctuation(post_headline)}`;

  const trimmedDescription = (description || "").trim();
  if (trimmedDescription && !isRedundant(trimmedDescription, post_headline)) {
    const candidateBody = `${body} ${ensureTerminalPunctuation(trimmedDescription)}`;
    const attribution = `Source: ${source_name}`;
    // Only add the description clause if the FULL caption (with
    // attribution) still stays comfortably under captionValidation.js's
    // MAX_LENGTH — never truncate a sentence mid-way; if it wouldn't fit,
    // the caption simply stays headline-only, which is always legal per
    // caption-prompt.template.md's own rule 3 ("a short, well-written
    // caption built from the headline alone is fine").
    if (candidateBody.length + 2 + attribution.length <= MAX_CAPTION_LENGTH - SAFETY_MARGIN) {
      body = candidateBody;
    }
  }

  const attribution = `Source: ${source_name}`;
  const text = `${body}\n\n${attribution}`;
  const hashtags = buildHashtags(teams);

  return { text, hashtags };
}
