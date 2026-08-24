#!/usr/bin/env node
// Main entry point: npm run refresh — $0 cost, no API key required.
//
//   1. Fetch new source articles (fetch-news.js)
//   2. Compare against already-processed URLs, cluster duplicates, extract
//      category/importance/teams/players deterministically (generate-content.js)
//   3. Write news.json + data/processed-articles.json (lib/store.js) —
//      only if something actually changed
//   4. Regenerate index.html + feed.xml + per-story pages/JSON — same guard
//   5. Write status.json — ALWAYS, on every successful run, whether or not
//      anything in step 3/4 changed. This is what the site's freshness
//      indicator reads; see writeStatus() in lib/store.js for why it's
//      deliberately separate from news.json's own timestamp.
import { readFile } from "node:fs/promises";
import { fetchAllSources } from "./fetch-news.js";
import { processDiscoveredArticles } from "./generate-content.js";
import {
  readNews,
  writeNews,
  readProcessedArticles,
  writeProcessedArticles,
  writeStatus,
  NEWS_JSON_PATH,
} from "./lib/store.js";
import { generateHtml, generateFeedXml } from "./generate-html.js";
import { generateStoryPages } from "./generate-stories.js";
import { isAiConfigured } from "./lib/ai.js";

async function main() {
  const startedAt = Date.now();
  console.log(
    `AI enrichment: ${isAiConfigured() ? "ON (Anthropic — this run will make paid API calls)" : "off (deterministic, $0 cost)"}`
  );

  const [existingStories, processedUrls, sourceResults] = await Promise.all([
    readNews(),
    readProcessedArticles(),
    fetchAllSources(),
  ]);

  for (const r of sourceResults) {
    if (r.error) console.warn(`[refresh] ${r.source.name} failed: ${r.error}`);
    else console.log(`[refresh] ${r.source.name}: ${r.articles.length} articles found`);
  }

  const { stories, processedUrls: updatedLedger, stats } = await processDiscoveredArticles(
    sourceResults,
    existingStories,
    processedUrls
  );

  const { stories: savedStories, changed } = await writeNews(stories);
  await writeProcessedArticles(updatedLedger);

  if (changed) {
    await generateHtml(savedStories);
    await generateFeedXml(savedStories);
    const { written, removed } = await generateStoryPages(savedStories);
    console.log(`[refresh] Story pages: ${written} written, ${removed} removed (aged out).`);
  } else {
    console.log("[refresh] No story content changed — index.html/feed.xml/stories left untouched.");
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nDone in ${seconds}s — ${stats.articlesSeen} articles checked, ${stats.newStories} new stories, ` +
      `${stats.updatedStories} updated, ${stats.skippedExisting} already known. ${savedStories.length} stories live.`
  );

  let succeeded = true;

  const failedSources = sourceResults.filter((r) => r.error);
  if (failedSources.length === sourceResults.length) {
    console.error("All sources failed — check network access.");
    succeeded = false;
  }

  if (!runFreshnessCheck(stats, savedStories)) {
    succeeded = false;
  }

  if (succeeded) {
    const newestStory = newestLatestPublishedAt(savedStories);
    await writeStatus({
      storyCount: savedStories.length,
      latestStoryPublishedAt: newestStory,
      // Reflects the current news.json regardless of whether *this* run
      // changed it — always the true "when did content last actually move".
      lastContentChange: await readGeneratedAt(),
      workflowEvent: process.env.GITHUB_EVENT_NAME || "manual",
    });
    console.log("[refresh] status.json updated (last_successful_refresh).");
  } else {
    console.error("[refresh] Refresh did not pass its own health checks — status.json NOT updated.");
    process.exitCode = 1;
  }
}

function newestLatestPublishedAt(savedStories) {
  return savedStories.reduce(
    (max, s) => (!max || Date.parse(s.latest_published_at) > Date.parse(max) ? s.latest_published_at : max),
    null
  );
}

async function readGeneratedAt() {
  try {
    const raw = await readFile(NEWS_JSON_PATH, "utf-8");
    return JSON.parse(raw).generated_at ?? null;
  } catch {
    return null;
  }
}

// Automated freshness self-check (runs every refresh, local and in CI).
// A green workflow only proves the script executed — it does NOT prove
// current news was actually captured. This compares what we *discovered*
// against what actually ended up in news.json and fails the run if a real
// gap appears, which blocks both the workflow's commit step AND
// status.json from being updated — a broken run never gets to claim
// "last successful refresh" for itself.
//
// Deliberately distinct from the staleness warning below: a freshness-check
// FAILURE means "we found something and didn't save it" (a real bug). A
// staleness WARNING just means "nothing new has published in a while,"
// which is normal overnight or in the offseason and does not fail the run.
const FRESHNESS_GAP_MINUTES = 10; // discovered-but-not-reflected tolerance
const STALE_SOURCE_HOURS = 6; // lenient on purpose: quiet windows are normal, not a bug

function runFreshnessCheck(stats, savedStories) {
  const newestStory = newestLatestPublishedAt(savedStories);

  console.log("\nFreshness check:");
  console.log(`  Newest discovered source article: ${stats.newestDiscoveredPublishedAt ?? "n/a"}`);
  console.log(`  Newest story saved to news.json:  ${newestStory ?? "n/a"}`);

  if (stats.newestDiscoveredPublishedAt && newestStory) {
    const gapMin = (Date.parse(stats.newestDiscoveredPublishedAt) - Date.parse(newestStory)) / 60_000;
    if (gapMin > FRESHNESS_GAP_MINUTES) {
      console.error(
        `FRESHNESS CHECK FAILED: the newest discovered article (${stats.newestDiscoveredPublishedAt}) is ` +
          `${gapMin.toFixed(0)} minutes newer than the newest story actually saved to news.json (${newestStory}). ` +
          `A discovered article is not being reflected in the output — do not trust this run's data.`
      );
      return false;
    }
  }

  if (newestStory) {
    const staleHours = (Date.now() - Date.parse(newestStory)) / 3_600_000;
    if (staleHours > STALE_SOURCE_HOURS) {
      console.warn(
        `NO NEW NEWS (not a failure): the newest story is ${staleHours.toFixed(1)}h old. Can be normal overnight ` +
          `or in the offseason; if this persists during an active news window it may mean a source stopped ` +
          `publishing or is broken. This does not affect last_successful_refresh — the refresh itself still ran fine.`
      );
    }
  }

  return true;
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exitCode = 1;
});
