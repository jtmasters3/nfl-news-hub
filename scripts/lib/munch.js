/**
 * Builds the plain-text Munch-ready content block: a clean factual briefing
 * assembled directly from source metadata — no AI-generated prose. Munch AI
 * (or another content-generation system) reads this and writes the actual
 * social copy itself.
 */
export function formatMunchContent({ headline, category, teams, players, sources, isRumor }) {
  const lines = ["NFL STORY"];

  if (isRumor) lines.push("STATUS: RUMOR — UNCONFIRMED");

  lines.push("", "HEADLINE:", headline || "(untitled)");
  lines.push("", "CATEGORY:", categoryLabel(category));
  lines.push("", "TEAMS:", teams.length ? teams.join(", ") : "(none identified)");
  lines.push("", "PLAYERS:", players.length ? players.join(", ") : "(none identified)");

  lines.push("", "SOURCE REPORTING:");
  for (const s of sources) {
    lines.push(
      `${s.name}:`,
      `Headline: ${s.headline}`,
      `Description: ${s.description || "(no description available)"}`,
      `Source: ${s.url}`,
      ""
    );
  }
  if (lines[lines.length - 1] === "") lines.pop();

  lines.push(
    "",
    "Use this information to create an accurate social media post/video about this NFL development. " +
      "Verify important facts against the provided sources. Do not invent facts, statistics, quotes, or " +
      "details not supported by the source material."
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
