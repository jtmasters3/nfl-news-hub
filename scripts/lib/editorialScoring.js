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
import { computePlayerImportanceMultipliers } from "./editorialPlayerImportance.js";

export const SCORING_VERSION = 1;

// ---------------------------------------------------------------------------
// Phase 2H-B — dual-score calibration (observe-only).
//
// scoreStory() still returns the exact same legacy top-level shape it always
// has (total_score, core_score, signals, modifiers, destination, ...) —
// nothing about those fields, or their values for any existing caller, is
// touched by this addition. This purely ADDS one new `enrichment` block
// containing an enriched score computed from the LOCKED Phase 2H-A player-
// importance multiplier helper, for calibration/comparison only. No
// production/pipeline caller consumes `enrichment` yet — see
// scripts/editorial/README.md.
//
// `context.player_context` is a new, entirely OPTIONAL field on the second
// (context) argument — deliberately NOT on `story`. `story` holds
// persisted article/event facts; `context.player_context` is derived
// scoring-time enrichment (Phase 2C-2G's resolved position/role/QB/star
// output) the caller supplies fresh on each call. Any `story.player_context`
// a caller might have persisted is never read as scoring context — this
// keeps derived roster/depth/identity/role/star data (especially Phase
// 2I's future historical as-of context) from ever leaking into the
// persisted story object. When a caller does not supply
// `context.player_context` at all, player importance is exactly neutral
// (1.0 everywhere) — an absent field must never retroactively damp a
// legacy caller the way an explicitly-unresolved player would. This is
// deliberately a different state from Phase 2H-A's own "unresolved player"
// result (0.855), which only occurs when a caller explicitly says a player
// subject exists but its position/role are unknown.
// ---------------------------------------------------------------------------
const NEUTRAL_PLAYER_IMPORTANCE = Object.freeze({
  position_weight: 1.0,
  role_weight: 1.0,
  raw_role_multiplier: 1.0,
  combined_role_multiplier: 1.0,
  star_boost: 1.0,
  combined_player_multiplier: 1.0,
  diagnostics: Object.freeze({ role_multiplier_floor_applied: false, role_multiplier_ceiling_applied: false, star_boost_applied: false, star_gate_passed: false, is_qb: false }),
  reason_codes: Object.freeze(["player_context_not_supplied"]),
});

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
 *   primary_image_url?, base_image_url? } — article/event FACTS only.
 *   `story.player_context`, even if present, is deliberately never read —
 *   see `context.player_context` below.
 * @param {object} [context] - reserved for future (Phase 3+) window/re-entry
 *   context; still unused for that purpose in Phase 1. Phase 2H-B adds one
 *   field here: `context.player_context` — resolved, DERIVED player
 *   enrichment (Phase 2C-2G's position/role/QB/star output), deliberately
 *   kept out of `story` itself. `story` is persisted article/event data;
 *   `context.player_context` is scoring-time-only enrichment the caller
 *   supplies fresh on each call — this boundary matters most for Phase 2I,
 *   whose historical as-of roster/depth/player context must never leak into
 *   the persisted story object by design.
 * @returns {object} deterministic, JSON-serializable, explainable score result
 */
export function scoreStory(story, context = {}) {
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
  // This is the LEGACY destination — still the only one any caller (the
  // read-only score-story.js CLI, or a future production caller) should
  // ever treat as the real recommendation. See enrichedDestinationPreview
  // below, which is observe-only and never substituted here.
  const destination = computeDestinationFit({ totalScore, rung: eventMagnitude.rung, isRumor, constants });

  // --- Phase 2H-B: player-importance enrichment (observe-only) ----------
  // `context.player_context` is optional and new — deliberately NOT read
  // from `story`. A `story.player_context` some caller might have persisted
  // is intentionally ignored as scoring context (see the module's own
  // doc comment on scoreStory and the "no ambiguous precedence" test).
  // Absent entirely -> exactly neutral (see NEUTRAL_PLAYER_IMPORTANCE's doc
  // comment for why this must differ from Phase 2H-A's own "unresolved
  // player" result). Present -> delegate wholesale to the LOCKED Phase
  // 2H-A helper; this module never duplicates or re-tunes its tables.
  const playerContext = context?.player_context ?? null;
  const playerImportance = playerContext ? computePlayerImportanceMultipliers(playerContext) : NEUTRAL_PLAYER_IMPORTANCE;

  const enrichedMagnitude = eventMagnitude.magnitude * playerImportance.combined_role_multiplier * playerImportance.star_boost * gamePerformanceMultiplier;
  const enrichedTotal = round1(enrichedMagnitude + corroboration + socialInterest.bonus + escalation.bonus - rumorPenalty - repetitionPenalty);

  // Delta diagnostics use the TRUE pre-display-rounding totals, not the
  // rounded `totalScore`/`enrichedTotal` above (those remain exactly the
  // existing, externally-visible legacy/enriched display values — nothing
  // about them changes here). `coreScore` and `enrichedMagnitude` are
  // themselves already unrounded; `corroboration`/`socialInterest.bonus`
  // similarly carry full floating-point precision until their own
  // individual round1() call in the `modifiers` output below — reusing
  // them here (rather than the rounded `totalScore`/`enrichedTotal`) is
  // what makes this a genuinely raw-vs-raw comparison, not raw-vs-rounded.
  const rawLegacyTotal = coreScore + corroboration + socialInterest.bonus + escalation.bonus - rumorPenalty - repetitionPenalty;
  const rawEnrichedTotal = enrichedMagnitude + corroboration + socialInterest.bonus + escalation.bonus - rumorPenalty - repetitionPenalty;
  const rawScoreDelta = rawEnrichedTotal - rawLegacyTotal;
  const scoreDelta = round1(rawScoreDelta);
  // Divide-by-zero guard: an explicit, documented null rather than
  // Infinity/NaN when the raw legacy total is exactly zero.
  const scoreDeltaPercent = rawLegacyTotal === 0 ? null : round1((rawScoreDelta / rawLegacyTotal) * 100);

  // Observe-only preview: the SAME destination-fit function, same rumor
  // gate, evaluated against the enriched total instead. Never assigned to
  // `destination` above, never read by score-story.js or any other caller.
  const enrichedDestinationPreview = computeDestinationFit({ totalScore: enrichedTotal, rung: eventMagnitude.rung, isRumor, constants });

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
    `Enrichment (Phase 2H-B, observe-only): ${playerContext ? "player_context supplied" : "no player_context supplied — neutral"} — position_weight ${playerImportance.position_weight} × role_weight ${playerImportance.role_weight} → combined_role_multiplier ${playerImportance.combined_role_multiplier}, star_boost ${playerImportance.star_boost}`,
    `Enriched total: ${round1(enrichedMagnitude)} + ${round1(corroboration)} + ${round1(socialInterest.bonus)} + ${escalation.bonus} - ${rumorPenalty} - ${repetitionPenalty} = ${enrichedTotal} (delta ${scoreDelta} vs. legacy — NOT used for destination selection)`,
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
    // --- Phase 2H-B (observe-only) --------------------------------------
    // Additive only. `destination` above (legacy) remains the only field
    // any production/pipeline caller may ever treat as the real
    // recommendation — see enriched_destination_preview's own note.
    enrichment: {
      legacy_total: totalScore,
      enriched_total: enrichedTotal,
      score_delta: scoreDelta,
      score_delta_percent: scoreDeltaPercent,
      event_magnitude: eventMagnitude.magnitude,
      legacy_role_multiplier: roleMultiplier,
      legacy_star_boost: starBoost,
      legacy_game_performance_multiplier: gamePerformanceMultiplier,
      legacy_magnitude: round1(coreScore),
      position_weight: playerImportance.position_weight,
      role_weight: playerImportance.role_weight,
      raw_role_multiplier: playerImportance.raw_role_multiplier,
      combined_role_multiplier: playerImportance.combined_role_multiplier,
      star_boost: playerImportance.star_boost,
      combined_player_multiplier: playerImportance.combined_player_multiplier,
      enriched_magnitude: round1(enrichedMagnitude),
      player_importance_diagnostics: playerImportance.diagnostics,
      player_importance_reason_codes: playerImportance.reason_codes,
      legacy_destination: destination,
      // OBSERVE-ONLY: never consumed by score-story.js, generate-content.js,
      // or any other caller. Real destination selection remains `destination`.
      enriched_destination_preview: enrichedDestinationPreview,
    },
  };
}
