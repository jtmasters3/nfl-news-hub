// Editorial Scoring Brain — PHASE 1 (observe-only).
//
// Implements the architecture locked across the three "Editorial Scoring
// Brain" design memos, using ONLY signals that already exist in this
// repository today: category, event types, teams, players[], visual_subject,
// current_team, source metadata, timestamps, is_rumor. No nflverse, no
// roster/depth-chart data, no star-exception list, no game/performance data
// — all deferred to later phases per the locked build order.
//
// scoreStory() is a PURE function: same input -> same output, always. It
// performs no I/O, claims nothing, mutates nothing, and is not imported by
// any production code path. See scripts/editorial/README.md for what Phase 1
// is (and is deliberately not) allowed to do.
import { computeEventMagnitude } from "./editorialEventMagnitude.js";
import { bestSourceTier, corroborationBonus, UNKNOWN_SOURCE_TIER } from "./editorialSourceConfidence.js";
import { normalizeHeadlineTokens } from "./similarity.js";

export const SCORING_VERSION = 1;

// ---------------------------------------------------------------------------
// OBSERVE_ONLY_CALIBRATION_DEFAULTS
//
// Every number below is a Phase 1 starting point, not a locked editorial
// weight — per the Editorial Scoring Brain's explicit "do not lock numbers
// until real dry-run data exists" decision. Multiplier floors/ceilings exist
// to guarantee two properties regardless of what the eventual real numbers
// turn out to be: no single unresolved factor can ever crush a score toward
// zero, and no single factor can ever manufacture Feed-worthy magnitude out
// of a trivial event on its own.
// ---------------------------------------------------------------------------
export const OBSERVE_ONLY_CALIBRATION_DEFAULTS = Object.freeze({
  ROLE_MULTIPLIER: Object.freeze({ NEUTRAL: 1.0, FLOOR: 0.6, CEILING: 1.8 }),
  STAR_BOOST: Object.freeze({ NEUTRAL: 1.0, FLOOR: 1.0, CEILING: 1.3 }),
  GAME_PERFORMANCE_MULTIPLIER: Object.freeze({ NEUTRAL: 1.0, FLOOR: 0.8, CEILING: 2.0 }),
  CORROBORATION: Object.freeze({ PER_SOURCE_BONUS: 4, MAX_BONUS: 12 }),
  SOCIAL_INTEREST: Object.freeze({
    GENERIC_MAX_FRACTION_OF_MAGNITUDE: 0.2,
    GENERIC_MAX_ABSOLUTE: 15,
    // Bad-beat evidence is deliberately NOT scaled off the underlying game's
    // football magnitude (which can be genuinely low for a "meaningless"
    // result) — see editorialScoring's computeSocialInterest doc comment
    // and the Editorial Scoring Brain's §05 for why this is the one
    // intentional exception to "social interest can never manufacture
    // importance alone."
    BAD_BEAT_NOTABLE_MAX_ABSOLUTE: 20,
    BAD_BEAT_EXCEPTIONAL_MAX_ABSOLUTE: 45,
  }),
  RUMOR_PENALTY: 12,
  REPETITION_PENALTY: 10, // not computed in Phase 1 — no window/multi-story context yet; reserved for Phase 3+
  FEED_THRESHOLD_PROVISIONAL: 55,
  STORY_THRESHOLD_PROVISIONAL: 25,
});

// ---------------------------------------------------------------------------
// Social interest / bad-beat detection
// ---------------------------------------------------------------------------
const SOCIAL_INTEREST_PATTERNS = [
  /\bcontrovers(?:y|ial)\b/i, /\bfeud\b/i, /\bblasts?\b/i,
  /\bsurpris(?:e|ing|ingly)\b/i, /\bshocking\b/i, /\bstuns?\b/i,
  /\bwalk-?off\b/i, /\bcomeback\b/i, /\brivalry\b/i,
];

