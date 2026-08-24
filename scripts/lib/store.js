import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NEWS_JSON_PATH = path.join(ROOT, "news.json");
export const PROCESSED_ARTICLES_PATH = path.join(ROOT, "data", "processed-articles.json");
export const INDEX_HTML_PATH = path.join(ROOT, "index.html");
export const FEED_XML_PATH = path.join(ROOT, "feed.xml");

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
  return Array.isArray(data.stories) ? data.stories : [];
}

/**
 * Writes news.json — but only if the story content actually changed.
 * Comparing against what's currently on disk (rather than blindly writing
 * every run) keeps `generated_at` stable across no-op refreshes, which in
 * turn keeps the scheduled workflow from creating a git commit every 20
 * minutes when nothing new happened.
 */
export async function writeNews(stories) {
  const cutoff = Date.now() - MAX_STORY_AGE_DAYS * 86_400_000;
  const pruned = stories
    .filter((s) => Date.parse(s.updated_at) >= cutoff)
    .sort((a, b) => {
      if (b.importance_score !== a.importance_score) return b.importance_score - a.importance_score;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    })
    .slice(0, MAX_STORIES);

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

export function projectRoot() {
  return ROOT;
}

export function fileExists(filePath) {
  return existsSync(filePath);
}
