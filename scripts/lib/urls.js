// Public base URL for this deployment. GitHub Actions doesn't expose the
// Pages URL as a built-in env var, so this defaults to the project's known
// live URL; override with SITE_URL if ever deployed elsewhere.
export const SITE_URL = (process.env.SITE_URL || "https://jtmasters3.github.io/nfl-news-hub").replace(
  /\/+$/,
  ""
);

export function absUrl(relativePath) {
  return `${SITE_URL}/${relativePath}`;
}

export function storyHtmlUrl(slug) {
  return absUrl(`stories/${slug}.html`);
}

export function storyJsonUrl(slug) {
  return absUrl(`stories/${slug}.json`);
}
