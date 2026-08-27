// Event-type detection for clustering purposes only (see similarity.js).
// Deliberately NOT used for the public category badge/filter chips — this
// exists purely to let the clustering gate tell "same event, different
// outlet" apart from "materially new development about the same subject"
// without an AI call. Reuses classifyCategory as the base signal (per its
// own broad trade/injury/contract/etc buckets) and layers a small set of
// supplementary patterns on top for distinctions classifyCategory doesn't
// need to make for display purposes but clustering does — e.g. a plain
// injury mention vs. a confirmed diagnosis, or a trade vs. that same trade
// later falling through medically.
import { classifyCategory } from "./extraction.js";

// classifyCategory's catch-all for anything that doesn't match a specific
// rule. Two headlines both landing here says nothing about whether they're
// the same event — it must never count as a "new type" signal on its own.
// See similarity.js's use of detectEventTypes for why that matters.
export const UNSPECIFIC_TYPE = "league_news";

const SUPPLEMENTARY_PATTERNS = [
  {
    // A materially more specific/severe development than a bare injury
    // mention — the exact shape of update that should split off into its
    // own story/social post rather than silently join the original report.
    type: "injury_diagnosis",
    patterns: [
      /\bMRI\s+confirms?\b/i,
      /\bdiagnos(?:ed|is)\b/i,
      // Named-structure mentions (ACL/MCL/achilles/meniscus) are specific
      // enough on their own to mean a diagnosis was made, regardless of
      // the surrounding verb tense/word order ("torn ACL" vs "tore his
      // ACL" vs "ACL tear") — matching on the structure name alone avoids
      // missing real diagnoses over incidental outlet-to-outlet phrasing
      // differences (found during the live-data audit: one outlet's "tore
      // his ACL" didn't match a "torn ACL"-only pattern that a second
      // outlet's "torn ACL" did, making the second look like new
      // information about an already-known diagnosis).
      /\bACL\b/i,
      /\bMCL\b/i,
      /\bachilles\b/i,
      /\bmeniscus\b/i,
      /\bout\s+for\s+(?:the\s+)?season\b/i,
      /\bplaced\s+on\s+(?:injured\s+reserve|IR)\b/i,
      /\bruled\s+out\b/i,
      /\bfails?\s+(?:his |her |a |the )?physical\b/i,
    ],
  },
  {
    // classifyCategory's trade pattern matches the word "trade" regardless
    // of context, so a trade that later collapses would otherwise still
    // read as the same "trade" type as the original report. This flags the
    // reversal explicitly as its own type so it's recognized as new.
    type: "trade_rescinded",
    patterns: [/\btrade\s+(?:rescinded|voided|falls?\s+through|nixed|cancell?ed)\b/i],
  },
  {
    // A practice-return/clearance update — not captured by any
    // classifyCategory rule, so without this it would fall through to the
    // unspecific catch-all and never register as a distinct development.
    type: "cleared_status",
    patterns: [/\bcleared\b/i, /\breturns?\s+to\s+practice\b/i],
  },
  {
    // classifyCategory's own free_agency rule only matches the PAST-TENSE
    // "released" — a present-tense/gerund "release"/"releasing" headline
    // (common outlet phrasing: "Team releasing Player") falls all the way
    // through to the unspecific catch-all instead. Since the catch-all
    // never counts as a "new type" (see UNSPECIFIC_TYPE), a "sign" story
    // and a later, unrelated "release" story for the SAME player could
    // both land on no-concrete-type and look compatible — exactly the kind
    // of opposite-action false merge the event-type gate exists to catch.
    // This is a general action-family signal (independent of
    // classifyCategory, and never touches the public category field), not
    // specific to any one player/team/outlet — caught by the
    // "signing -> later release" case in the permanent regression suite.
    type: "release",
    patterns: [/\breleas(?:e|es|ed|ing)\b/i, /\bwaiv(?:e|es|ed|ing)\b/i],
  },
];

/**
 * Returns the set of event-type labels a piece of text matches — always
 * includes the classifyCategory() result, plus zero or more supplementary
 * labels for finer distinctions clustering needs but the public category
 * badge doesn't. A text can carry multiple types at once (e.g. a headline
 * that says both "trade" and "fails physical").
 */
export function detectEventTypes(text) {
  const types = new Set([classifyCategory(text)]);
  for (const { type, patterns } of SUPPLEMENTARY_PATTERNS) {
    if (patterns.some((p) => p.test(text))) types.add(type);
  }
  return types;
}
