// Editorial Scoring Brain — Phase 2F: fresh-role evidence. Answers ONLY:
// "does newer, explicit, source-supported reporting establish a player's
// football role more recently than the supplied nflverse depth-chart
// snapshot?" Phase 2C answers WHO, Phase 2D answers WHAT POSITION, Phase 2E
// answers WHAT STRUCTURED ROLE the depth chart supports; this module never
// redoes any of that — it only decides whether fresh article text should
// SUPERSEDE Phase 2E's structured role. Pure, offline, no network, no file
// reads, no story mutation.
//
// This is a narrow deterministic parser for EXPLICIT role statements, not a
// general NLP classifier. False negatives (missing a real but non-explicit
// role change) are acceptable; false positives are not — every gate below
// (hedge/negation rejection, literal subject-name binding, strict timestamp
// freshness, non-rumor, source-tier corroboration) exists to keep it that
// way, mirroring the same conservative philosophy the hardened Phase 2C
// transaction-team binding already established.
//
// Real input shape (confirmed by reading scripts/generate-content.js's
// toSourceEntry() and a live news.json story): each source object is
// { name, headline, description, url, published_at, discovered_at, ... }.
// is_rumor lives at the STORY level today (computed once from all sources'
// combined text), not per source — this module accepts an optional
// per-source `is_rumor` too (for forward compatibility with a richer future
// shape) but real current data will only ever populate the story-level flag.
import { sourceTier } from "./editorialSourceConfidence.js";
import { normalizePlayerPosition } from "./nflversePositionNormalizer.js";
import { resolvePlayerRole } from "./nflverseRoleResolver.js";

