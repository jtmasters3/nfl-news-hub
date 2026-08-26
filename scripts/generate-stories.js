// Generates one static HTML page and one JSON file per story under
// /stories/, and prunes files for stories no longer in the current set
// (aged out or pruned by store.js). Runs automatically as part of
// `npm run refresh` — no manual page creation.
import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { categoryLabel } from "./lib/munch.js";
import { formatHumanDateTime } from "./lib/dates.js";
import { escapeHtml, truncate } from "./lib/text.js";
import { STORIES_DIR } from "./lib/store.js";
import { BREAKING_IMPORTANCE_THRESHOLD } from "./lib/filters.js";
import { absUrl } from "./lib/urls.js";

function importanceLabel(score) {
  if (score >= 9) return "Breaking";
  if (score >= 7) return "Major";
  if (score >= 4) return "Normal";
  return "Minor";
}

function renderSourceReport(s) {
  return `<div class="source-report">
        <h4>${escapeHtml(s.name)}</h4>
        <p><strong>Headline:</strong> ${escapeHtml(s.headline)}</p>
        <p><strong>Description:</strong> ${escapeHtml(s.description || "(no description available)")}</p>
        <p><strong>Published:</strong> ${escapeHtml(formatHumanDateTime(s.published_at))}</p>
        <p><strong>Source:</strong> <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a></p>
      </div>`;
}

// Only rendered when a subject-matching image actually cleared the
// confidence bar (see imageMatch.js) — no image field means no image area,
// never a broken placeholder. "Image: [source]" always shown alongside a
// real image; "Credit: [credit]" only when a credit was actually found —
// never invented (see imageMeta.js).
function renderStoryMedia(story) {
  if (!story.primary_image_url) return "";
  const alt = story.primary_image_alt || story.visual_subject || story.headline;
  return `<div class="story-media">
        <img src="${escapeHtml(story.primary_image_url)}" alt="${escapeHtml(alt)}" loading="lazy" />
        <p class="media-attribution">
          Image: ${escapeHtml(story.primary_image_source || "Unknown source")}
          ${story.primary_image_credit ? ` &bull; Credit: ${escapeHtml(story.primary_image_credit)}` : ""}
        </p>
      </div>`;
}

/**
 * Compact "Social Post" block replacing the old Munch Content Brief —
 * exactly the three facts needed to hand a post to Munch (or another
 * downstream creative system): the graphic-ready headline, the base
 * article image, and the reporting source. Deliberately does NOT show
 * the creative brief, full instructions, source-reporting summaries, or
 * caption text — those either live elsewhere already (Source Reporting
 * section above) or are computed but not meant to be pasted anywhere
 * (see socialPayload.js). story.munch_content itself is untouched and
 * still computed/stored — this only stops rendering it. Fixed element
 * IDs are fine here (unlike the homepage, only one story per page).
 */
function renderSocialPost(story) {
  const social = story.social;

  const headlineHtml = social.post_headline
    ? `<p class="social-post-value">${escapeHtml(social.post_headline)}</p>
        <input type="hidden" id="social-headline" value="${escapeHtml(social.post_headline)}" />
        <button type="button" class="copy-btn" data-copy-target="social-headline">Copy Headline</button>`
    : `<p class="social-post-empty">Needs review</p>`;

  const imageHtml = social.base_image_url
    ? `<img class="social-post-image" src="${escapeHtml(social.base_image_url)}" alt="${escapeHtml(story.primary_image_alt || story.headline)}" loading="lazy" />
        <input type="hidden" id="social-image-url" value="${escapeHtml(social.base_image_url)}" />
        <div class="social-post-image-actions">
          <a class="open-story-btn" href="${escapeHtml(social.base_image_url)}" target="_blank" rel="noopener noreferrer">Open Image</a>
          <button type="button" class="copy-btn" data-copy-target="social-image-url">Copy Image URL</button>
        </div>`
    : `<p class="social-post-empty">No image found — needs media</p>`;

  return `<section class="social-post">
        <h2>Social Post</h2>
        <div class="social-post-field">
          <span class="social-post-label">Post Headline</span>
          ${headlineHtml}
        </div>
        <div class="social-post-field">
          <span class="social-post-label">Base Image</span>
          ${imageHtml}
        </div>
        <div class="social-post-field">
          <span class="social-post-label">Source</span>
          <p class="social-post-value">${escapeHtml(social.source_name || "(unknown)")}</p>
        </div>
      </section>`;
}

function jsonLd(story) {
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: story.headline,
    datePublished: story.first_published_at,
    dateModified: story.latest_published_at,
    articleSection: categoryLabel(story.category),
    about: story.teams,
    url: story.story_url,
    isAccessibleForFree: true,
  };
}