// A bare "covered"/"against the spread" is explicitly NOT sufficient
// evidence on its own — every pattern here requires a specific, named
// BAD-BEAT phrase, never a plain description of an ordinary betting
// outcome. "Covered the spread" was removed after the calibration review
// found it fires on completely routine results ("Team covers the spread
// in blowout win" — an unremarkable, expected outcome, not a bad beat) —
// covering is what happens in the ordinary case, not evidence of anything
// notable. Only phrases that specifically describe the LATE/BACKDOOR/
// GARBAGE-TIME reversal a bad beat actually is qualify.
const BAD_BEAT_NOTABLE_PATTERNS = [
  /\bbad beat\b/i, /\bbackdoor cover\b/i, /\bflipped? the spread\b/i,
  /\bmeaningless\s+(?:late\s+)?(?:touchdown|score|field goal)\b/i,
];
const BAD_BEAT_EXCEPTIONAL_PATTERNS = [
  /\bhistoric(?:al)?\s+bad beat\b/i, /\bworst bad beat\b/i, /\bone-of-a-kind bad beat\b/i,
];

function detectBadBeatCandidateTier(text) {
  if (BAD_BEAT_EXCEPTIONAL_PATTERNS.some((p) => p.test(text))) return "exceptional_candidate";
  if (BAD_BEAT_NOTABLE_PATTERNS.some((p) => p.test(text))) return "notable";
  return "none";
}

/**
 * Bounded, guardrailed social-interest bonus. Zeroed outright for a rumor,
 * an unknown-tier-only source, or an event with no real magnitude at all —
 * closing the "sensational headline from a nobody source" loophole
 * structurally, not by convention.
 */
function computeSocialInterest({ text, magnitude, isRumor, sourceTier, distinctReportCount, constants }) {
  if (isRumor) return { tier: "zeroed_rumor", bad_beat_tier: "none", bonus: 0 };
  if (sourceTier === UNKNOWN_SOURCE_TIER) return { tier: "zeroed_unverified_source", bad_beat_tier: "none", bonus: 0 };
  if (magnitude <= 0) return { tier: "zeroed_zero_magnitude", bad_beat_tier: "none", bonus: 0 };

  const candidateTier = detectBadBeatCandidateTier(text);
  // "Exceptional" requires the strictest evidence bar in the whole model:
  // an already-authoritative source AND genuine multi-source corroboration.
  // Falling short downgrades to "notable" rather than being discarded.
  const badBeatTier =
    candidateTier === "exceptional_candidate" ? (distinctReportCount >= 2 ? "exceptional" : "notable") : candidateTier;

  if (badBeatTier === "notable" || badBeatTier === "exceptional") {
    const cap = badBeatTier === "exceptional" ? constants.BAD_BEAT_EXCEPTIONAL_MAX_ABSOLUTE : constants.BAD_BEAT_NOTABLE_MAX_ABSOLUTE;
    return { tier: `bad_beat_${badBeatTier}`, bad_beat_tier: badBeatTier, bonus: cap };
  }

  const genericHit = SOCIAL_INTEREST_PATTERNS.some((p) => p.test(text));
  if (!genericHit) return { tier: "none", bad_beat_tier: "none", bonus: 0 };

  const cap = Math.min(constants.GENERIC_MAX_ABSOLUTE, constants.GENERIC_MAX_FRACTION_OF_MAGNITUDE * magnitude);
  return { tier: "generic_drama", bad_beat_tier: "none", bonus: Math.max(0, cap) };
}

// ---------------------------------------------------------------------------
// Player identity — two independent existing extraction paths (visual
// subject resolution vs. description-only players[]) agreeing with each
// other is the only cross-validation Phase 1 has available; it is honest
// about that rather than pretending to a confidence level roster data would
// be needed to actually earn. See scripts/editorial/README.md.
// ---------------------------------------------------------------------------
function resolvePlayerIdentity({ visualSubject, visualSubjectType, players }) {
  if (visualSubjectType !== "player" || !visualSubject) {
    return { identity: null, confidence: "none" };
  }
  const crossValidated = Array.isArray(players) && players.includes(visualSubject);
  return { identity: visualSubject, confidence: crossValidated ? "high" : "medium" };
}

function determineEventScope({ isOrganizational, visualSubjectType }) {
  if (isOrganizational) return "organizational";
  if (visualSubjectType === "player") return "player";
  if (visualSubjectType === "coach" || visualSubjectType === "executive") return "organizational";
  return "unresolved";
}

