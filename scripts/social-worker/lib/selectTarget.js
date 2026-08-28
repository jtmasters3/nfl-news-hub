// Pure target-selection + fixture-completeness check, split out of
// process-one.js so both are unit-testable without a live queue or claim.
//
// Root cause of the 2026-08-28 f4328222-15b2-4086-b9fb-04f7f5ec9e6f
// incident: the old inline pickTarget() returned a bare { story_id } when
// --story-id was passed, WITHOUT looking it up in the queue for its real
// post_headline/base_image_url — so the fixture written for Codex had
// only story_id. Codex correctly refused to fabricate the missing fields
// and exited cleanly, but the run had already claimed a real lease and
// burned a generation attempt on data that could never have worked.

/**
 * @param {Array<{story_id: string}>} queue - current social-artwork-queue.json entries
 * @param {string|null} storyId - explicit --story-id, or null to take the front of the queue
 * @returns {object|null} the full queue entry when found, a bare {story_id} as a last
 *   resort when an explicit id isn't in the live queue (e.g. a lease-recovery
 *   case, where the claim endpoint may still accept it) — missingFixtureFields()
 *   below is what catches that case before it ever reaches Codex.
 */
export function selectTarget(queue, storyId) {
  if (storyId) {
    return queue.find((entry) => entry.story_id === storyId) ?? { story_id: storyId };
  }
  return queue.length ? queue[0] : null;
}

const REQUIRED_FIXTURE_FIELDS = ["post_headline", "base_image_url"];

/** Returns the required fields that are missing/empty on `target` — an empty array means it's usable. */
export function missingFixtureFields(target) {
  return REQUIRED_FIXTURE_FIELDS.filter((field) => !target?.[field]);
}
