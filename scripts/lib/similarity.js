import { jaccardSimilarity, titleTokens } from "./text.js";

const CLUSTER_WINDOW_HOURS = 72;
const TEAM_AWARE_THRESHOLD = 0.32; // article and candidate share a team
const TEAM_AGNOSTIC_THRESHOLD = 0.5; // no shared team (e.g. league-wide news) — require a closer match

/**
 * Decides whether a newly discovered article is reporting the same event as
 * an existing recent story. Combines: (1) recency window, (2) team overlap,
 * (3) title token similarity (Jaccard) against the story's headline and
 * every source headline already attached to it. Deterministic and free —
 * no AI call needed to make the clustering decision itself.
 *
 * `candidates` is an array of { id, headline, sourceHeadlines, teams, lastUpdatedAt }.
 */
export function pickBestMatch(article, candidates) {
  const now = Date.now();
  const articleTokens = titleTokens(article.headline);

  let best = null;

  for (const candidate of candidates) {
    const ageHours = (now - Date.parse(candidate.lastUpdatedAt)) / 3_600_000;
    if (ageHours > CLUSTER_WINDOW_HOURS) continue;

    const sharesTeam =
      article.teams.length > 0 &&
      candidate.teams.length > 0 &&
      article.teams.some((t) => candidate.teams.includes(t));

    const threshold = sharesTeam ? TEAM_AWARE_THRESHOLD : TEAM_AGNOSTIC_THRESHOLD;

    const headlinesToCompare = [candidate.headline, ...candidate.sourceHeadlines];
    const maxScore = Math.max(
      ...headlinesToCompare.map((h) => jaccardSimilarity(articleTokens, titleTokens(h)))
    );

    if (maxScore >= threshold && (best === null || maxScore > best.score)) {
      best = { storyId: candidate.id, score: maxScore };
    }
  }

  return best;
}