// ---------------------------------------------------------------------------
// Destination-fit metadata — OBSERVE-ONLY. Deliberately never receives image/
// production-readiness data as an input (see production_readiness below) —
// that is a structural guarantee, not just a convention, that image
// availability can never leak into an editorial signal.
// ---------------------------------------------------------------------------
function computeDestinationFit({ totalScore, rung, isRumor, constants }) {
  const feed_block_reasons = [];
  const story_block_reasons = [];

  const meetsFeedMagnitude = totalScore >= constants.FEED_THRESHOLD_PROVISIONAL;
  const meetsStoryMagnitude = totalScore >= constants.STORY_THRESHOLD_PROVISIONAL;

  if (!meetsFeedMagnitude) feed_block_reasons.push("insufficient_magnitude");
  if (isRumor) feed_block_reasons.push("unconfirmed_rumor");
  const structurallyStoryNatured = rung === "depth_chart_designation";
  if (structurallyStoryNatured) feed_block_reasons.push("structurally_story_natured");

  if (!meetsStoryMagnitude) story_block_reasons.push("insufficient_magnitude");

  return {
    feed_fit: feed_block_reasons.length === 0 ? "meets_feed_bar_provisional" : meetsFeedMagnitude ? "magnitude_ok_but_blocked" : "insufficient_magnitude",
    story_fit: story_block_reasons.length === 0 ? "meets_story_bar_provisional" : "insufficient_magnitude",
    feed_block_reasons,
    story_block_reasons,
    structurally_story_natured: structurallyStoryNatured,
  };
}

