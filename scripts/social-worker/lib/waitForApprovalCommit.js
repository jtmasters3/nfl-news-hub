// Bounded poll for the AUTHORITATIVE approved/rejected commit after the
// Worker's /social/approval/decide returns "pending" (dispatch accepted by
// GitHub, not yet committed) — the same repository_dispatch-acceptance-
// vs-Action-commit gap already proven in production for captions (see
// scripts/social-worker/lib/waitForCaptionClaim.js). Never infers the
// decision from the Worker's response alone; every attempt re-reads
// data/social-state.json fresh.
export const APPROVAL_POLL_MAX_ATTEMPTS = 20;
export const APPROVAL_POLL_INTERVAL_MS = 3000;

/**
 * @param {() => Promise<object>} fetchState - returns the parsed social-state.json
 * @param {string} storyId
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number) => void }} [opts]
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
  } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = await fetchState();
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
