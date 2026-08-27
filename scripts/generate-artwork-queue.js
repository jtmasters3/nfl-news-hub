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
import { readSocialState, writeSocialState, syncStories, promoteEligible, buildQueueEntries } from "./lib/socialState.js";

/**
 * @param {Array} stories - current news.json stories (post-prune, i.e. what writeNews() returned)
 */
export async function generateArtworkQueue(stories) {
  let state = await readSocialState();

  const syncResult = syncStories(state, stories, { defaultStatus: "new" });
  state = syncResult.state;

  const promoteResult = promoteEligible(state, stories);
  state = promoteResult.state;

  await writeSocialState(state);

  const queueEntries = buildQueueEntries(state);
  await writeFile(SOCIAL_ARTWORK_QUEUE_JSON_PATH, JSON.stringify(queueEntries, null, 2) + "\n", "utf-8");

  return { count: queueEntries.length, created: syncResult.created, promoted: promoteResult.promoted };
}