function buildExplanation(parts) {
  return parts.filter(Boolean);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * @param {object} story - a story-shaped object: { headline, description?,
 *   category?, teams?, players?, visual_subject?, visual_subject_type?,
 *   current_team?, is_rumor?, sources?: [{name?, source_name?, headline?,
 *   description?}], first_published_at?, latest_published_at?,
 *   primary_image_url?, base_image_url? }
 * @param {object} [context] - reserved for future (Phase 3+) window/re-entry
 *   context; unused in Phase 1, accepted for forward API compatibility.
 * @returns {object} deterministic, JSON-serializable, explainable score result
 */
export function scoreStory(story, context = {}) {
  void context; // Phase 1: not yet consumed — see docs.
  const constants = OBSERVE_ONLY_CALIBRATION_DEFAULTS;

  const headline = story?.headline ?? "";
  const description = story?.description ?? "";
  const sources = Array.isArray(story?.sources) ? story.sources : [];
  const players = Array.isArray(story?.players) ? story.players : [];
  const isRumor = story?.is_rumor === true;
  const visualSubject = story?.visual_subject ?? null;
  const visualSubjectType = story?.visual_subject_type ?? null;

  const sourceText = sources.map((s) => `${s.headline ?? ""} ${s.description ?? ""}`).join(" ");
  const text = [headline, description, sourceText].filter(Boolean).join(" ");

  // --- Event magnitude ------------------------------------------------
  const eventMagnitude = computeEventMagnitude(text);

  // --- Player identity + role/star routing (all neutral in Phase 1) ---
  const eventScope = determineEventScope({ isOrganizational: eventMagnitude.is_organizational, visualSubjectType });
  const playerIdentity = eventScope === "player" ? resolvePlayerIdentity({ visualSubject, visualSubjectType, players }) : { identity: null, confidence: eventScope === "organizational" ? "not_applicable" : "none" };

  const roleMultiplier = constants.ROLE_MULTIPLIER.NEUTRAL; // Phase 1: always neutral — no position/depth-chart data exists yet
  const starBoost = constants.STAR_BOOST.NEUTRAL; // Phase 1: always neutral — no star-exception list exists yet
  const gamePerformanceMultiplier = constants.GAME_PERFORMANCE_MULTIPLIER.NEUTRAL; // Phase 1: always neutral — no game/performance data exists yet

  const coreScore = eventMagnitude.magnitude * roleMultiplier * starBoost * gamePerformanceMultiplier;

  // --- Source confidence + corroboration -------------------------------
  const tier = bestSourceTier(sources.length ? sources : story?.source_name ? [{ name: story.source_name }] : []);
  const { distinct_report_count: distinctReportCount, bonus: corroboration } = corroborationBonus(sources, constants.CORROBORATION);

  // --- Social interest (bounded; bad-beat ladder integrated) -----------
  const socialInterest = computeSocialInterest({
    text,
    magnitude: eventMagnitude.magnitude,
    isRumor,
    sourceTier: tier,
    distinctReportCount,
    constants: constants.SOCIAL_INTEREST,
  });

  // --- Escalation (structure only — NOT activated in Phase 1) ----------
  const escalation = {
    development_timestamp: story?.latest_published_at ?? story?.first_published_at ?? null,
    event_types: eventMagnitude.event_types,
    escalation_types_present: eventMagnitude.escalation_types_present,
    evidence_fingerprint: Array.from(normalizeHeadlineTokens(headline)).sort().join("|") || null,
    re_entry_eligible: false, // Phase 1: window re-entry is not active — see the locked window architecture's own phasing
    bonus: 0,
  };

  // --- Penalties ---------------------------------------------------------
  const rumorPenalty = isRumor ? constants.RUMOR_PENALTY : 0;
  const repetitionPenalty = 0; // not computed in Phase 1 — requires multi-story/window context (Phase 3+)

  const totalScore = round1(coreScore + corroboration + socialInterest.bonus + escalation.bonus - rumorPenalty - repetitionPenalty);

  // --- Destination fit (observe-only) -----------------------------------
  const destination = computeDestinationFit({ totalScore, rung: eventMagnitude.rung, isRumor, constants });

  // --- Production readiness (NEVER an input to any score term above) ----
  const imageAvailable = Boolean(story?.primary_image_url ?? story?.base_image_url ?? null);
  const productionReadiness = {
    image_available: imageAvailable,
    note: "informational only — does not affect editorial score (see Editorial Scoring Brain §06)",
  };

  const explanation = buildExplanation([
    `Event: ${eventMagnitude.rung} (category: ${eventMagnitude.category}) — base magnitude ${eventMagnitude.magnitude}`,
    eventScope === "organizational" ? "Scope: organizational/game-level — neutral role multiplier applied (1.0), no player subject required" : null,
    eventScope === "player" ? `Player identity: ${playerIdentity.identity ?? "unresolved"} (confidence: ${playerIdentity.confidence}) — role multiplier neutral in Phase 1 (${roleMultiplier})` : null,
    eventScope === "unresolved" ? `Player identity: unresolved (confidence: ${playerIdentity.confidence}) — neutral role multiplier applied (${roleMultiplier})` : null,
    `Star boost: not available in Phase 1 (${starBoost})`,
    `Game/performance multiplier: not available in Phase 1 (${gamePerformanceMultiplier})`,
    `Core score: ${eventMagnitude.magnitude} × ${roleMultiplier} × ${starBoost} × ${gamePerformanceMultiplier} = ${round1(coreScore)}`,
    `Source confidence: best tier ${tier}, ${distinctReportCount} distinct report(s) → corroboration +${round1(corroboration)}`,
    `Social interest: ${socialInterest.tier} → +${round1(socialInterest.bonus)}`,
    `Rumor: ${isRumor} → ${rumorPenalty > 0 ? `-${rumorPenalty}` : "no penalty"}`,
    `Repetition: not computed in Phase 1 (0)`,
    `Total: ${round1(coreScore)} + ${round1(corroboration)} + ${round1(socialInterest.bonus)} + ${escalation.bonus} - ${rumorPenalty} - ${repetitionPenalty} = ${totalScore}`,
  ]);

  return {
    version: SCORING_VERSION,
    total_score: totalScore,
    core_score: round1(coreScore),
    signals: {
      event_type: eventMagnitude.rung,
      event_magnitude: eventMagnitude.magnitude,
      event_scope: eventScope,
      player_identity: playerIdentity.identity,
      player_identity_confidence: playerIdentity.confidence,
      role_multiplier: roleMultiplier,
      star_boost: starBoost,
      game_performance_multiplier: gamePerformanceMultiplier,
      source_confidence: tier,
      corroboration: distinctReportCount,
      social_interest: socialInterest.tier,
      bad_beat_tier: socialInterest.bad_beat_tier,
      escalation: escalation.event_types,
      rumor: isRumor,
      repetition: null,
    },
    modifiers: {
      corroboration_bonus: round1(corroboration),
      social_interest_bonus: round1(socialInterest.bonus),
      escalation_bonus: escalation.bonus,
      rumor_penalty: rumorPenalty,
      repetition_penalty: repetitionPenalty,
    },
    destination,
    escalation,
    production_readiness: productionReadiness,
    explanation,
  };
}
