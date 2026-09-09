// NFL-Only Ingestion Cleanup — Stage 2: pure NFL relevance classifier.
// Deterministic, local, free, fast, reproducible. No network, no AI, no
// Date.now, no state mutation. NOT wired into production — this module has
// zero importers outside its own regression suite as of this pass; wiring
// it into scripts/generate-content.js is a separate, not-yet-authorized
// step (see the module's own file header discussion in the design report).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — a read-only audit (this same task) found 21/300 (7.0%)
// of currently retained stories are genuinely non-NFL (college-football
// eligibility/legal disputes, conference governance, a marching-band
// tragedy) despite arriving through NFL-oriented sources. Several tempting
// "easy" signals were measured directly against real data and found NOT
// reliable, so none of them are trusted alone here:
//   - URL PATH: every Pro Football Talk article — contaminant or not —
//     shares the identical /nfl/profootballtalk/ path (confirmed against
//     the live feed, no exception). Path structure cannot separate them.
//   - EMBEDDED VIDEO METADATA: PFT's RSS items carry a `"league":"NFL"` /
//     `"NCAA"` tag inside their embedded video-player JSON, which looked
//     promising but is a shared/stale "featured video" tag, not an
//     article-specific one — confirmed by a live example: the genuinely-NFL
//     "Colts sign OT Luke Tenuta off of their practice squad" transaction
//     story carried `"league":"NCAA"` because an unrelated video happened to
//     be attached to it. Using it would silently reject real NFL news.
//   - classifyCategory() (locked, extraction.js): its categories are
//     GENERIC sports/event classifiers, not NFL-specific — proven unsafe as
//     standalone evidence by two synthetic tests built for this module: a
//     pure NBA story mentioning the league stripping "future draft picks"
//     classified as category "draft", and a pure college-rankings story
//     saying rankings were "released" classified as category "free_agency"
//     (its own pattern list includes the bare word "released"). Both are
//     ordinary English words any sport can use. classifyCategory()'s output
//     is still recorded in this module's output for diagnostics, but it is
//     NEVER, by itself, treated as evidence a story is about the NFL.
//
// The only signals proven reliable are: detectTeams() (teams.js, unmodified
// — a real NFL team name/nickname/city is essentially unambiguous), and a
// small, explicit set of phrases that literally contain the token "NFL"
// itself (so they cannot be triggered by another sport's identical generic
// transaction language) — plus a small, explicit, structural vocabulary
// (not a denylist of every college/pro team or athlete in existence) for
// the college/other-sport REJECT side.
//
// ---------------------------------------------------------------------------
// HARD INVARIANT: FAIL OPEN, and STRONG NFL EVIDENCE ALWAYS WINS. A real
// audit example proves why the second half matters just as much as the
// first: "2027 NFL Mock Draft: Arch Manning Or Dante Moore At No. 1
// Overall?" is unambiguous NFL content (it is about the NFL Draft) that is
// ALSO full of college-football language (a college QB's name). A naive
// keyword-rejection pass — built and run once, read-only, during the
// earlier audit — misclassified this exact story as college football. That
// live false positive is the concrete reason this classifier's precedence
// puts team-detection and literal-"NFL"-phrase evidence FIRST: if either
// exists, KEEP unconditionally, regardless of how much college/other-sport
// vocabulary is also present.
//
// PRECEDENCE (exact order, see classifyNflRelevance's body):
//   1. detectTeams() finds a real NFL team           -> KEEP (strong)
//   2. a literal "NFL ..." structural phrase matches -> KEEP (strong)
//   3. an explicit other-sport league token matches  -> REJECT (other_sport)
//   4. an explicit college/conference marker matches -> REJECT (college_football)
//   5. a generic, sport-agnostic transaction phrase   -> KEEP (weak, uncontradicted —
//      matches (undrafted rookie, practice squad,        only reached if steps 3-4
//      drafted by, signs with, ...) with nothing           found nothing to contradict it)
//      contradicting it
//   6. nothing matched at all                        -> KEEP (ambiguous, fail open)
//
// Steps 3-4 deliberately sit ABOVE step 5: a generic transaction verb
// ("drafted", "signed", "released") is NOT NFL-specific — any sport uses
// the same words — so an explicit other-sport/college marker is allowed to
// override it. Only detectTeams() and a literal "NFL" phrase are strong
// enough to override an explicit non-NFL marker.
// ---------------------------------------------------------------------------
import { detectTeams } from "./teams.js";
import { classifyCategory } from "./extraction.js";

