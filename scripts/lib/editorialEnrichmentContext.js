// Production Integration — Stage 1: observe-only enrichment assembly. Pure
// orchestration ONLY — it calls the already-locked Phase 2C-2I modules in
// sequence and assembles their outputs into the `player_context` shape
// Phase 2H-B's `scoreStory(story, context)` already expects. It duplicates
// NONE of their algorithms: no identity matching, no position/role tables,
// no fresh-role phrase detection, no QB/star logic, no temporal eligibility
// rules. This is NOT Phase 2J — nothing here is a new scoring phase, and
// nothing here is wired into production selection.
//
// HARD INVARIANT: FAIL OPEN. Any missing/malformed/unavailable input at any
// step — no nflverse cache, no schedule data, no historical roster, no
// depth chart, unresolved identity, unknown position, unknown role, star
// registry miss, even an unexpected exception — degrades to a neutral
// player_context (`has_player_subject: false`, or otherwise a safely
// "unknown"/null-filled shape) and NEVER throws. This function is designed
// to be safe to call from a production path without any additional
// try/catch at the call site, though callers should still not rely on that
// — see the module's own try/catch wrapper below.
//
// ---------------------------------------------------------------------------
// STORY AS_OF POLICY — inspected, not assumed. generate-content.js's real
// story schema (confirmed by direct inspection) carries THREE timestamps:
//
//   first_published_at  — the EARLIEST source's effective date (its own
//                          published_at, or our discovery time as a last
//                          resort — see generate-content.js's effectiveDate()
//                          and computePublishWindow()). This is the closest
//                          available proxy for "when the underlying event
//                          entered our system."
//   latest_published_at — the NEWEST source's effective date. Grows over
//                          time as new reporting arrives — using this as
//                          as_of would let a story's own enrichment eligibility
//                          silently expand over time as unrelated later
//                          reporting accumulates, which is exactly the kind
//                          of moving-target lookahead risk Phase 2I's own
//                          "no future evidence" invariant exists to prevent.
//                          NEVER used here.
//   updated_at           — purely an internal processing/audit timestamp
//                          (when OUR pipeline last touched the record), NOT
//                          a claim about when the news itself happened.
//                          Already documented as "deliberately NOT used for
//                          sorting or freshness" in generate-content.js
//                          itself. NEVER used here.
//
// Therefore: as_of = story.first_published_at, and ONLY that. If it is
// missing (sources array empty/malformed — first_published_at can only be
// null in that case, since effectiveDate() always falls back to
// discovered_at otherwise), enrichment fails open to neutral rather than
// substituting Date.now(), latest_published_at, or any other timestamp.
//
// ---------------------------------------------------------------------------
// PLAYER-SUBJECT GATE — hardened after real-story validation surfaced a real
// gap. Inspected, not assumed: visualSubject.js's determineVisualSubject()
// returns `visual_subject_type: "player"` whenever a candidate name matched
// its HEADLINE-CANDIDATE branch (players[] filtered to headline matches, or
// a raw headline-name-extraction fallback) — this branch has NO awareness
// that the matched name might be a coach/executive ("Chiefs HC Andy Reid
// says Patrick Mahomes 'most likely' to start" real story: "Andy Reid" was
// selected as visual_subject_type:"player" purely because "HC" isn't in
// COACH_TITLES' matched phrases, so the coach-detection branch below it
// never got a chance to fire). `visual_subject_type === "player"` therefore
// does NOT by itself prove the subject is really a player — it only proves
// WHICH branch matched.
//
// The one signal that DOES distinguish a confidently-established single
// player subject is the SAME `subject_match_count` field
// nflverseIdentityResolver.js's own (locked, unmodified) selectSubject()
// already uses to set its `confident` flag:
//
//   visual_subject_type === "player" && subject_match_count === 1
//     -> exactly one candidate name, and it appeared in the headline once,
//        unambiguously — the confident branch (determineVisualSubject's own
//        code: "return { ..., subject_match_count: 1 }" only ever executes
//        from `if (inHeadline.length === 1)`).
//   visual_subject_type === "player" && subject_match_count > 1
//     -> the WEAKER "earliest of several headline candidates" fallback —
//        already marked non-confident by Phase 2C's own selectSubject
//        (`confident: subject_match_count === 1`, else
//        "visual_subject_weak_fallback"). Multiple genuine player names
//        competing for "the" subject is exactly the "prefer neutral over a
//        wrong primary player" case this gate exists to catch.
//   visual_subject_type is "coach" | "executive" | "team" | "event"
//     -> a real, confident subject was found, but determineVisualSubject
//        itself says it is NOT a player. subject_match_count is always 0 on
//        these branches (hardcoded in visualSubject.js) — not because
//        nothing was found, but because this field is only meaningful on
//        the player branch. Phase 2C's own selectSubject already refuses to
//        treat a non-"player"-typed visual_subject as its resolution
//        subject (its guard is `visual_subject_type === "player"`), so it
//        never reaches identity resolution as the primary subject — this
//        gate exists so THIS module's own has_player_subject flag reflects
//        the same refusal, rather than silently falling through.
//   visual_subject_type is null
//     -> nothing confident enough was found at all (determineVisualSubject's
//        own final "leave it unknown" branch).
//
// This is orchestration-only: no change to visualSubject.js or
// nflverseIdentityResolver.js, no new name/nickname/fuzzy matching, no AI.
// resolvePlayerIdentity() is still called exactly as before (it is safe to
// call regardless — Phase 2C's own players[] fallback is unaffected); this
// gate only decides what the ORCHESTRATOR reports as has_player_subject.
//
// ---------------------------------------------------------------------------
// ADDITIONAL PLAYERS[] SUPPORT CHECK — and its HONEST, DEMONSTRATED LIMIT.
// A further condition was investigated: require the confirmed visual_subject
// to also appear in story.players[] (compared via Phase 2B's own locked,
// exported `normalizeName()` — no new normalization logic). This IS added
// below, and it IS real: it correctly neutralizes the headline-only
// fallback path (determineVisualSubject's `players.length === 0` branch,
// which calls extractLikelyPlayerNames() on the HEADLINE directly, entirely
// independent of players[]).
//
// It does NOT close the dominant real-world gap, and this was verified
// against LIVE production data, not assumed: extractLikelyPlayerNames()
// (scripts/lib/extraction.js) has no player/coach type awareness at all —
// it is a pure capitalized-name-shape extractor, and a head coach's name in
// ordinary sentence-subject position ("Sean McVay expects...", "Kyle
// Shanahan said...") matches it exactly like a player's name would, with or
// without a stripped title word. Confirmed live in the current news.json:
// "Kyle Shanahan", "Sean McVay", and "Mike Vrabel" (all real NFL HEAD
// COACHES) currently appear inside players[] as its ONLY entry for at least
// one real story each, which means determineVisualSubject's
// `players.length > 0` branch draws visual_subject FROM players[] in the
// first place — checking "is visual_subject supported by players[]" is
// TAUTOLOGICAL in that branch (of course a value is a member of the exact
// list it was drawn from). No existing locked signal in this codebase can
// break that tie: identity resolution fails identically for a genuine
// unresolved rookie (real player, absent from the roster index) and for a
// coach (never in the player index at all) — both produce the same
// `no_name_match`. Building a coach/executive name denylist to close this
// gap would be inventing new data/heuristic logic this task explicitly
// forbids, so none was added.
//
// Practical severity is bounded, not open-ended: a misclassified coach can
// only ever receive the SAME mild ~0.855 unresolved-player dampening a
// genuine unresolved player already gets (`player_id` stays null — no real
// roster player shares a coach's name) — never a wrongly-boosted resolved
// star. Fully closing this gap would require either a locked-module change
// (e.g. reordering determineVisualSubject to check coach-titles before the
// player-candidate branch, or exporting a coach/executive marker) — out of
// scope here and would need separate authorization — or accepting this as
// a documented Stage 1 limitation. Neither was done unilaterally; this is
// reported, not hidden.
//
// FINAL POLICY DECISION (LOCKED — do not revisit within Stage 1). A
// follow-up investigation compared this against the alternative of
// requiring canonical nflverse identity to resolve before granting
// has_player_subject at all, and found that alternative worse, not better:
// canonical identity legitimately fails for real, currently-newsworthy NFL
// players constantly — every one of a sampled set of real active players
// (a retiring veteran, a practice-squad signing, a workout tryout, a
// re-signed veteran) had ZERO matches in the current-season nflverse index,
// because the index only reflects players already rostered as of the latest
// snapshot, while the STORY is specifically reporting the transaction that
// changes that. Requiring canonical resolution would silently neutralize
// most transaction/free-agency/retirement news — exactly the content this
// system exists to score — which is a broader, worse failure mode than the
// bounded, non-amplifying coach/executive dampening documented above. No
// existing deterministic signal (identity output, story.category, team
// context) was found that reliably separates the two cases. Stage 1
// therefore intentionally KEEPS granting has_player_subject to a
// confidently-established subject even when canonical identity is
// unresolved, accepting the rare, bounded, observe-only coach/executive
// side effect as the deliberate cost of correctly handling the far more
// common real-unresolved-player case.
// ---------------------------------------------------------------------------
import { determineVisualSubject } from "./visualSubject.js";
import { resolvePlayerIdentity } from "./nflverseIdentityResolver.js";
import { normalizePlayerPosition } from "./nflversePositionNormalizer.js";
import { resolvePlayerRole } from "./nflverseRoleResolver.js";
import { resolveFreshRoleEvidence } from "./nflverseFreshRoleResolver.js";
import { classifyQbImportance } from "./nflversePlayerImportance.js";
import { lookupPlayerStarStatus } from "./nflverseStarRegistry.js";
import { resolveNflverseAsOfEvidence } from "./nflverseAsOfResolver.js";
import { normalizeName } from "./nflversePlayerIndex.js";
import { NFL_STAR_REGISTRY } from "../data/nfl-star-registry.js";

