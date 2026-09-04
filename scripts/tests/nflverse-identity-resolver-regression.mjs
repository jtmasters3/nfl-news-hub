#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2C regression suite. Fully offline,
// fully deterministic — no network, no live nflverse dependency. All
// player fixtures are synthetic (not real players), per the Phase 2B
// precedent, except where explicitly noted.
// Run with: node scripts/tests/nflverse-identity-resolver-regression.mjs
import assert from "node:assert/strict";
import { resolvePlayerIdentity, canonicalTeamName } from "../lib/nflverseIdentityResolver.js";
import { buildPlayerIndex } from "../lib/nflversePlayerIndex.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function rosterRow(overrides = {}) {
  return {
    season: "2026",
    week: "1",
    team: "KC",
    position: "QB",
    depth_chart_position: "QB",
    status: "ACT",
    status_description_abbr: "A01",
    full_name: "Test Player",
    football_name: "Test",
    gsis_id: "00-0000001",
    espn_id: "1",
    ...overrides,
  };
}

function index(rows) {
  return buildPlayerIndex({ rows });
}

function story(overrides = {}) {
  return {
    visual_subject: null,
    visual_subject_type: null,
    subject_match_count: 0,
    players: [],
    current_team: null,
    sources: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1-3: unique visual_subject variants
// ---------------------------------------------------------------------------

test("1. Unique visual_subject + matching team -> HIGH", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.equal(r.player_id, "00-1000001");
  assert.equal(r.team_context.agreement, true);
});

test("2. Unique visual_subject + matching team + players[] agreement -> HIGH with positive evidence", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs", players: ["Pax Michaels"] });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.ok(r.reason_codes.includes("players_cross_validated"));
  assert.ok(r.matched_by.includes("players"));
});

test("3. Unique visual_subject + matching team + players[] EMPTY -> still HIGH", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs", players: [] });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high", "an empty players[] must never prevent HIGH");
  assert.ok(r.reason_codes.includes("players_empty"));
});

// ---------------------------------------------------------------------------
// 4-5
// ---------------------------------------------------------------------------

test("4. Unique visual_subject + NO team -> MEDIUM", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: null });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "medium");
  assert.equal(r.team_context.agreement, null, "no team must be neutral, not negative");
});

test("5. Zero roster matches -> LOW", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Someone Else", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low");
  assert.equal(r.player_id, null);
  assert.ok(r.reason_codes.includes("no_name_match"));
});

// ---------------------------------------------------------------------------
// 6-9: duplicate-name handling (the Josh-Allen class of problem)
// ---------------------------------------------------------------------------

function duplicateIndex() {
  return index([
    rosterRow({ gsis_id: "00-2000001", espn_id: "201", full_name: "Jordan Carter", football_name: "Jordan", team: "BUF", position: "QB" }),
    rosterRow({ gsis_id: "00-2000002", espn_id: "202", full_name: "Jordan Carter", football_name: "Jordan", team: "JAX", position: "EDGE" }),
  ]);
}

test("6. Duplicate normalized name + NO team -> LOW", () => {
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: null });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "low");
  assert.equal(r.player_id, null);
  assert.equal(r.candidate_count, 2, "diagnostics must retain both candidates");
});

test("7. Duplicate normalized name + matching team uniquely disambiguates -> HIGH", () => {
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: "Buffalo Bills" });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "high");
  assert.equal(r.player_id, "00-2000001");
  assert.ok(r.reason_codes.includes("duplicate_name_disambiguated_by_team"));
});

test("8. Duplicate normalized name + players[] contains the SAME ambiguous name -> still LOW", () => {
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: null, players: ["Jordan Carter"] });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "low", "players[] agreement must never rescue an ambiguous duplicate-name case");
});

test("9. Duplicate normalized name + team conflicts with ALL candidates -> LOW", () => {
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: "Miami Dolphins" });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "low");
  assert.equal(r.player_id, null);
});

// ---------------------------------------------------------------------------
// 10: unexplained team mismatch (single candidate)
// ---------------------------------------------------------------------------

test("10. Unique visual_subject, unexplained team mismatch -> LOW", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Denver Broncos", sources: [{ headline: "Pax Michaels talks about the season", description: "" }] });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("team_mismatch"));
});

