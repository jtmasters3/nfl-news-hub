import { USER_AGENT } from "./xml.js";
import { decodeHtmlEntities, truncate } from "./text.js";

/**
 * Fetches only the public `og:description` meta tag from an article page —
 * the short snippet sites expose for social-media link previews. This is
 * not article scraping: we never read or store the article body.
 */
export async function fetchOgDescription(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (!res.ok) return "";
    const html = await res.text();
    const match =
      html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i) ??
      html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:description["']/i) ??
      html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
    if (!match) return "";
    return truncate(decodeHtmlEntities(match[1] ?? "").trim(), 600);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
