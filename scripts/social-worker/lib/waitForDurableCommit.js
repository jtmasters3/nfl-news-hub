// Generalizes waitForApprovalCommit.js's proven poll loop (see that file's
// header for the full 2026-09-03 false-timeout incident and its real fix —
// SHA-pinned reads via githubStateReader.js's createFreshStateFetcher(),
// never the mutable branch URL) to an arbitrary durable-commit predicate.
//
// This is the mechanism Stage 5B uses to prove "dispatch accepted by
// GitHub" has become "actually committed to data/social-state.json" for
// the posting-claimed and posting-publish-attempted events, BEFORE the
// orchestrator is allowed to proceed to an external Buffer mutation. A 204
// from repository_dispatch only proves GitHub accepted the request, not
// that the Action's commit landed — this poller closes that gap the same
// way it was already closed for approval decisions.
export const DURABLE_COMMIT_POLL_MAX_ATTEMPTS = 20;
export const DURABLE_COMMIT_POLL_INTERVAL_MS = 3000;

/**
 * @param {() => Promise<object>} fetchState - returns the parsed, current data/social-state.json,
 *   or rejects (optionally with `.rateLimited = true`) on a read failure. A pure READ.
 * @param {string} storyId
 * @param {(record: object) => boolean} isCommitted - returns true once the record reflects the durable commit being waited for
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number, reason: "pending"|"read_error") => void }} [opts]
 * @returns {Promise<
 *   {committed: true, record: object} |
 *   {committed: false, status: "timeout"} |
 *   {committed: false, status: "read_error", error: string, rateLimited?: boolean}
 * >}
 */
export async function waitForDurableCommit(
  fetchState,
  storyId,
  isCommitted,
  {
    attempts = DURABLE_COMMIT_POLL_MAX_ATTEMPTS,
    intervalMs = DURABLE_COMMIT_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onWaiting,
  } = {}
) {
  let lastReadError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let state;
    try {
      state = await fetchState();
      lastReadError = null;
    } catch (err) {
      lastReadError = err;
      if (err?.rateLimited) break;
      if (attempt < attempts) {
        onWaiting?.(attempt, attempts, "read_error");
        await sleep(intervalMs);
      }
      continue;
    }
    const record = state?.stories?.[storyId];
    if (record && isCommitted(record)) {
      return { committed: true, record };
    }
    if (attempt < attempts) {
      onWaiting?.(attempt, attempts, "pending");
      await sleep(intervalMs);
    }
  }
  if (lastReadError) {
    return { committed: false, status: "read_error", error: lastReadError.message, rateLimited: !!lastReadError.rateLimited };
  }
  return { committed: false, status: "timeout" };
}