// ---------------------------------------------------------------------------
// 11-13: fresh transaction override
// ---------------------------------------------------------------------------

test("11. Unique name + stale roster team + valid fresh transaction override -> HIGH (confident subject)", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]); // stale: cache still says KC
  const s = story({
    visual_subject: "Pax Michaels",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos", // freshly detected via transaction language
    sources: [{ headline: "Chiefs trade Pax Michaels to Denver Broncos", description: "" }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.equal(r.team_context.transaction_override, true);
  assert.ok(r.reason_codes.includes("transaction_team_override"));
});

test("12. Transaction override does not mutate the roster candidate", () => {
  const row = rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" });
  const idx = index([row]);
  const s = story({
    visual_subject: "Pax Michaels",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Chiefs trade Pax Michaels to Denver Broncos", description: "" }],
  });
  resolvePlayerIdentity(s, idx);
  assert.equal(row.team, "KC", "the underlying cache row must never be mutated by resolution");
});

test("13. Transaction override does not assign a role (identity output has no role/position-weight fields)", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({
    visual_subject: "Pax Michaels",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Chiefs trade Pax Michaels to Denver Broncos", description: "" }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.role, undefined);
  assert.equal(r.position_weight, undefined);
  assert.equal(r.role_multiplier, undefined);
});

test("14. Duplicate name + transaction to a THIRD team does NOT resolve the ambiguity", () => {
  const s = story({
    visual_subject: "Jordan Carter",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Miami Dolphins",
    sources: [{ headline: "Jordan Carter traded to Miami Dolphins", description: "" }],
  });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "low", "a transaction signal alone must never disambiguate WHICH duplicate-name player was traded");
  assert.equal(r.player_id, null);
});

// ---------------------------------------------------------------------------
// 15-17: players[] treatment
// ---------------------------------------------------------------------------

test("15. players[] conflicting with visual_subject produces a diagnostic and downgrades confidence", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs", players: ["Someone Completely Different"] });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "medium", "HIGH must downgrade to MEDIUM on a genuine players[] conflict");
  assert.ok(r.reason_codes.includes("players_conflict"));
});

test("16. players[] EMPTY is not negative evidence", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs", players: [] });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
});

test("17. No visual_subject + ONE uniquely resolvable players[] candidate -> conservative MEDIUM", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: null, visual_subject_type: null, players: ["Pax Michaels"], current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "medium", "no visual_subject means HIGH is never reachable, even with team agreement");
});

