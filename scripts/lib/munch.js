import { formatHumanDateTime } from "./dates.js";

/**
 * Builds the plain-text Munch Content Brief: a clean factual briefing
 * assembled directly from source metadata — no AI-generated prose. Munch AI
 * (or another content-generation system) reads this and writes the actual
 * social copy itself. Used both on the homepage cards and on each
 * individual story page — one canonical format, generated deterministically
 * from the structured story data.
 */
export function formatMunchContent({
  headline,
  category,
  teams,
  players,
  sources,
  latestPublishedAt,
  isRumor,
  visualSubject,
  visualSubjectType,
  currentTeam,
  primaryImageUrl,
  primaryImageSource,
  primaryImageCredit,
  visualSearchQuery,
  imageCandidates,
}) {
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

  lines.push("", ...formatVisualMediaSection({
    visualSubject,
    visualSubjectType,
    currentTeam,
    primaryImageUrl,
    primaryImageSource,
    primaryImageCredit,
    visualSearchQuery,
    imageCandidates,
  }));

  return lines.join("\n");
}

/**
 * The VISUAL MEDIA briefing + dynamic MEDIA INSTRUCTION. Built entirely
 * from this story's own derived fields — nothing here is hardcoded to any
 * specific player/team, and every line is omitted rather than guessed when
 * its underlying field is null (see visualSubject.js / imageMatch.js for
 * how conservative those derivations are).
 */
function formatVisualMediaSection({
  visualSubject,
  visualSubjectType,
  currentTeam,
  primaryImageUrl,
  primaryImageSource,
  primaryImageCredit,
  visualSearchQuery,
  imageCandidates,
}) {
  const lines = ["VISUAL MEDIA:", ""];

  lines.push("PRIMARY VISUAL SUBJECT:", visualSubject || "(not confidently identified)", "");
  lines.push("SUBJECT TYPE:", subjectTypeLabel(visualSubjectType), "");

  if (visualSubjectType === "player" || visualSubjectType === "coach" || visualSubjectType === "executive") {
    lines.push("CURRENT TEAM:", currentTeam || "(unknown)", "");
  }

  if (primaryImageUrl) {
    lines.push("PRIMARY IMAGE REFERENCE:", primaryImageUrl, "");
    lines.push("IMAGE SOURCE:", primaryImageSource || "(unknown)", "");
    if (primaryImageCredit) lines.push("IMAGE CREDIT:", primaryImageCredit, "");
  } else {
    lines.push("PRIMARY IMAGE REFERENCE:", "(none — no confidently subject-matching image found)", "");
  }

  lines.push("VISUAL SEARCH QUERY:", visualSearchQuery || "(not available)", "");

  const additional = (imageCandidates || []).filter((c) => c.url !== primaryImageUrl);
  if (additional.length) {
    lines.push("ADDITIONAL IMAGE REFERENCES:");
    for (const c of additional) lines.push(`${c.url} (${c.source})`);
    lines.push("");
  }

  lines.push("MEDIA INSTRUCTION:", "");
  lines.push(...buildMediaInstruction({ visualSubject, visualSubjectType, currentTeam }));

  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function subjectTypeLabel(type) {
  if (!type) return "(not confidently identified)";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function buildMediaInstruction({ visualSubject, visualSubjectType, currentTeam }) {
  if (!visualSubject) {
    return [
      "No primary visual subject was confidently identified for this story.",
      "Do not invent one — use a general NFL editorial graphic, or a graphic for a team/topic",
      "only if the source reporting above clearly supports it.",
    ];
  }

  const lines = [
    `Create social media content visually centered on ${visualSubject} because ${
      visualSubject
    } is the primary subject of this story.`,
  ];

  if ((visualSubjectType === "player" || visualSubjectType === "coach" || visualSubjectType === "executive") && currentTeam) {
    lines.push(`Use current ${currentTeam} context where appropriate.`);
  }

  lines.push(
    "Do not substitute an unrelated NFL player.",
    "Do not use an outdated team association if the current reporting establishes that the subject has changed teams.",
    "If the supplied image reference cannot legally or technically be reused, use it only as visual context and obtain appropriately licensed imagery of the same subject or create a compliant original editorial graphic centered on that subject."
  );

  return lines;
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
