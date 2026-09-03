// Pure message builder for the caption-claim readiness-timeout case,
// extracted from process-one.js's processCaption() so its exact wording
// is directly testable (2026-09-03 incident: the OLD message said "rerun
// ... to retry Story generation" for a Story that had already generated,
// uploaded, and validated successfully — only its GitHub commit was
// delayed, not a real failure; that instruction was actively dangerous
// advice). This function is deliberately never allowed to say
// "regenerate"/"retry Story generation"/"retry Feed generation" — a
// commit-visibility delay looks identical to a genuine failure from here,
// and the asset in question may already be perfectly valid.
export function describeReadinessTimeout({ lastReason, storyId, totalSeconds }) {
  const what = lastReason === "story_artwork_not_ready" ? "Story artwork" : "Feed artwork";
  return (
    `Caption not claimed: ${what} was not confirmed committed within ~${totalSeconds}s. ` +
    `This does NOT necessarily mean it failed — it may only be a GitHub state-commit delay, and it may already be valid. ` +
    `Feed and Story are both preserved and untouched either way — rerun with --story-id=${storyId} later; ` +
    `it will automatically resume from wherever the story actually is (caption-only recovery if both are already valid, ` +
    `Story-only recovery only if Story genuinely never became valid).`
  );
}