test("18. No visual_subject + MULTIPLE players[] candidates -> LOW (never pick players[0])", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" }), rosterRow({ gsis_id: "00-1000002", full_name: "Other Guy", team: "KC" })]);
  const s = story({ visual_subject: null, visual_subject_type: null, players: ["Pax Michaels", "Other Guy"], current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low");
  assert.equal(r.player_id, null);
  assert.ok(r.reason_codes.includes("players_multiple_unresolved"));
});

// ---------------------------------------------------------------------------
// 19-20: canonical identity / missing gsis_id
// ---------------------------------------------------------------------------

test("19. Missing gsis_id cannot become the canonical resolved identity", () => {
  const idx = index([rosterRow({ gsis_id: "", espn_id: "999", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.player_id, null);
  assert.equal(r.confidence, "low", "HARD INVARIANT: missing gsis_id must force LOW even though every other signal (confident subject + team match) would otherwise earn HIGH");
  assert.ok(r.reason_codes.includes("canonical_gsis_missing"));
});

test("20. espn_id alone does not replace a missing gsis_id in player_id", () => {
  const idx = index([rosterRow({ gsis_id: "", espn_id: "999", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.notEqual(r.player_id, "999");
  assert.equal(r.player_id, null);
  assert.equal(r.confidence, "low", "espn_id must never let confidence rise above LOW when gsis_id is absent");
  assert.equal(r.espn_id, "999", "espn_id is still reported in its own field — just never promoted to player_id");
});

// ---------------------------------------------------------------------------
// 21: empty/unavailable index
// ---------------------------------------------------------------------------

test("21. Empty/unavailable index -> LOW without throwing", () => {
  assert.doesNotThrow(() => resolvePlayerIdentity(story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1 }), null));
  const r = resolvePlayerIdentity(story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1 }), null);
  assert.equal(r.confidence, "low");
  assert.ok(r.reason_codes.includes("player_index_unavailable"));
});

// ---------------------------------------------------------------------------
// 22-25: name normalization reuse (through the 2B index, not reimplemented)
// ---------------------------------------------------------------------------

test("22. Name suffix normalization (Jr/III) works through the 2B index", () => {
  const idx = index([rosterRow({ gsis_id: "00-3000001", full_name: "Marvin Harrison Jr.", team: "ARI" })]);
  const s = story({ visual_subject: "Marvin Harrison Jr.", visual_subject_type: "player", subject_match_count: 1, current_team: "Arizona Cardinals" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.equal(r.player_id, "00-3000001");
});

test("23. Apostrophe name works through the 2B index", () => {
  const idx = index([rosterRow({ gsis_id: "00-3000002", full_name: "Ja'Marr Chase", team: "CIN" })]);
  const s = story({ visual_subject: "Ja'Marr Chase", visual_subject_type: "player", subject_match_count: 1, current_team: "Cincinnati Bengals" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
});

test("24. Hyphenated name works through the 2B index", () => {
  const idx = index([rosterRow({ gsis_id: "00-3000003", full_name: "Amon-Ra St. Brown", team: "DET" })]);
  const s = story({ visual_subject: "Amon-Ra St. Brown", visual_subject_type: "player", subject_match_count: 1, current_team: "Detroit Lions" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
});

test("25. Accented name works through the 2B index", () => {
  const idx = index([rosterRow({ gsis_id: "00-3000004", full_name: "Andre Rison", team: "ATL" })]);
  const s = story({ visual_subject: "André Rison", visual_subject_type: "player", subject_match_count: 1, current_team: "Atlanta Falcons" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------------------
// 26: team abbreviation adapter
// ---------------------------------------------------------------------------

test("26. Team abbreviation adapter — every mapping actually required between this repo and nflverse (confirmed against real fetched data)", () => {
  // Confirmed identical in both systems — no adapter entry needed:
  assert.equal(canonicalTeamName("WAS"), "Washington Commanders");
  assert.equal(canonicalTeamName("JAX"), "Jacksonville Jaguars");
  assert.equal(canonicalTeamName("LV"), "Las Vegas Raiders");
  assert.equal(canonicalTeamName("LAC"), "Los Angeles Chargers");
  assert.equal(canonicalTeamName("NYJ"), "New York Jets");
  assert.equal(canonicalTeamName("NYG"), "New York Giants");
  // The ONE real, confirmed discrepancy: nflverse uses "LA" for the Rams.
  assert.equal(canonicalTeamName("LAR"), "Los Angeles Rams", "this repo's own abbreviation must still work directly");
  assert.equal(canonicalTeamName("LA"), "Los Angeles Rams", "nflverse's actual abbreviation must be adapted");
});

// ---------------------------------------------------------------------------
// 27-28: determinism
// ---------------------------------------------------------------------------

test("27. Resolver output is deterministic regardless of candidate/index insertion order", () => {
  const rowA = rosterRow({ gsis_id: "00-2000001", full_name: "Jordan Carter", team: "BUF" });
  const rowB = rosterRow({ gsis_id: "00-2000002", full_name: "Jordan Carter", team: "JAX" });
  const idxForward = index([rowA, rowB]);
  const idxReversed = index([rowB, rowA]);
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: "Buffalo Bills" });
  const rForward = resolvePlayerIdentity(s, idxForward);
  const rReversed = resolvePlayerIdentity(s, idxReversed);
  assert.deepEqual(rForward, rReversed);
});

test("28. reason_codes are deterministic for identical input", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const a = resolvePlayerIdentity(s, idx);
  const b = resolvePlayerIdentity(s, idx);
  assert.deepEqual(a.reason_codes, b.reason_codes);
});

// ---------------------------------------------------------------------------
// 29-30
// ---------------------------------------------------------------------------

test("29. Candidate diagnostics are retained on LOW ambiguity", () => {
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: null });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "low");
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every((c) => c.gsis_id && c.team));
});

test("30. The resolver performs no network calls (pure function — no fetch reference anywhere in the module)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseIdentityResolver.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(/.test(src), false, "the identity resolver must never call fetch()");
});

// ---------------------------------------------------------------------------
// Additional coverage
// ---------------------------------------------------------------------------

test("Weak visual_subject fallback (subject_match_count > 1) caps at MEDIUM even with team agreement", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 2, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "medium", "a weak, multi-candidate visual_subject resolution must never reach HIGH on its own");
});

test("No scoring fields anywhere in the output shape (position_weight, role_weight, ROLE_MULTIPLIER, STAR_BOOST, total_score, destination)", () => {
  const idx = index([rosterRow({ gsis_id: "00-1000001", full_name: "Pax Michaels", team: "KC" })]);
  const s = story({ visual_subject: "Pax Michaels", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  for (const forbidden of ["position_weight", "role_weight", "ROLE_MULTIPLIER", "STAR_BOOST", "total_score", "destination", "role"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, forbidden), false, `output must never contain a scoring field: ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// 31-34: Issue 2 hardening — gsis_id is a hard confidence gate, checked
// across every path that can otherwise reach HIGH/MEDIUM (unique-candidate
// team match, no-team MEDIUM, duplicate disambiguated by team), plus
// confirming espn_id's presence never substitutes.
// ---------------------------------------------------------------------------

test("31. Missing gsis_id + unique name + matching team -> forced LOW, never HIGH", () => {
  const idx = index([rosterRow({ gsis_id: "", espn_id: "555", full_name: "Dallas Rowe", team: "KC" })]);
  const s = story({ visual_subject: "Dallas Rowe", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low");
  assert.equal(r.player_id, null);
  assert.ok(r.reason_codes.includes("canonical_gsis_missing"));
});

test("32. Missing gsis_id + unique name + no team -> LOW, never MEDIUM", () => {
  const idx = index([rosterRow({ gsis_id: "", espn_id: "556", full_name: "Dallas Rowe", team: "KC" })]);
  const s = story({ visual_subject: "Dallas Rowe", visual_subject_type: "player", subject_match_count: 1, current_team: null });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low", "the no-team MEDIUM path must also be gated by gsis_id presence");
  assert.equal(r.player_id, null);
  assert.ok(r.reason_codes.includes("canonical_gsis_missing"));
});

test("33. Duplicate disambiguated by team + missing gsis_id on the winning candidate -> LOW", () => {
  const idx = index([
    rosterRow({ gsis_id: "", espn_id: "557", full_name: "Jordan Carter", football_name: "Jordan", team: "BUF", position: "QB" }),
    rosterRow({ gsis_id: "00-2000002", espn_id: "202", full_name: "Jordan Carter", football_name: "Jordan", team: "JAX", position: "EDGE" }),
  ]);
  const s = story({ visual_subject: "Jordan Carter", visual_subject_type: "player", subject_match_count: 1, current_team: "Buffalo Bills" });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low", "team-based disambiguation must not bypass the gsis_id gate");
  assert.equal(r.player_id, null);
  assert.ok(r.reason_codes.includes("duplicate_name_disambiguated_by_team"), "the disambiguation itself still succeeded and must be recorded");
  assert.ok(r.reason_codes.includes("canonical_gsis_missing"));
});

test("34. espn_id present does not increase confidence when gsis_id is absent", () => {
  const idx = index([rosterRow({ gsis_id: "", espn_id: "558", full_name: "Dallas Rowe", team: "KC" })]);
  const s = story({ visual_subject: "Dallas Rowe", visual_subject_type: "player", subject_match_count: 1, current_team: "Kansas City Chiefs", players: ["Dallas Rowe"] });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low", "even with team match AND players[] cross-validation AND a present espn_id, missing gsis_id still forces LOW");
  assert.equal(r.espn_id, "558", "espn_id is still surfaced diagnostically");
  assert.equal(r.player_id, null);
});

// ---------------------------------------------------------------------------
// 35-42: Issue 3 hardening — a transaction-team override must be bound to
// the resolved subject (same sentence-like text unit), never merely
// present anywhere in the story's combined text.
// ---------------------------------------------------------------------------

test("35. SUBJECT-BINDING: subject's OWN transaction sentence, amid unrelated noise sentences, still yields a valid override", () => {
  const idx = index([rosterRow({ gsis_id: "00-4000001", full_name: "Casey Nolan", team: "KC" })]); // stale cached team
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Morning links: league notes", description: "Riley Thompson signed with the Cowboys today. Casey Nolan was traded to the Denver Broncos in a separate deal." }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.equal(r.team_context.transaction_override, true);
  assert.ok(r.reason_codes.includes("transaction_team_override"));
});

test("36. SUBJECT-BINDING: a DIFFERENT player's transaction sentence elsewhere in the story must NOT override the subject's mismatch", () => {
  const idx = index([rosterRow({ gsis_id: "00-4000002", full_name: "Casey Nolan", team: "KC" })]);
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Team notes", description: "Casey Nolan spoke to reporters about the offense. Riley Thompson was traded to the Denver Broncos." }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low", "Riley Thompson's transaction language must never explain Casey Nolan's stale team");
  assert.equal(r.team_context.transaction_override, false);
  assert.ok(r.reason_codes.includes("team_mismatch"));
  assert.ok(!r.reason_codes.includes("transaction_team_override"));
});

test("37. SUBJECT-BINDING: multi-player story, only the NON-subject player has transaction language -> subject stays LOW", () => {
  const idx = index([rosterRow({ gsis_id: "00-4000003", full_name: "Casey Nolan", team: "KC" })]);
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    players: ["Casey Nolan", "Riley Thompson"],
    sources: [{ headline: "Team notes", description: "Casey Nolan spoke to reporters about the offense. Riley Thompson was traded to the Denver Broncos." }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "low");
  assert.equal(r.player_id, "00-4000003", "identity is still resolved (name+team logic), just not upgraded by the unrelated transaction");
  assert.equal(r.team_context.transaction_override, false);
});

test("38. SUBJECT-BINDING: subject's transaction language appears directly in the HEADLINE -> valid override", () => {
  const idx = index([rosterRow({ gsis_id: "00-4000004", full_name: "Casey Nolan", team: "KC" })]);
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Casey Nolan traded to the Denver Broncos", description: "" }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.equal(r.team_context.transaction_override, true);
});

test("39. SUBJECT-BINDING: subject's transaction language appears only in the source DESCRIPTION -> valid override", () => {
  const idx = index([rosterRow({ gsis_id: "00-4000005", full_name: "Casey Nolan", team: "KC" })]);
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Team notes for the week", description: "Casey Nolan was traded to the Denver Broncos." }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.confidence, "high");
  assert.equal(r.team_context.transaction_override, true);
});

test("40. SUBJECT-BINDING: duplicate-name ambiguity + a subject-bound transaction to a third team -> still unresolved", () => {
  const s = story({
    visual_subject: "Jordan Carter",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Miami Dolphins",
    sources: [{ headline: "Jordan Carter traded to the Miami Dolphins", description: "" }],
  });
  const r = resolvePlayerIdentity(s, duplicateIndex());
  assert.equal(r.confidence, "low", "a subject-bound transaction sentence still cannot tell apart two different real people who share a name");
  assert.equal(r.player_id, null);
  assert.ok(!r.reason_codes.includes("transaction_team_override"), "duplicate-name resolution must never even consult transaction language");
});

test("41. SUBJECT-BINDING: a valid override does not mutate the underlying roster row or index", () => {
  const row = rosterRow({ gsis_id: "00-4000006", full_name: "Casey Nolan", team: "KC" });
  const idx = index([row]);
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Casey Nolan traded to the Denver Broncos", description: "" }],
  });
  resolvePlayerIdentity(s, idx);
  assert.equal(row.team, "KC", "the source roster row must never be mutated by resolution");
  const stillCached = idx.by_gsis_id.get("00-4000006");
  assert.equal(stillCached.team, "KC", "the index's own stored copy must never be mutated by resolution");
});

test("42. SUBJECT-BINDING: a valid override never introduces a role/position field into the output", () => {
  const idx = index([rosterRow({ gsis_id: "00-4000007", full_name: "Casey Nolan", team: "KC" })]);
  const s = story({
    visual_subject: "Casey Nolan",
    visual_subject_type: "player",
    subject_match_count: 1,
    current_team: "Denver Broncos",
    sources: [{ headline: "Casey Nolan traded to the Denver Broncos", description: "" }],
  });
  const r = resolvePlayerIdentity(s, idx);
  assert.equal(r.role, undefined);
  assert.equal(r.position_weight, undefined);
  assert.equal(r.destination, undefined);
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
