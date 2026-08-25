// Extracts publicly exposed article-image metadata (og:image, twitter:image,
// JSON-LD image, caption/credit where present) from a single article page.
// Fetched ONCE per article URL at discovery time and cached on the source
// record — never re-fetched on later refreshes (see generate-content.js).
// We only ever read metadata tags, never the article body, and we never
// download/rehost the image itself — only the remote URL + attribution is
// stored. Every failure mode here degrades to nulls; this must never throw
// or block the news pipeline (see fetchArticleImageMeta's try/catch).
import { USER_AGENT } from "./xml.js";
import { decodeHtmlEntities } from "./text.js";

// Substring (not \b-bounded word) matches on purpose — verified against a
// live ESPN URL ("nfl_shield01jr_1296x729.jpg") during source testing that
// a trailing suffix right after "shield" breaks a \bshield\b boundary
// match, letting the generic NFL shield stock photo slip through undetected.
const NON_CONTENT_URL_PATTERNS = [
  /logo/i, /sprite/i, /avatar/i, /placeholder/i,
  /pixel/i, /tracking/i, /\bblank\b/i, /spacer/i,
  /favicon/i, /\bicon[-_]/i, /1x1/, /default[-_]?image/i,
  /nfl[-_]?shield/i,
];

function metaContent(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return null;
}

