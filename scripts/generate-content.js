// Processing stage: turn newly discovered articles into stories.
// Fully deterministic — no AI calls, $0 cost. Dedupes against already
// processed URLs, clusters against existing stories using team overlap +
// title similarity, and extracts category/importance/players/rumor status
// via rule-based logic. Pure data in / data out — no file I/O here (store.js
// handles that).
import { randomUUID } from "node:crypto";
import { detectTeams, teamName } from "./lib/teams.js";
import { pickBestMatch } from "./lib/similarity.js";
import { classifyCategory, estimateImportance, looksLikeRumor, extractLikelyPlayerNames } from "./lib/extraction.js";
import { formatMunchContent } from "./lib/munch.js";
import { makeSlug } from "./lib/text.js";
import { fetchArticleImageMeta, validateImageUrl } from "./lib/imageMeta.js";
import { determineVisualSubject, detectCurrentTeam, buildVisualSearchQuery } from "./lib/visualSubject.js";
import { selectStoryImages } from "./lib/imageMatch.js";
import { mapWithConcurrency } from "./lib/concurrency.js";

const EMPTY_IMAGE_META = {
  image_url: null,
  image_alt: null,
  image_caption: null,
  image_credit: null,
  image_width: null,
  image_height: null,
};

/**
 * Fetches + validates one article's lead-image metadata. Always resolves
 * (never throws, never rejects) — a broken/unreachable article page just
 * means this source gets null image fields, never a failed refresh. The
 * HEAD-request validation step (successful response, image/* MIME, not a
 * ~1x1 tracking pixel) runs here too, once, at the same time as extraction.
 */
async function fetchAndValidateImage(url) {
  try {
    const meta = await fetchArticleImageMeta(url);
    if (!meta.image_url) return meta;
    const validation = await validateImageUrl(meta.image_url);
    return validation.ok ? meta : { ...EMPTY_IMAGE_META };
  } catch {
    return { ...EMPTY_IMAGE_META };
  }
}

/**
 * @param {Array} sourceResults - output of fetchAllSources()
 * @param {Array} existingStories - current news.json stories
 * @param {Object} processedUrls - ledger: { [url]: { storyId, processedAt } }
 */
export async function processDiscoveredArticles(sourceResults, existingStories, processedUrls) {
  const stories = [...existingStories];
  const ledger = { ...processedUrls };
  const candidates = buildClusterCandidates(stories);

  const stats = {
    articlesSeen: 0,
    skippedExisting: 0,
    newStories: 0,
    updatedStories: 0,
    // Freshness self-check (see refresh.js) — the newest source-claimed
    // publish time seen across every discovered article this run,
    // regardless of whether it was new or a duplicate.
    newestDiscoveredPublishedAt: null,
  };

  for (const result of sourceResults) {
    for (const article of result.articles) {
      stats.articlesSeen++;
      if (article.publishedAt && isNewer(article.publishedAt, stats.newestDiscoveredPublishedAt)) {
        stats.newestDiscoveredPublishedAt = article.publishedAt;
      }

      if (ledger[article.sourceUrl]) {
        stats.skippedExisting++;
        continue;
      }

      const text = `${article.headline} ${article.excerpt}`;
      const teamsDetected = detectTeams(text).map(teamName);
      const match = pickBestMatch({ headline: article.headline, teams: teamsDetected }, candidates);

      let story;
      if (match) {
        const existing = stories.find((s) => s.id === match.storyId);
        if (existing) {
          story = await updateStory(existing, article, teamsDetected);
          const idx = stories.findIndex((s) => s.id === story.id);
          stories[idx] = story;
          if (story.status === "updated") stats.updatedStories++;
        }
      }

      if (!story) {
        story = await createStory(article, teamsDetected);
        stories.push(story);
        stats.newStories++;
      }

      ledger[article.sourceUrl] = { storyId: story.id, processedAt: new Date().toISOString() };
      upsertCandidate(candidates, story);
    }
  }

  // One-time-per-source image backfill: any source record that predates
  // the media-layer feature (or whose fetch never completed) has
  // image_url === undefined rather than a resolved value (URL or null).
  // Fetch it once here, bounded concurrency so this never hammers source
  // sites — after this, every source has an explicit value and is never
  // re-fetched again on a later run. On the first run after this feature
  // ships this backfills every existing story; every run after that, the
  // list is empty (new sources already get fetched in toSourceEntry) and
  // this is a no-op.
  const sourcesNeedingBackfill = stories
    .flatMap((s) => s.sources)
    .filter((source) => source.image_url === undefined);
  if (sourcesNeedingBackfill.length > 0) {
    console.log(`[images] Backfilling image metadata for ${sourcesNeedingBackfill.length} source(s)...`);
    await mapWithConcurrency(sourcesNeedingBackfill, 8, async (source) => {
      Object.assign(source, await fetchAndValidateImage(source.url));
    });
  }

  // Recompute players, visual-media fields, and munch_content for every
  // story, not just ones touched this run. A story that hasn't received a
  // new source in months would otherwise keep whatever player list /
  // visual subject / munch_content was generated the last time it *was*
  // touched — including, permanently, any bug fixes since. Cheap: pure
  // string processing over already-fetched data, no I/O.
  // Order matters: players -> visual media (uses players) -> munch_content
  // (uses both).
  for (const story of stories) {
    story.players = Array.from(
      new Set(story.sources.flatMap((s) => extractLikelyPlayerNames(s.description || "")))
    );
    applyVisualMedia(story);
    story.munch_content = buildMunchContent(story);
  }

  return { stories, processedUrls: ledger, stats };
}

