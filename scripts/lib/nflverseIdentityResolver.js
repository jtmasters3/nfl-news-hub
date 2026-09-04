// Editorial Scoring Brain — Phase 2C: deterministic player identity
// resolver. Answers "which actual NFL player does this story refer to?" —
// IDENTITY ONLY. No position weights, no role, no star boost, no scoring
// multipliers, no destination. Pure function, no network calls, no hidden
// "fetch current data" — the caller supplies the player index (from Phase
// 2B), which is what lets a future historical resolver (Phase 2I) pass an
// as-of index instead, with zero change to this module.
//
// Reuses, rather than reimplements: the Phase 2B normalized name index
// (no second normalization/nickname system), and visualSubject.js's
// existing, production-tested findTransactionTeam() for the fresh-
// transaction override (no new NLP) — but see findSubjectBoundTransactionTeam
// below: findTransactionTeam() itself has NO player-name awareness (it
// captures only a destination team from raw text), so this module adds the
// smallest possible deterministic binding rule on top, rather than trusting
// it blindly. See that function's own doc comment.
import { lookupByName } from "./nflversePlayerIndex.js";
import { findTransactionTeam } from "./visualSubject.js";
import { teamName as repoTeamName } from "./teams.js";

// ---------------------------------------------------------------------------
// Team canonicalization adapter — confirmed against REAL fetched nflverse
// data (roster_2026.csv), not assumed. Every current-season nflverse team
// abbreviation matches this repo's teams.js exactly (WAS, JAX, LV, LAC,
// NYJ, NYG all identical) EXCEPT the Rams: nflverse uses "LA", this repo's
// canonical abbreviation is "LAR". This is the one adapter entry actually
// required. Historical relocated-franchise codes (OAK, SD, STL) are out of
// scope here — current-season data only; Phase 2I can extend this if
// historical resolution ever needs it.
// ---------------------------------------------------------------------------
const NFLVERSE_TEAM_ABBR_ADAPTER = { LA: "LAR" };

/** nflverse team abbreviation -> this repo's canonical full team name, or null if unrecognized. */
export function canonicalTeamName(nflverseAbbr) {
  if (!nflverseAbbr) return null;
  const abbr = NFLVERSE_TEAM_ABBR_ADAPTER[nflverseAbbr] ?? nflverseAbbr;
  const name = repoTeamName(abbr);
  return name === abbr ? null : name; // repoTeamName() falls back to echoing the abbr itself when unrecognized
}

// ---------------------------------------------------------------------------
// Confidence tiers
// ---------------------------------------------------------------------------
const CONFIDENCE = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });
const DOWNGRADE = { high: "medium", medium: "low", low: "low" };

// ---------------------------------------------------------------------------
// Subject selection — visual_subject is the primary input, but only ever
// "confident" when it came from determineVisualSubject()'s single-headline-
// candidate branch (subject_match_count === 1), never its weaker
// multi-candidate "earliest in headline" fallback. players[] is used
// conservatively only when no visual_subject exists at all, and NEVER by
// picking players[0] — a multi-candidate players[] with no visual_subject
// stays unresolved rather than guessing a "main player" from list order.
// ---------------------------------------------------------------------------
function selectSubject(story) {
  const players = Array.isArray(story.players) ? story.players : [];

  if (story.visual_subject && story.visual_subject_type === "player") {
    return {
      subject: story.visual_subject,
      source: "visual_subject",
      confident: story.subject_match_count === 1,
      reason: story.subject_match_count === 1 ? null : "visual_subject_weak_fallback",
    };
  }

  if (players.length === 1) {
    return { subject: players[0], source: "players_only", confident: false, reason: null };
  }
  if (players.length > 1) {
    return { subject: null, source: "players_multiple", confident: false, reason: "players_multiple_unresolved" };
  }
  return { subject: null, source: "none", confident: false, reason: "visual_subject_missing" };
}

// ---------------------------------------------------------------------------
// players[] cross-validation — positive evidence when it agrees, a
// diagnosed conflict (never a silent override) when it names someone else
// entirely, and explicitly non-negative when simply empty.
// ---------------------------------------------------------------------------
function crossValidatePlayers(story, subjectSource, resolvedSubjectName) {
  const players = Array.isArray(story.players) ? story.players : [];
  if (subjectSource !== "visual_subject") return { status: "not_applicable", conflict: false };
  if (players.length === 0) return { status: "empty", conflict: false };
  const matches = players.some((p) => p === resolvedSubjectName);
  if (matches) return { status: "cross_validated", conflict: false };
  return { status: "conflict", conflict: true, conflicting_names: players };
}

