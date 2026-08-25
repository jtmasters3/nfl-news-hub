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
import { formatHumanDateTime } from "./lib/dates.js";
import { INDEX_HTML_PATH, FEED_XML_PATH } from "./lib/store.js";
import { absUrl } from "./lib/urls.js";

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
                <p><strong>Published:</strong> ${escapeHtml(formatHumanDateTime(s.published_at))}</p>
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

  const breakingClass = story.importance_score >= BREAKING_IMPORTANCE_THRESHOLD ? " card-breaking" : "";
  // Only ever a remote reference to the publisher's own photo — never
  // downloaded/rehosted (see imageMeta.js) — and only shown when a
  // subject-matching image actually cleared the confidence bar (see
  // imageMatch.js). No image field means no image area, never a broken
  // placeholder.
  const mediaHtml = story.primary_image_url
    ? `<div class="card-media">
          <img src="${escapeHtml(story.primary_image_url)}" alt="${escapeHtml(story.primary_image_alt || story.visual_subject || story.headline)}" loading="lazy" />
        </div>`
    : "";
  const mediaClass = story.primary_image_url ? " card-has-media" : "";

  return `
      <article class="card${breakingClass}${mediaClass}"
        data-id="${escapeHtml(story.id)}"
        data-category="${escapeHtml(story.category)}"
        data-teams="${escapeHtml(story.teams.join(","))}"
        data-importance="${story.importance_score}"
        data-rumor="${story.is_rumor}"
        data-latest-published-at="${escapeHtml(story.latest_published_at)}"
        data-search="${escapeHtml(searchBlob)}">
        ${mediaHtml}
        <div class="card-body">
        <div class="card-badges">
            ${badges}
            <span class="time" data-relative-time data-time="${escapeHtml(story.latest_published_at)}"></span>
        </div>
        <h2 class="headline"><a href="${escapeHtml(story.story_url)}">${escapeHtml(story.headline)}</a></h2>
        ${teams ? `<p class="meta teams">${escapeHtml(teams)}</p>` : ""}
        ${players ? `<p class="meta players">${escapeHtml(players)}</p>` : ""}
        ${previewText ? `<p class="summary">${escapeHtml(truncate(previewText, 220))}</p>` : ""}
        <p class="card-actions"><a class="open-story-btn" href="${escapeHtml(story.story_url)}">Open Story</a></p>

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
        </div>
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
  <title>The Aggregate | NFL News</title>
  <meta name="description" content="The Aggregate — NFL news aggregated from ESPN, NFL.com, FOX Sports, and Pro Football Talk, organized as source material for social content production." />
  <link rel="icon" type="image/png" href="./assets/aggregate-favicon.png" />
  <link rel="alternate" type="application/rss+xml" title="The Aggregate | NFL" href="${absUrl("feed.xml")}" />
  <link rel="stylesheet" href="./styles.css" />
  <meta property="og:site_name" content="The Aggregate" />
  <meta property="og:title" content="The Aggregate | NFL News" />
  <meta property="og:description" content="NFL news aggregated from ESPN, NFL.com, FOX Sports, and Pro Football Talk." />
  <meta property="og:image" content="${absUrl("assets/aggregate-logo.png")}" />
</head>
<body>
  <header class="site-header">
    <div class="wrap header-row">
      <a class="brand" href="./index.html">
        <img class="brand-logo brand-logo-full" src="./assets/aggregate-logo-dark.png" alt="The Aggregate" />
        <img class="brand-logo brand-logo-mark" src="./assets/aggregate-mark-dark.png" alt="The Aggregate" />
      </a>
      <p class="freshness" id="freshness-indicator">
        <span id="freshness-label">Checking feed status…</span>
      </p>
    </div>
    <div class="header-subrow">
      <div class="wrap">
        <span class="section-label">NFL</span>
      </div>
    </div>
    <p class="feed-links"><a href="./news.json">news.json</a> · <a href="./feed.xml">feed.xml</a> · <a href="./status.json">status.json</a></p>
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
      <div class="footer-brand-row">
        <img class="footer-logo" src="./assets/aggregate-mark-dark.png" alt="" />
        <p class="footer-brand">The Aggregate</p>
      </div>
      <p>NFL News Aggregator</p>
      <p>Sources include ESPN, NFL.com, FOX Sports, and Pro Football Talk. Every story links back to its original reporting.</p>
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
  // Links to our own story page (which itself links out to every original
  // source) now that one exists — more useful to a feed reader than a
  // single arbitrary source link, and matches the guid so it's stable.
  return `    <item>
      <title>${xmlEscape(story.headline)}</title>
      <link>${xmlEscape(story.story_url)}</link>
      <guid isPermaLink="true">${xmlEscape(story.story_url)}</guid>
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
    <title>The Aggregate | NFL</title>
    <link>${xmlEscape(absUrl("index.html"))}</link>
    <description>The Aggregate — aggregated, deduplicated NFL news with organized source reporting.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  await writeFile(FEED_XML_PATH, xml, "utf-8");
}