// Explicit, literal-"NFL" structural phrases — a small, closed vocabulary.
// Every pattern here contains the literal token "NFL" (or "NFLPA"), which is
// what makes it safe to trust unconditionally: no other sport can trigger
// these by coincidence the way it can trigger a bare "drafted"/"signed".
const EXPLICIT_NFL_PHRASE_PATTERNS = [
  { code: "phrase_nfl_draft", pattern: /\bNFL\s+(?:mock\s+)?draft\b/i },
  { code: "phrase_nfl_combine", pattern: /\bNFL\s+Combine\b/i },
  { code: "phrase_nfl_commissioner", pattern: /\bNFL\s+Commissioner\b/i },
  { code: "phrase_nfl_owner", pattern: /\bNFL\s+owners?\b/i },
  { code: "phrase_nflpa", pattern: /\bNFLPA\b/ },
];

// Generic, sport-agnostic transaction phrases — real language any league
// uses. WEAK evidence: only sufficient to KEEP when nothing more specific
// (team, explicit "NFL" phrase) exists AND no explicit non-NFL marker
// contradicts it (see precedence in the module header).
const GENERIC_TRANSACTION_PATTERNS = [
  { code: "phrase_drafted_by", pattern: /\bdrafted\s+by\b/i },
  { code: "phrase_selected_by", pattern: /\bselected\s+by\b/i },
  { code: "phrase_signs_with", pattern: /\bsigns?\s+with\b/i },
  { code: "phrase_signed_by", pattern: /\bsigned\s+by\b/i },
  { code: "phrase_practice_squad", pattern: /\bpractice\s+squad\b/i },
  { code: "phrase_udfa", pattern: /\bundrafted\s+(?:free\s+agent|rookie)\b|\bUDFA\b/i },
  { code: "phrase_waived_by", pattern: /\bwaived\s+by\b/i },
  { code: "phrase_claimed_by", pattern: /\bclaimed\s+by\b/i },
  { code: "phrase_released_by", pattern: /\breleased\s+by\b/i },
];

// classifyCategory() (locked, extraction.js) — recorded for diagnostics
// only. NEVER treated as evidence on its own; see module header for why.
const NFL_PRESERVING_CATEGORIES_FOR_DIAGNOSTICS_ONLY = new Set(["draft", "free_agency", "roster_move", "contract"]);

// Small, explicit, structural vocabulary — deliberately NOT a list of every
// college program/conference/athlete. Confirmed sufficient against the real
// contamination sample found during the audit without needing a larger list.
const COLLEGE_MARKERS = [
  { code: "college_ncaa", pattern: /\bNCAA\b/ },
  { code: "college_football_phrase", pattern: /\bcollege\s+football\b/i },
  { code: "college_transfer_portal", pattern: /\btransfer\s+portal\b/i },
  { code: "college_recruiting", pattern: /\b(?:college\s+)?recruiting\s+class\b/i },
];
const COLLEGE_CONFERENCE_MARKERS = [
  { code: "conference_sec", pattern: /\bSEC\b/ },
  { code: "conference_big_ten", pattern: /\bBig\s+Ten\b/i },
  { code: "conference_big_12", pattern: /\bBig\s+12\b/i },
  { code: "conference_acc", pattern: /\bACC\b/ },
  { code: "conference_aac", pattern: /\bAAC\b/ },
  { code: "conference_mac", pattern: /\bMid-American Conference\b/i },
  { code: "conference_mountain_west", pattern: /\bMountain West\b/i },
  { code: "conference_sun_belt", pattern: /\bSun Belt\b/i },
];
const OTHER_SPORT_LEAGUE_MARKERS = [
  { code: "league_nba", pattern: /\bNBA\b/ },
  { code: "league_mlb", pattern: /\bMLB\b/ },
  { code: "league_nhl", pattern: /\bNHL\b/ },
  { code: "league_wnba", pattern: /\bWNBA\b/ },
];

function matchAll(text, patternList) {
  const hits = [];
  for (const { code, pattern } of patternList) {
    if (pattern.test(text)) hits.push(code);
  }
  return hits;
}

function result({ decision, classification, confidence, nfl_evidence, non_nfl_evidence, detected_teams, detected_category, reason_codes }) {
  return { decision, classification, confidence, nfl_evidence, non_nfl_evidence, detected_teams, detected_category, reason_codes };
}

/**
 * Classifies whether a raw discovered article (BEFORE story construction)
 * is NFL-relevant enough to keep. Pure, deterministic, fail-open. See the
 * module header for the exact precedence rule and why it exists.
 *
 * @param {{sourceId?: string|null, sourceName?: string|null, sourceUrl?: string|null, headline?: string|null, excerpt?: string|null}} input
 * @returns {{
 *   decision: "keep"|"reject",
 *   classification: "nfl"|"nfl_with_college_context"|"college_football"|"other_sport"|"non_sport"|"ambiguous",
 *   confidence: "high"|"medium"|"low",
 *   nfl_evidence: string[],
 *   non_nfl_evidence: string[],
 *   detected_teams: string[],
 *   detected_category: string|null,
 *   reason_codes: string[],
 * }}
 */