function neutralPlayerContext() {
  return { has_player_subject: false, normalized_position: null, effective_role: null, qb_importance: null, player_id: null, identity_confidence: null, star_level: null, star_matched: false };
}

function neutralResult(as_of, reason_codes) {
  return {
    status: "neutral",
    as_of: as_of ?? null,
    subject: null,
    temporal: null,
    identity: null,
    position: null,
    baseline_role: null,
    fresh_role: null,
    effective_role: null,
    qb_importance: null,
    star: null,
    player_context: neutralPlayerContext(),
    diagnostics: { subject_match_count: null, candidate_count: null },
    reason_codes,
  };
}

/**
 * Recomputes the SAME subject candidate visualSubject.js's own production
 * caller (generate-content.js's applyVisualMedia) already derives from a
 * story's persisted headline/sources/players/teams/category — pure,
 * deterministic, no story mutation, no dependency on whether the story's
 * own persisted visual_subject/visual_subject_type/subject_match_count
 * fields exist (subject_match_count in particular is NOT currently
 * persisted on the story object; recomputing it here needs no production
 * file change at all).
 */
/**
 * True when `name` normalized-matches at least one entry of `players`,
 * using Phase 2B's own locked, exported normalizeName() — the same
 * normalization Phase 2B's own name index already uses (diacritics,
 * apostrophes, hyphens, Jr/Sr/II-IV suffixes, case). No new normalization
 * logic; no fuzzy/partial matching.
 */
