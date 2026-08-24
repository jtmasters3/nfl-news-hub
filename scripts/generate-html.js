// Renders the fully static index.html (and feed.xml) from the current
// story list. All story content is baked directly into the HTML — nothing
// is fetched client-side — so the page works for crawlers, for Munch AI's
// HTTP fetcher, and even opened directly via file://. JS only adds
// filtering/search/copy interactivity on top of what's already rendered.
import { writeFile } from "node:fs/promises";
import { TEAMS } from "./lib/teams.js";
import { FILTERS, BREAKING_IMPORTANCE_THRESHOLD } from "./lib/filters.js";
import { categoryLabel } from "./lib/munch.js";
import { escapeHtml, truncate } from "./lib/text.js";
import { INDEX_HTML_PATH, FEED_XML_PATH } from "./lib/store.js";

// Optional: set SITE_URL (e.g. https://my-nfl-feed.com) once deployed so
// feed.xml and canonical links use absolute URLs, which RSS readers expect.
// Left unset, everything uses relative paths and still works fine.
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
function absUrl(relativePath) {
  return SITE_URL ? `${SITE_URL}/${relativePath}` : `./${relativePath}`;
}

// GITHUB_REPOSITORY ("owner/repo") is set automatically inside GitHub
// Actions; falls back to this project's known repo for local `npm run
// refresh` runs so the freshness indicator still works outside CI.
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || "jtmasters3/nfl-news-hub";
const WORKFLOW_FILE = "refresh.yml";

function importanceLabel(score) {
  if (score >= 9) return "Breaking";
  if (score >= 7) return "Major";
  if (score >= 4) return "Normal";
  return "Minor";
}

function renderFilters() {
  return FILTERS.map((f) => {
    const categories = f.categories ? f.categories.join(",") : "";
    const minImportance = f.key === "breaking" ? ` data-min-importance="${BREAKING_IMPORTANCE_THRESHOLD}"` : "";
    return `<button type="button" class="chip" data-filter="${f.key}" data-categories="${categories}"${minImportance}>${escapeHtml(f.label)}</button>`;
  }).join("\n        ");
}

function renderTeamOptions() {
  // Value = full team name, matching the full names stored in story.teams /
  // data-teams — one representation everywhere, no abbreviation lookup needed.
  return TEAMS.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join(
    "\n        "
  );
}

function renderStoryCard(story) {
  const teams = story.teams.join(", ");
  const players = story.players.join(", ");
  const searchBlob = [
    story.headline,
    ...story.sources.flatMap((s) => [s.headline, s.description]),
    teams,
    players,
    categoryLabel(story.category),
  ]
    .join(" ")
    .toLowerCase();

  const previewText = story.sources[0]?.description || story.sources[0]?.headline || "";

  const sourceReportsHtml = story.sources
    .map(
      (s) => `<div class="source-report">
                <h4>${escapeHtml(s.name)}</h4>
                <p><strong>Headline:</strong> ${escapeHtml(s.headline)}</p>
                <p><strong>Description:</strong> ${escapeHtml(s.description || "(no description available)")}</p>
                <p><strong>Source:</strong> <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(s.url, 70))}</a></p>
              </div>`
    )
    .join("\n              ");

  const badges = [
    `<span class="badge badge-category">${escapeHtml(categoryLabel(story.category))}</span>`,
    `<span class="badge badge-importance badge-importance-${importanceLabel(story.importance_score).toLowerCase()}">${importanceLabel(story.importance_score)}</span>`,
    story.is_rumor ? `<span class="badge badge-rumor">RUMOR</span>` : "",
    story.status === "updated"
      ? `<span class="badge badge-updated">UPDATED <span data-relative-time-short data-time="${escapeHtml(story.latest_published_at)}"></span></span>`
      : "",
  ]
    .filter(Boolean)
    .join("\n            ");

  return `
      <article class="card"
        data-id="${escapeHtml(story.id)}"
        data-category="${escapeHtml(story.category)}"
        data-teams="${escapeHtml(story.teams.join(","))}"
        data-importance="${story.importance_score}"
        data-rumor="${story.is_rumor}"
        data-latest-published-at="${escapeHtml(story.latest_published_at)}"
        data-search="${escapeHtml(searchBlob)}">
        <div class="card-badges">
            ${badges}
            <span class="time" data-relative-time data-time="${escapeHtml(story.latest_published_at)}"></span>
        </div>
        <h2 class="headline">${escapeHtml(story.headline)}</h2>
        ${teams ? `<p class="meta teams">${escapeHtml(teams)}</p>` : ""}
        ${players ? `<p class="meta players">${escapeHtml(players)}</p>` : ""}
        ${previewText ? `<p class="summary">${escapeHtml(truncate(previewText, 220))}</p>` : ""}

        <details class="story-details">
          <summary>Show full story (${story.sources.length} source${story.sources.length === 1 ? "" : "s"})</summary>

          ${story.is_rumor ? `<p class="callout callout-rumor">RUMOR — unconfirmed report</p>` : ""}
          ${story.status === "updated" && story.update_note ? `<p class="callout callout-updated"><strong>UPDATED:</strong> ${escapeHtml(story.update_note)}</p>` : ""}

          <section>
            <h3>Source Reporting</h3>
            ${sourceReportsHtml}
          </section>

          <section class="munch-block">
            <div class="munch-header">
              <h3>Munch Content</h3>
              <button type="button" class="copy-btn" data-copy-target="munch-${escapeHtml(story.id)}">Copy for Munch</button>
            </div>
            <textarea id="munch-${escapeHtml(story.id)}" class="munch-textarea" readonly>${escapeHtml(story.munch_content)}</textarea>
          </section>
        </details>
      </article>`;
}

