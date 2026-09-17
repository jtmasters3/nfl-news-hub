// Writes social-artwork-queue.json: the machine-readable list of story_ids
// that currently need artwork. Deliberately separate from social-feed.json
// (general social-ready story information, derived fresh from news.json
// every run) — this file is derived from data/social-state.json instead,
// which is the actual persistent authority on social-workflow history. All
// the state-mutating logic (sync + promote) lives in scripts/lib/
// socialState.js as pure, unit-tested functions; this module is just the
// thin file-I/O shell around them.
import { writeFile } from "node:fs/promises";
import { SOCIAL_ARTWORK_QUEUE_JSON_PATH } from "./lib/store.js";
import { readSocialState, writeSocialState, syncStories, promoteEligible, refreshQueuedSnapshots, buildQueueEntries } from "./lib/socialState.js";

/**
 * @param {Array} stories - current news.json stories (post-prune, i.e. what writeNews() returned)
 * @param {{filePath?: string, queueFilePath?: string}} [options] - test-only
 *   overrides for the social-state and queue-file paths, mirroring
 *   generate-selection.js's own existing `filePath` convention exactly.
 *   Both default to the real production paths for every real caller
 *   (refresh.js never passes either) — this exists purely so a refresh
 *   cycle's own same-run re-invocation (see refresh.js's 2026-09-17
 *   same-cycle queue-visibility fix) can be exercised in isolation against
 *   temp files, never against the live production files.
 */
export async function generateArtworkQueue(stories, { filePath, queueFilePath = SOCIAL_ARTWORK_QUEUE_JSON_PATH } = {}) {
  let state = await readSocialState(filePath);

  const syncResult = syncStories(state, stories, { defaultStatus: "new" });
  state = syncResult.state;

  const promoteResult = promoteEligible(state, stories);
  state = promoteResult.state;

  // Lets a corrected upstream computation (e.g. a socialPayload.js fix)
  // reach an already-queued entry on this very refresh — see
  // refreshQueuedSnapshots' doc comment for why this is safe only for
  // "queued" (zero Content Creation progress) and never any later status.
  const refreshResult = refreshQueuedSnapshots(state, stories);
  state = refreshResult.state;

  await writeSocialState(state, filePath);

  const queueEntries = buildQueueEntries(state);
  await writeFile(queueFilePath, JSON.stringify(queueEntries, null, 2) + "\n", "utf-8");

  return { count: queueEntries.length, created: syncResult.created, promoted: promoteResult.promoted, refreshed: refreshResult.refreshed };
}