function isSupportedByPlayersList(name, players) {
  if (!name) return false;
  const target = normalizeName(name);
  return players.some((p) => normalizeName(p) === target);
}

/**
 * The player-subject gate — see the module-level "PLAYER-SUBJECT GATE" and
 * "ADDITIONAL PLAYERS[] SUPPORT CHECK" comments. A pure function of
 * determineVisualSubject()'s own output plus story.players[]; independent
 * of whether identity resolution later succeeds. See those comments for
 * the demonstrated, honestly-reported limit of the players[] check: it is
 * real protection for the headline-only-fallback path, but tautological
 * (and therefore NOT sufficient by itself) whenever visual_subject was
 * itself drawn from players[] — which real production data confirms
 * includes real NFL head coaches whose names carry no type marker
 * extractLikelyPlayerNames() can distinguish from a player's.
 * @returns {{confirmed: boolean, reason: "player_subject_confirmed"|"player_subject_ambiguous"|"player_subject_not_player"|"player_subject_not_established"|"player_subject_not_supported_by_players", supportedByPlayersList: boolean|null}}
 */
function gatePlayerSubject(subjectInfo, players) {
  if (subjectInfo.visual_subject_type === "player") {
    if (subjectInfo.subject_match_count !== 1) return { confirmed: false, reason: "player_subject_ambiguous", supportedByPlayersList: null };
    const supported = isSupportedByPlayersList(subjectInfo.visual_subject, players);
    if (!supported) return { confirmed: false, reason: "player_subject_not_supported_by_players", supportedByPlayersList: false };
    return { confirmed: true, reason: "player_subject_confirmed", supportedByPlayersList: true };
  }
  if (subjectInfo.visual_subject_type === null) {
    return { confirmed: false, reason: "player_subject_not_established", supportedByPlayersList: null };
  }
  return { confirmed: false, reason: "player_subject_not_player", supportedByPlayersList: null }; // coach | executive | team | event
}

