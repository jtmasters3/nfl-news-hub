import { enabledSources } from "./sources.js";
import { fetchRssSource } from "./rss.js";
import { fetchSitemapSource } from "./sitemap.js";

async function fetchOneSource(source) {
  try {
    const articles =
      source.type === "rss" ? await fetchRssSource(source) : await fetchSitemapSource(source);
    return { source, articles, error: null };
  } catch (err) {
    return { source, articles: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetches every enabled source in parallel. A failure in one source (feed
 * down, network blip) never blocks the others — each result reports its own
 * error so the pipeline can log it without aborting the whole run.
 */
export async function fetchAllSources() {
  return Promise.all(enabledSources().map(fetchOneSource));
}
