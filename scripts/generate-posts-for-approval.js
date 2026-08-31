// Renders posts-for-approval.html — a read-only admin/social-workflow view,
// NOT an NFL-news category (deliberately not wired into lib/filters.js or
// the category classifier). Displays ONLY social-state records whose
// status is exactly "awaiting_approval" — never "queued" or any other
// in-progress status, since this page's whole purpose is "what needs a
// human decision right now," and nothing reaches awaiting_approval in this
// phase (no artwork/validation pipeline is connected yet), so the expected
// Phase 2A output is the empty state.
//
// Every media slot degrades to text rather than a broken image tag: no
// artwork.image_url means "Artwork not created yet", never a fabricated or
// placeholder graphic. No Approve/Reject/Regenerate controls are rendered —
// GitHub Pages can't persist a click, and a button that looks functional
// but silently does nothing (or only mutates local browser state) would be
// worse than no button at all. See README/architecture notes for why real
// actions need a backend this phase deliberately does not build.
import { writeFile } from "node:fs/promises";
import { escapeHtml } from "./lib/text.js";
import { formatHumanDateTime } from "./lib/dates.js";
import { POSTS_FOR_APPROVAL_HTML_PATH } from "./lib/store.js";
import { readSocialState } from "./lib/socialState.js";

function renderMediaBlock(label, url, alt) {
  const body = url
    ? `<img class="approval-media-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt || "")}" loading="lazy" />`
    : `<p class="approval-empty">${label === "Generated Graphic" ? "Artwork not created yet" : "No base image available"}</p>`;
  return `<div class="approval-media-block">
          <span class="approval-media-label">${escapeHtml(label)}</span>
          ${body}
        </div>`;
}

/**
 * Phase 2C: caption.text is only ever non-null once server-side
 * validateCaption() has actually passed (see scripts/lib/captionEvents.js)
 * — so displaying it here is inherently safe, never a rejected candidate.
 * Historical pre-Caption-phase records (caption.status "not_created")
 * degrade to the same "not yet" text pattern already used for artwork —
 * never a fabricated placeholder caption.
 */
function renderCaptionBlock(caption) {
  if (!caption || caption.status !== "ready" || !caption.text) {
    return `<div class="approval-caption-block">
          <span class="approval-media-label">Generated Caption</span>
          <p class="approval-empty">Caption not generated yet</p>
        </div>`;
  }
  const hashtagLine = Array.isArray(caption.hashtags) && caption.hashtags.length ? `<p class="approval-caption-hashtags">${escapeHtml(caption.hashtags.join(" "))}</p>` : "";
  return `<div class="approval-caption-block">
          <span class="approval-media-label">Generated Caption</span>
          <p class="approval-caption-text">${escapeHtml(caption.text)}</p>
          ${hashtagLine}
        </div>`;
}

function renderItem(record) {
  const s = record.source_story || {};
  const headline = s.post_headline || "(no headline captured)";

  return `<article class="card approval-item" data-story-id="${escapeHtml(record.story_id)}">
        <div class="card-badges approval-badges">
          <span class="badge badge-category">${escapeHtml(record.status)}</span>
          ${s.category ? `<span class="badge badge-category">${escapeHtml(s.category)}</span>` : ""}
        </div>
        <h2 class="headline approval-headline">${escapeHtml(headline)}</h2>
        <div class="approval-media">
          ${renderMediaBlock("Generated Graphic", record.artwork?.image_url, headline)}
          ${renderMediaBlock("Base Article Image", s.base_image_url, headline)}
        </div>
        ${renderCaptionBlock(record.caption)}
        <p class="meta"><strong>Source:</strong> ${escapeHtml(s.source_name || "(unknown)")}
          ${s.source_url ? ` &mdash; <a href="${escapeHtml(s.source_url)}" target="_blank" rel="noopener noreferrer">View original</a>` : ""}</p>
        <p class="meta"><strong>Story ID:</strong> <code>${escapeHtml(record.story_id)}</code></p>
        <p class="meta"><strong>Created:</strong> ${escapeHtml(formatHumanDateTime(record.created_at))}</p>
        ${record.artwork?.created_at ? `<p class="meta"><strong>Artwork created:</strong> ${escapeHtml(formatHumanDateTime(record.artwork.created_at))}</p>` : ""}
        <p class="approval-actions-note">Approve / Reject / Regenerate will appear here once the approval backend is connected. No action taken on this page persists anything yet.</p>
      </article>`;
}

function renderPage(records) {
  const items = records.length
    ? records.map(renderItem).join("\n")
    : `<p class="empty-state">No posts are currently awaiting approval.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Posts For Approval | The Aggregate</title>
  <meta name="description" content="The Aggregate — social workflow items awaiting human approval before publishing." />
  <meta name="robots" content="noindex" />
  <link rel="icon" type="image/png" href="./assets/aggregate-favicon.png" />
  <link rel="stylesheet" href="./styles.css" />
  <meta property="og:site_name" content="The Aggregate" />
  <meta property="og:title" content="Posts For Approval | The Aggregate" />
</head>
<body>
  <header class="site-header">
    <div class="wrap header-row">
      <a class="brand" href="./index.html">
        <img class="brand-logo brand-logo-full" src="./assets/aggregate-logo-dark.png" alt="The Aggregate" />
        <img class="brand-logo brand-logo-mark" src="./assets/aggregate-mark-dark.png" alt="The Aggregate" />
      </a>
    </div>
    <div class="header-subrow">
      <div class="wrap">
        <span class="section-label">SOCIAL WORKFLOW</span>
      </div>
    </div>
    <p><a class="back-link" href="./index.html">&larr; Back to NFL Feed</a></p>
  </header>

  <main class="wrap story-page">
    <h1 class="approval-page-title">Posts For Approval</h1>
    <div id="approval-list" class="approval-list">
      ${items}
    </div>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <div class="footer-brand-row">
        <img class="footer-logo" src="./assets/aggregate-mark-dark.png" alt="" />
        <p class="footer-brand">The Aggregate</p>
      </div>
      <p>Social workflow admin view &mdash; not an NFL news category.</p>
    </div>
  </footer>
</body>
</html>
`;
}

export async function generatePostsForApproval() {
  const state = await readSocialState();
  const records = Object.values(state.stories)
    .filter((r) => r.status === "awaiting_approval")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  await writeFile(POSTS_FOR_APPROVAL_HTML_PATH, renderPage(records), "utf-8");
  return { count: records.length };
}
