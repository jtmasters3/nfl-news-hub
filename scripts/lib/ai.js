// ---------------------------------------------------------------------------
// DORMANT BY DEFAULT — not imported or called anywhere in the current
// pipeline (scripts/generate-content.js is fully deterministic: rule-based
// category/importance/rumor detection + a dictionary team matcher, $0 cost,
// no API key required). This file is kept only as an optional building
// block for a *future* AI-enrichment pass, should one ever be wanted.
//
// Even if ANTHROPIC_API_KEY is present in the environment, analyzeStory()
// below refuses to call the API unless USE_ANTHROPIC=true is *also* set —
// two separate opt-ins are required before a single paid API call can
// happen. Nothing in scripts/refresh.js sets that flag or imports this file.
// ---------------------------------------------------------------------------
import Anthropic from "@anthropic-ai/sdk";
import { classifyCategory, looksLikeRumor, estimateImportance, extractLikelyPlayerNames } from "./extraction.js";

const DEFAULT_MODEL = "claude-sonnet-5";

const CATEGORY_VALUES = [
  "breaking", "trade", "rumor", "injury", "contract", "free_agency", "draft",
  "fantasy", "team_news", "player_news", "league_news", "roster_move",
  "suspension", "coaching", "retirement", "other",
];

export function isAiConfigured() {
  return process.env.USE_ANTHROPIC === "true" && Boolean(process.env.ANTHROPIC_API_KEY);
}

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are the editorial engine for an NFL news aggregation site. Your job is to turn short factual snippets from multiple NFL news outlets into ONE original, factual briefing that will be handed to a downstream AI (Munch AI) as raw material for social media content.

You are NOT writing a final social media post. You are writing an accurate, neutral, source-grounded briefing.

HARD RULES — accuracy and copyright:
- Use ONLY the facts present in the provided source headlines/excerpts. Do not add outside knowledge, do not guess at details, and do not invent quotes, trade compensation, contract values, statistics, injury diagnoses, player names, team names, or reporter attribution that are not explicitly present in the provided text.
- If a detail is unclear, ambiguous, or only partially reported, say so explicitly (e.g. "terms were not disclosed", "the severity is unconfirmed") or omit it — never fill the gap with a plausible-sounding guess. If the available information is limited, write a SHORTER summary rather than padding it — accuracy over length.
- Never copy sentences verbatim from the source excerpts and never lightly reword a single source's sentence. Synthesize an ORIGINAL summary in your own words and structure, combining facts across sources when more than one source is given.
- If the story is based on unconfirmed reporting, speculation, or attributed to unnamed sources ("a source said", "expected to", "could land"), set isRumor to true and make sure the summary reads as unconfirmed (e.g. "is reportedly considering", not "will"). Never present a rumor as confirmed news.
- Attribute reporting to outlets by name in the summary or key facts when it strengthens credibility (e.g. "per ESPN"), but do not fabricate a reporter's name unless it is literally given in the source text.

OTHER INSTRUCTIONS:
- headline: a clean, neutral, original headline for the combined story (not copy-pasted from one outlet).
- summary: ~100-250 words covering what happened, who's involved, key numbers/contract figures/injury details/trade compensation if present, why it matters, and — only when supported by the given facts — what could happen next.
- whyItMatters: 1-2 sentences on the significance.
- keyFacts: 3-7 short, standalone factual bullet points.
- socialAngles: exactly 3 distinct content angles a social team could use (e.g. breaking-news announcement, team/franchise impact, fantasy football impact, player-legacy angle, rivalry angle) — label + one-sentence angle each.
- category: pick the single best-fitting category from this exact list: ${CATEGORY_VALUES.join(", ")}.
- players: full names of NFL players explicitly named in the provided source text only.
- importanceScore: integer 1-10 using this rubric —
  10: major trade, firing, retirement, major injury, suspension, or championship-level news
  8-9: significant roster move, major contract, starting QB news, major injury
  6-7: important team/player update
  4-5: normal NFL news
  1-3: minor update
- isUpdate / updateNote: if EXISTING STORY CONTEXT is provided below, set isUpdate to true only if the new source(s) add materially new information beyond what's already summarized (e.g. injury severity confirmed, contract finalized) and write a short updateNote describing what's new (e.g. "MRI confirms torn ACL"). If the new source is just another outlet reporting the same already-known facts, set isUpdate to false and updateNote to null.

