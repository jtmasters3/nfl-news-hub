// Bounded poll wrapper around claimStoryArtwork(), closing the SAME
// repository_dispatch-acceptance-vs-Action-commit race already proven and
// fixed for captions (waitForCaptionClaim.js) and for Approval
// confirmation (waitForApprovalCommit.js) — this Story-artwork claim path
// was simply built without the same protection when it was added.
//
// Real incident: story 6a443992-55a9-4ac5-b57d-ba2993a740e3 (2026-09-03).
// Feed's own /complete returned dispatch_confirmed:true (GitHub ACCEPTED
// the webhook) at ~16:21:43-44Z; the one-shot Story claim attempted
// immediately afterward hit not_artwork_ready because the asynchronous
// GitHub Action hadn't yet committed artwork_ready into
// data/social-state.json (it landed at ~16:21:53-57Z, ~9-13s later).
//
// Retries ONLY when the authoritative story-artwork-claim endpoint
// reports "not_artwork_ready" — every other reason (success,
// already_captioned, retry_not_allowed, not_found, invalid_story_id,
// merged_story, ...) returns immediately, no polling. Never infers
// artwork_ready from elapsed time, dispatch_confirmed, or R2 — each
// attempt re-reads the real authoritative endpoint. Never touches Feed in
// any way — this only retries the independent Story claim call.
export const STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS = 20;
export const STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS = 3000;

/**
 * @param {(storyId: string) => Promise<object>} claimFn - e.g. apiClient's claimStoryArtwork
 * @param {string} storyId
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number) => void }} [opts]
 * @returns {Promise<object>} the claim result from claimFn (success or a non-retryable rejection), or a
 *   synthetic { claimed: false, reason: "not_artwork_ready_timeout" } once every attempt is exhausted
 */
export async function waitForStoryArtworkClaim(
  claimFn,
  storyId,
  {
    attempts = STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS,
    intervalMs = STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS,
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
