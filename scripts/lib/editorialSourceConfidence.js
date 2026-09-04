// Editorial Scoring Brain — Phase 1: source-tier lookup + bounded
// corroboration. Small, explicit, centralized tier map — an unknown outlet
// gets a safe neutral tier, never a fabricated one. Corroboration reuses
// similarity.js's existing, production-proven headline-normalization
// machinery to tell genuinely independent reporting apart from mechanical
// re-syndication of the same wire copy, rather than building a second
// duplicate-detection system.
import { normalizeHeadlineTokens } from "./similarity.js";
import { jaccardSimilarity } from "./text.js";

// OBSERVE_ONLY_CALIBRATION_DEFAULTS — see editorialScoring.js. Deliberately
// small and conservative; extend only when real dry-run data shows a real
// outlet being mistiered.
const SOURCE_TIERS = {
  A: new Set(["NFL Network", "NFL.com", "ESPN"]),
  B: new Set(["Pro Football Talk", "PFT", "NBC Sports", "CBS Sports", "FOX Sports", "Fox Sports", "Yahoo Sports", "The Athletic"]),
};
export const UNKNOWN_SOURCE_TIER = "unknown";

/** @returns {"A"|"B"|"unknown"} */
export function sourceTier(sourceName) {
  if (!sourceName) return UNKNOWN_SOURCE_TIER;
  if (SOURCE_TIERS.A.has(sourceName)) return "A";
  if (SOURCE_TIERS.B.has(sourceName)) return "B";
  return UNKNOWN_SOURCE_TIER;
}

/** The single most-authoritative tier among a set of sources — "A" beats "B" beats "unknown". */
export function bestSourceTier(sources) {
  const tiers = sources.map((s) => sourceTier(s.name ?? s.source_name));
  if (tiers.includes("A")) return "A";
  if (tiers.includes("B")) return "B";
  return UNKNOWN_SOURCE_TIER;
}

const DEDUP_SIMILARITY_THRESHOLD = 0.7;

/**
 * Groups sources whose headline+description text is near-identical (the
 * same wire copy re-published by several outlets) into single "distinct
 * report" clusters, so corroboration counts genuinely independent
 * reporting, not mechanical re-syndication. Order-independent in the sense
 * that matters for scoring: the returned COUNT does not depend on which
 * source happened to be listed first for the common cases this exists to
 * handle (all-distinct or all-identical); a greedy first-seen clustering is
 * a deliberate, documented Phase 1 simplification for the rare 3-source
 * transitive-similarity edge case, not a claim of perfect invariance.
 * @param {Array<{headline?: string, description?: string}>} sources
 * @returns {number} count of distinct reports
 */
export function countDistinctReports(sources) {
  const clusters = [];
  for (const source of sources) {
    const text = `${source.headline ?? ""} ${source.description ?? ""}`.trim();
    const tokens = normalizeHeadlineTokens(text);
    const matchesExisting = clusters.some((cluster) => jaccardSimilarity(tokens, cluster) >= DEDUP_SIMILARITY_THRESHOLD);
    if (!matchesExisting) clusters.push(tokens);
  }
  return clusters.length || sources.length; // sources with no usable text still count as 1 each
}

/**
 * Logarithmic, hard-capped corroboration bonus — six rewrites of one wire
 * story must never outweigh actual editorial magnitude. The cap is on the
 * OUTPUT (never exceeds MAX_BONUS), not just the growth rate, so it is
 * trivially, deterministically bounded regardless of source count.
 * @param {Array} sources
 * @param {{PER_SOURCE_BONUS: number, MAX_BONUS: number}} constants
 */
export function corroborationBonus(sources, constants) {
  const distinctCount = countDistinctReports(sources ?? []);
  const raw = constants.PER_SOURCE_BONUS * Math.log2(1 + distinctCount);
  const bonus = Math.min(constants.MAX_BONUS, Math.max(0, raw));
  return { distinct_report_count: distinctCount, bonus };
}
