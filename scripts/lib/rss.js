import { asArray, fetchXml, textOf } from "./xml.js";
import { stripHtml, truncate } from "./text.js";

export async function fetchRssSource(source) {
  const xml = await fetchXml(source.feedUrl);
  const items = asArray(xml.rss?.channel?.item);

  const articles = [];
  for (const item of items) {
    const headline = stripHtml(textOf(item.title));
    const link = textOf(item.link).trim();
    const description = stripHtml(textOf(item.description));
    const pubDate = textOf(item.pubDate).trim();

    if (!headline || !link) continue;

    articles.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: link,
      headline,
      excerpt: truncate(description, 600),
      publishedAt: parseDate(pubDate),
    });
  }

  return articles;
}

function parseDate(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
