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

  const version = record.content_package_version ?? 1;
  if (version !== 2) return "caption_only";

  const story = record.story_artwork || {};
  const storyReady = story.status === "created" && story.validation?.passed === true;
  return storyReady ? "caption_only" : "story_only";
}