function recomputeSubject(story) {
  const sources = Array.isArray(story?.sources) ? story.sources : [];
  const combinedText = sources.map((s) => `${s?.headline ?? ""} ${s?.description ?? ""}`).join(" ");
  return determineVisualSubject({
    headline: story?.headline ?? "",
    combinedText,
    players: Array.isArray(story?.players) ? story.players : [],
    teams: Array.isArray(story?.teams) ? story.teams : [],
    category: story?.category ?? null,
  });
}

/**
 * Builds the observe-only enrichment context for one story. Pure
 * orchestration over already-locked Phase 2C-2I modules — see the module
 * header for the fail-open invariant and the as_of policy.
 *
 * Identity resolution uses `player_index` (Phase 2B, typically built from
 * the LATEST nflverse roster cache — see nflversePlayerIndex.js) because
 * identifying WHO a person is does not depend on historical data. Position
 * and role resolution, in contrast, use ONLY the as-of-eligible rows Phase
 * 2I selects (`temporal.roster.rows` / `temporal.depth_chart.rows`) —
 * NEVER `player_index` or any other current/latest source — so a player's
 * historical position/role/depth is never contaminated by their current
 * team or current depth-chart slot. This is the one deliberate exception to
 * "never duplicate a locked module's logic": choosing WHICH already-locked
 * module's output feeds which downstream call is this module's entire job.
 *
 * @param {{
 *   story: object,
 *   as_of?: string|null,
 *   roster_rows?: Array<object>,
 *   depth_chart_rows?: Array<object>,
 *   schedule_rows?: Array<object>|null,
 *   target_season?: number|string|null,
 *   target_week?: number|string|null,
 *   player_index?: {by_gsis_id: Map, by_espn_id: Map, by_normalized_name: Map}|null,
 *   star_records?: Array<object>,
 * }} input
 * @returns {object} a deterministic, JSON-serializable diagnostic — never throws.
 */
