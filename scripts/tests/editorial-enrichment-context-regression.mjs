#!/usr/bin/env node
// Production Integration — Stage 1 regression suite. Fully offline and
// deterministic: no network, no live nflverse dependency. Exercises the
// ENTIRE locked chain (Phase 2C-2I) through the new pure orchestrator,
// using synthetic fixtures shaped exactly like real production/nflverse
// data confirmed during this stage's own inspection.
// Run with: node scripts/tests/editorial-enrichment-context-regression.mjs
import assert from "node:assert/strict";
import { buildEditorialPlayerContext } from "../lib/editorialEnrichmentContext.js";
import { buildPlayerIndex } from "../lib/nflversePlayerIndex.js";
import { scoreStory } from "../lib/editorialScoring.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const AS_OF = "2026-09-21T12:00:00Z"; // a Monday, mid-Week-3

function rosterRow({ season = 2026, week = 3, gsis_id = "00-0000001", espn_id = "1001", full_name = "Test Starter Qb", football_name = "Test", team = "KC", position = "QB", depth_chart_position = "QB", status = "ACT", status_description_abbr = "A01" } = {}) {
  return { season, week, gsis_id, espn_id, full_name, football_name, team, position, depth_chart_position, status, status_description_abbr };
}

function depthRow({ dt = "2026-09-20T00:00:00Z", team = "KC", player_name = "Test Starter Qb", espn_id = "1001", gsis_id = "00-0000001", pos_abb = "QB", pos_rank = "1", pos_slot = "1" } = {}) {
  return { dt, team, player_name, espn_id, gsis_id, pos_grp_id: "1", pos_grp: "Base Offense", pos_id: "1", pos_name: "Quarterback", pos_abb, pos_slot, pos_rank };
}

function scheduleRow({ season = 2026, week = 3, game_type = "REG", gameday = "2026-09-20", gametime = "13:00" } = {}) {
  return { season, week, game_type, gameday, gametime };
}

function source({ name = "ESPN", headline = "Test Starter Qb expected to start for the Chiefs", description = "The Chiefs starting quarterback is expected to play.", url = "https://espn.test/story-1", published_at = "2026-09-19T10:00:00Z" } = {}) {
  return { name, headline, description, url, published_at, discovered_at: published_at };
}

function makeStory({
  headline = "Test Starter Qb expected to start for the Chiefs",
  sources = [source()],
  players = ["Test Starter Qb"],
  teams = ["Kansas City Chiefs"],
  current_team = "Kansas City Chiefs",
  is_rumor = false,
  // Safely AFTER Week 3's final scheduled kickoff (SCHEDULE_ROWS' Monday
  // game concludes at 2026-09-22T00:15:00Z) and AFTER the default depth-row
  // dt (2026-09-20T00:00:00Z) — so the fixture's own roster/depth data is
  // genuinely eligible for this as_of, rather than being (correctly)
  // rejected as future evidence.
  first_published_at = "2026-09-22T02:00:00Z",
  category = "injury",
} = {}) {
  return { id: "story-1", headline, category, is_rumor, teams, players, current_team, sources, first_published_at, latest_published_at: first_published_at, updated_at: first_published_at };
}

// Standard Week 3 schedule (used across most fixtures) + player index built
// from a small, deterministic synthetic roster.
const SCHEDULE_ROWS = [scheduleRow({ week: 3, gameday: "2026-09-20", gametime: "13:00" }), scheduleRow({ week: 3, gameday: "2026-09-21", gametime: "20:15" })];

function starterQbFixture() {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow()];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  return { story: makeStory(), roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index };
}

// ---------------------------------------------------------------------------
// 1. non-player story -> neutral player context
// ---------------------------------------------------------------------------
test("1. non-player story -> neutral player context", () => {
  const story = makeStory({ headline: "NFL announces new playoff format", players: [], teams: ["Kansas City Chiefs"], current_team: null });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.status, "neutral");
  assert.deepEqual(result.player_context, { has_player_subject: false, normalized_position: null, effective_role: null, qb_importance: null, player_id: null, identity_confidence: null, star_level: null, star_matched: false });
});

// ---------------------------------------------------------------------------
// 2-6. Position/role scenarios
// ---------------------------------------------------------------------------
test("2. confident starter QB", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.status, "resolved");
  assert.equal(result.player_context.normalized_position, "QB");
  assert.equal(result.player_context.effective_role, "starter");
  assert.equal(result.player_context.player_id, "00-0000001");
});

