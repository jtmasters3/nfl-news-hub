/**
 * Registry of approved NFL news sources. Every entry uses a legitimate,
 * publicly accessible feed (official RSS or a Google News sitemap) — no
 * scraping, no paywall/robots bypass, no anti-bot circumvention.
 *
 * To add a new source: add an entry here. Nothing else in the pipeline
 * needs to change as long as it's a standard RSS feed or news sitemap.
 */
export const NEWS_SOURCES = [
  {
    id: "espn",
    name: "ESPN",
    homepageUrl: "https://www.espn.com/nfl/",
    type: "rss",
    feedUrl: "https://www.espn.com/espn/rss/nfl/news",
    enabled: true,
  },
  {
    id: "nfl",
    name: "NFL.com",
    homepageUrl: "https://www.nfl.com/news/",
    // NFL.com does not publish a public RSS feed. It does publish a Google
    // News sitemap (linked from robots.txt) listing recently published
    // articles with title + publish date — a standard, crawler-facing
    // discovery mechanism, not scraping.
    type: "sitemap",
    feedUrl: "https://www.nfl.com/sitemap-fast-changing.xml",
    fetchDescription: true,
    enabled: true,
  },
  {
    id: "foxsports",
    name: "FOX Sports",
    homepageUrl: "https://www.foxsports.com/nfl",
    // Official public feed listed at https://www.foxsports.com/rss-feeds
    // ("free of charge ... for non-commercial use" with attribution).
    type: "rss",
    feedUrl:
      "https://api.foxsports.com/v2/content/optimized-rss?partnerKey=MB0Wehpmuj2lUhuRhQaafhBjAJqaPU244mlTDK1i&size=30&tags=fs/nfl",
    enabled: true,
  },
  {
    id: "pft",
    name: "Pro Football Talk",
    homepageUrl: "https://www.nbcsports.com/profootballtalk",
    type: "rss",
    feedUrl: "https://www.nbcsports.com/profootballtalk.rss",
    enabled: true,
  },
];

export function enabledSources() {
  return NEWS_SOURCES.filter((s) => s.enabled);
}
