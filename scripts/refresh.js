#!/usr/bin/env node
// Main entry point: npm run refresh — $0 cost, no API key required.
//
//   1. Fetch new source articles (fetch-news.js)
//   2. Compare against already-processed URLs, cluster duplicates, extract
//      category/importance/teams/players deterministically (generate-content.js)
//   3. Write news.json + data/processed-articles.json (lib/store.js) —
//      only if something actually changed
//   4. Regenerate index.html + feed.xml (generate-html.js) — same guard
import { fetchAllSources } from "./fetch-news.js";
import { processDiscoveredArticles } from "./generate-content.js";
import { readNews, writeNews, readProcessedArticles, writeProcessedArticles } from "./lib/store.js";
import { generateHtml, generateFeedXml } from "./generate-html.js";
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
  } else {
    console.log("[refresh] No story content changed — index.html/feed.xml left untouched.");
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nDone in ${seconds}s — ${stats.articlesSeen} articles checked, ${stats.newStories} new stories, ` +
      `${stats.updatedStories} updated, ${stats.skippedExisting} already known. ${savedStories.length} stories live.`
  );

  const failedSources = sourceResults.filter((r) => r.error);
  if (failedSources.length === sourceResults.length) {
    console.error("All sources failed — check network access.");
    process.exitCode = 1;
  }

  runFreshnessCheck(stats, savedStories);
}

// Automated freshness self-check (runs every refresh, local and in CI).
// A green workflow only proves the script executed — it does NOT prove
// current news was actually captured. This compares what we *discovered*
// against what actually ended up in news.json and fails the run (non-zero
// exit) if a real gap shows up, which — combined with the workflow running
// this before its commit step — blocks a broken run from ever being
// published as if it were healthy.
const FRESHNESS_GAP_MINUTES = 10; // discovered-but-not-reflected tolerance
const STALE_SOURCE_HOURS = 6; // lenient on purpose: quiet overnight windows are normal

function runFreshnessCheck(stats, savedStories) {
  const newestStory = savedStories.reduce(
    (max, s) => (!max || Date.parse(s.latest_published_at) > Date.parse(max) ? s.latest_published_at : max),
    null
  );

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
      process.exitCode = 1;
      return;
    }
  }

  if (newestStory) {
    const staleHours = (Date.now() - Date.parse(newestStory)) / 3_600_000;
    if (staleHours > STALE_SOURCE_HOURS) {
      console.warn(
        `FRESHNESS WARNING: the newest story is ${staleHours.toFixed(1)}h old. Can be normal overnight; ` +
          `if this persists during the day it may mean a source stopped publishing or a source is broken.`
      );
    }
  }
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exitCode = 1;
});
