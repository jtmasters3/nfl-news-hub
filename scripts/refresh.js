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
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exitCode = 1;
});