// ---------------------------------------------------------------------------
// Deterministic sentence/clause splitting for subject binding. Mirrors the
// hardened Phase 2C `findSubjectBoundTransactionTeam` technique (split, then
// require literal subject-name presence in the SAME unit as the evidence)
// but additionally splits on ";" — a real story in this repo's own news.json
// ("Colts' Keenan Allen stays mum on arrest; Anthony Richardson wins backup
// quarterback job") joins two independent clauses about two different
// players with a semicolon, not a period. Splitting only on [.!?] would
// leave both clauses in one unit and let "wins backup quarterback job"
// falsely bind to Keenan Allen (the resolved subject of that story) merely
// because his name appears earlier in the same un-split unit. This is a
// deliberate, documented refinement over Phase 2C's exact regex — same
// philosophy (smallest deterministic subject-binding rule), a broader
// delimiter set justified by real, observed data.
// ---------------------------------------------------------------------------
function splitIntoUnits(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Hedge/negation guards — checked BEFORE any positive phrase recognition.
// A unit matching any of these can never produce fresh-role evidence,
// regardless of what positive-looking substring it also contains.
// ---------------------------------------------------------------------------
const HEDGE_PATTERNS = [
  /\bnot\s+(?:be\s+)?named\b/i,
  /\bwill\s+not\s+start\b/i,
  /\bwon'?t\s+start\b/i,
  /\bnot\s+expected\s+to\s+start\b/i,
  /\bcould\s+start\b/i,
  /\bmay\s+start\b/i,
  /\bmight\s+start\b/i,
  /\bcould\s+be\s+the\s+starter\b/i,
  /\bmay\s+be\s+the\s+starter\b/i,
  /\bpossible\s+starter\b/i,
  /\bcandidate\s+to\s+start\b/i,
  /\bcompeting\s+to\s+start\b/i,
  /\bcompetition\s+for\s+starter\b/i,
  /\bchance\s+to\s+start\b/i,
  /\bexpected\s+to\s+(?:be\s+)?name/i, // "expected to be named the starter" / "expected to name X the starter"
  /\breportedly\b/i,
  /\bsources?\s+believe\b/i,
];

// ---------------------------------------------------------------------------
// Positive explicit phrases. Deliberately narrow — see the module doc
// comment. Only these phrases (plus the locked positioned rank-label
// grammar below) can ever produce fresh-role evidence.
// ---------------------------------------------------------------------------
const STARTER_PATTERNS = [
  /\bnamed\s+the\s+starting\s+\w+/i,
  /\bnamed\s+the\s+starter\b/i,
  /\bwill\s+start\b/i,
  /\bwill\s+be\s+the\s+starter\b/i,
  /\bset\s+to\s+start\b/i,
  /\bpromoted\s+to\s+the\s+starting\s+lineup\b/i,
  /\bpromoted\s+to\s+starter\b/i,
];

const BACKUP_PATTERNS = [/\bnamed\s+the\s+backup\b/i, /\bwill\s+serve\s+as\s+the\s+backup\b/i, /\bwill\s+be\s+the\s+backup\b/i, /\bdemoted\s+to\s+backup\b/i];

// Broadened from the locked examples' exact tense/determiner ("signed to
// the practice squad") after real news.json headlines showed present-tense
// headline style ("Packers sign QB Kedon Slovis to the practice squad")
// and team-possessive determiners ("joins Chargers' practice squad",
// "returns to Titans practice squad") — same explicit meaning, different
// grammatical shape. SIGN/ADD still require an explicit "to <the/their/
// team's>" destination (those verbs are common in unrelated football
// prose, e.g. "sign a contract extension", so the destination phrase is
// kept as a guard); JOIN/RETURN are unambiguous enough on their own to use
// a bounded proximity window instead.
const PRACTICE_SQUAD_PATTERNS = [
  /\b(?:sign|signs|signed)\b.{0,60}?\bto\s+(?:the|their|\S+['’]s)\s+practice\s+squad\b/i,
  /\b(?:add|adds|added)\b.{0,60}?\bto\s+(?:the|their|\S+['’]s)\s+practice\s+squad\b/i,
  /\bjoins?\b.{0,40}?\bpractice\s+squad\b/i,
  /\breturns?\b.{0,40}?\bpractice\s+squad\b/i,
];

// Explicit destination rank labels (QB2, WR3, ...), only when tied to an
// explicit assignment verb — never a bare "QB2" floating in prose (that
// would risk matching a jersey number or an unrelated numeral).
const RANK_LABEL_PATTERN = /\b(?:named|promoted\s+to|demoted\s+to)\s+(QB|RB|WR|TE|LT|RT|LG|RG|C|EDGE|DE|DT|LB|CB|FS|SS|K|P|LS)([1-9])\b/i;

// ---------------------------------------------------------------------------
// Rank-label -> role, reusing the LOCKED, exported Phase 2D/2E pure
// functions rather than a second role/position table. Each entry names a
// real nflverse pos_abb that Phase 2D's own DIRECT_MAP already resolves,
// used purely as a mechanical vehicle to invoke the locked rank table for
// the correct Aggregate bucket — never a claim about the player's real
// depth-chart alignment. "DE" is structurally ambiguous on its own (could
// be edge or interior) exactly as Phase 2D itself already treats bare "DE"
// (its own locked default), so DE-prefixed labels are mapped through the
// same EDGE vehicle as EDGE-prefixed labels — reusing Phase 2D's own
// already-approved interpretation of this exact ambiguity, not inventing a
// new one.
// ---------------------------------------------------------------------------
const LABEL_VEHICLE_POS_ABB = Object.freeze({
  QB: "QB", RB: "RB", WR: "WR", TE: "TE",
  LT: "LT", RT: "RT", LG: "LG", RG: "RG", C: "C",
  EDGE: "LDE", DE: "LDE",
  DT: "DT", LB: "LB", CB: "CB", FS: "FS", SS: "SS",
  K: "K", P: "P", LS: "LS",
});

function roleFromRankLabel(prefix, rank) {
  const vehicleAbb = LABEL_VEHICLE_POS_ABB[prefix];
  if (!vehicleAbb) return null; // unsupported/ambiguous label prefix — never guess a mapping Phase 2D itself doesn't already support
  const posResult = normalizePlayerPosition({ player: {}, depth_chart_rows: [{ pos_abb: vehicleAbb }] });
  if (!posResult.normalized_position || posResult.normalized_position === "unknown") return null;
  const roleResult = resolvePlayerRole({
    normalized_position: posResult.normalized_position,
    position_confidence: "high",
    player: { status: "ACT" },
    depth_chart_rows: [{ pos_abb: vehicleAbb, pos_rank: String(rank) }],
  });
  if (roleResult.role === "unknown") return null;
  return roleResult.role;
}

/** Finds the first explicit, non-hedged positive role phrase in a single text unit, or null. */
function extractRoleFromUnit(unit) {
  if (HEDGE_PATTERNS.some((p) => p.test(unit))) return null;
  for (const p of STARTER_PATTERNS) {
    const m = p.exec(unit);
    if (m) return { role: "starter", matched_phrase: m[0] };
  }
  for (const p of BACKUP_PATTERNS) {
    const m = p.exec(unit);
    if (m) return { role: "backup", matched_phrase: m[0] };
  }
  for (const p of PRACTICE_SQUAD_PATTERNS) {
    const m = p.exec(unit);
    if (m) return { role: "practice_squad", matched_phrase: m[0] };
  }
  const rankMatch = RANK_LABEL_PATTERN.exec(unit);
  if (rankMatch) {
    const role = roleFromRankLabel(rankMatch[1].toUpperCase(), Number(rankMatch[2]));
    if (role) return { role, matched_phrase: rankMatch[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Materiality — a fully enumerated, hand-curated lookup (not a distance
// formula: the locked spec's own examples are not symmetric — e.g.
// "practice_squad -> backup" is minor but "backup -> practice_squad" is
// material), extended only where the spec left a reachable pair
// undocumented, per its own instruction to "implement a pure deterministic
// classifier and document the exact final table" for those gaps. Extension
// rule actually applied: (a) any transition that REACHES or LEAVES
// "starter" is material (consistent with every "any -> starter" and
// "starter -> any" entry already being material) — this is the only
// documented gap-fill needed for significant_rotation<->starter; (b) every
// other undocumented-but-reachable pair is adjacent in the significance
// order the same way the given MINOR pairs are, so it is classified minor
// by that same pattern. A transition INTO "unknown" is never reachable in
// practice: fresh_role can only be "unknown" when no qualifying evidence
// exists at all, which this module always reports as shift_materiality
// "none" before this table is ever consulted.
// ---------------------------------------------------------------------------
const MATERIAL_SHIFTS = new Set([
  "backup>starter", "fringe>starter", "practice_squad>starter", "unknown>starter", "significant_rotation>starter",
  "starter>backup", "starter>fringe", "starter>practice_squad", "starter>significant_rotation",
  "fringe>significant_rotation", "practice_squad>significant_rotation", "unknown>significant_rotation",
  "significant_rotation>fringe", "significant_rotation>practice_squad",
  "backup>practice_squad",
]);

const MINOR_SHIFTS = new Set([
  "fringe>backup", "backup>fringe", "unknown>backup", "unknown>fringe", "practice_squad>backup",
  "backup>significant_rotation", "significant_rotation>backup",
  "practice_squad>fringe", "fringe>practice_squad", "unknown>practice_squad",
]);

function computeMateriality(baseline_role, fresh_role) {
  if (!baseline_role || baseline_role === fresh_role) return "none";
  const key = `${baseline_role}>${fresh_role}`;
  if (MATERIAL_SHIFTS.has(key)) return "material";
  if (MINOR_SHIFTS.has(key)) return "minor";
  return "none"; // never guess a materiality the locked table doesn't define
}

// ---------------------------------------------------------------------------
// Publisher-identity canonicalization — strictly for independence/
// corroboration dedupe, never for authority classification (sourceTier()
// remains the sole authority, always called on the raw, un-canonicalized
// name — see evaluateSource below). Two deterministic signals, no fuzzy
// matching:
//
// 1. An explicit, small, LOCKED name-alias table for known abbreviation
//    variants of the SAME outlet. Editorial Scoring Brain's own Tier B set
//    (editorialSourceConfidence.js, unmodified) lists "PFT" and "Pro
//    Football Talk" as siblings — this repo's ingestion pipeline uses both
//    strings for the same real outlet, confirmed by a real story in
//    news.json whose source name is "Pro Football Talk" hosted at
//    nbcsports.com/nfl/profootballtalk/. A plain case-fold alone already
//    unifies "FOX Sports"/"Fox Sports" (verified below by test), so no
//    alias entry is needed for that pair.
// 2. URL hostname (www.-stripped, case-folded). Two candidates sharing the
//    same hostname are the same publisher regardless of what name string
//    was attached, which is what correctly catches an exact duplicate URL
//    or a second article from the same outlet under a differently-cased
//    or differently-abbreviated byline. This does NOT merge distinct
//    named outlets that merely share a generic word ("Sports"/"News"/
//    "NFL") — hostnames are not shared by coincidence in practice, unlike
//    words in a name.
//
// Two candidates are the same publisher if EITHER signal matches.
// ---------------------------------------------------------------------------
const PUBLISHER_NAME_ALIASES = Object.freeze({
  pft: "pro football talk",
  "pro football talk": "pro football talk",
});

function normalizedNameKey(name) {
  const key = (name ?? "").trim().toLowerCase();
  return PUBLISHER_NAME_ALIASES[key] ?? key;
}

function hostnameKey(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null; // malformed/relative URL — never guess a hostname
  }
}

function canonicalPublisherKey(candidate) {
  return { nameKey: normalizedNameKey(candidate.source_name), hostKey: hostnameKey(candidate.source_url) };
}

function samePublisher(a, b) {
  if (a.nameKey && b.nameKey && a.nameKey === b.nameKey) return true;
  if (a.hostKey && b.hostKey && a.hostKey === b.hostKey) return true;
  return false;
}

/** Dedupe by canonical publisher identity (name-alias OR hostname match) — never by sources[] position, per the locked independence rule. Transitive: if A~B by one signal and B~C by the other, all three collapse to one. */
function dedupeIndependentPublishers(candidates) {
  const keys = candidates.map(canonicalPublisherKey);
  const groups = [];
  for (let i = 0; i < candidates.length; i++) {
    const existing = groups.find((g) => g.some((j) => samePublisher(keys[j], keys[i])));
    if (existing) existing.push(i);
    else groups.push([i]);
  }
  return groups.map((g) => candidates[g[0]]);
}

function evaluateGroup(materiality, candidates) {
  if (materiality === "none") return { qualifies: false, confidence: "low", reason: "no_meaningful_shift" };
  if (candidates.some((c) => c.source_tier === "A")) return { qualifies: true, confidence: "high", reason: "tier_a_sufficient" };
  const independentTierB = dedupeIndependentPublishers(candidates.filter((c) => c.source_tier === "B"));
  if (materiality === "minor" && independentTierB.length >= 1) return { qualifies: true, confidence: "medium", reason: "tier_b_minor_sufficient" };
  if (materiality === "material" && independentTierB.length >= 2) return { qualifies: true, confidence: "high", reason: "tier_b_material_corroborated" };
  return { qualifies: false, confidence: "low", reason: "insufficient_corroboration" };
}

function latestPublishedAt(candidates) {
  let latest = null;
  for (const c of candidates) {
    if (!latest || Date.parse(c.published_at) > Date.parse(latest)) latest = c.published_at;
  }
  return latest;
}

/** A rejection entry built from a full evaluated candidate — carries the asserted role/tier/publisher so a failed-corroboration or superseded group stays fully auditable, not just a bare source name. */
function candidateRejection(candidate, reason_codes) {
  return {
    source_name: candidate.source_name,
    source_url: candidate.source_url,
    source_tier: candidate.source_tier,
    publisher_key: candidate.publisher_key,
    mapped_role: candidate.mapped_role,
    published_at: candidate.published_at,
    reason_codes,
  };
}

function publicName(source) {
  return source?.source_name ?? source?.name ?? null;
}
function publicUrl(source) {
  return source?.source_url ?? source?.url ?? null;
}

function containsAnyOtherPlayer(unit, otherPlayers) {
  return otherPlayers.some((name) => name && unit.includes(name));
}

/**
 * Evaluates one source against the subject, returning either a qualifying
 * candidate or a structured rejection. Every gate is independent and
 * ordered so the FIRST failing reason is the one reported.
 */
function evaluateSource(source, subject, otherPlayers, depth_chart_as_of, storyIsRumor) {
  const source_name = publicName(source);
  const source_url = publicUrl(source);
  const headlineUnits = splitIntoUnits(source?.headline ?? "");
  const descriptionUnits = splitIntoUnits(source?.description ?? "");
  const allUnits = [...headlineUnits, ...descriptionUnits];

  // Pass 1: only units that literally contain the resolved subject's name.
  // A unit that ALSO literally names another known player alongside a
  // found phrase is never used — no proximity/word-order guessing about
  // which player the phrase actually belongs to; false negative over false
  // positive, per the locked conservative philosophy.
  let extracted = null;
  let ambiguous = false;
  for (const unit of allUnits) {
    if (!subject || !unit.includes(subject)) continue;
    const found = extractRoleFromUnit(unit);
    if (!found) continue;
    if (containsAnyOtherPlayer(unit, otherPlayers)) {
      ambiguous = true;
      continue;
    }
    extracted = found;
    break;
  }

  if (!extracted) {
    if (ambiguous) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["ambiguous_multi_player_sentence"] } };
    // Pass 2 (diagnostic only): was there a role phrase ANYWHERE in this
    // source, just not bound to the subject? Distinguishes "nothing here"
    // (not reported at all) from "a real phrase existed but belongs to
    // someone else" (reported, for auditability — e.g. subject-binding
    // rejections like the real Keenan Allen / Anthony Richardson case).
    const anyPhrase = allUnits.some((u) => extractRoleFromUnit(u));
    if (anyPhrase) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["phrase_found_not_subject_bound"] } };
    return { qualifies: false, reject: null }; // nothing relevant here at all — not reported
  }

  const isRumor = storyIsRumor === true || source?.is_rumor === true;
  if (isRumor) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["rumor_excluded"] } };

  if (!depth_chart_as_of) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["depth_chart_as_of_missing"] } };
  const dcAsOf = Date.parse(depth_chart_as_of);
  if (Number.isNaN(dcAsOf)) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["depth_chart_as_of_invalid"] } };

  const publishedAt = source?.published_at ?? null;
  if (!publishedAt) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["published_at_missing"] } };
  const pub = Date.parse(publishedAt);
  if (Number.isNaN(pub)) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["published_at_invalid"] } };
  if (!(pub > dcAsOf)) return { qualifies: false, reject: { source_name, source_url, reason_codes: ["not_newer_than_depth_chart"] } };

  return {
    qualifies: true,
    candidate: {
      source_name,
      source_url,
      source_tier: sourceTier(source_name),
      publisher_key: normalizedNameKey(source_name), // corroboration identity only — never the authority tier
      published_at: publishedAt,
      matched_phrase: extracted.matched_phrase,
      mapped_role: extracted.role,
      subject_bound: true,
    },
  };
}