function extractOgImage(html) {
  const url = metaContent(html, [
    /<meta\s+property=["']og:image:secure_url["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:image:secure_url["']/i,
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
  ]);
  const width = metaContent(html, [
    /<meta\s+property=["']og:image:width["']\s+content=["'](\d+)["']/i,
    /<meta\s+content=["'](\d+)["']\s+property=["']og:image:width["']/i,
  ]);
  const height = metaContent(html, [
    /<meta\s+property=["']og:image:height["']\s+content=["'](\d+)["']/i,
    /<meta\s+content=["'](\d+)["']\s+property=["']og:image:height["']/i,
  ]);
  const alt = metaContent(html, [
    /<meta\s+property=["']og:image:alt["']\s+content=["']([^"']*)["']/i,
    /<meta\s+content=["']([^"']*)["']\s+property=["']og:image:alt["']/i,
  ]);
  return { url, width, height, alt };
}

function extractTwitterImage(html) {
  const url = metaContent(html, [
    /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+name=["']twitter:image["']/i,
    /<meta\s+name=["']twitter:image:src["']\s+content=["']([^"']+)["']/i,
  ]);
  const alt = metaContent(html, [
    /<meta\s+name=["']twitter:image:alt["']\s+content=["']([^"']*)["']/i,
  ]);
  return { url, alt };
}

/** Best-effort scan of <script type="application/ld+json"> blocks for an image + credit. */
function extractJsonLd(html) {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = node["@type"];
      const isArticle = typeof type === "string" ? /article/i.test(type) : Array.isArray(type) && type.some((t) => /article/i.test(t));
      if (!isArticle && !node.image) continue;

      let image = node.image;
      if (Array.isArray(image)) image = image[0];
      if (!image) continue;

      if (typeof image === "string") {
        return { url: image, width: null, height: null, credit: null, caption: null };
      }
      if (typeof image === "object") {
        const url = image.url ?? image.contentUrl ?? null;
        if (!url) continue;
        const credit = image.creditText ?? image.copyrightHolder?.name ?? image.creator?.name ?? node.copyrightHolder?.name ?? null;
        return {
          url,
          width: image.width ? String(image.width) : null,
          height: image.height ? String(image.height) : null,
          credit: credit ? String(credit).trim() : null,
          caption: image.caption ? String(image.caption).trim() : null,
        };
      }
    }
  }
  return null;
}

/**
 * Best-effort credit scrape via common credit markup or a "(Photo by ...)"
 * caption phrase. Deliberately does NOT fall back to "the first
 * <figcaption> on the page" — verified against live ESPN articles during
 * testing, that heuristic frequently grabs an embedded video's caption
 * instead of the actual og:image's caption (ESPN articles commonly have a
 * video player above the static thumbnail), which is a misattribution, not
 * a null. A caption is only ever trusted when it comes from JSON-LD's
 * `image.caption` (see extractJsonLd) — structurally scoped to the image
 * itself, not scraped positionally.
 */
function extractCredit(html) {
  let credit = null;
  const creditClassMatch = html.match(
    /class=["'][^"']*(?:photo-credit|image-credit|img-credit|media-credit|credit)[^"']*["'][^>]*>([\s\S]{0,200}?)</i
  );
  if (creditClassMatch) {
    credit = decodeHtmlEntities(creditClassMatch[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() || null;
  }
  if (!credit) {
    const parenMatch = html.match(/\(Photo(?:s)?\s+(?:by|courtesy of)\s+([^)]{2,80})\)/i);
    if (parenMatch) credit = decodeHtmlEntities(parenMatch[1]).replace(/\s+/g, " ").trim();
  }

  return credit;
}

function looksLikeNonContentImage(url) {
  if (!url) return true;
  // Decode first — verified against a live ESPN URL during source testing
  // that percent-encoding (og:image values are often embedded/re-encoded,
  // e.g. "nfl%2Dshield" for "nfl-shield") otherwise hides an obvious logo
  // filename from these patterns entirely.
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed percent-encoding — fall back to matching the raw string.
  }
  return NON_CONTENT_URL_PATTERNS.some((p) => p.test(decoded));
}

/**
 * Validates a candidate image URL with a cheap HEAD request: successful
 * response, image/* MIME type, and not a ~1x1 tracking pixel (by byte
 * size — a real editorial photo is never under a few KB). Never throws;
 * any failure is treated as "could not validate" (caller decides whether
 * to keep or drop the candidate).
 */
export async function validateImageUrl(url, timeoutMs = 5000) {
  if (!url) return { ok: false, reason: "no-url" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return { ok: false, reason: `bad-mime-${contentType}` };
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 0 && len < 2000) return { ok: false, reason: "too-small" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches an article page once and extracts the best available lead-image
 * metadata: og:image, then twitter:image, then JSON-LD image — in that
 * priority order. Never invents missing fields; every field is null when
 * not publicly present. Never throws — any failure (network, parse,
 * timeout) resolves to an all-null result so a bad article never breaks
 * the refresh (see generate-content.js's try/catch around every call site).
 */
export async function fetchArticleImageMeta(url, timeoutMs = 8000) {
  const empty = {
    image_url: null,
    image_alt: null,
    image_caption: null,
    image_credit: null,
    image_width: null,
    image_height: null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let html;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (!res.ok) return empty;
    html = await res.text();
  } catch {
    return empty;
  } finally {
    clearTimeout(timeout);
  }

  try {
    const og = extractOgImage(html);
    const twitter = extractTwitterImage(html);
    const jsonLd = extractJsonLd(html);
    const credit = extractCredit(html);

    // Priority: og:image > twitter:image > JSON-LD image. Skip a candidate
    // outright if its URL matches an obvious logo/placeholder pattern
    // rather than falling back further with no basis to prefer one.
    const candidates = [
      og.url ? { url: og.url, width: og.width, height: og.height, alt: og.alt, caption: null, credit: null } : null,
      twitter.url ? { url: twitter.url, width: null, height: null, alt: twitter.alt, caption: null, credit: null } : null,
      jsonLd ? { url: jsonLd.url, width: jsonLd.width, height: jsonLd.height, alt: null, caption: jsonLd.caption, credit: jsonLd.credit } : null,
    ].filter(Boolean);

    const best = candidates.find((c) => !looksLikeNonContentImage(c.url));
    if (!best) return empty;

    return {
      image_url: best.url,
      image_alt: best.alt || null,
      image_caption: best.caption || null,
      image_credit: best.credit || credit || null,
      image_width: best.width ? Number(best.width) : null,
      image_height: best.height ? Number(best.height) : null,
    };
  } catch {
    return empty;
  }
}
