// Conservative hashtag strategy for captions: #NFL always, plus up to 2
// team hashtags derived from the same team-nickname dictionary the news
// pipeline itself already uses (scripts/lib/teams.js) — capped at 3 total,
// never a giant block, no player-name hashtags, no generic engagement tags.
import { TEAMS } from "../../lib/teams.js";

const MAX_HASHTAGS = 3;

/**
 * @param {string[]} teamNames - full team names, e.g. "Carolina Panthers"
 * @returns {string[]} e.g. ["#NFL", "#Panthers"]
 */
export function buildHashtags(teamNames) {
  const tags = ["#NFL"];
  for (const name of teamNames || []) {
    const team = TEAMS.find((t) => t.name === name);
    const tag = team ? `#${team.nickname}` : null;
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_HASHTAGS) break;
  }
  return tags;
}

export { MAX_HASHTAGS };
