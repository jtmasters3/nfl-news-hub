import { XMLParser } from "fast-xml-parser";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; NFLNewsHubBot/1.0; +https://example.com/bot) NewsAggregator";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#text",
  trimValues: true,
});

export async function fetchXml(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) {
      throw new Error(`Fetch failed for ${url}: HTTP ${res.status}`);
    }
    const text = await res.text();
    return parser.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

/** Normalizes a field that fast-xml-parser may return as one object or an array. */
export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Extracts plain text from a node that may be a plain string, a
 * `{ "#text": ... }` CDATA node, or (as fast-xml-parser sometimes emits for
 * CDATA-only elements) a one-element array wrapping either of those.
 */
export function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object" && "#text" in value) {
    return textOf(value["#text"]);
  }
  return "";
}
