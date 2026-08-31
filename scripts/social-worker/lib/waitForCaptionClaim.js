// Bounded poll wrapper around claimCaption(), closing the race between
// /social/artwork/complete returning dispatch_confirmed:true (which only
// means GitHub ACCEPTED the repository_dispatch webhook) and the
// asynchronous GitHub Action actually committing artwork_ready into
// data/social-state.json (2026-08-31 incident, story
// 34195a7b-69d8-4225-b58b-757febe23f4d: a one-shot claim attempted ~1s
// after dispatch acceptance hit the guard while the ~20s Action run was
// still in flight). Retries ONLY when the authoritative caption-claim
// endpoint reports "not_artwork_ready" — every other reason (success,
// already_captioned, retry_not_allowed, not_found, invalid_story_id,
// merged_story, ...) returns immediately, no polling. Never infers
// artwork_ready from elapsed time, dispatch_confirmed, or R2 — each
// attempt re-reads the real authoritative endpoint.
export const CAPTION_CLAIM_POLL_MAX_ATTEMPTS = 20;
export const CAPTION_CLAIM_POLL_INTERVAL_MS = 3000;

/**
 * @param {(storyId: string) => Promise<object>} claimFn - e.g. apiClient's claimCaption
 * @param {string} storyId
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number) => void }} [opts]
 * @returns {Promise<object>} the claim result from claimFn (success or a non-retryable rejection), or a
 *   synthetic { claimed: false, reason: "not_artwork_ready_timeout" } once every attempt is exhausted
 */
export async function waitForCaptionClaim(
  claimFn,
  storyId,
  {
    attempts = CAPTION_CLAIM_POLL_MAX_ATTEMPTS,
    intervalMs = CAPTION_CLAIM_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onWaiting,
  } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await claimFn(storyId);
    if (result.claimed || result.reason !== "not_artwork_ready") return result;
    if (attempt < attempts) {
      onWaiting?.(attempt, attempts);
      await sleep(intervalMs);
    }
  }
  return { claimed: false, reason: "not_artwork_ready_timeout" };
}
