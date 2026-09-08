// Editorial Scoring Brain — Phase 2G production star/notable registry.
//
// INTENTIONALLY EMPTY. Phase 2G's job was to prove the architecture
// (canonical gsis_id keying, effective-dating, no-lookahead, duplicate/
// overlap validation) — it does NOT decide which real NFL players are
// elite or notable. That is a separate, explicitly-reviewed calibration
// step this file has not yet gone through. Do not add a real player entry
// here without that explicit, separate authorization.
//
// Each entry, when populated later, must match the shape validated by
// scripts/lib/nflverseStarRegistry.js's validateStarRegistry():
//   { gsis_id, display_name, star_level: "elite"|"notable",
//     effective_from, effective_to, season, reason }
export const NFL_STAR_REGISTRY = [];
