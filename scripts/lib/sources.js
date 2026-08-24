/**
 * Registry of approved NFL news sources. Every entry uses a legitimate,
 * publicly accessible feed (official RSS or a Google News sitemap) — no
 * scraping, no paywall/robots bypass, no anti-bot circumvention.
 *
 * To add a new source: add an entry here. Nothing else in the pipeline
 * needs to change as long as it's a standard RSS feed or news sitemap.
 *
 * Multiple entries can share the same `name` (outlet) if that outlet is
 * discovered through more than one legitimate channel — see FOX Sports
 * below, which needed a second path after a real coverage gap was found.
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
    sitemapPathFilter: "/news/",
    fetchDescription: true,
    enabled: true,
  },
  {
    id: "foxsports",
    name: "FOX Sports",
    homepageUrl: "https://www.foxsports.com/nfl",
    // Official public feed listed at https://www.foxsports.com/rss-feeds
    // ("free of charge ... for non-commercial use" with attribution).
    // Bumped size 30 -> 50 (verified FOX honors it: 41 real items returned
    // vs 26 at size=30). NOTE: this feed does NOT carry every NFL article —
    // see foxsports-sitemap below for why a second source is required.
    type: "rss",
    feedUrl:
      "https://api.foxsports.com/v2/content/optimized-rss?partnerKey=MB0Wehpmuj2lUhuRhQaafhBjAJqaPU244mlTDK1i&size=50&tags=fs/nfl",
    enabled: true,
  },
  {
    id: "foxsports-sitemap",
    name: "FOX Sports",
    homepageUrl: "https://www.foxsports.com/nfl",
    // Confirmed real coverage gap: short-form "spark_post" items (e.g.
    // single-team injury briefs) are published live on foxsports.com and
    // listed in FOX's own Google News sitemap, but never appear in the
    // tags=fs/nfl RSS feed above at any size (tested up to size=100) — they
    // appear to be excluded from that feed by content type or tag
    // classification. FOX's public news sitemap (declared in robots.txt)
    // is the legitimate second discovery path for that gap. It covers all
    // of foxsports.com (NASCAR, motor sports, etc.), so sitemapPathFilter
    // isolates /stories/nfl/ articles. Same feed-parsing code as NFL.com's
    // sitemap (scripts/lib/sitemap.js) — no bespoke logic needed.
    type: "sitemap",
    feedUrl: "https://www.foxsports.com/sitemap.xml?type=news",
    sitemapPathFilter: "/stories/nfl/",
    fetchDescription: true,
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
