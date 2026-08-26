import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storyHtmlUrl, storyJsonUrl } from "./urls.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NEWS_JSON_PATH = path.join(ROOT, "news.json");
export const PROCESSED_ARTICLES_PATH = path.join(ROOT, "data", "processed-articles.json");
export const INDEX_HTML_PATH = path.join(ROOT, "index.html");
export const FEED_XML_PATH = path.join(ROOT, "feed.xml");
export const STORIES_DIR = path.join(ROOT, "stories");
export const STATUS_JSON_PATH = path.join(ROOT, "status.json");
export const SOCIAL_FEED_JSON_PATH = path.join(ROOT, "social-feed.json");

const MAX_STORY_AGE_DAYS = 7; // stories older than this drop out of news.json
const MAX_STORIES = 300; // hard cap regardless of age
// URLs stay in the ledger well past MAX_STORY_AGE_DAYS so a story that has
// aged out of the public feed can't immediately reappear as "new" if an
// outlet's feed still lists it.
const MAX_PROCESSED_AGE_DAYS = 45;

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

/** Atomic write: write to a temp file then rename, so a crash mid-write can't corrupt the file. */
async function writeJsonAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

export async function readNews() {
  const data = await readJson(NEWS_JSON_PATH, { stories: [], generated_at: null });
  const stories = Array.isArray(data.stories) ? data.stories : [];
  return stories.map(migrateStory);
}

/**
 * One-time migration for stories written before first_published_at /
 * latest_published_at existed (they only had a single `published_at` +
 * `updated_at`). Without this, old stories would evaluate to an invalid
 * date on read and get silently pruned as "expired" the moment this schema
 * shipped — a real data-loss bug, not a hypothetical one. Backfills from
 * whatever the old story already has; a no-op once a story has already
 * been through generate-content.js under the new schema.
 */
function migrateStory(story) {
  if (story.latest_published_at && story.first_published_at) return story;
  const fallback = story.published_at ?? story.updated_at ?? new Date().toISOString();
  return {
    ...story,
    first_published_at: story.first_published_at ?? story.published_at ?? fallback,
    latest_published_at: story.latest_published_at ?? story.published_at ?? fallback,
  };
}

/**
 * Writes news.json — but only if the story content actually changed.
 * Comparing against what's currently on disk (rather than blindly writing
 * every run) keeps `generated_at` stable across no-op refreshes. This is
 * `last_content_change`, NOT a proxy for "the aggregator is running" — see
 * status.json / writeStatus() for that.
 */
export async function writeNews(stories) {
  const cutoff = Date.now() - MAX_STORY_AGE_DAYS * 86_400_000;
  const pruned = stories
    // Age based on actual news recency (latest_published_at), not on when we
    // last happened to touch the record — a story shouldn't get an
    // indefinite reprieve from pruning just because a late duplicate source
    // was discovered.
    .filter((s) => Date.parse(s.latest_published_at) >= cutoff)
    // Default sort: newest actual news first, full stop. Importance is
    // shown as a badge but must never bury today's stories under an old
    // "Breaking"-scored one — that was the root cause of stale-looking
    // homepage content.
    .sort((a, b) => Date.parse(b.latest_published_at) - Date.parse(a.latest_published_at))
    .slice(0, MAX_STORIES)
    // Recomputed fresh every write from slug + SITE_URL — always in sync,
    // no drift risk, no separate field to keep updated by hand.
    .map((s) => ({ ...s, story_url: storyHtmlUrl(s.slug), story_json_url: storyJsonUrl(s.slug) }));

  const onDisk = await readJson(NEWS_JSON_PATH, { stories: [] });
  const unchanged = JSON.stringify(onDisk.stories ?? []) === JSON.stringify(pruned);

  if (unchanged) {
    return { stories: pruned, changed: false };
  }

  await writeJsonAtomic(NEWS_JSON_PATH, {
    generated_at: new Date().toISOString(),
    count: pruned.length,
    stories: pruned,
  });

  return { stories: pruned, changed: true };
}

export async function readProcessedArticles() {
  const data = await readJson(PROCESSED_ARTICLES_PATH, { urls: {} });
  return data.urls ?? {};
}

export async function writeProcessedArticles(urls) {
  const cutoff = Date.now() - MAX_PROCESSED_AGE_DAYS * 86_400_000;
  const pruned = Object.fromEntries(
    Object.entries(urls).filter(([, entry]) => Date.parse(entry.processedAt) >= cutoff)
  );
  await writeJsonAtomic(PROCESSED_ARTICLES_PATH, { urls: pruned });
  return pruned;
}

/**
 * status.json is the source of truth for "is the aggregator actually
 * running", separate from news.json's `generated_at` (which only moves
 * when story *content* changes — many successful refreshes find nothing
 * new, and that's not the same thing as the system being broken). Written
 * unconditionally on every successful refresh, so a run that checked all
 * sources and found zero new stories still proves the feed was checked.
 *
 * Three distinct timestamps, deliberately not conflated:
 *   last_successful_refresh   — when the aggregator itself last completed
 *                                a successful source check (this write)
 *   last_content_change       — when the public story data itself last
 *                                changed (mirrors news.json's generated_at)
 *   latest_story_published_at — newest source-claimed publish time
 *                                currently in the feed (can be legitimately
 *                                old overnight/in the offseason — this is
 *                                NOT a health signal on its own)
 */
export async function writeStatus({ storyCount, latestStoryPublishedAt, lastContentChange, workflowEvent }) {
  await writeJsonAtomic(STATUS_JSON_PATH, {
    last_successful_refresh: new Date().toISOString(),
    last_content_change: lastContentChange,
    latest_story_published_at: latestStoryPublishedAt,
    story_count: storyCount,
    workflow_event: workflowEvent,
  });
}

export function projectRoot() {
  return ROOT;
}

export function fileExists(filePath) {
  return existsSync(filePath);
}
