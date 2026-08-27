#!/usr/bin/env node
// Maintainer-run manual enqueue: node scripts/social/enqueue-story.js <story_id>
//
// For Phase 2A this ONLY supports preexisting_ignored -> new (promoting a
// pre-cutover story you've explicitly picked). It does not queue the story
// itself — the next refresh's normal sync/promote step (see
// generate-artwork-queue.js) picks up the "new" record and, if the story's
// current data is still eligible (post_headline/base_image_url/source_url
// all present), advances it to "queued" like any other story.
//
// Deliberately does NOT support force-reposting an already posted/rejected/
// approved story_id — that's a separate, explicit future administrative
// capability, not implemented here.
import { readSocialState, writeSocialState, resolveCanonicalId, transition } from "../lib/socialState.js";

async function main() {
  const storyId = process.argv[2];
  if (!storyId) {
    console.error("Usage: node scripts/social/enqueue-story.js <story_id>");
    process.exitCode = 1;
    return;
  }

  const state = await readSocialState();
  const resolved = resolveCanonicalId(state, storyId);

  if (!resolved.ok) {
    console.error(`Could not resolve story_id ${storyId}: ${resolved.error} (chain: ${resolved.chain?.join(" -> ")})`);
    process.exitCode = 1;
    return;
  }
  if (!resolved.record) {
    console.error(
      `No social-state record found for ${storyId}. Has scripts/social/cutover-seed.js been run? ` +
        `(A genuinely new post-cutover story only gets a record once it's been through a refresh.)`
    );
    process.exitCode = 1;
    return;
  }
  if (resolved.story_id !== storyId) {
    console.log(`Note: ${storyId} resolved to canonical story_id ${resolved.story_id} via merged_into.`);
  }
  if (resolved.record.status !== "preexisting_ignored") {
    console.error(
      `story_id ${resolved.story_id} is currently "${resolved.record.status}", not "preexisting_ignored". ` +
        `Manual enqueue in this phase only supports preexisting_ignored -> new.`
    );
    process.exitCode = 1;
    return;
  }

  const result = transition(state, storyId, "new");
  if (!result.ok) {
    console.error(`Transition failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  await writeSocialState(result.state);
  console.log(`story_id ${resolved.story_id}: preexisting_ignored -> new.`);
  console.log("It will be evaluated for eligibility (and queued, if eligible) on the next refresh.");
}

main().catch((err) => {
  console.error("Manual enqueue failed:", err);
  process.exitCode = 1;
});