export function classifyNflRelevance({ sourceId = null, sourceName = null, sourceUrl = null, headline = null, excerpt = null } = {}) {
  const headlineText = typeof headline === "string" ? headline : "";
  const excerptText = typeof excerpt === "string" ? excerpt : "";
  const text = `${headlineText} ${excerptText}`.trim();

  if (!headlineText.trim() && !excerptText.trim()) {
    return result({
      decision: "keep",
      classification: "ambiguous",
      confidence: "low",
      nfl_evidence: [],
      non_nfl_evidence: [],
      detected_teams: [],
      detected_category: null,
      reason_codes: ["missing_text_fail_open"],
    });
  }

  const detected_teams = detectTeams(text);
  const detected_category = classifyCategory(text);

  const explicitNflPhraseHits = matchAll(text, EXPLICIT_NFL_PHRASE_PATTERNS);
  const genericTransactionHits = matchAll(text, GENERIC_TRANSACTION_PATTERNS);
  const collegeHits = [...matchAll(text, COLLEGE_MARKERS), ...matchAll(text, COLLEGE_CONFERENCE_MARKERS)];
  const otherSportHits = matchAll(text, OTHER_SPORT_LEAGUE_MARKERS);

  const hasTeam = detected_teams.length > 0;
  const hasExplicitNflPhrase = explicitNflPhraseHits.length > 0;
  const hasCollegeMarker = collegeHits.length > 0;
  const hasOtherSportMarker = otherSportHits.length > 0;
  const hasGenericTransactionEvidence = genericTransactionHits.length > 0;

  // nfl_evidence always includes the diagnostic-only category tag when
  // present, so it remains fully auditable — it just never drives a
  // decision on its own (see module header).
  const categoryTag = NFL_PRESERVING_CATEGORIES_FOR_DIAGNOSTICS_ONLY.has(detected_category) ? [`nfl_preserving_category:${detected_category}`] : [];
  const nfl_evidence = [...(hasTeam ? ["nfl_team_detected"] : []), ...explicitNflPhraseHits, ...genericTransactionHits, ...categoryTag];
  const non_nfl_evidence = [...collegeHits, ...otherSportHits];

  // Step 1-2: strong NFL evidence always wins, regardless of college/other-
  // sport vocabulary also present. This is what protects the real "2027 NFL
  // Mock Draft: Arch Manning..." case.
  if (hasTeam || hasExplicitNflPhrase) {
    return result({
      decision: "keep",
      classification: hasCollegeMarker || hasOtherSportMarker ? "nfl_with_college_context" : "nfl",
      confidence: "high",
      nfl_evidence,
      non_nfl_evidence,
      detected_teams,
      detected_category,
      reason_codes: ["kept_strong_nfl_evidence"],
    });
  }

  // Step 3: an explicit other-sport league token, with no team/explicit-NFL
  // phrase to contradict it, is trusted to reject.
  if (hasOtherSportMarker) {
    return result({
      decision: "reject",
      classification: "other_sport",
      confidence: "high",
      nfl_evidence,
      non_nfl_evidence,
      detected_teams,
      detected_category,
      reason_codes: ["other_sport_marker_no_nfl_evidence"],
    });
  }

  // Step 4: same for an explicit college/conference marker.
  if (hasCollegeMarker) {
    return result({
      decision: "reject",
      classification: "college_football",
      confidence: "medium",
      nfl_evidence,
      non_nfl_evidence,
      detected_teams,
      detected_category,
      reason_codes: ["college_marker_no_nfl_evidence"],
    });
  }

  // Step 5: no team, no explicit "NFL" phrase, no non-NFL marker of any
  // kind — a generic transaction phrase is weak but wholly uncontradicted,
  // so it is enough to keep (still auditable via nfl_evidence/reason_codes).
  if (hasGenericTransactionEvidence) {
    return result({
      decision: "keep",
      classification: "nfl",
      confidence: "medium",
      nfl_evidence,
      non_nfl_evidence,
      detected_teams,
      detected_category,
      reason_codes: ["kept_weak_uncontradicted_transaction_evidence"],
    });
  }

  // Step 6: no signal in any direction at all — fail open.
  return result({
    decision: "keep",
    classification: "ambiguous",
    confidence: "low",
    nfl_evidence,
    non_nfl_evidence,
    detected_teams,
    detected_category,
    reason_codes: ["no_signal_fail_open"],
  });
}
