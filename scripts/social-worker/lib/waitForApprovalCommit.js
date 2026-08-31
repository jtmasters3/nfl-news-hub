// Bounded poll for the AUTHORITATIVE approved/rejected commit after the
// Worker's /social/approval/decide returns "pending" (dispatch accepted by
// GitHub, not yet committed) — the same repository_dispatch-acceptance-
// vs-Action-commit gap already proven in production for captions (see
// scripts/social-worker/lib/waitForCaptionClaim.js). Never infers the
// decision from the Worker's response alone; every attempt re-reads
// data/social-state.json fresh.
//
// 2026-08-31 false-timeout incident: the Jets story's approval-approved
// Action committed in ~15s, well inside the 60s poll window, but the
// console still reported a timeout. Root cause: raw.githubusercontent.com
// is fronted by a Fastly CDN with Cache-Control: max-age=300 — our
// fetch's `cache: "no-store"` only controls the LOCAL client's own cache
// and has zero effect on that upstream edge cache, so every one of the 20
// polls could keep hitting the exact same stale cached response for the
// entire window. Fastly keys its cache by full URL including the query
// string, so each attempt now appends a fresh, unique query parameter —
// this is the actual fix; cache: "no-store" (kept in apiClient.js) is
// only ever secondary defense, never relied on alone.
export const APPROVAL_POLL_MAX_ATTEMPTS = 20;
export const APPROVAL_POLL_INTERVAL_MS = 3000;

/** Deterministic-enough by default (time + attempt + random); injectable for exact-value tests. */
function defaultCacheBustToken(attempt) {
  return `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {(cacheBustToken: string) => Promise<object>} fetchState - returns the parsed social-state.json;
 *   receives a fresh cache-busting token on every call so the caller's URL construction (see
 *   apiClient.js's fetchSocialState) can defeat upstream CDN caching. fetchState is a pure READ —
 *   this function never calls anything that could mutate the approval decision.
 * @param {string} storyId
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number) => void, cacheBustToken?: (attempt: number) => string }} [opts]
 * @returns {Promise<{committed: true, status: "approved"|"rejected", record: object} | {committed: false, status: "timeout"}>}
 */
export async function waitForApprovalCommit(
  fetchState,
  storyId,
  {
    attempts = APPROVAL_POLL_MAX_ATTEMPTS,
    intervalMs = APPROVAL_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onWaiting,
    cacheBustToken = defaultCacheBustToken,
  } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = await fetchState(cacheBustToken(attempt));
    const record = state?.stories?.[storyId];
    const status = record?.status;
    if (status === "approved" || status === "rejected") {
      return { committed: true, status, record };
    }
    if (attempt < attempts) {
      onWaiting?.(attempt, attempts);
      await sleep(intervalMs);
    }
  }
  return { committed: false, status: "timeout" };
}
