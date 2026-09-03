// Bounded poll wrapper around claimCaption(), closing the repository_dispatch-
// acceptance-vs-Action-commit race for BOTH temporary readiness reasons the
// caption-claim endpoint can return:
//   - "not_artwork_ready"        — Feed's own artwork_ready commit hasn't
//     landed yet (original 2026-08-31 incident, story 34195a7b-...).
//   - "story_artwork_not_ready"  — (content_package_version 2 only) Feed IS
//     ready, but Story's own completion commit hasn't landed yet (2026-09-03
//     incident, story 6a443992-...: Story generated and uploaded
//     successfully — dispatch_confirmed:true — but the caption claim
//     attempted ~1s later hit story_artwork_not_ready because the Action
//     hadn't committed yet; the poller at the time only knew about
//     "not_artwork_ready" and never retried this second reason at all).
// Every OTHER reason (success, already_captioned, retry_not_allowed,
// not_found, invalid_story_id, merged_story, ...) returns immediately, no
// polling — this is a closed, explicit allowlist of TEMPORARY readiness
// reasons, never a blanket "retry anything unrecognized" rule. Never
// infers readiness from elapsed time, dispatch_confirmed, or R2 — each
// attempt re-reads the real authoritative endpoint.
export const CAPTION_CLAIM_POLL_MAX_ATTEMPTS = 20;
export const CAPTION_CLAIM_POLL_INTERVAL_MS = 3000;

export const TEMPORARY_READINESS_REASONS = new Set(["not_artwork_ready", "story_artwork_not_ready"]);

/**
 * @param {(storyId: string) => Promise<object>} claimFn - e.g. apiClient's claimCaption
 * @param {string} storyId
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number, reason: string) => void }} [opts]
 * @returns {Promise<object>} the claim result from claimFn (success or a non-retryable rejection), or a
 *   synthetic { claimed: false, reason: "readiness_timeout", last_reason: string } once every attempt is exhausted —
 *   `last_reason` is whichever temporary reason was seen on the final attempt, so the caller can report accurately
 *   WHICH asset's commit was still pending rather than a generic message that risks implying it never succeeded.
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
  let lastReason = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await claimFn(storyId);
    if (result.claimed || !TEMPORARY_READINESS_REASONS.has(result.reason)) return result;
    lastReason = result.reason;
    if (attempt < attempts) {
      onWaiting?.(attempt, attempts, result.reason);
      await sleep(intervalMs);
    }
  }
  return { claimed: false, reason: "readiness_timeout", last_reason: lastReason };
}