// ---------------------------------------------------------------------------
// Subject-bound fresh transaction override.
//
// findTransactionTeam() (visualSubject.js, reused unmodified) captures ONLY
// a destination team from raw text — it has no player-name awareness at
// all. Confirmed by direct inspection of its patterns (TEAM_JOIN_PATTERNS,
// TEAM_FIRST_PATTERN): every one of them captures a team name, none of them
// captures or checks a player name. Calling it on a whole source's
// concatenated headline+description would happily return a team pulled
// from a sentence about a COMPLETELY DIFFERENT player mentioned elsewhere
// in the same text ("Player A discusses the season. Player B was traded to
// Team C.") and treat it as if it explained Player A's stale cached team.
//
// The fix is the smallest deterministic binding rule that closes this
// without any fuzzy matching, NLP, or AI: split each source's headline and
// description into sentence-like units, and only accept a transaction-team
// match from a unit that ALSO literally contains the resolved subject's
// exact name. A transaction sentence about someone else, anywhere else in
// the story, is never consulted.
// ---------------------------------------------------------------------------

/** A deliberately simple, bounded sentence split — not NLP, just enough to separate one player's sentence from another's within the same text field. */
function splitIntoSentenceUnits(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findSubjectBoundTransactionTeam(story, subjectName) {
  if (!subjectName) return null;
  const sources = Array.isArray(story.sources) ? story.sources : [];
  const bySource = [...sources].sort((a, b) => {
    const at = Date.parse(a.published_at ?? a.discovered_at ?? 0) || 0;
    const bt = Date.parse(b.published_at ?? b.discovered_at ?? 0) || 0;
    return bt - at; // newest first, matching detectCurrentTeam()'s own iteration order
  });
  for (const source of bySource) {
    // headline and description are checked as separate fields (never
    // concatenated) — a transaction match spanning from the tail of one
    // into the head of the other, with the subject's name only in ONE of
    // them, must not count as a bound match.
    const units = [...splitIntoSentenceUnits(source.headline ?? ""), ...splitIntoSentenceUnits(source.description ?? "")];
    for (const unit of units) {
      if (!unit.includes(subjectName)) continue; // the resolved subject must be literally named in THIS unit
      const team = findTransactionTeam(unit);
      if (team) return team;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * @param {object} story - { visual_subject, visual_subject_type, subject_match_count, players, current_team, sources }
 * @param {{by_gsis_id: Map, by_espn_id: Map, by_normalized_name: Map} | null | undefined} playerIndex - Phase 2B output
 * @returns {object} deterministic, JSON-serializable, non-scoring identity result
 */
export function resolvePlayerIdentity(story, playerIndex) {
  const reason_codes = [];
  const matched_by = [];

  const { subject, source: subjectSource, confident: subjectConfident, reason: subjectReason } = selectSubject(story);
  if (subjectReason) reason_codes.push(subjectReason);
  if (subjectSource === "visual_subject") matched_by.push("visual_subject");
  if (subjectSource === "players_only") matched_by.push("players");

  const normalized_subject = subject ?? null;

  const base = {
    player_id: null,
    espn_id: null,
    display_name: null,
    normalized_subject,
    candidate_count: 0,
    matched_by,
    team_context: { story_team: story.current_team ?? null, roster_team: null, agreement: null, transaction_override: false },
    candidates: [],
    reason_codes,
  };

  if (!subject) {
    return { ...base, confidence: CONFIDENCE.LOW };
  }

  if (!playerIndex || !playerIndex.by_normalized_name) {
    reason_codes.push("player_index_unavailable");
    return { ...base, confidence: CONFIDENCE.LOW };
  }

  const candidates = lookupByName(playerIndex, subject);
  base.candidate_count = candidates.length;
  // Sorted by gsis_id (a stable key) rather than left in index-insertion
  // order — the resolution ITSELF was already order-independent, but the
  // raw diagnostic list otherwise wasn't, which would make two functionally
  // identical resolutions produce differently-ordered debug output
  // depending only on how the underlying index happened to be built.
  base.candidates = candidates
    .map((c) => ({ gsis_id: c.gsis_id, espn_id: c.espn_id, full_name: c.full_name, football_name: c.football_name, team: c.team, position: c.position, status: c.status_bucket ?? c.raw_status ?? null }))
    .sort((a, b) => (a.gsis_id ?? "").localeCompare(b.gsis_id ?? ""));

  // players[] cross-validation (informational; never rescues ambiguity)
  const crossVal = crossValidatePlayers(story, subjectSource, subject);
  if (crossVal.status === "cross_validated") {
    reason_codes.push("players_cross_validated");
    matched_by.push("players");
  } else if (crossVal.status === "empty") {
    reason_codes.push("players_empty");
  } else if (crossVal.status === "conflict") {
    reason_codes.push("players_conflict");
  }

  // ---- Case: no candidates -------------------------------------------
  if (candidates.length === 0) {
    reason_codes.push("no_name_match");
    return { ...base, confidence: CONFIDENCE.LOW };
  }

  const storyTeam = story.current_team ?? null;

  // ---- Case: duplicate normalized name --------------------------------
  if (candidates.length > 1) {
    reason_codes.push("duplicate_name");

    if (!storyTeam) {
      // No story team at all -> cannot disambiguate. players[] agreement
      // (already checked above) must NEVER rescue this — it isn't
      // team-aware and can't tell the candidates apart either.
      return applyConflictDowngrade({ ...base, confidence: CONFIDENCE.LOW }, crossVal);
    }

    const teamMatches = candidates.filter((c) => canonicalTeamName(c.team) === storyTeam);
    if (teamMatches.length !== 1) {
      // Zero matches (team conflicts with every candidate) or more than
      // one (can't happen with real data, but handled safely) -> still
      // unresolved. Transaction-direction language is deliberately NEVER
      // consulted here — even subject-bound, it explains a stale TEAM
      // mismatch for an already-identified SINGLE candidate; it does not,
      // and must never, resolve NAME ambiguity between two different real
      // people who happen to share a name.
      return applyConflictDowngrade({ ...base, confidence: CONFIDENCE.LOW }, crossVal);
    }

    reason_codes.push("duplicate_name_disambiguated_by_team");
    matched_by.push("team");
    const winner = teamMatches[0];
    return applyConflictDowngrade(
      buildResolvedResult(
        { ...base, team_context: { story_team: storyTeam, roster_team: storyTeam, agreement: true, transaction_override: false } },
        winner,
        reason_codes,
        subjectSource === "visual_subject" && subjectConfident ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM
      ),
      crossVal
    );
  }

  // ---- Case: exactly one candidate -------------------------------------
  const candidate = candidates[0];
  const rosterTeam = canonicalTeamName(candidate.team);
  let agreement = null;
  let transactionOverride = false;

  if (storyTeam && rosterTeam) {
    agreement = storyTeam === rosterTeam;
  }

  if (agreement === true) {
    reason_codes.push("unique_name_team_match");
    matched_by.push("team");
  } else if (agreement === null) {
    reason_codes.push("unique_name_team_unknown");
  } else {
    // agreement === false: a real mismatch. The ONLY thing that can excuse
    // it is a qualifying, SUBJECT-BOUND fresh transaction-direction signal
    // (see findSubjectBoundTransactionTeam) that points at the SAME team
    // the story already claims as current.
    const transactionTeam = findSubjectBoundTransactionTeam(story, subject);
    if (transactionTeam && transactionTeam === storyTeam) {
      transactionOverride = true;
      reason_codes.push("transaction_team_override");
      matched_by.push("fresh_transaction");
    } else {
      reason_codes.push("team_mismatch");
    }
  }

  const teamOk = agreement === true || transactionOverride;
  let confidence;
  if (subjectSource === "visual_subject" && subjectConfident && teamOk) {
    confidence = CONFIDENCE.HIGH;
  } else if (agreement === false && !transactionOverride) {
    confidence = CONFIDENCE.LOW; // unexplained team conflict
  } else {
    confidence = CONFIDENCE.MEDIUM;
  }

  const result = buildResolvedResult(
    { ...base, team_context: { story_team: storyTeam, roster_team: rosterTeam, agreement, transaction_override: transactionOverride } },
    candidate,
    reason_codes,
    confidence
  );
  return applyConflictDowngrade(result, crossVal);
}

/**
 * Applies the canonical-identity gate (missing gsis_id -> LOW, player_id
 * null, no exceptions) and assembles the resolved-identity fields. This is
 * a HARD invariant, checked last, after every other confidence signal —
 * team agreement, transaction override, subject strength — has already
 * been computed. A candidate without gsis_id can never be reported as HIGH
 * or MEDIUM, regardless of how strong every other signal was.
 */
function buildResolvedResult(base, candidate, reason_codes, computedConfidence) {
  const hasGsisId = Boolean(candidate.gsis_id);
  const confidence = hasGsisId ? computedConfidence : CONFIDENCE.LOW;
  if (!hasGsisId) reason_codes.push("canonical_gsis_missing");
  return {
    ...base,
    confidence,
    player_id: hasGsisId ? candidate.gsis_id : null, // never silently substitute espn_id for a missing gsis_id
    espn_id: candidate.espn_id ?? null,
    display_name: candidate.full_name ?? null,
  };
}

/** A players[] conflict downgrades confidence by exactly one tier — never rescues, only ever lowers. */
function applyConflictDowngrade(result, crossVal) {
  if (!crossVal.conflict) return result;
  return { ...result, confidence: DOWNGRADE[result.confidence] };
}