/**
 * @param {{
 *   subject: string|null,
 *   baseline_role: string,
 *   normalized_position?: string|null,
 *   depth_chart_as_of: string|null,
 *   sources?: Array<{source_name?: string, name?: string, source_url?: string, url?: string, headline?: string, description?: string, published_at?: string|null, is_rumor?: boolean}>,
 *   is_rumor?: boolean,
 *   other_players?: string[],
 * }} input - `other_players` (e.g. the story's own players[] list, minus the
 *   subject) lets the resolver detect a unit that names the subject
 *   alongside another known player and refuse to bind an otherwise-found
 *   phrase to either of them — never guessing by word order/proximity.
 */
// Hard invariant on processing order — each candidate source runs through
// (1) explicit-phrase detection, (2) subject binding, (3) rumor rejection,
// (4) published_at > depth_chart_as_of, (5) source-tier lookup, producing a
// pool of qualifying candidates; those are then (6) grouped by the role
// they assert, (7) each group's own baseline->asserted materiality is
// computed, (8) independent-publisher dedupe is applied within the group,
// and (9) EACH GROUP independently decides whether it clears its own
// tier/corroboration threshold BEFORE any group is discarded. Only among
// the groups that survive step 9 does (10) conflict resolution (strict
// newest-timestamp-wins, ties/ambiguity -> no override) ever run. A newer
// report can therefore never bypass corroboration for the role IT asserts —
// it can only ever supersede another group that already independently
// qualified on its own.
export function resolveFreshRoleEvidence({ subject = null, baseline_role = "unknown", normalized_position = null, depth_chart_as_of = null, sources = [], is_rumor = false, other_players = [] } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const otherPlayers = (Array.isArray(other_players) ? other_players : []).filter((p) => p && p !== subject);
  const base = { baseline_role, depth_chart_as_of: depth_chart_as_of ?? null, normalized_position: normalized_position ?? null };

  const candidates = [];
  const rejected_evidence = [];
  for (const source of list) {
    const evaluated = evaluateSource(source, subject, otherPlayers, depth_chart_as_of, is_rumor);
    if (evaluated.qualifies) candidates.push(evaluated.candidate);
    else if (evaluated.reject) rejected_evidence.push(evaluated.reject);
  }

  if (candidates.length === 0) {
    return { ...base, fresh_role: "unknown", confidence: "low", override_applies: false, role_source: "none", role_as_of: null, shift_materiality: "none", qualifying_evidence: [], rejected_evidence, reason_codes: rejected_evidence.length ? ["no_qualifying_evidence"] : ["no_role_statement_found"] };
  }

  const groups = new Map();
  for (const c of candidates) {
    if (!groups.has(c.mapped_role)) groups.set(c.mapped_role, []);
    groups.get(c.mapped_role).push(c);
  }

  const evaluatedGroups = [...groups.entries()].map(([role, groupCandidates]) => {
    const materiality = computeMateriality(baseline_role, role);
    const evalResult = evaluateGroup(materiality, groupCandidates);
    return { role, candidates: groupCandidates, materiality, ...evalResult };
  });

  for (const g of evaluatedGroups) {
    if (!g.qualifies) {
      for (const c of g.candidates) rejected_evidence.push(candidateRejection(c, [g.reason]));
    }
  }

  const qualifyingGroups = evaluatedGroups.filter((g) => g.qualifies);

  if (qualifyingGroups.length === 0) {
    return { ...base, fresh_role: "unknown", confidence: "low", override_applies: false, role_source: "none", role_as_of: null, shift_materiality: "none", qualifying_evidence: [], rejected_evidence, reason_codes: ["insufficient_evidence"] };
  }

  if (qualifyingGroups.length === 1) {
    const g = qualifyingGroups[0];
    return {
      ...base,
      fresh_role: g.role,
      confidence: g.confidence,
      override_applies: true,
      role_source: "fresh_report",
      role_as_of: latestPublishedAt(g.candidates),
      shift_materiality: g.materiality,
      qualifying_evidence: g.candidates,
      rejected_evidence,
      reason_codes: ["fresh_role_override_applied"],
    };
  }

  // Multiple qualifying groups asserting DIFFERENT roles: never arbitrarily
  // choose. Only a STRICTLY newer group (by its own latest published_at)
  // may supersede an older conflicting one; a tie means no override.
  const withLatest = qualifyingGroups.map((g) => ({ ...g, latest: latestPublishedAt(g.candidates) })).sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest));
  const [top, second] = withLatest;
  if (Date.parse(top.latest) > Date.parse(second.latest)) {
    const superseded = withLatest.slice(1);
    for (const g of superseded) {
      for (const c of g.candidates) rejected_evidence.push(candidateRejection(c, ["superseded_by_newer_conflicting_report"]));
    }
    return {
      ...base,
      fresh_role: top.role,
      confidence: top.confidence,
      override_applies: true,
      role_source: "fresh_report",
      role_as_of: latestPublishedAt(top.candidates),
      shift_materiality: top.materiality,
      qualifying_evidence: top.candidates,
      rejected_evidence,
      reason_codes: ["fresh_role_override_applied", "newer_report_superseded_conflicting_older_report"],
    };
  }

  for (const g of withLatest) {
    for (const c of g.candidates) rejected_evidence.push(candidateRejection(c, ["conflicting_fresh_reports"]));
  }
  return { ...base, fresh_role: "unknown", confidence: "low", override_applies: false, role_source: "none", role_as_of: null, shift_materiality: "none", qualifying_evidence: [], rejected_evidence, reason_codes: ["conflicting_fresh_reports"] };
}