Call the submit_story_analysis tool exactly once with your complete analysis.`;

function buildUserPrompt({ detectedTeams, sources, existingStory }) {
  const parts = [];

  parts.push(
    `CODE-DETECTED TEAMS (treat as reliable ground truth, do not contradict): ${
      detectedTeams.length ? detectedTeams.join(", ") : "(none detected)"
    }`
  );

  parts.push("\nSOURCE REPORTS:");
  sources.forEach((s, i) => {
    parts.push(
      `\n[${i + 1}] Outlet: ${s.sourceName}\nHeadline: ${s.sourceHeadline}\nExcerpt: ${
        s.excerpt || "(no excerpt available)"
      }\nPublished: ${s.publishedAt ?? "unknown"}\nURL: ${s.sourceUrl}`
    );
  });

  if (existingStory) {
    parts.push(
      `\n\nEXISTING STORY CONTEXT (already published — decide if the source(s) above add new information):\nHeadline: ${existingStory.headline}\nSummary: ${existingStory.summary}\nKey facts: ${existingStory.keyFacts.join("; ")}`
    );
  }

  return parts.join("\n");
}

const SUBMIT_STORY_ANALYSIS_TOOL = {
  name: "submit_story_analysis",
  description: "Submit the structured editorial analysis for this NFL story.",
  input_schema: {
    type: "object",
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      whyItMatters: { type: "string" },
      keyFacts: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7 },
      socialAngles: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: { label: { type: "string" }, angle: { type: "string" } },
          required: ["label", "angle"],
        },
      },
      category: { type: "string", enum: CATEGORY_VALUES },
      players: { type: "array", items: { type: "string" } },
      importanceScore: { type: "integer", minimum: 1, maximum: 10 },
      isRumor: { type: "boolean" },
      isUpdate: { type: "boolean" },
      updateNote: { type: ["string", "null"] },
    },
    required: [
      "headline", "summary", "whyItMatters", "keyFacts", "socialAngles",
      "category", "players", "importanceScore", "isRumor", "isUpdate", "updateNote",
    ],
  },
};

/**
 * Analyzes one story event (a new article, or a new article clustered
 * against an existing story) into a structured, AI-written briefing. Falls
 * back to a deterministic, clearly-labeled rule-based digest if
 * ANTHROPIC_API_KEY isn't set or the API call fails, so the pipeline never
 * hard-fails on the AI step.
 */
export async function analyzeStory(input) {
  if (!isAiConfigured()) {
    return fallbackAnalyzeStory(input);
  }

  try {
    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    const response = await getClient().messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [SUBMIT_STORY_ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: "submit_story_analysis" },
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a submit_story_analysis tool call");

    return normalizeAnalysis(toolUse.input);
  } catch (err) {
    console.error("[analyzeStory] AI analysis failed, using fallback:", err.message || err);
    return fallbackAnalyzeStory(input);
  }
}

function normalizeAnalysis(raw) {
  const category = CATEGORY_VALUES.includes(raw.category) ? raw.category : "league_news";
  const importanceScore = clamp(Number(raw.importanceScore) || 4, 1, 10);
  const keyFacts = Array.isArray(raw.keyFacts) ? raw.keyFacts.map(String).filter(Boolean) : [];
  const players = Array.isArray(raw.players) ? raw.players.map(String).filter(Boolean) : [];
  const socialAngles = Array.isArray(raw.socialAngles)
    ? raw.socialAngles
        .filter((a) => a && typeof a === "object")
        .map((a) => ({ label: String(a.label ?? "").trim(), angle: String(a.angle ?? "").trim() }))
        .filter((a) => a.label && a.angle)
        .slice(0, 3)
    : [];

  return {
    headline: String(raw.headline ?? "").trim() || "NFL News Update",
    summary: String(raw.summary ?? "").trim(),
    whyItMatters: String(raw.whyItMatters ?? "").trim(),
    keyFacts: keyFacts.slice(0, 7),
    socialAngles,
    category,
    players,
    importanceScore,
    isRumor: Boolean(raw.isRumor),
    isUpdate: Boolean(raw.isUpdate),
    updateNote: raw.updateNote ? String(raw.updateNote) : null,
    isFallback: false,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Fallback path (no ANTHROPIC_API_KEY): deterministic, clearly-labeled
// extractive digest rather than a polished original summary. It attributes
// rather than paraphrases, since paraphrasing without an LLM risks lightly
// rewriting source text — exactly what the copyright rule prohibits.
// ---------------------------------------------------------------------------

const ANGLE_TEMPLATES = {
  trade: [
    { label: "Breaking-news announcement", angle: "Straightforward trade announcement graphic with the key details." },
    { label: "Team impact", angle: "What this trade means for the roster and depth chart going forward." },
    { label: "Fantasy impact", angle: "How the move shifts fantasy value for the players involved." },
  ],
  injury: [
    { label: "Breaking-news announcement", angle: "Injury update graphic with status and expected timeline." },
    { label: "Team impact", angle: "How the team's plans change without this player available." },
    { label: "Fantasy impact", angle: "Fantasy implications and next-man-up value." },
  ],
  default: [
    { label: "Breaking-news announcement", angle: "Straightforward news announcement summarizing what happened." },
    { label: "Why it matters", angle: "Context on what this means for the team going forward." },
    { label: "Fantasy football impact", angle: "How this news affects fantasy outlooks, if applicable." },
  ],
};

function fallbackAnalyzeStory(input) {
  const combinedText = input.sources.map((s) => `${s.sourceHeadline} ${s.excerpt}`).join(" ");
  const primary = input.sources[0];

  const attributedLines = input.sources
    .filter((s) => s.excerpt)
    .map((s) => `According to ${s.sourceName}: ${s.excerpt}`)
    .join(" ");

  const summary = [
    "[Automated draft summary — set ANTHROPIC_API_KEY for an AI-written original summary.]",
    attributedLines || `${primary?.sourceName ?? "A source"} reports: ${primary?.sourceHeadline ?? ""}`,
  ]
    .filter(Boolean)
    .join(" ");

  const category = classifyCategory(combinedText);

  // Player extraction only looks at excerpts, not headlines: several outlets
  // (FOX Sports especially) publish Title Case headlines where every word is
  // capitalized, which defeats the "consecutive capitalized words = name"
  // heuristic and produces junk like "Pleads No Contest". Excerpts are
  // normal sentence case, so the heuristic is far more reliable there.
  const excerptText = input.sources.map((s) => s.excerpt).join(" ");

  return {
    headline: primary?.sourceHeadline ?? "NFL News Update",
    summary,
    whyItMatters: "",
    keyFacts: input.sources.map((s) => `${s.sourceName}: ${s.sourceHeadline}`),
    socialAngles: ANGLE_TEMPLATES[category] ?? ANGLE_TEMPLATES.default,
    category,
    players: extractLikelyPlayerNames(excerptText),
    importanceScore: estimateImportance(combinedText),
    isRumor: looksLikeRumor(combinedText),
    isUpdate: input.existingStory !== null,
    updateNote: input.existingStory ? "New reporting added." : null,
    isFallback: true,
  };
}
