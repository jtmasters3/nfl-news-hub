#!/usr/bin/env node
// Editorial Scoring Brain — PHASE 1 observe-only inspection CLI.
//
// Strictly read-only: reads a local fixture file, or (with --story-id)
// reads the ALREADY-PUBLISHED news.json read-only via the existing
// readNews() helper. Never writes, claims, dispatches, or calls any
// network endpoint. Never touches data/social-state.json. Safe to run
// against real production data because it only ever reads it.
//
// Usage:
//   node scripts/editorial/score-story.js --fixture scripts/editorial/fixtures/head-coach-fired.json
//   node scripts/editorial/score-story.js --story-id <uuid> [--json]
//   node scripts/editorial/score-story.js --fixture <path> --json
import { readFile } from "node:fs/promises";
import { scoreStory, SCORING_VERSION } from "../lib/editorialScoring.js";
import { readNews } from "../lib/store.js";

function parseArgs(argv) {
  const args = { fixture: null, storyId: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture") args.fixture = argv[++i];
    else if (argv[i] === "--story-id") args.storyId = argv[++i];
    else if (argv[i] === "--json") args.json = true;
  }
  return args;
}

async function loadStory({ fixture, storyId }) {
  if (fixture) {
    const raw = await readFile(fixture, "utf-8");
    return JSON.parse(raw);
  }
  if (storyId) {
    // Read-only: readNews() only ever reads news.json from disk. No write,
    // no social-state access, no network call.
    const stories = await readNews();
    const story = stories.find((s) => s.id === storyId);
    if (!story) throw new Error(`story_id ${storyId} not found in the current news.json`);
    return story;
  }
  throw new Error("Provide either --fixture <path> or --story-id <uuid>");
}

function printHuman(result, label) {
  console.log(`\n=== Editorial score (v${SCORING_VERSION}) — ${label} ===`);
  console.log(`TOTAL SCORE: ${result.total_score}   (core: ${result.core_score})\n`);
  console.log("Explanation:");
  for (const line of result.explanation) console.log(`  - ${line}`);
  console.log("\nDestination fit (observe-only, provisional thresholds):");
  console.log(`  feed_fit:  ${result.destination.feed_fit}${result.destination.feed_block_reasons.length ? ` [${result.destination.feed_block_reasons.join(", ")}]` : ""}`);
  console.log(`  story_fit: ${result.destination.story_fit}${result.destination.story_block_reasons.length ? ` [${result.destination.story_block_reasons.join(", ")}]` : ""}`);
  console.log(`\nProduction readiness: image_available=${result.production_readiness.image_available} (${result.production_readiness.note})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let story;
  try {
    story = await loadStory(args);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const result = scoreStory(story);
  const label = args.fixture ?? args.storyId;

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result, label);
}

main().catch((err) => {
  console.error("score-story failed:", err);
  process.exitCode = 1;
});
