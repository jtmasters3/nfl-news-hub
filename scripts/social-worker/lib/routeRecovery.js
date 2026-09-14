// Pure recovery-route decision for process-one.js's main(), used only for
// a --story-id that isn't in the live artwork queue (i.e. Feed already
// succeeded in an earlier run — see lib/routeTarget.js's shouldSkipArtwork).
// Decides which recovery path applies WITHOUT ever touching Feed, which by
// this point already has its own completed (and thus un-reclaimable) DO
// claim — nothing here can regenerate it.
//
//   "caption_only" — the existing, already-proven recovery path: either a
//     legacy (content_package_version 1) record, where Story was never a
//     requirement, or a v2 record whose Story asset is already valid.
//   "story_only"   — NEW: a v2 record whose Feed succeeded but Story
//     hasn't (never attempted, or attempted and failed/invalid) — retry
//     ONLY Story, never touch Feed, never proceed to caption until Story
//     succeeds.
//   "none"         — status isn't "artwork_ready" at all (e.g. still
//     mid-generation, already captioned/approved, or failed) — recovery
//     doesn't apply; the caller's existing status-based handling covers this.
export function determineRecoveryAction(record) {
  if (!record || record.status !== "artwork_ready") return "none";

  // Stage 3B: a Feed-selected record's single required asset is Feed,
  // already satisfied by reaching artwork_ready — it must never be routed
  // into Story recovery merely for lacking a story_artwork it was never
  // supposed to generate (destination is authoritative over version here,
  // exactly as in artworkPlan.js's determineArtworkPlan).
  if (record.selection?.destination === "feed") return "caption_only";

  // 2026-09-14 fix: the SAME is true in reverse for a Story-selected
  // record — reaching "artwork_ready" at all can ONLY have happened via
  // its own PRIMARY story_artwork completion (applyCompleteEvent routes
  // Story-selected records through record.story_artwork exclusively), so
  // status alone already proves it's ready; no further check is needed or
  // correct here. Falling through to the legacy paired-assets check below
  // was a latent bug: applyCompleteEvent writes the actual pass/fail
  // outcome into the record's TOP-LEVEL `validation` field for every
  // primary completion (Feed or Story alike) — it never populates
  // `story_artwork.validation` for a Stage 3A Story-selected record — so
  // that check below would always read passed:null and incorrectly route
  // an already-successful Story-primary record into "story_only",
  // reclaiming and regenerating Story artwork that was already valid.
  // Proven against story_id 0cba51db-8c38-436f-ae48-a4af46e9f6bd.
  if (record.selection?.destination === "story") return "caption_only";

  const version = record.content_package_version ?? 1;
  if (version !== 2) return "caption_only";

  const story = record.story_artwork || {};
  const storyReady = story.status === "created" && story.validation?.passed === true;
  return storyReady ? "caption_only" : "story_only";
}