function renderPage(stories) {
  const cards = stories.length
    ? stories.map(renderStoryCard).join("\n")
    : `<p class="empty-state">No stories yet. Run <code>npm run refresh</code> to fetch the latest NFL news.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NFL News Hub</title>
  <meta name="description" content="Aggregated NFL news, deduplicated and organized as source material for social content production." />
  <link rel="alternate" type="application/rss+xml" title="NFL News Hub" href="${absUrl("feed.xml")}" />
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <h1>NFL NEWS FEED</h1>
      <p class="tagline">Aggregated from ESPN, NFL.com, FOX Sports &amp; Pro Football Talk — organized source material for Munch AI.</p>
      <p class="feed-links"><a href="./news.json">news.json</a> · <a href="./feed.xml">feed.xml</a></p>
      <p class="freshness" id="freshness-indicator" data-gh-repo="${escapeHtml(GITHUB_REPO)}" data-gh-workflow="${escapeHtml(WORKFLOW_FILE)}">
        <span id="freshness-label">Checking feed status…</span>
      </p>
    </div>
  </header>

  <main class="wrap">
    <div class="filters">
      <div class="chips" id="filter-chips">
        ${renderFilters()}
      </div>
      <div class="controls">
        <select id="team-filter">
          <option value="">All Teams</option>
          ${renderTeamOptions()}
        </select>
        <input type="search" id="search-box" placeholder="Search players, teams, topics…" />
      </div>
    </div>

    <p id="empty-message" class="empty-state" hidden>No stories match these filters.</p>

    <div id="story-list" class="story-list">
      ${cards}
    </div>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <p>Sources: ESPN · NFL.com · FOX Sports · Pro Football Talk. Every story links back to its original reporting.</p>
    </div>
  </footer>

  <script src="./app.js"></script>
</body>
</html>
`;
}

export async function generateHtml(stories) {
  await writeFile(INDEX_HTML_PATH, renderPage(stories), "utf-8");
}

function xmlEscape(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderFeedItem(story) {
  const primarySource = story.sources[0];
  const description = primarySource?.description || story.headline;
  return `    <item>
      <title>${xmlEscape(story.headline)}</title>
      <link>${xmlEscape(primarySource?.url ?? "")}</link>
      <guid isPermaLink="false">${xmlEscape(story.id)}</guid>
      <pubDate>${new Date(story.latest_published_at).toUTCString()}</pubDate>
      <category>${xmlEscape(categoryLabel(story.category))}</category>
      <description>${xmlEscape(description)}</description>
    </item>`;
}

export async function generateFeedXml(stories) {
  const items = stories.map(renderFeedItem).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>NFL News Hub</title>
    <link>${xmlEscape(absUrl("index.html"))}</link>
    <description>Aggregated, deduplicated NFL news with organized source reporting.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  await writeFile(FEED_XML_PATH, xml, "utf-8");
}
