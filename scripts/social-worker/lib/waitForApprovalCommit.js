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
// console still reported a timeout. Original (WRONG) diagnosis: a stale
// Fastly edge cache on raw.githubusercontent.com, "fixed" by appending a
// unique `?approval_poll=<value>` query parameter to every poll.
//
// 2026-09-03 correction: that fix never worked. Anthony Richardson's
// approval hit the exact same false-timeout symptom, and direct empirical
// testing (repeated requests against the same URL with distinct,
// never-before-seen query values) proved Fastly ignores the query string
// entirely for this asset's cache key — every request kept returning the
// same cached object regardless of the value appended. A query-string
// cache-buster on a MUTABLE branch-name URL cannot be fixed by trying
// harder at cache-busting; the URL itself can always be stale.
//
// The real fix: `fetchState` no longer reads via the mutable
// `.../main/data/social-state.json` URL at all. It reads via
// lib/githubStateReader.js's createFreshStateFetcher(), which checks the
// GitHub REST API (not a long-TTL CDN) for the latest commit SHA touching
// the file, then reads the content pinned to that exact SHA — a URL that
// is either a genuine first-ever fetch (guaranteed fresh) or safely,
// permanently correct to have cached (a given commit's content never
// changes). There is no "stale" state possible for a SHA-pinned URL.
//
// A consequence of reading through a real API is that a single attempt can
// now genuinely fail (a transient GitHub API error, a rate limit) rather
// than just returning "not yet approved". Such a failure is tracked
// separately from ordinary pending/waiting and reported as its own
// terminal `status: "read_error"` if every remaining attempt keeps
// failing — it must never be silently folded into "timeout", since an
// operator needs to be able to tell "GitHub API had a blip" apart from
// "the Action is just taking a while."
export const APPROVAL_POLL_MAX_ATTEMPTS = 20;
export const APPROVAL_POLL_INTERVAL_MS = 3000;

/**
 * @param {() => Promise<object>} fetchState - returns the parsed, current data/social-state.json,
 *   or rejects (optionally with `.rateLimited = true`) on a read failure. A pure READ — this
 *   function never calls anything that could mutate the approval decision.
 * @param {string} storyId
 * @param {{ attempts?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>, onWaiting?: (attempt: number, attempts: number, reason: "pending"|"read_error") => void }} [opts]
 * @returns {Promise<
 *   {committed: true, status: "approved"|"rejected", record: object} |
 *   {committed: false, status: "timeout"} |
 *   {committed: false, status: "read_error", error: string, rateLimited?: boolean}
 * >}
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
  let lastReadError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let state;
    try {
      state = await fetchState();
      lastReadError = null;
    } catch (err) {
      lastReadError = err;
      // A rate-limit signal means keeping the loop running (and hammering
      // an already-limited API) can only make things worse — stop now and
      // report it rather than burning the rest of the attempt budget.
      if (err?.rateLimited) break;
      if (attempt < attempts) {
        onWaiting?.(attempt, attempts, "read_error");
        await sleep(intervalMs);
      }
      continue;
    }
    const record = state?.stories?.[storyId];
    const status = record?.status;
    if (status === "approved" || status === "rejected") {
      return { committed: true, status, record };
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