function renderStoryPage(story) {
  // Same badge set/classes as the homepage cards: category + importance
  // (the importance badge itself reads "Breaking" once score crosses the
  // breaking threshold, so there's no separate BREAKING badge to duplicate
  // that), plus RUMOR/UPDATED when applicable.
  const badgesHtml = [
    `<span class="badge badge-category">${escapeHtml(categoryLabel(story.category))}</span>`,
    `<span class="badge badge-importance badge-importance-${importanceLabel(story.importance_score).toLowerCase()}">${importanceLabel(story.importance_score)}</span>`,
    story.is_rumor ? `<span class="badge badge-rumor">RUMOR</span>` : "",
    story.status === "updated" ? `<span class="badge badge-updated">UPDATED</span>` : "",
  ]
    .filter(Boolean)
    .join("\n        ");
  const teams = story.teams.join(", ");
  const players = story.players.join(", ");
  const description = truncate(story.sources[0]?.description || story.headline, 200);
  const sourceReportsHtml = story.sources.map(renderSourceReport).join("\n      ");
  const breakingClass = story.importance_score >= BREAKING_IMPORTANCE_THRESHOLD ? " card-breaking" : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(story.headline)} | The Aggregate</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="icon" type="image/png" href="../assets/aggregate-favicon.png" />
  <link rel="canonical" href="${escapeHtml(story.story_url)}" />
  <link rel="stylesheet" href="../styles.css" />
  <meta property="og:site_name" content="The Aggregate" />
  <meta property="og:title" content="${escapeHtml(story.headline)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(absUrl("assets/aggregate-logo.png"))}" />
  <script type="application/ld+json">${JSON.stringify(jsonLd(story))}</script>
</head>
<body>
  <header class="site-header">
    <div class="wrap header-row">
      <a class="brand brand--compact" href="../index.html">
        <img class="brand-logo brand-logo-full" src="../assets/aggregate-logo-dark.png" alt="The Aggregate" />
        <img class="brand-logo brand-logo-mark" src="../assets/aggregate-mark-dark.png" alt="The Aggregate" />
      </a>
    </div>
    <div class="header-subrow">
      <div class="wrap">
        <span class="section-label">NFL</span>
      </div>
    </div>
    <p><a class="back-link" href="../index.html">&larr; Back to NFL Feed</a></p>
  </header>

  <main class="wrap story-page">
    <article class="card${breakingClass}">
      <div class="card-badges">
        ${badgesHtml}
      </div>

      <h1 class="headline">${escapeHtml(story.headline)}</h1>

      ${teams ? `<p class="meta teams">${escapeHtml(teams)}</p>` : ""}
      ${players ? `<p class="meta players">${escapeHtml(players)}</p>` : ""}
      <p class="meta">
        Latest report:
        <time datetime="${escapeHtml(story.latest_published_at)}">${escapeHtml(formatHumanDateTime(story.latest_published_at))}</time>
      </p>
      ${renderStoryMedia(story)}
      ${story.status === "updated" && story.update_note ? `<p class="callout callout-updated"><strong>UPDATED:</strong> ${escapeHtml(story.update_note)}</p>` : ""}
      ${story.is_rumor ? `<p class="callout callout-rumor">RUMOR — unconfirmed report</p>` : ""}

      <section>
        <h2>Source Reporting</h2>
        ${sourceReportsHtml}
      </section>

      ${renderSocialPost(story)}

      <p class="meta"><a href="${escapeHtml(story.story_json_url)}">View this story as JSON</a></p>
    </article>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <div class="footer-brand-row">
        <img class="footer-logo" src="../assets/aggregate-mark-dark.png" alt="" />
        <p class="footer-brand">The Aggregate</p>
      </div>
      <p>NFL News Aggregator</p>
      <p>Sources include ESPN, NFL.com, FOX Sports, and Pro Football Talk. Every story links back to its original reporting.</p>
    </div>
  </footer>

  <script src="../app.js"></script>
</body>
</html>
`;
}

function toStoryJson(story) {
  // Same structured story data as news.json — one story per file instead of
  // one array of all of them.
  return story;
}

/**
 * Writes /stories/{slug}.html and /stories/{slug}.json for every current
 * story, then removes any .html/.json file for a slug that's no longer in
 * the set (aged out via the 7-day retention window, or pruned past the
 * story cap) — reconciled directly against what's on disk so it's
 * self-healing even if a previous run didn't finish cleanly.
 */
export async function generateStoryPages(stories) {
  await mkdir(STORIES_DIR, { recursive: true });
  const validSlugs = new Set(stories.map((s) => s.slug));

  for (const story of stories) {
    await writeFile(path.join(STORIES_DIR, `${story.slug}.html`), renderStoryPage(story), "utf-8");
    await writeFile(
      path.join(STORIES_DIR, `${story.slug}.json`),
      JSON.stringify(toStoryJson(story), null, 2) + "\n",
      "utf-8"
    );
  }

  let removed = 0;
  const existingFiles = await readdir(STORIES_DIR).catch(() => []);
  for (const file of existingFiles) {
    const match = file.match(/^(.+)\.(html|json)$/);
    if (!match) continue;
    if (!validSlugs.has(match[1])) {
      await unlink(path.join(STORIES_DIR, file));
      removed++;
    }
  }

  return { written: stories.length, removed };
}
