import { formatHumanDateTime } from "./dates.js";

/**
 * Builds the plain-text Munch Content Brief: a clean factual briefing
 * assembled directly from source metadata — no AI-generated prose. Munch AI
 * (or another content-generation system) reads this and writes the actual
 * social copy itself. Used both on the homepage cards and on each
 * individual story page — one canonical format, generated deterministically
 * from the structured story data.
 */
export function formatMunchContent({ headline, category, teams, players, sources, latestPublishedAt, isRumor }) {
  const lines = [];

  if (isRumor) lines.push("STATUS: RUMOR — UNCONFIRMED", "");

  lines.push("NFL STORY", "");
  lines.push("HEADLINE:", headline || "(untitled)", "");
  lines.push("CATEGORY:", categoryLabel(category), "");
  lines.push("TEAMS:", teams.length ? teams.join(", ") : "(none identified)", "");
  lines.push("PLAYERS:", players.length ? players.join(", ") : "(none identified)", "");
  lines.push("LATEST REPORT:", formatHumanDateTime(latestPublishedAt), "");

  lines.push("SOURCE REPORTING:");
  for (const s of sources) {
    lines.push(
      s.name,
      `Headline: ${s.headline}`,
      `Description: ${s.description || "(no description available)"}`,
      `Published: ${formatHumanDateTime(s.published_at)}`,
      `URL: ${s.url}`,
      ""
    );
  }
  if (lines[lines.length - 1] === "") lines.pop();

  lines.push(
    "",
    "INSTRUCTIONS FOR CONTENT CREATION:",
    "Create accurate social media content based only on the source reporting above.",
    "Do not invent facts, quotes, statistics, contract figures, injury details, or trade compensation.",
    "If sources disagree, mention the uncertainty rather than choosing one unsupported version.",
    "The output should be engaging but factually grounded."
  );

  return lines.join("\n");
}

const CATEGORY_LABELS = {
  breaking: "Breaking News",
  trade: "Trade",
  rumor: "Rumor",
  injury: "Injury",
  contract: "Contract",
  free_agency: "Free Agency",
  draft: "NFL Draft",
  fantasy: "Fantasy",
  team_news: "Team News",
  player_news: "Player News",
  league_news: "League News",
  roster_move: "Roster Move",
  suspension: "Suspension",
  coaching: "Coaching",
  retirement: "Retirement",
  other: "Other",
};

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? "Other";
}
