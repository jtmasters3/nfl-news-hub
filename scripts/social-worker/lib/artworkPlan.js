// Stage 3B — pure destination-routing decision, split out of process-one.js
// so it's unit-testable without a live queue/claim/Codex invocation. Mirrors
// this directory's own established pattern (selectTarget.js, routeTarget.js).
//
// Never touches Feed for a Story-selected record, never attempts the
// legacy Story-after-Feed step for a Feed-selected record, and preserves
// the EXACT existing behavior for legacy entries (no `destination` field,
// or `destination` absent entirely — pre-Stage-3B queue entries).

/**
 * @param {{destination?: "feed"|"story", content_package_version?: number}} target - a social-artwork-queue.json entry
 * @returns {{attemptFeed: boolean, attemptPrimaryStory: boolean, attemptLegacyStoryAfterFeed: boolean}}
 */
export function determineArtworkPlan(target) {
  const destination = target?.destination ?? "feed";

  if (destination === "story") {
    // Stage 3A Story-selected: ONLY the Story asset, submitted through the
    // PRIMARY claim/complete lifecycle — Feed is never attempted.
    return { attemptFeed: false, attemptPrimaryStory: true, attemptLegacyStoryAfterFeed: false };
  }

  // destination === "feed" (explicit Stage 3A selection, or absent entirely
  // on a legacy/no-selection entry — both cases mean "Feed as usual").
  const version = target?.content_package_version ?? 1;
  const isExplicitlySelected = target?.destination === "feed";

  // A legacy v2 record with NO Stage 3A selection at all keeps its
  // existing paired behavior (Feed, then Story-as-sibling). A Stage 3A
  // Feed-SELECTED v2 record's single destination is satisfied by Feed
  // alone — never attempt the legacy Story-after-Feed step for it, even
  // though content_package_version is 2.
  const attemptLegacyStoryAfterFeed = version === 2 && !isExplicitlySelected;

  return { attemptFeed: true, attemptPrimaryStory: false, attemptLegacyStoryAfterFeed };
}