export function buildEditorialPlayerContext({
  story,
  as_of = null,
  roster_rows = [],
  depth_chart_rows = [],
  schedule_rows = null,
  target_season = null,
  target_week = null,
  player_index = null,
  star_records = NFL_STAR_REGISTRY,
} = {}) {
  try {
    if (!story || typeof story !== "object") {
      return neutralResult(null, ["story_missing"]);
    }

    const effectiveAsOf = as_of ?? story.first_published_at ?? null;
    if (!effectiveAsOf) {
      return neutralResult(null, ["story_as_of_missing"]);
    }

    const subjectInfo = recomputeSubject(story);

    // A read-only, story-SHAPED view for the identity resolver — never the
    // real story object, never mutated, and never written back onto story.
    const identityInput = {
      visual_subject: subjectInfo.visual_subject,
      visual_subject_type: subjectInfo.visual_subject_type,
      subject_match_count: subjectInfo.subject_match_count,
      players: Array.isArray(story.players) ? story.players : [],
      current_team: story.current_team ?? null,
      sources: Array.isArray(story.sources) ? story.sources : [],
    };

    // resolvePlayerIdentity is still called unconditionally — it is always
    // safe to call (Phase 2C's own selectSubject already refuses to treat a
    // non-"player"-typed visual_subject as its resolution subject) and its
    // diagnostics (candidate_count, reason_codes) are still worth reporting
    // even when the gate below ultimately neutralizes the result.
    const identity = resolvePlayerIdentity(identityInput, player_index);
    const gate = gatePlayerSubject(subjectInfo, identityInput.players);
    const hasPlayerSubject = gate.confirmed;

    const subjectDiagnostics = {
      visual_subject: subjectInfo.visual_subject,
      visual_subject_type: subjectInfo.visual_subject_type,
      subject_match_count: subjectInfo.subject_match_count,
      candidate_count: identity.candidate_count,
      player_list_support: gate.supportedByPlayersList,
      player_subject_established: hasPlayerSubject,
    };

    if (!hasPlayerSubject) {
      return {
        ...neutralResult(effectiveAsOf, [gate.reason, ...identity.reason_codes]),
        subject: subjectDiagnostics,
        identity,
      };
    }

    // ---- Temporal evidence (Phase 2I) — the ONLY source of roster/depth
    // rows used from here on. Never player_index, never "current" data.
    const temporal = resolveNflverseAsOfEvidence({
      as_of: effectiveAsOf,
      roster_rows,
      depth_chart_rows,
      schedule_rows,
      target_season,
      target_week,
    });

    const reasonCodes = [gate.reason, ...identity.reason_codes, ...temporal.reason_codes];

    // The identified player's row within the AS-OF-ELIGIBLE roster snapshot
    // ONLY — never a fallback to player_index or "latest" data. Not found
    // is a normal, expected outcome (e.g. no historical roster evidence
    // supplied at all) and degrades gracefully via normalizePlayerPosition/
    // resolvePlayerRole's own locked null-player handling.
    const historicalPlayerRow = identity.player_id ? (temporal.roster.rows.find((r) => r.gsis_id === identity.player_id) ?? null) : null;
    if (identity.player_id && !historicalPlayerRow) reasonCodes.push("player_not_in_temporal_roster");

    // Phase 2D/2E's depth_chart_rows contract expects ONLY the one already-
    // identified player's own row(s) from the snapshot (typically 1, at most
    // 2 — e.g. a WR who also returns punts) — never the full multi-thousand-
    // row league-wide snapshot Phase 2I's temporal selector returns. Passing
    // the whole snapshot would hand normalizePlayerPosition a pile of OTHER
    // players' pos_abb values, which it correctly reports as
    // "conflicting_position_evidence" (confirmed by real-story validation
    // during this stage — this filter is what fixes that finding).
    const playerDepthRows = identity.player_id ? temporal.depth_chart.rows.filter((r) => r.gsis_id === identity.player_id) : [];

    const position = normalizePlayerPosition({ player: historicalPlayerRow, depth_chart_rows: playerDepthRows });
    reasonCodes.push(...position.reason_codes);

    const baselineRole = resolvePlayerRole({
      normalized_position: position.normalized_position,
      position_confidence: position.confidence,
      player: historicalPlayerRow,
      depth_chart_rows: playerDepthRows,
      roster_as_of: temporal.roster.roster_as_of,
      depth_chart_as_of: temporal.depth_chart.depth_chart_as_of,
    });
    reasonCodes.push(...baselineRole.reason_codes);

    const otherPlayers = identityInput.players.filter((p) => p !== identity.normalized_subject);
    const freshRole = resolveFreshRoleEvidence({
      subject: identity.normalized_subject,
      baseline_role: baselineRole.role,
      normalized_position: position.normalized_position,
      depth_chart_as_of: temporal.depth_chart.depth_chart_as_of,
      sources: identityInput.sources,
      is_rumor: story.is_rumor === true,
      other_players: otherPlayers,
    });
    reasonCodes.push(...freshRole.reason_codes);

    // LOCKED Phase 2F contract, exactly — never recompute materiality or
    // fresh-role qualification here.
    const effectiveRole = freshRole.override_applies ? freshRole.fresh_role : baselineRole.role;

    const qb = classifyQbImportance({ normalized_position: position.normalized_position, resolved_role: effectiveRole });

    const star = lookupPlayerStarStatus({ gsis_id: identity.player_id, as_of: effectiveAsOf, records: star_records });
    reasonCodes.push(...star.reason_codes);

    const player_context = {
      has_player_subject: true,
      normalized_position: position.normalized_position,
      effective_role: effectiveRole,
      qb_importance: qb.qb_importance,
      player_id: identity.player_id,
      identity_confidence: identity.confidence,
      star_level: star.star_level,
      star_matched: star.matched,
    };

    const resolved = Boolean(identity.player_id) && position.normalized_position !== "unknown" && effectiveRole !== "unknown";
    const status = resolved ? "resolved" : "partial";

    return {
      status,
      as_of: effectiveAsOf,
      subject: subjectDiagnostics,
      temporal,
      identity,
      position,
      baseline_role: baselineRole,
      fresh_role: freshRole,
      effective_role: effectiveRole,
      qb_importance: qb,
      star,
      player_context,
      diagnostics: {
        subject_match_count: subjectInfo.subject_match_count,
        candidate_count: identity.candidate_count,
        historical_player_row_found: Boolean(historicalPlayerRow),
        temporal_roster_found: temporal.diagnostics.roster_found,
        temporal_depth_chart_found: temporal.diagnostics.depth_chart_found,
        temporal_schedule_found: temporal.diagnostics.schedule_found,
      },
      reason_codes: [...new Set(reasonCodes)],
    };
  } catch (err) {
    // FAIL OPEN — an exception anywhere in the chain above must never reach
    // the caller. Legacy scoring must always remain safely callable.
    return { ...neutralResult(null, ["enrichment_exception"]), diagnostics: { subject_match_count: null, candidate_count: null, error_message: err instanceof Error ? err.message : String(err) } };
  }
}