/**
 * Determines visual_subject/visual_subject_type/current_team and selects
 * the primary image + image_candidates for a story — pure computation over
 * already-fetched source data (see comment above). Conservative by design:
 * every field is null when it can't be determined confidently, per the
 * "leave it unknown, do not guess" requirement — see visualSubject.js and
 * imageMatch.js for the actual decision logic.
 */
function applyVisualMedia(story) {
  const combinedText = story.sources.map((s) => `${s.headline} ${s.description}`).join(" ");
  const { visual_subject, visual_subject_type } = determineVisualSubject({
    headline: story.headline,
    combinedText,
    players: story.players,
    teams: story.teams,
    category: story.category,
  });

  const isPerson = visual_subject_type === "player" || visual_subject_type === "coach" || visual_subject_type === "executive";
  const current_team = isPerson ? detectCurrentTeam(story) : null;

  const { image_candidates, primary_image_url, primary_image_source, primary_image_credit, primary_image_alt } =
    selectStoryImages({ sources: story.sources, visual_subject, visual_subject_type, current_team });

  story.visual_subject = visual_subject;
  story.visual_subject_type = visual_subject_type;
  story.current_team = current_team;
  story.image_candidates = image_candidates;
  story.primary_image_url = primary_image_url;
  story.primary_image_source = primary_image_source;
  story.primary_image_credit = primary_image_credit;
  story.primary_image_alt = primary_image_alt;
  story.visual_search_query = buildVisualSearchQuery({ visual_subject, visual_subject_type, current_team });
}

function isNewer(a, b) {
  return !b || Date.parse(a) > Date.parse(b);
}

function buildClusterCandidates(stories) {
  return stories.map((s) => ({
    id: s.id,
    headline: s.headline,
    sourceHeadlines: s.sources.map((src) => src.headline),
    teams: s.teams,
    // Clustering eligibility ages out based on actual news recency
    // (latest_published_at), not on when we last happened to touch the
    // record (updated_at) — otherwise a story that keeps picking up late
    // cross-outlet duplicates could stay "eligible" forever even though the
    // real event is old, risking an unrelated new story getting merged in.
    lastUpdatedAt: s.latest_published_at,
  }));
}

function upsertCandidate(candidates, story) {
  const next = {
    id: story.id,
    headline: story.headline,
    sourceHeadlines: story.sources.map((s) => s.headline),
    teams: story.teams,
    lastUpdatedAt: story.latest_published_at,
  };
  const idx = candidates.findIndex((c) => c.id === next.id);
  if (idx >= 0) candidates[idx] = next;
  else candidates.unshift(next);
}

/**
 * Builds one source record, including a one-time fetch of its lead-image
 * metadata (see fetchAndValidateImage). Only ever called for a genuinely
 * new article URL (see createStory/updateStory below), so this fetch never
 * repeats for the same source on a later run.
 */
async function toSourceEntry(article) {
  const imageMeta = await fetchAndValidateImage(article.sourceUrl);
  return {
    name: article.sourceName,
    headline: article.headline,
    description: article.excerpt || "",
    url: article.sourceUrl,
    // The source's own claimed publish time — null if genuinely unavailable
    // (never silently backfilled with discovery time; see effectiveDate()).
    published_at: article.publishedAt,
    // When WE found this specific URL. Not the same thing as published_at —
    // an outlet can (and does) republish/re-report an older event, which we
    // may only discover well after its real publish time.
    discovered_at: new Date().toISOString(),
    // Publicly exposed article-image metadata only (og:image/twitter:image/
    // JSON-LD) — never the article body, never a rehosted copy of the image
    // itself. Null fields mean "not publicly present", never invented.
    ...imageMeta,
  };
}

