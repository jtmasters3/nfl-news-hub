// Pure routing decision extracted from process-one.js's main() so it's
// unit-testable without a real queue fetch. social-artwork-queue.json only
// ever lists "queued" stories (see scripts/social/apply-artwork-event.js's
// regenerateDerivedFiles -> buildQueueEntries in scripts/lib/socialState.js),
// so a target absent from the fetched queue means Content Creation already
// succeeded in an earlier run: this is a caption-only retry/recovery, and
// processArtwork() must never run again for it.
export function shouldSkipArtwork(queue, storyId) {
  return !queue.some((entry) => entry.story_id === storyId);
}
