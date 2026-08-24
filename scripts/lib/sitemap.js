import { asArray, fetchXml, textOf } from "./xml.js";
import { stripHtml, truncate } from "./text.js";
import { fetchOgDescription } from "./ogDescription.js";

const MAX_ARTICLES = 25;
const MAX_DESCRIPTION_FETCHES = 15;

export async function fetchSitemapSource(source) {
  const xml = await fetchXml(source.feedUrl);
  const entries = asArray(xml.urlset?.url);

  const candidates = entries
    .filter((entry) => Boolean(entry["news:news"]))
    .map((entry) => {
      const loc = textOf(entry.loc).trim();
      const news = entry["news:news"];
      const title = stripHtml(textOf(news["news:title"]));
      const publishedRaw = textOf(news["news:publication_date"]).trim();
      return { loc, title, publishedAt: parseDate(publishedRaw) };
    })
    .filter((entry) => entry.loc.includes("/news/") && entry.title);

  candidates.sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bt - at;
  });

  const selected = candidates.slice(0, MAX_ARTICLES);

  const articles = [];
  let descriptionFetches = 0;

  for (const entry of selected) {
    let excerpt = "";
    if (source.fetchDescription && descriptionFetches < MAX_DESCRIPTION_FETCHES) {
      descriptionFetches++;
      excerpt = await fetchOgDescription(entry.loc);
    }

    articles.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: entry.loc,
      headline: entry.title,
      excerpt: truncate(excerpt, 600),
      publishedAt: entry.publishedAt,
    });
  }

  return articles;
}

function parseDate(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
