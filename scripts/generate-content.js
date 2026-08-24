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

/**
 * @param {Array} sourceResults - output of fetchAllSources()
 * @param {Array} existingStories - current news.json stories
 * @param {Object} processedUrls - ledger: { [url]: { storyId, processedAt } }
 */
export async function processDiscoveredArticles(sourceResults, existingStories, processedUrls) {
  const stories = [...existingStories];
  const ledger = { ...processedUrls };
  const candidates = buildClusterCandidates(stories);

  const stats = { articlesSeen: 0, skippedExisting: 0, newStories: 0, updatedStories: 0 };

  for (const result of sourceResults) {
    for (const article of result.articles) {
      stats.articlesSeen++;

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
          story = updateStory(existing, article, teamsDetected);
          const idx = stories.findIndex((s) => s.id === story.id);
          stories[idx] = story;
          if (story.status === "updated") stats.updatedStories++;
        }
      }

      if (!story) {
        story = createStory(article, teamsDetected);
        stories.push(story);
        stats.newStories++;
      }

      ledger[article.sourceUrl] = { storyId: story.id, processedAt: new Date().toISOString() };
      upsertCandidate(candidates, story);
    }
  }

  return { stories, processedUrls: ledger, stats };
}

function buildClusterCandidates(stories) {
  return stories.map((s) => ({
    id: s.id,
    headline: s.headline,
    sourceHeadlines: s.sources.map((src) => src.headline),
    teams: s.teams,
    lastUpdatedAt: s.updated_at,
  }));
}

function upsertCandidate(candidates, story) {
  const next = {
    id: story.id,
    headline: story.headline,
    sourceHeadlines: story.sources.map((s) => s.headline),
    teams: story.teams,
    lastUpdatedAt: story.updated_at,
  };
  const idx = candidates.findIndex((c) => c.id === next.id);
  if (idx >= 0) candidates[idx] = next;
  else candidates.unshift(next);
}

function toSourceEntry(article) {
  return {
    name: article.sourceName,
    headline: article.headline,
    description: article.excerpt || "",
    url: article.sourceUrl,
    published_at: article.publishedAt,
  };
}

function createStory(article, teamsDetected) {
  const now = new Date().toISOString();
  const text = `${article.headline} ${article.excerpt}`;

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
    sources: [toSourceEntry(article)],
    published_at: article.publishedAt ?? now,
    updated_at: now,
    munch_content: "",
  };

  story.munch_content = buildMunchContent(story);
  return story;
}

function updateStory(story, article, teamsDetected) {
  const now = new Date().toISOString();
  const alreadyHasSource = story.sources.some((s) => s.url === article.sourceUrl);
  const sources = alreadyHasSource ? story.sources : [...story.sources, toSourceEntry(article)];

  // Recompute from the combined text of every source now attached to the
  // story — more reporting means a better signal, still $0 and instant.
  const combinedText = sources.map((s) => `${s.headline} ${s.description}`).join(" ");
  const combinedPlayers = sources.flatMap((s) => extractLikelyPlayerNames(s.description || ""));

  const earliestPublished = sources.reduce((earliest, s) => {
    if (!s.published_at) return earliest;
    return !earliest || Date.parse(s.published_at) < Date.parse(earliest) ? s.published_at : earliest;
  }, story.published_at);

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
    published_at: earliestPublished,
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
    isRumor: story.is_rumor,
  });
}
