// Explicit source allowlist for AUTOMATIC approval only — never used to
// gate ingestion, selection, editorial scoring, or human approval (all of
// which remain free to accept any source exactly as they already do).
//
// No general-purpose "allowed sources" concept existed anywhere in this
// codebase before this file (audited 2026-09-11) — the closest prior art,
// editorialSourceConfidence.js's SOURCE_TIERS, is a scoring-confidence
// map, not a gate, and its own tier lists include aliases ("PFT",
// "NBC Sports", "Fox Sports") that have never actually appeared in
// production data (see below). This file exists specifically so
// auto-approval has its own narrow, explicitly-audited, exact-match list —
// never inferred from the scoring tiers, never guessed.
//
// Canonical identifiers verified against REAL production
// data/social-state.json source_story.source_name values (2026-09-11
// audit): the only three strings ever actually observed in production
// were exactly "Pro Football Talk", "FOX Sports" (this casing only — never
// "Fox Sports"), and "NFL.com". "ESPN" is explicitly requested as an
// intended source and is unambiguous (no casing/aliasing question), so it
// is included even though zero real ESPN records exist yet — flagged here
// so a future audit can confirm the real string once one appears.
// "PFT"/"NBC Sports" are deliberately NOT included: they are aliases from
// editorialSourceConfidence.js's tier map that have never appeared in a
// real production record — adding them now would be guessing, which this
// file's whole purpose is to avoid.
//
// Matching is EXACT and case-sensitive, never normalized/fuzzy — "FOX
// Sports" and "Fox Sports" are treated as different strings on purpose,
// since the two literally coexisting in the tier map was itself a source
// of real confusion audited during this change. An outlet whose casing
// doesn't match exactly is "not on the allowlist," not "close enough."
export const AUTO_APPROVAL_ALLOWED_SOURCES = new Set([
  "ESPN", // requested/intended; not yet verified in real production data
  "NFL.com", // verified in production data
  "FOX Sports", // verified in production data (this exact casing only)
  "Pro Football Talk", // verified in production data
]);

/**
 * @param {string|null|undefined} sourceName
 * @returns {boolean}
 */
export function isAutoApprovalAllowedSource(sourceName) {
  return typeof sourceName === "string" && AUTO_APPROVAL_ALLOWED_SOURCES.has(sourceName);
}