test("3. backup QB", () => {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow({ pos_rank: "2" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const result = buildEditorialPlayerContext({ story: makeStory(), roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.player_context.effective_role, "backup");
});

test("4. fringe QB", () => {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow({ pos_rank: "3" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const result = buildEditorialPlayerContext({ story: makeStory(), roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.player_context.effective_role, "fringe");
});

test("5. practice-squad QB", () => {
  const roster_rows = [rosterRow({ status: "DEV", status_description_abbr: null })];
  const depth_chart_rows = []; // real DEV players carry zero current depth-chart rows
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const result = buildEditorialPlayerContext({ story: makeStory(), roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.player_context.effective_role, "practice_squad");
});

test("6. starter WR", () => {
  const roster_rows = [rosterRow({ gsis_id: "00-0000002", espn_id: "1002", full_name: "Test Starter Wr", football_name: "Test", position: "WR", depth_chart_position: "WR" })];
  const depth_chart_rows = [depthRow({ gsis_id: "00-0000002", espn_id: "1002", player_name: "Test Starter Wr", pos_abb: "WR", pos_rank: "1" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ headline: "Test Starter Wr expected to have a big role this week", players: ["Test Starter Wr"], sources: [source({ headline: "Test Starter Wr expected to have a big role this week", description: "The Chiefs' top wideout is healthy." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.player_context.normalized_position, "WR");
  assert.equal(result.player_context.effective_role, "starter");
  assert.equal(result.player_context.qb_importance, "none");
});

// ---------------------------------------------------------------------------
// 7-8. Identity edge cases
// ---------------------------------------------------------------------------
test("7. unresolved identity (name not in index)", () => {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow()];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ headline: "Totally Different Player expected to start", players: ["Totally Different Player"], sources: [source({ headline: "Totally Different Player expected to start", description: "A player not in our roster fixture." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.status, "partial");
  assert.equal(result.player_context.player_id, null);
  assert.equal(result.player_context.has_player_subject, true); // a subject WAS identified, just never matched a real player
  assert.equal(result.player_context.normalized_position, "unknown");
});

test("8. duplicate-name ambiguous identity, no story team to disambiguate", () => {
  const roster_rows = [rosterRow({ gsis_id: "00-AAA", espn_id: "2001", team: "KC" }), rosterRow({ gsis_id: "00-BBB", espn_id: "2002", team: "SEA" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ current_team: null });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.player_context.player_id, null);
  assert.equal(result.identity.candidate_count, 2);
  assert.ok(result.identity.reason_codes.includes("duplicate_name"));
});

// ---------------------------------------------------------------------------
// 9-13. Temporal evidence availability
// ---------------------------------------------------------------------------
test("9. missing roster evidence", () => {
  const { story, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.temporal.diagnostics.roster_found, false);
  assert.equal(result.player_context.normalized_position, "unknown");
});

test("10. missing depth evidence", () => {
  const { story, roster_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows: [], schedule_rows, player_index });
  assert.equal(result.temporal.diagnostics.depth_chart_found, false);
  assert.equal(result.player_context.effective_role, "unknown");
});

test("11. missing schedule evidence (manual target also absent -> no roster target at all)", () => {
  const { story, roster_rows, depth_chart_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: null, player_index });
  assert.equal(result.temporal.schedule, null);
  assert.equal(result.temporal.diagnostics.roster_found, false);
  assert.ok(result.temporal.reason_codes.includes("roster_week_target_not_supplied"));
});

test("12. future depth rejected", () => {
  const { story, roster_rows, schedule_rows, player_index } = starterQbFixture();
  const depth_chart_rows = [depthRow({ dt: "2026-09-25T00:00:00Z" })]; // after AS_OF
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.temporal.diagnostics.future_depth_chart_rejected, true);
  assert.equal(result.temporal.diagnostics.depth_chart_found, false);
});

test("13. future roster rejected", () => {
  const { story, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const roster_rows = [rosterRow({ week: 3 }), rosterRow({ week: 20, gsis_id: "00-0000099" })];
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.temporal.diagnostics.future_roster_rejected, true);
  assert.equal(result.player_context.normalized_position, "QB"); // week 3 still correctly selected
});

// ---------------------------------------------------------------------------
// 14-15. Roster provenance modes
// ---------------------------------------------------------------------------
test("14. schedule-indirect roster provenance retained", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.temporal.roster.temporal_basis, "schedule_final_kickoff");
  assert.equal(result.temporal.roster.temporal_confidence, "indirect");
  assert.equal(result.temporal.roster.roster_as_of, null);
});

test("15. manual roster provenance retained", () => {
  const { story, roster_rows, depth_chart_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: null, target_season: 2026, target_week: 3, player_index });
  assert.equal(result.temporal.roster.temporal_basis, "manual_target");
  assert.equal(result.temporal.roster.temporal_confidence, "unverified");
  assert.equal(result.player_context.normalized_position, "QB");
  assert.ok(result.temporal.reason_codes.includes("manual_roster_target_not_temporally_verified"));
});

// ---------------------------------------------------------------------------
// 16-20. Fresh-role scenarios
// ---------------------------------------------------------------------------
test("16. fresh role override applies (Tier A, single source)", () => {
  const roster_rows = [rosterRow()]; // baseline: rank 2 depth row below, so baseline = backup
  const depth_chart_rows = [depthRow({ pos_rank: "2" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({
    headline: "Test Starter Qb named the starter for the Chiefs",
    sources: [source({ name: "ESPN", headline: "Test Starter Qb named the starter for the Chiefs", description: "Test Starter Qb will start.", published_at: "2026-09-21T00:00:00Z" })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.baseline_role.role, "backup");
  assert.equal(result.fresh_role.override_applies, true);
  assert.equal(result.player_context.effective_role, "starter");
});

test("17. fresh role evidence insufficient (unknown-tier source) -> baseline retained", () => {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow({ pos_rank: "1" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({
    headline: "Test Starter Qb named the backup for the Chiefs",
    sources: [source({ name: "Some Random Blog", headline: "Test Starter Qb named the backup for the Chiefs", description: "Test Starter Qb will be the backup.", published_at: "2026-09-21T00:00:00Z" })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.fresh_role.override_applies, false);
  assert.equal(result.player_context.effective_role, "starter"); // baseline retained
});

test("18. fresh role conflict (two Tier A sources, same timestamp, different roles) -> baseline retained", () => {
  // Baseline must be a role BOTH asserted roles are materially different
  // from (otherwise the group matching baseline is filtered out at the
  // materiality gate before conflict resolution ever runs) — a WR at rank 3
  // (significant_rotation) works; QB's rank table only has starter/backup.
  const roster_rows = [rosterRow({ gsis_id: "00-0000003", espn_id: "1003", full_name: "Test Rotation Wr", position: "WR", depth_chart_position: "WR" })];
  const depth_chart_rows = [depthRow({ gsis_id: "00-0000003", espn_id: "1003", player_name: "Test Rotation Wr", pos_abb: "WR", pos_rank: "3" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({
    headline: "Test Rotation Wr role in question for the Chiefs",
    players: ["Test Rotation Wr"],
    sources: [
      source({ name: "ESPN", headline: "Test Rotation Wr named the starter for the Chiefs", description: "Test Rotation Wr will start.", published_at: "2026-09-21T00:00:00Z", url: "https://espn.test/conflict-a" }),
      source({ name: "NFL Network", headline: "Test Rotation Wr named the backup for the Chiefs", description: "Test Rotation Wr will be the backup.", published_at: "2026-09-21T00:00:00Z", url: "https://nflnetwork.test/conflict-b" }),
    ],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.baseline_role.role, "significant_rotation");
  assert.equal(result.fresh_role.override_applies, false);
  assert.ok(result.fresh_role.reason_codes.includes("conflicting_fresh_reports"));
  assert.equal(result.player_context.effective_role, "significant_rotation"); // baseline retained
});

test("19. Tier A fresh role override (single ESPN source sufficient)", () => {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow({ pos_rank: "2" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({
    sources: [source({ name: "ESPN", headline: "Test Starter Qb will start for the Chiefs", description: "Test Starter Qb will start this week.", published_at: "2026-09-21T00:00:00Z" })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.fresh_role.qualifying_evidence[0].source_tier, "A");
  assert.equal(result.fresh_role.override_applies, true);
});

test("20. Tier B corroborated fresh-role override (two independent Tier B sources, material shift)", () => {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow({ pos_rank: "2" })]; // baseline backup
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({
    sources: [
      source({ name: "Pro Football Talk", headline: "Test Starter Qb named the starter for the Chiefs", description: "Test Starter Qb will start.", published_at: "2026-09-21T00:00:00Z", url: "https://pft.test/story-a" }),
      source({ name: "CBS Sports", headline: "Test Starter Qb named the starter for the Chiefs", description: "Test Starter Qb will start.", published_at: "2026-09-21T01:00:00Z", url: "https://cbssports.test/story-b" }),
    ],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.baseline_role.role, "backup");
  assert.equal(result.fresh_role.override_applies, true);
  assert.equal(result.player_context.effective_role, "starter");
});

// ---------------------------------------------------------------------------
// 21-23. Star gating
// ---------------------------------------------------------------------------
test("21. low-confidence identity blocks star boost", () => {
  const roster_rows = [rosterRow({ gsis_id: "00-AAA", espn_id: "2001", team: "KC" }), rosterRow({ gsis_id: "00-BBB", espn_id: "2002", team: "SEA" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const star_records = [{ gsis_id: "00-AAA", star_level: "elite", effective_from: "2020-01-01T00:00:00Z", effective_to: null }];
  const story = makeStory({ current_team: null }); // ambiguous -> low confidence, player_id null
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS, player_index, star_records });
  assert.equal(result.player_context.player_id, null);
  assert.equal(result.star.matched, false);
  assert.equal(result.player_context.star_level, "none");
});

test("22. missing canonical gsis blocks star boost", () => {
  const roster_rows = [rosterRow({ gsis_id: "" })]; // no gsis_id on the matched candidate
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const result = buildEditorialPlayerContext({ story: makeStory(), roster_rows, depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.identity.player_id, null);
  assert.ok(result.identity.reason_codes.includes("canonical_gsis_missing"));
  assert.equal(result.player_context.star_level, "none");
  assert.equal(result.player_context.star_matched, false);
});

test("23. empty production star registry remains none (real default)", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  // star_records not supplied at all -> defaults to the real, intentionally-empty production registry.
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.player_context.star_level, "none");
  assert.equal(result.player_context.star_matched, false);
});

// ---------------------------------------------------------------------------
// 24-25. QB importance
// ---------------------------------------------------------------------------
test("24. QB importance uses effective role (elevated for starter QB)", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.player_context.qb_importance, "elevated");
});

test("25. non-QB importance correct (none for a WR)", () => {
  const roster_rows = [rosterRow({ gsis_id: "00-0000002", espn_id: "1002", full_name: "Test Starter Wr", position: "WR", depth_chart_position: "WR" })];
  const depth_chart_rows = [depthRow({ gsis_id: "00-0000002", espn_id: "1002", player_name: "Test Starter Wr", pos_abb: "WR", pos_rank: "1" })];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ headline: "Test Starter Wr practices fully", players: ["Test Starter Wr"], sources: [source({ headline: "Test Starter Wr practices fully", description: "He looked good at practice." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.player_context.qb_importance, "none");
});

// ---------------------------------------------------------------------------
// 26-28. Phase 2H-B contract compliance
// ---------------------------------------------------------------------------
test("26. player_context exactly matches Phase 2H-B contract (no extra/missing keys)", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const expectedKeys = ["has_player_subject", "normalized_position", "effective_role", "qb_importance", "player_id", "identity_confidence", "star_level", "star_matched"].sort();
  assert.deepEqual(Object.keys(result.player_context).sort(), expectedKeys);
});

test("27. scoreStory receives context.player_context and it visibly changes the enriched score", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const enrichment = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const withoutContext = scoreStory(story);
  const withContext = scoreStory(story, { player_context: enrichment.player_context });
  assert.equal(withContext.total_score, withoutContext.total_score); // legacy untouched
  assert.notEqual(withContext.enrichment.enriched_total, withoutContext.enrichment.enriched_total); // enriched preview visibly reflects the QB starter boost
});

test("28. story.player_context remains ignored by scoreStory (Phase 2H-B's own locked boundary)", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const enrichment = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const storyWithBogusField = { ...story, player_context: enrichment.player_context };
  const result = scoreStory(storyWithBogusField); // no context argument at all
  assert.equal(result.enrichment.enriched_total, result.total_score); // neutral — story.player_context was never read
});

// ---------------------------------------------------------------------------
// 29-32. Legacy safety
// ---------------------------------------------------------------------------
test("29. legacy score identical with enrichment present", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const enrichment = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const legacyAlone = scoreStory(story);
  const withEnrichment = scoreStory(story, { player_context: enrichment.player_context });
  assert.equal(withEnrichment.total_score, legacyAlone.total_score);
  assert.deepEqual(withEnrichment.destination, legacyAlone.destination);
  assert.deepEqual(withEnrichment.signals, legacyAlone.signals);
  assert.deepEqual(withEnrichment.modifiers, legacyAlone.modifiers);
});

test("30. enriched preview differs when expected (starter QB boost)", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const enrichment = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const result = scoreStory(story, { player_context: enrichment.player_context });
  assert.ok(result.enrichment.enriched_total > result.total_score);
});

test("31. enriched preview neutral when enrichment is unavailable for a non-player story", () => {
  // "Unavailable" here means genuinely no player subject at all (has_player_subject:
  // false) -> editorialPlayerImportance's own fully-neutral (1.0 everywhere) path.
  // A story that DOES name a subject but can't resolve their position/role/team
  // (see 31b) is a materially different, already-locked case: Phase 2H-A's own
  // documented "explicitly-supplied unresolved player" gets its mild 0.855-ish
  // multiplier, deliberately NOT full neutrality — asserting full neutrality
  // there would be asserting against locked Phase 2H-A behavior, not this stage.
  const story = makeStory({ headline: "NFL announces new playoff format", players: [], current_team: null });
  const enrichment = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: null });
  assert.equal(enrichment.player_context.has_player_subject, false);
  const result = scoreStory(story, { player_context: enrichment.player_context });
  assert.equal(result.enrichment.enriched_total, result.total_score);
});

test("31b. a story WITH a player subject but no resolvable roster/depth/index data gets the locked mild unresolved-player multiplier, not full neutrality", () => {
  const story = makeStory(); // has a player subject (headline/players both name one)
  const enrichment = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: null }); // no player_index either
  assert.equal(enrichment.player_context.has_player_subject, true);
  assert.equal(enrichment.player_context.player_id, null);
  const result = scoreStory(story, { player_context: enrichment.player_context });
  assert.notEqual(result.enrichment.enriched_total, result.total_score); // NOT neutral — this is the locked "unresolved player" path, by design
});

test("32. rumor gate remains identical regardless of enrichment", () => {
  const story = makeStory({ is_rumor: true, headline: "Report: Test Starter Qb could start", category: "rumor" });
  const { roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const enrichment = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const withoutEnrichment = scoreStory(story);
  const withEnrichment = scoreStory(story, { player_context: enrichment.player_context });
  assert.equal(withEnrichment.destination.story_fit, withoutEnrichment.destination.story_fit);
  assert.equal(withEnrichment.destination.feed_fit, withoutEnrichment.destination.feed_fit);
});

// ---------------------------------------------------------------------------
// 33-36. Purity / determinism / fail-open
// ---------------------------------------------------------------------------
test("33. no input mutation", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const storySnapshot = JSON.stringify(story);
  const rosterSnapshot = JSON.stringify(roster_rows);
  const depthSnapshot = JSON.stringify(depth_chart_rows);
  const scheduleSnapshot = JSON.stringify(schedule_rows);
  buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(JSON.stringify(story), storySnapshot);
  assert.equal(JSON.stringify(roster_rows), rosterSnapshot);
  assert.equal(JSON.stringify(depth_chart_rows), depthSnapshot);
  assert.equal(JSON.stringify(schedule_rows), scheduleSnapshot);
  assert.equal(story.player_context, undefined); // never attached to the story object
});

test("34. Date.now unavailable without breaking the deterministic path", () => {
  const original = Date.now;
  Date.now = () => {
    throw new Error("buildEditorialPlayerContext must never call Date.now()");
  };
  try {
    const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
    const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
    assert.equal(result.status, "resolved");
  } finally {
    Date.now = original;
  }
});

test("35. repeated invocation deterministic", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const a = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const b = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.deepEqual(a, b);
});

test("36. enrichment exception/failure degrades to neutral legacy-safe behavior", () => {
  const malformedStory = { headline: 12345, sources: "not-an-array", players: null, first_published_at: "2026-09-19T10:00:00Z" };
  const result = buildEditorialPlayerContext({ story: malformedStory, roster_rows: "not-an-array", depth_chart_rows: undefined, schedule_rows: 42 });
  assert.equal(result.status, "neutral");
  assert.deepEqual(result.player_context, { has_player_subject: false, normalized_position: null, effective_role: null, qb_importance: null, player_id: null, identity_confidence: null, star_level: null, star_matched: false });
  // and scoreStory must still work fine with this neutral context
  const scored = scoreStory(makeStory(), { player_context: result.player_context });
  assert.equal(scored.enrichment.enriched_total, scored.total_score);
});

test("36b. buildEditorialPlayerContext itself never throws even with a null story", () => {
  assert.doesNotThrow(() => buildEditorialPlayerContext({ story: null }));
  const result = buildEditorialPlayerContext({ story: null });
  assert.equal(result.status, "neutral");
});

// ---------------------------------------------------------------------------
// Supporting: as_of policy
// ---------------------------------------------------------------------------
test("37. as_of defaults to story.first_published_at, never latest_published_at or Date.now", () => {
  const { roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const story = { ...makeStory(), first_published_at: "2026-09-19T10:00:00Z", latest_published_at: "2026-12-01T00:00:00Z" };
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.as_of, "2026-09-19T10:00:00Z");
});

test("38. missing first_published_at -> neutral, never Date.now substitution", () => {
  const story = { ...makeStory(), first_published_at: null };
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.status, "neutral");
  assert.ok(result.reason_codes.includes("story_as_of_missing"));
});

test("39. explicit as_of override takes precedence over story.first_published_at", () => {
  const { roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const story = makeStory();
  const result = buildEditorialPlayerContext({ story, as_of: "2026-09-15T00:00:00Z", roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.as_of, "2026-09-15T00:00:00Z");
});

test("40. a realistic multi-player league-wide depth snapshot never leaks another player's position/role evidence (real-data-validation regression)", () => {
  // The identified player's own row (rank 1 -> starter) PLUS several
  // unrelated players' rows at OTHER positions in the same snapshot — a
  // real depth-chart snapshot always looks like this (thousands of rows),
  // never just the one player's row in isolation.
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [
    depthRow(), // the subject's own row: QB, rank 1
    depthRow({ gsis_id: "00-OTHER-1", espn_id: "9001", player_name: "Unrelated Wr", pos_abb: "WR", pos_rank: "1" }),
    depthRow({ gsis_id: "00-OTHER-2", espn_id: "9002", player_name: "Unrelated Edge", pos_abb: "LDE", pos_rank: "1" }),
    depthRow({ gsis_id: "00-OTHER-3", espn_id: "9003", player_name: "Unrelated Cb", pos_abb: "CB", pos_rank: "2" }),
  ];
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const result = buildEditorialPlayerContext({ story: makeStory(), roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index });
  assert.equal(result.position.normalized_position, "QB");
  assert.equal(result.position.confidence, "high");
  assert.ok(!result.reason_codes.includes("conflicting_position_evidence"));
  assert.equal(result.player_context.effective_role, "starter");
});

// ---------------------------------------------------------------------------
// SUBJECT-SAFETY HARDENING (41-53) — the real "Andy Reid on Mahomes" story
// showed visual_subject_type:"player" does NOT by itself prove the subject
// IS a player (it only proves which branch of determineVisualSubject
// matched — the headline-name-candidate branch has no coach/player
// awareness). Only visual_subject_type==="player" AND subject_match_count
// ===1 is a confidently-established player subject; everything else must
// neutralize to has_player_subject:false, never the mild 0.855 unresolved-
// player path. See editorialEnrichmentContext.js's own "PLAYER-SUBJECT
// GATE" comment for the full reasoning.
// ---------------------------------------------------------------------------

test("41. single confident player subject + resolved identity -> has_player_subject true", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.subject.visual_subject_type, "player");
  assert.equal(result.subject.subject_match_count, 1);
  assert.equal(result.subject.player_subject_established, true);
  assert.equal(result.player_context.has_player_subject, true);
  assert.equal(result.player_context.player_id, "00-0000001");
  assert.ok(result.reason_codes.includes("player_subject_confirmed"));
});

test("42. single confident player subject + unresolved identity -> has_player_subject true, mild unresolved-player multiplier preserved", () => {
  const story = makeStory({ headline: "Totally Different Player expected to start", players: ["Totally Different Player"], sources: [source({ headline: "Totally Different Player expected to start", description: "A player not in our roster fixture." })] });
  const { roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture(); // index/rows for a DIFFERENT player — this name won't match
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.subject.subject_match_count, 1);
  assert.equal(result.player_context.has_player_subject, true);
  assert.equal(result.player_context.player_id, null); // identity genuinely unresolved
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.notEqual(scored.enrichment.enriched_total, scored.total_score); // the locked 0.855-ish path, NOT neutral
});

test("43. coach + player ambiguous headline (coach is the recomputed subject) -> has_player_subject false, multiplier 1.0", () => {
  // The player's name is only in the DESCRIPTION, never the headline, so
  // determineVisualSubject's player-candidate branch finds nothing in the
  // headline and correctly falls through to coach detection.
  const story = makeStory({
    headline: "Chiefs Head Coach Andy Reid discusses quarterback situation",
    players: ["Patrick Mahomes"],
    sources: [source({ headline: "Chiefs Head Coach Andy Reid discusses quarterback situation", description: "Head Coach Andy Reid said Patrick Mahomes will play." })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject_type, "coach");
  assert.equal(result.subject.player_subject_established, false);
  assert.equal(result.player_context.has_player_subject, false);
  assert.ok(result.reason_codes.includes("player_subject_not_player"));
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.equal(scored.enrichment.enriched_total, scored.total_score); // neutral, 1.0 multiplier
});

test("44. two-player ambiguous headline -> has_player_subject false, multiplier 1.0", () => {
  const story = makeStory({
    headline: "Test Player Alpha and Test Player Beta both expected to play Week 1",
    players: ["Test Player Alpha", "Test Player Beta"],
    sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject_type, "player");
  assert.ok(result.subject.subject_match_count > 1);
  assert.equal(result.player_context.has_player_subject, false);
  assert.ok(result.reason_codes.includes("player_subject_ambiguous"));
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.equal(scored.enrichment.enriched_total, scored.total_score);
});

test("45. known non-player organizational subject (single dominant team) -> has_player_subject false", () => {
  const story = makeStory({ headline: "Chiefs announce new stadium renovation plans", players: [], teams: ["Kansas City Chiefs"], current_team: null, sources: [source({ headline: "Chiefs announce new stadium renovation plans", description: "The team unveiled the plans Monday." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject_type, "team");
  assert.equal(result.player_context.has_player_subject, false);
  assert.ok(result.reason_codes.includes("player_subject_not_player"));
});

test("46. subject_match_count === 0 with nothing confidently found at all -> neutral", () => {
  const story = makeStory({ headline: "League discusses future scheduling formats", players: [], teams: [], current_team: null, category: "other", sources: [source({ headline: "League discusses future scheduling formats", description: "No specific team or player was named." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject_type, null);
  assert.equal(result.subject.subject_match_count, 0);
  assert.equal(result.player_context.has_player_subject, false);
  assert.ok(result.reason_codes.includes("player_subject_not_established"));
});

test("47. subject_match_count > 1 -> neutral (locked semantics never establish a single safe player from the weak fallback)", () => {
  const story = makeStory({
    headline: "Sean McVay expects Puka Nacua and Nick Bosa to play in Week 1",
    players: ["Sean McVay", "Puka Nacua", "Nick Bosa"],
    sources: [source({ headline: "Sean McVay expects Puka Nacua and Nick Bosa to play in Week 1", description: "The Rams and 49ers both expect their stars to suit up." })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.ok(result.subject.subject_match_count > 1);
  assert.equal(result.player_context.has_player_subject, false);
});

test("48. story.player_context remains ignored even in the ambiguous ->neutral case", () => {
  const story = makeStory({
    headline: "Test Player Alpha and Test Player Beta both expected to play Week 1",
    players: ["Test Player Alpha", "Test Player Beta"],
    sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })],
  });
  const enrichment = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  const storyWithBogusField = { ...story, player_context: { has_player_subject: true, normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", player_id: "fake", identity_confidence: "high", star_level: "elite", star_matched: true } };
  const result = scoreStory(storyWithBogusField);
  assert.equal(result.enrichment.enriched_total, result.total_score);
  assert.equal(enrichment.player_context.has_player_subject, false); // sanity: the real orchestrator output stayed neutral too
});

test("49. no input mutation in the ambiguous path", () => {
  const story = makeStory({
    headline: "Test Player Alpha and Test Player Beta both expected to play Week 1",
    players: ["Test Player Alpha", "Test Player Beta"],
    sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })],
  });
  const snapshot = JSON.stringify(story);
  buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(JSON.stringify(story), snapshot);
});

test("50. deterministic repeated invocation in the ambiguous path", () => {
  const story = makeStory({
    headline: "Chiefs Head Coach Andy Reid discusses quarterback situation",
    players: ["Patrick Mahomes"],
    sources: [source({ headline: "Chiefs Head Coach Andy Reid discusses quarterback situation", description: "Head Coach Andy Reid said Patrick Mahomes will play." })],
  });
  const input = { story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS };
  const a = buildEditorialPlayerContext(input);
  const b = buildEditorialPlayerContext(input);
  assert.deepEqual(a, b);
});

test("51. legacy total/destination remain unchanged for an ambiguous-subject story", () => {
  const story = makeStory({
    headline: "Test Player Alpha and Test Player Beta both expected to play Week 1",
    players: ["Test Player Alpha", "Test Player Beta"],
    sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })],
  });
  const enrichment = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  const legacyAlone = scoreStory(story);
  const withEnrichment = scoreStory(story, { player_context: enrichment.player_context });
  assert.equal(withEnrichment.total_score, legacyAlone.total_score);
  assert.deepEqual(withEnrichment.destination, legacyAlone.destination);
});

test("52. enriched preview for the ambiguous/non-player cases exactly equals legacy score (no player-multiplier effect at all)", () => {
  const coachStory = makeStory({ headline: "Chiefs Head Coach Andy Reid discusses quarterback situation", players: ["Patrick Mahomes"], sources: [source({ headline: "Chiefs Head Coach Andy Reid discusses quarterback situation", description: "Head Coach Andy Reid said Patrick Mahomes will play." })] });
  const twoPlayerStory = makeStory({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", players: ["Test Player Alpha", "Test Player Beta"], sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })] });
  for (const story of [coachStory, twoPlayerStory]) {
    const enrichment = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
    const scored = scoreStory(story, { player_context: enrichment.player_context });
    assert.equal(scored.enrichment.enriched_total, scored.total_score);
  }
});

test("53. true unresolved-player case remains distinct from ambiguous-neutral case", () => {
  const unresolvedPlayerStory = makeStory({ headline: "Totally Different Player expected to start", players: ["Totally Different Player"], sources: [source({ headline: "Totally Different Player expected to start", description: "A player not in our roster fixture." })] });
  const ambiguousStory = makeStory({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", players: ["Test Player Alpha", "Test Player Beta"], sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })] });
  const { roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();

  const unresolved = buildEditorialPlayerContext({ story: unresolvedPlayerStory, roster_rows, depth_chart_rows, schedule_rows, player_index });
  const ambiguous = buildEditorialPlayerContext({ story: ambiguousStory, roster_rows, depth_chart_rows, schedule_rows, player_index });

  assert.equal(unresolved.player_context.has_player_subject, true); // Case A
  assert.equal(ambiguous.player_context.has_player_subject, false); // Case B
  assert.notDeepEqual(unresolved.player_context, ambiguous.player_context);

  const unresolvedScored = scoreStory(unresolvedPlayerStory, { player_context: unresolved.player_context });
  const ambiguousScored = scoreStory(ambiguousStory, { player_context: ambiguous.player_context });
  assert.notEqual(unresolvedScored.enrichment.enriched_total, unresolvedScored.total_score); // Case A: mild dampening applies
  assert.equal(ambiguousScored.enrichment.enriched_total, ambiguousScored.total_score); // Case B: exactly neutral
});

// ---------------------------------------------------------------------------
// PLAYERS[] SUPPORT CHECK (54-73) — an additional condition C on top of the
// existing gate: the confirmed visual_subject must also be normalized-
// matched (Phase 2B's own locked normalizeName(), no new logic) somewhere
// in story.players[]. Real, but demonstrated NOT sufficient by itself for
// the dominant real-world case (a coach's name self-referentially present
// in players[], since visual_subject was drawn FROM players[] in the first
// place) — see editorialEnrichmentContext.js's own "ADDITIONAL PLAYERS[]
// SUPPORT CHECK" comment. It IS real protection for the headline-only
// fallback path (players[] empty, subject drawn straight from the headline
// instead) — that is what most of these tests exercise.
// ---------------------------------------------------------------------------

test("54. single real NFL player subject present in players[] -> established, has_player_subject true", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.subject.player_list_support, true);
  assert.equal(result.subject.player_subject_established, true);
  assert.equal(result.player_context.has_player_subject, true);
});

test("55. same as 54 but identity unresolved -> has_player_subject true, mild 0.855-ish behavior preserved", () => {
  const story = makeStory({ headline: "Totally Different Player expected to start", players: ["Totally Different Player"], sources: [source({ headline: "Totally Different Player expected to start", description: "A player not in our roster fixture." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.player_list_support, true); // "Totally Different Player" is in players[]
  assert.equal(result.player_context.has_player_subject, true);
  assert.equal(result.player_context.player_id, null);
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.notEqual(scored.enrichment.enriched_total, scored.total_score);
});

test("56. single NFL coach-like headline candidate NOT present in players[] (headline-only fallback) -> neutral, multiplier 1.0", () => {
  // players[] intentionally empty -> determineVisualSubject's headline-only
  // fallback fires (extractLikelyPlayerNames on the HEADLINE, independent
  // of players[]) -- exactly the path this check DOES protect.
  const story = makeStory({ headline: "Sean McVay discusses Rams season outlook", players: [], sources: [source({ headline: "Sean McVay discusses Rams season outlook", description: "The team is confident heading into Week 1." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject, "Sean McVay");
  assert.equal(result.subject.visual_subject_type, "player"); // determineVisualSubject itself has no coach awareness here
  assert.equal(result.subject.subject_match_count, 1);
  assert.equal(result.subject.player_list_support, false); // NOT in players[] (empty)
  assert.equal(result.player_context.has_player_subject, false);
  assert.ok(result.reason_codes.includes("player_subject_not_supported_by_players"));
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.equal(scored.enrichment.enriched_total, scored.total_score);
});

test("57. Andy Reid single-candidate synthetic case -> must not become unresolved player when players[] does not support him", () => {
  const story = makeStory({ headline: "Andy Reid addresses Chiefs quarterback plans", players: [], sources: [source({ headline: "Andy Reid addresses Chiefs quarterback plans", description: "The coach spoke to reporters Monday." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject, "Andy Reid");
  assert.equal(result.subject.player_list_support, false);
  assert.equal(result.player_context.has_player_subject, false);
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.equal(scored.enrichment.enriched_total, scored.total_score);
});

test("58. NFL executive single-candidate case (unsupported by players[]) -> neutral", () => {
  const story = makeStory({ headline: "Jerry Jones addresses Cowboys cap situation", players: [], sources: [source({ headline: "Jerry Jones addresses Cowboys cap situation", description: "The owner spoke about the team's finances." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject, "Jerry Jones");
  assert.equal(result.subject.player_list_support, false);
  assert.equal(result.player_context.has_player_subject, false);
});

test("59. reporter/person-name single-candidate case (unsupported by players[]) -> neutral", () => {
  // Uses "discusses" rather than "breaks" deliberately — "breaks" is itself
  // already caught by extraction.js's own locked BYLINE_FOLLOWING_VERBS
  // guard ("X breaks down..." is a columnist byline pattern), which would
  // exercise a different, already-covered code path than the one this test
  // targets (a name-shaped candidate that DOES survive extraction but is
  // still correctly unsupported by an empty players[]).
  const story = makeStory({ headline: "Some Random Reporter discusses the quarterback battle", players: [], sources: [source({ headline: "Some Random Reporter discusses the quarterback battle", description: "An analysis of the situation." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject_type, "player"); // extraction has no reporter-type awareness either, absent a KNOWN_REPORTERS/byline-verb match
  assert.equal(result.subject.player_list_support, false);
  assert.equal(result.player_context.has_player_subject, false);
});

test("60. ambiguous two-name case -> neutral regardless of players[] support", () => {
  const story = makeStory({
    headline: "Test Player Alpha and Test Player Beta both expected to play Week 1",
    players: ["Test Player Alpha", "Test Player Beta"],
    sources: [source({ headline: "Test Player Alpha and Test Player Beta both expected to play Week 1", description: "Both players are healthy." })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.player_context.has_player_subject, false);
  assert.equal(result.subject.player_list_support, null); // ambiguity is checked before players[] support even applies
});

test("61. confident subject but players[] empty (a genuine player name, not just a coach) -> conservative neutral, per the approved fail-closed rule", () => {
  // Documents the accepted recall trade-off: a real player whose name
  // appears only in the headline, with an empty players[] (e.g. a terse
  // description that never repeats the name), now also neutralizes. This
  // is the explicitly approved "false neutral over false player
  // attribution" trade-off, not a bug.
  // Note: the fake name deliberately avoids the literal word "Player" —
  // extraction.js's own NON_STRIPPABLE_REJECT_WORDS rejects any candidate
  // containing it (a real, separate, already-locked guard), which would
  // make this fixture fall through to a team-type subject instead of
  // exercising the headline-only-fallback path this test targets.
  const story = makeStory({ headline: "Marcus Testfield discusses new contract", players: [], sources: [source({ headline: "Marcus Testfield discusses new contract", description: "He is pleased with the new deal." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.subject.visual_subject_type, "player");
  assert.equal(result.subject.subject_match_count, 1);
  assert.equal(result.subject.player_list_support, false);
  assert.equal(result.player_context.has_player_subject, false);
});

test("62. normalization is available for benign formatting differences, though architecturally rarely reachable end-to-end", () => {
  // IMPORTANT, discovered during this hardening pass: when players.length > 0,
  // determineVisualSubject's own candidate pool IS players[] itself, and its
  // own inHeadline check is a raw, case-sensitive substring match — so
  // whatever it selects as visual_subject is ALWAYS already byte-identical
  // to the players[] entry that matched (a formatting difference would have
  // prevented that entry from matching the headline at all, falling through
  // to a non-"player" subject type instead — see test 63 below). The
  // normalizeName() comparison is still real, defensive code (reused, not
  // invented) — this test proves it directly rather than overclaiming an
  // end-to-end scenario the real architecture cannot produce.
  const players = ["Ja'Marr Chase"];
  const result = buildEditorialPlayerContext({
    story: makeStory({ headline: "Ja'Marr Chase expected to play through minor injury", players, sources: [source({ headline: "Ja'Marr Chase expected to play through minor injury", description: "He is listed as questionable." })] }),
    roster_rows: [],
    depth_chart_rows: [],
    schedule_rows: SCHEDULE_ROWS,
  });
  assert.equal(result.subject.visual_subject, "Ja'Marr Chase");
  assert.equal(result.subject.player_list_support, true);
  // A curly-apostrophe duplicate of the SAME real name elsewhere in players[]
  // (plausible messy real-world data) does not break support or crash.
  const resultWithMessyDuplicate = buildEditorialPlayerContext({
    story: makeStory({ headline: "Ja'Marr Chase expected to play through minor injury", players: ["Ja'Marr Chase", "Ja’Marr Chase"], sources: [source({ headline: "Ja'Marr Chase expected to play through minor injury", description: "He is listed as questionable." })] }),
    roster_rows: [],
    depth_chart_rows: [],
    schedule_rows: SCHEDULE_ROWS,
  });
  assert.equal(resultWithMessyDuplicate.subject.player_list_support, true);
});

test("63. architectural invariant: when players[] is non-empty, a 'player'-typed visual_subject can NEVER fail the support check (it was drawn FROM players[] itself) — player_subject_not_supported_by_players is only reachable via the empty-players[] headline-only fallback", () => {
  // "Andy Reid" is only mentioned in the HEADLINE, not in players[] or the
  // description — with players[] non-empty (["Patrick Mahomes"]),
  // determineVisualSubject's branch 1 candidates ARE players[] itself, and
  // "Patrick Mahomes" never appears in this headline, so branch 1 produces
  // NOTHING at all (not "Andy Reid") — it falls through to the team-type
  // fallback instead. This documents, rather than works around, that real
  // constraint.
  const story = makeStory({
    headline: "Andy Reid addresses Chiefs quarterback plans",
    players: ["Patrick Mahomes"],
    teams: ["Kansas City Chiefs"],
    current_team: null,
    sources: [source({ headline: "Andy Reid addresses Chiefs quarterback plans", description: "The coach discussed Patrick Mahomes's health." })],
  });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.notEqual(result.subject.visual_subject, "Andy Reid"); // branch 1 could not select him — players[] didn't contain him
  assert.equal(result.subject.visual_subject_type, "team"); // falls through to the single-dominant-team branch instead
  assert.equal(result.player_context.has_player_subject, false);
});

test("64. duplicate players[] entries matching the headline correctly trigger the (already-locked) ambiguous multi-candidate branch, not a crash", () => {
  // A real, locked determineVisualSubject behavior worth documenting: two
  // IDENTICAL players[] entries both independently satisfy inHeadline's
  // per-entry substring filter, so inHeadline.length becomes 2 (not 1) even
  // though there is only one underlying name — correctly routed to the
  // ambiguous branch (never a crash, never miscounted as confirmed).
  const story = makeStory({ headline: "Marcus Testfield expected to start", players: ["Marcus Testfield", "Marcus Testfield"], sources: [source({ headline: "Marcus Testfield expected to start", description: "..." })] });
  const a = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  const b = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.deepEqual(a, b); // deterministic either way
  assert.equal(a.subject.subject_match_count, 2);
  assert.equal(a.player_context.has_player_subject, false);
});

test("65. story.players[] not mutated by the support check", () => {
  const story = makeStory({ headline: "Andy Reid addresses Chiefs quarterback plans", players: ["Patrick Mahomes"], sources: [source({ headline: "Andy Reid addresses Chiefs quarterback plans", description: "..." })] });
  const snapshot = JSON.stringify(story.players);
  buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(JSON.stringify(story.players), snapshot);
});

test("66. true NFL non-player/organizational story -> multiplier 1.0 (unaffected by the players[] check)", () => {
  const story = makeStory({ headline: "Chiefs announce new stadium renovation plans", players: [], teams: ["Kansas City Chiefs"], current_team: null, sources: [source({ headline: "Chiefs announce new stadium renovation plans", description: "The team unveiled the plans Monday." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  assert.equal(result.player_context.has_player_subject, false);
  const scored = scoreStory(story, { player_context: result.player_context });
  assert.equal(scored.enrichment.enriched_total, scored.total_score);
});

test("67. true unresolved NFL-player story -> approximately 0.855 (unaffected by the players[] check)", () => {
  const story = makeStory({ headline: "Totally Different Player expected to start", players: ["Totally Different Player"], sources: [source({ headline: "Totally Different Player expected to start", description: "..." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  const scored = scoreStory(story, { player_context: result.player_context });
  const impliedMultiplier = scored.enrichment.enriched_total / scored.enrichment.legacy_total;
  assert.ok(Math.abs(impliedMultiplier - 0.855) < 0.05, `expected ~0.855, got ${impliedMultiplier}`);
});

test("68. resolved NFL-player story -> normal position/role path unchanged by the new gate", () => {
  const { story, roster_rows, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.status, "resolved");
  assert.equal(result.player_context.normalized_position, "QB");
  assert.equal(result.player_context.effective_role, "starter");
});

test("69. legacy total/destination remain unchanged for a coach-misidentified-as-player-candidate story", () => {
  const story = makeStory({ headline: "Sean McVay discusses Rams season outlook", players: [], sources: [source({ headline: "Sean McVay discusses Rams season outlook", description: "The team is confident heading into Week 1." })] });
  const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
  const legacyAlone = scoreStory(story);
  const withEnrichment = scoreStory(story, { player_context: result.player_context });
  assert.equal(withEnrichment.total_score, legacyAlone.total_score);
  assert.deepEqual(withEnrichment.destination, legacyAlone.destination);
});

test("70. repeated invocation deterministic for the coach-unsupported case", () => {
  const story = makeStory({ headline: "Sean McVay discusses Rams season outlook", players: [], sources: [source({ headline: "Sean McVay discusses Rams season outlook", description: "The team is confident heading into Week 1." })] });
  const input = { story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS };
  assert.deepEqual(buildEditorialPlayerContext(input), buildEditorialPlayerContext(input));
});

test("71. no Date.now dependency introduced by the players[] support check", () => {
  const original = Date.now;
  Date.now = () => {
    throw new Error("must never call Date.now()");
  };
  try {
    const story = makeStory({ headline: "Sean McVay discusses Rams season outlook", players: [], sources: [source({ headline: "Sean McVay discusses Rams season outlook", description: "The team is confident heading into Week 1." })] });
    const result = buildEditorialPlayerContext({ story, roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS });
    assert.equal(result.player_context.has_player_subject, false);
  } finally {
    Date.now = original;
  }
});

test("72. no future roster/depth/schedule evidence introduced (temporal logic untouched, composes fine with the new gate)", () => {
  const { story, depth_chart_rows, schedule_rows, player_index } = starterQbFixture();
  const roster_rows = [rosterRow({ week: 3 }), rosterRow({ week: 20, gsis_id: "00-0000099" })];
  const result = buildEditorialPlayerContext({ story, roster_rows, depth_chart_rows, schedule_rows, player_index });
  assert.equal(result.temporal.diagnostics.future_roster_rejected, true);
  assert.equal(result.player_context.normalized_position, "QB"); // correct week still selected
});

test("73. story.player_context remains ignored (coach-unsupported case)", () => {
  const story = makeStory({ headline: "Sean McVay discusses Rams season outlook", players: [], sources: [source({ headline: "Sean McVay discusses Rams season outlook", description: "The team is confident heading into Week 1." })] });
  const storyWithBogusField = { ...story, player_context: { has_player_subject: true, normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", player_id: "fake", identity_confidence: "high", star_level: "elite", star_matched: true } };
  const result = scoreStory(storyWithBogusField);
  assert.equal(result.enrichment.enriched_total, result.total_score);
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
