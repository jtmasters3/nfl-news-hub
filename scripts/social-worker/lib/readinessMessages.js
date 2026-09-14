// Pure message builders for the caption-claim readiness-wait/-timeout
// case, extracted from process-one.js's processCaption() so their exact
// wording is directly testable.
//
// 2026-09-03 incident: the OLD timeout message said "rerun ... to retry
// Story generation" for a Story that had already generated, uploaded, and
// validated successfully — only its GitHub commit was delayed, not a real
// failure; that instruction was actively dangerous advice. This module is
// deliberately never allowed to say "regenerate"/"retry Story
// generation"/"retry Feed generation" — a commit-visibility delay looks
// identical to a genuine failure from here, and the asset in question may
// already be perfectly valid.
//
// 2026-09-14 incident: "not_artwork_ready" was always labeled "Feed
// artwork" regardless of the record's own Stage 3A selection.destination —
// wrong for a Story-only record, where Feed is intentionally never
// attempted at all (proven against story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd). describeArtworkAsset() is the
// ONE place this label is now decided, used by both the per-attempt
// "waiting" log in process-one.js and the timeout message below, so the
// two can never drift back out of sync with each other.

/**
 * Names WHICH artwork asset a "not yet ready" caption-claim reason refers
 * to. "story_artwork_not_ready" is unambiguous on its own (the legacy
 * paired-assets flow, Story specifically, v2-without-selection records
 * only). "not_artwork_ready" means the record's own SINGLE primary asset
 * isn't ready yet — Feed's, for any legacy/Feed-selected record, but
 * Story's for a Stage 3A Story-selected record.
 * @param {{reason: string, destination?: "feed"|"story"}} args
 * @returns {"Story artwork"|"Feed artwork"}
 */
export function describeArtworkAsset({ reason, destination }) {
  return reason === "story_artwork_not_ready" || destination === "story" ? "Story artwork" : "Feed artwork";
}

export function describeReadinessTimeout({ lastReason, storyId, totalSeconds, destination }) {
  const what = describeArtworkAsset({ reason: lastReason, destination });
  return (
    `Caption not claimed: ${what} was not confirmed committed within ~${totalSeconds}s. ` +
    `This does NOT necessarily mean it failed — it may only be a GitHub state-commit delay, and it may already be valid. ` +
    `Feed and Story are both preserved and untouched either way — rerun with --story-id=${storyId} later; ` +
    `it will automatically resume from wherever the story actually is (caption-only recovery if both are already valid, ` +
    `Story-only recovery only if Story genuinely never became valid).`
  );
}
