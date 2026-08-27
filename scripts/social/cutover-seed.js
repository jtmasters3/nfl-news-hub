#!/usr/bin/env node
// ONE-TIME cutover tool. Run exactly once, at the moment the social
// automation system goes live: node scripts/social/cutover-seed.js
//
// Snapshots every story_id currently in news.json and marks it
// "preexisting_ignored" in data/social-state.json — this, not a stored
// timestamp, IS the cutover line. From this point on, the regular refresh
// pipeline's sync step (see generate-artwork-queue.js) only ever creates
// FRESH records with status "new" for story_ids it has never seen before;
// every story_id seeded here already has a record, so it's permanently
// excluded from ever auto-entering the artwork queue. Use
// scripts/social/enqueue-story.js to manually promote one of these later.
//
// Idempotent: re-running only adds records for story_ids not already
// present (e.g. if the very first run was interrupted) — it never touches
// or resets an existing record, regardless of that record's current status.
import { readNews } from "../lib/store.js";
import { readSocialState, writeSocialState, ensureRecord } from "../lib/socialState.js";

async function main() {
  const stories = await readNews();
  let state = await readSocialState();
  const alreadyPresent = Object.keys(state.stories).length;

  let seeded = 0;
  for (const story of stories) {
    const result = ensureRecord(state, story.id, { status: "preexisting_ignored" });
    state = result.state;
    if (result.created) seeded++;
  }

  if (!state.cutover_at) {
    state = { ...state, cutover_at: new Date().toISOString() };
  }

  await writeSocialState(state);

  console.log(`news.json currently has ${stories.length} stor${stories.length === 1 ? "y" : "ies"}.`);
  console.log(`social-state.json already had ${alreadyPresent} record(s) before this run.`);
  console.log(`Newly seeded as preexisting_ignored: ${seeded}`);
  console.log(`Total records in social-state.json now: ${Object.keys(state.stories).length}`);
  console.log(`cutover_at: ${state.cutover_at}`);
  console.log("\nNone of these will enter social-artwork-queue.json automatically.");
  console.log("Use scripts/social/enqueue-story.js <story_id> to manually promote one.");
}

main().catch((err) => {
  console.error("Cutover seed failed:", err);
  process.exitCode = 1;
});