/** Publish-time fallback order per source entry: its own timestamp, else our discovery time (last resort). */
function effectiveDate(source) {
  return source.published_at ?? source.discovered_at;
}

/** first_published_at = earliest source report, latest_published_at = newest — both by *source* date, never by our processing time. */
function computePublishWindow(sources) {
  const dates = sources.map(effectiveDate).filter(Boolean);
  let first = null;
  let latest = null;
  for (const d of dates) {
    if (!first || Date.parse(d) < Date.parse(first)) first = d;
    if (!latest || Date.parse(d) > Date.parse(latest)) latest = d;
  }
  return { first_published_at: first, latest_published_at: latest };
}

async function createStory(article, teamsDetected) {
  const now = new Date().toISOString();
  const text = `${article.headline} ${article.excerpt}`;
  const sources = [await toSourceEntry(article)];
  const { first_published_at, latest_published_at } = computePublishWindow(sources);

  const story = {
    id: randomUUID(),
    slug: makeSlug(article.headline),
    // Best/most representative headline = the headline of the source that
    // broke the story. Never algorithmically rewritten. Original per-outlet
    // headlines are always preserved separately in `sources[].headline`.
    headline: article.headline,
    category: classifyCategory(text),
    importance_score: estimateImportance(text),
    is_rumor: looksLikeRumor(text),
    status: "new",
    update_note: null,
    teams: teamsDetected,
    // Player detection only looks at the description, not the headline —
    // several outlets publish Title Case headlines where every word is
    // capitalized, which defeats "consecutive capitalized words = name" and
    // produces junk. Conservative on purpose: better empty than wrong.
    players: extractLikelyPlayerNames(article.excerpt || ""),
    sources,
    first_published_at,
    latest_published_at,
    // When OUR pipeline last touched this record — an audit/processing
    // timestamp, deliberately NOT used for sorting or freshness display
    // (see latest_published_at for that).
    updated_at: now,
    munch_content: "",
    // Visual-media fields (see applyVisualMedia) — populated by the final
    // recompute pass in processDiscoveredArticles, not here, so every
    // story (new or old) goes through the exact same derivation logic.
    visual_subject: null,
    visual_subject_type: null,
    current_team: null,
    image_candidates: [],
    primary_image_url: null,
    primary_image_source: null,
    primary_image_credit: null,
    primary_image_alt: null,
    visual_search_query: null,
  };

  story.munch_content = buildMunchContent(story);
  return story;
}

async function updateStory(story, article, teamsDetected) {
  const now = new Date().toISOString();
  const alreadyHasSource = story.sources.some((s) => s.url === article.sourceUrl);
  const sources = alreadyHasSource ? story.sources : [...story.sources, await toSourceEntry(article)];

  // Recompute from the combined text of every source now attached to the
  // story — more reporting means a better signal, still $0 and instant.
  const combinedText = sources.map((s) => `${s.headline} ${s.description}`).join(" ");
  const combinedPlayers = sources.flatMap((s) => extractLikelyPlayerNames(s.description || ""));
  const { first_published_at, latest_published_at } = computePublishWindow(sources);

  const updated = {
    ...story,
    teams: Array.from(new Set([...story.teams, ...teamsDetected])),
    players: Array.from(new Set(combinedPlayers)),
    category: classifyCategory(combinedText),
    // A rumor stays a rumor only if every source attached to it still reads
    // as unconfirmed reporting — one outlet stating it plainly is enough to
    // drop the label.
    is_rumor: sources.every((s) => looksLikeRumor(`${s.headline} ${s.description}`)),
    importance_score: Math.max(story.importance_score, estimateImportance(combinedText)),
    sources,
    first_published_at,
    latest_published_at,
    updated_at: now,
    ...(alreadyHasSource
      ? {}
      : {
          status: "updated",
          update_note: `Additional reporting from ${article.sourceName}.`,
        }),
  };

  updated.munch_content = buildMunchContent(updated);
  return updated;
}

function buildMunchContent(story) {
  return formatMunchContent({
    headline: story.headline,
    category: story.category,
    teams: story.teams,
    players: story.players,
    sources: story.sources,
    latestPublishedAt: story.latest_published_at,
    isRumor: story.is_rumor,
    visualSubject: story.visual_subject,
    visualSubjectType: story.visual_subject_type,
    currentTeam: story.current_team,
    primaryImageUrl: story.primary_image_url,
    primaryImageSource: story.primary_image_source,
    primaryImageCredit: story.primary_image_credit,
    visualSearchQuery: story.visual_search_query,
    imageCandidates: story.image_candidates,
  });
}
