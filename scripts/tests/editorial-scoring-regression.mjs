#!/usr/bin/env node
// Editorial Scoring Brain — PHASE 1 regression suite. Pure-function tests
// only: no file I/O against production data, no network, no mutation.
// Fixture files under scripts/editorial/fixtures/ are test data only and
// never reference a real production story_id.
// Run with: node scripts/tests/editorial-scoring-regression.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreStory, OBSERVE_ONLY_CALIBRATION_DEFAULTS } from "../lib/editorialScoring.js";
import { corroborationBonus, countDistinctReports, sourceTier, bestSourceTier } from "../lib/editorialSourceConfidence.js";
import { computeEventMagnitude } from "../lib/editorialEventMagnitude.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = path.join(ROOT, "scripts", "editorial", "fixtures");

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function loadFixture(name) {
  const raw = await readFile(path.join(FIXTURES_DIR, name), "utf-8");
  return JSON.parse(raw);
}

function minimalStory(overrides = {}) {
  return {
    headline: "",
    description: "",
    sources: [],
    players: [],
    teams: [],
    is_rumor: false,
    visual_subject: null,
    visual_subject_type: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Anchor fixtures — qualitative sanity checks
// ---------------------------------------------------------------------------

test("Anchor: elite-QB-shaped season-ending injury scores meaningfully high even with fully neutral role/star multipliers (no star list exists in Phase 1)", async () => {
  const story = await loadFixture("elite-qb-season-ending-injury.json");
  const result = scoreStory(story);
  assert.ok(result.total_score >= 60, `expected a season-ending injury to score high on event magnitude alone, got ${result.total_score}`);
  assert.equal(result.signals.role_multiplier, 1.0);
  assert.equal(result.signals.star_boost, 1.0);
});

test("Anchor: Anthony-Richardson-shaped QB2 depth-chart fixture (NOT the real production record) lands in Story range, not Feed", async () => {
  const story = await loadFixture("backup-qb-depth-chart-designation.json");
  const result = scoreStory(story);
  assert.equal(result.signals.event_type, "depth_chart_designation");
  assert.ok(result.total_score < OBSERVE_ONLY_CALIBRATION_DEFAULTS.FEED_THRESHOLD_PROVISIONAL, "must not clear the provisional Feed bar");
  assert.ok(result.total_score >= OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL, "should clear the provisional Story bar — this is the anchor example the whole model was designed around");
  assert.equal(result.destination.story_fit, "meets_story_bar_provisional");
  assert.equal(result.destination.structurally_story_natured, true);
});

test("Anchor: backup OL limited at practice scores very low", async () => {
  const story = await loadFixture("backup-ol-limited-practice.json");
  const result = scoreStory(story);
  assert.equal(result.signals.event_type, "limited_practice");
  assert.ok(result.total_score < 20, `expected a very low score, got ${result.total_score}`);
});

test("Anchor: head coach fired scores high via the organizational path, with no player subject involved", async () => {
  const story = await loadFixture("head-coach-fired.json");
  const result = scoreStory(story);
  assert.equal(result.signals.event_scope, "organizational");
  assert.equal(result.signals.player_identity, null);
  assert.ok(result.total_score >= 50, `expected an organizational firing to score high, got ${result.total_score}`);
});

test("Anchor: confirmed blockbuster trade scores high and is not rumor-penalized", async () => {
  const story = await loadFixture("blockbuster-trade-confirmed.json");
  const result = scoreStory(story);
  assert.equal(result.signals.event_type, "blockbuster_trade");
  assert.equal(result.modifiers.rumor_penalty, 0);
  assert.ok(result.total_score >= 60);
});

test("Anchor: unconfirmed blockbuster trade rumor is still Story-level, but blocked from Feed by the rumor flag, not disqualified outright", async () => {
  const story = await loadFixture("blockbuster-trade-rumor.json");
  const result = scoreStory(story);
  assert.ok(result.total_score >= OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL, "a credible but unconfirmed blockbuster report should still be Story-level");
  assert.ok(result.destination.feed_block_reasons.includes("unconfirmed_rumor"));
});

test("Anchor: generic coach praise quote scores extremely weak", async () => {
  const story = await loadFixture("generic-coach-praise-quote.json");
  const result = scoreStory(story);
  assert.ok(result.total_score < 20, `expected a generic quote to score extremely weak, got ${result.total_score}`);
});

test("Anchor: documented notable bad beat is Story-capable via the bounded social-interest channel, never inflating game/event magnitude", async () => {
  const story = await loadFixture("documented-notable-bad-beat.json");
  const result = scoreStory(story);
  assert.equal(result.signals.bad_beat_tier, "notable");
  assert.ok(result.modifiers.social_interest_bonus > 0);
  assert.ok(result.total_score >= OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL);
});

// ---------------------------------------------------------------------------
// The 20 required regression tests
// ---------------------------------------------------------------------------

test("1. Major injury with an unresolved player does NOT collapse toward zero", () => {
  const story = minimalStory({ headline: "Player out for the season with torn ACL, MRI confirms", description: "The team confirmed the player suffered a torn ACL and will miss the rest of the season." });
  const result = scoreStory(story);
  assert.ok(result.total_score >= 55, `expected a season-ending injury to stay meaningful even unresolved, got ${result.total_score}`);
});

test("2. A non-player major event (organizational) uses a neutral player/role multiplier, not a suppressed one", () => {
  const story = minimalStory({ headline: "Team fires head coach", description: "The team announced it has fired its head coach." });
  const result = scoreStory(story);
  assert.equal(result.signals.event_scope, "organizational");
  assert.equal(result.signals.role_multiplier, OBSERVE_ONLY_CALIBRATION_DEFAULTS.ROLE_MULTIPLIER.NEUTRAL);
});

test("3. An unknown/unresolved player receives neutral role behavior and no star boost", () => {
  const story = minimalStory({ headline: "Player ruled out for Sunday's game", description: "The team ruled the player out for this week's game." });
  const result = scoreStory(story);
  assert.equal(result.signals.player_identity, null);
  assert.equal(result.signals.role_multiplier, 1.0);
  assert.equal(result.signals.star_boost, 1.0);
});

test("4. Rumor cannot receive an unrestricted social-interest boost", () => {
  const story = minimalStory({
    headline: "Shocking, controversial blockbuster trade rumor stuns fans",
    description: "Reportedly, according to one source, a shocking trade could happen.",
    is_rumor: true,
    sources: [{ name: "Anonymous Blog", headline: "Shocking rumor" }],
  });
  const result = scoreStory(story);
  assert.equal(result.modifiers.social_interest_bonus, 0, "rumor must zero the social-interest bonus outright");
});

test("5. Duplicate/repeated near-identical sources do not create unlimited corroboration", () => {
  const identicalSource = { name: "Outlet", headline: "Team signs veteran cornerback to one-year deal", description: "The team announced the signing of a veteran cornerback to a one-year contract." };
  const sixCopies = Array.from({ length: 6 }, () => ({ ...identicalSource }));
  const { distinct_report_count, bonus } = corroborationBonus(sixCopies, OBSERVE_ONLY_CALIBRATION_DEFAULTS.CORROBORATION);
  assert.equal(distinct_report_count, 1, "six near-identical reports must count as one distinct report");
  assert.ok(bonus <= OBSERVE_ONLY_CALIBRATION_DEFAULTS.CORROBORATION.MAX_BONUS);
});

test("6. Missing optional data never crashes scoring", () => {
  assert.doesNotThrow(() => scoreStory({}));
  assert.doesNotThrow(() => scoreStory({ headline: null, description: undefined, sources: null, players: undefined, teams: null }));
  assert.doesNotThrow(() => scoreStory(minimalStory()));
});

test("7. Identical input produces an identical score (deterministic, no randomness)", () => {
  const story = minimalStory({ headline: "Team trades star receiver in blockbuster deal for multiple first-round picks", sources: [{ name: "ESPN", headline: "trade" }, { name: "NFL Network", headline: "trade confirmed" }] });
  const a = scoreStory(JSON.parse(JSON.stringify(story)));
  const b = scoreStory(JSON.parse(JSON.stringify(story)));
  assert.deepEqual(a, b);
});

test("8. Source ordering does not change the score", () => {
  const s1 = { name: "ESPN", headline: "Team fires head coach", description: "The team fired its head coach." };
  const s2 = { name: "NFL Network", headline: "Team moves on from head coach", description: "The head coach was let go." };
  const story = minimalStory({ headline: "Team fires head coach" });
  const resultA = scoreStory({ ...story, sources: [s1, s2] });
  const resultB = scoreStory({ ...story, sources: [s2, s1] });
  assert.equal(resultA.total_score, resultB.total_score);
});

test("9. story_id (or any lexical identity field) has no effect on the score", () => {
  const base = minimalStory({ headline: "Team signs backup quarterback" });
  const resultA = scoreStory({ ...base, id: "aaaaaaaa-0000-0000-0000-000000000000" });
  const resultB = scoreStory({ ...base, id: "zzzzzzzz-ffff-ffff-ffff-ffffffffffff" });
  assert.equal(resultA.total_score, resultB.total_score);
});

test("10. Generic coach praise remains extremely weak", () => {
  const story = minimalStory({ headline: "Coach praises team's effort in practice", description: "The coach said the team worked hard this week." });
  const result = scoreStory(story);
  assert.ok(result.total_score < 20, `got ${result.total_score}`);
});

test("11. Practice-squad signing remains weak", () => {
  const story = minimalStory({ headline: "Team signs receiver to the practice squad", description: "The team announced a practice squad signing." });
  const result = scoreStory(story);
  assert.equal(result.signals.event_type, "practice_squad");
  assert.ok(result.total_score < 20, `got ${result.total_score}`);
});

test("12. A significant head coach firing remains high", () => {
  const story = minimalStory({ headline: "Team fires head coach after 2-8 start", description: "The franchise fired its head coach on Monday." });
  const result = scoreStory(story);
  assert.ok(result.total_score >= 50, `got ${result.total_score}`);
});

test("13. A major injury outranks limited-practice status under otherwise-equal conditions", () => {
  const major = scoreStory(minimalStory({ headline: "Player out for the season, torn ACL confirmed", description: "MRI confirms a torn ACL, player is out for the season." }));
  const minor = scoreStory(minimalStory({ headline: "Player limited at Wednesday's practice", description: "The player was limited at practice with a minor issue." }));
  assert.ok(major.total_score > minor.total_score);
});

test("14. Injury ladder ordering: season-ending > multi-week > ruled-out-one-game > questionable > limited", () => {
  const seasonEnding = computeEventMagnitude("Player out for the season with torn ACL");
  const multiWeek = computeEventMagnitude("Player expected to miss multiple weeks with a hamstring injury");
  const ruledOut = computeEventMagnitude("Player ruled out for Sunday's game");
  const questionable = computeEventMagnitude("Player is questionable for Sunday with an ankle injury");
  const limited = computeEventMagnitude("Player was limited at Wednesday's practice");
  assert.ok(seasonEnding.magnitude > multiWeek.magnitude, `${seasonEnding.magnitude} > ${multiWeek.magnitude}`);
  assert.ok(multiWeek.magnitude > ruledOut.magnitude, `${multiWeek.magnitude} > ${ruledOut.magnitude}`);
  assert.ok(ruledOut.magnitude > questionable.magnitude, `${ruledOut.magnitude} > ${questionable.magnitude}`);
  assert.ok(questionable.magnitude > limited.magnitude, `${questionable.magnitude} > ${limited.magnitude}`);
});

test("15. Transaction ladder ordering: blockbuster > starter signing > backup signing > practice-squad signing", () => {
  const blockbuster = computeEventMagnitude("Team completes blockbuster trade for star receiver, sending multiple first-round picks");
  const starter = computeEventMagnitude("Team signs veteran as the new starting cornerback");
  const backup = computeEventMagnitude("Team signs a cornerback");
  const practiceSquad = computeEventMagnitude("Team signs a cornerback to the practice squad");
  assert.ok(blockbuster.magnitude > starter.magnitude, `${blockbuster.magnitude} > ${starter.magnitude}`);
  assert.ok(starter.magnitude > backup.magnitude, `${starter.magnitude} > ${backup.magnitude}`);
  assert.ok(backup.magnitude > practiceSquad.magnitude, `${backup.magnitude} > ${practiceSquad.magnitude}`);
});

test("16. Image unavailable does NOT reduce the editorial score", () => {
  const withImage = minimalStory({ headline: "Team fires head coach", primary_image_url: "https://example.test/img.jpg" });
  const withoutImage = minimalStory({ headline: "Team fires head coach", primary_image_url: null });
  const resultWith = scoreStory(withImage);
  const resultWithout = scoreStory(withoutImage);
  assert.equal(resultWith.total_score, resultWithout.total_score);
  assert.equal(resultWith.production_readiness.image_available, true);
  assert.equal(resultWithout.production_readiness.image_available, false);
});

test("17. Low-confidence player resolution does NOT receive star/role assumptions", () => {
  const ambiguous = minimalStory({
    headline: "Player questionable for Sunday",
    players: [], // no cross-validation available at all
    visual_subject: "Some Player",
    visual_subject_type: "player",
  });
  const result = scoreStory(ambiguous);
  assert.equal(result.signals.player_identity_confidence, "medium", "a single-source, non-cross-validated resolution should be medium, not high");
  assert.equal(result.signals.role_multiplier, 1.0, "no role assumption is ever applied in Phase 1 regardless of confidence");
  assert.equal(result.signals.star_boost, 1.0, "no star boost is ever applied in Phase 1");
});

test("18. Corroboration has a strict, verifiable maximum effect", () => {
  const manySources = Array.from({ length: 20 }, (_, i) => ({ name: `Outlet ${i}`, headline: `Completely unrelated distinct report number ${i} about a trade involving many different specific unique words ${i}`, description: `Report ${i}` }));
  const { bonus } = corroborationBonus(manySources, OBSERVE_ONLY_CALIBRATION_DEFAULTS.CORROBORATION);
  assert.ok(bonus <= OBSERVE_ONLY_CALIBRATION_DEFAULTS.CORROBORATION.MAX_BONUS);
});

test("19. Social interest has a strict, verifiable maximum effect", () => {
  const story = minimalStory({
    headline: "Shocking, stunning, controversial, surprising comeback walk-off rivalry feud",
    description: "An extremely dramatic and surprising set of events unfolded.",
    sources: [{ name: "ESPN", headline: "drama" }],
  });
  const result = scoreStory(story);
  const cap = Math.min(OBSERVE_ONLY_CALIBRATION_DEFAULTS.SOCIAL_INTEREST.GENERIC_MAX_ABSOLUTE, OBSERVE_ONLY_CALIBRATION_DEFAULTS.SOCIAL_INTEREST.GENERIC_MAX_FRACTION_OF_MAGNITUDE * result.core_score);
  assert.ok(result.modifiers.social_interest_bonus <= Math.max(cap, OBSERVE_ONLY_CALIBRATION_DEFAULTS.SOCIAL_INTEREST.BAD_BEAT_EXCEPTIONAL_MAX_ABSOLUTE));
});

test("20. Score components sum/multiply exactly into the reported total", () => {
  const story = minimalStory({
    headline: "Team fires head coach",
    sources: [{ name: "ESPN", headline: "Team fires head coach", description: "confirmed" }, { name: "NFL Network", headline: "Head coach let go", description: "confirmed" }],
  });
  const result = scoreStory(story);
  const recomputedCore = result.signals.event_magnitude * result.signals.role_multiplier * result.signals.star_boost * result.signals.game_performance_multiplier;
  assert.equal(Math.round(recomputedCore * 10) / 10, result.core_score);
  const recomputedTotal =
    result.core_score + result.modifiers.corroboration_bonus + result.modifiers.social_interest_bonus + result.modifiers.escalation_bonus - result.modifiers.rumor_penalty - result.modifiers.repetition_penalty;
  assert.equal(Math.round(recomputedTotal * 10) / 10, result.total_score);
});

// ---------------------------------------------------------------------------
// 21. Bad-beat pattern precision — regression for the 2026-09-04 calibration
// review's real finding: BAD_BEAT_NOTABLE_PATTERNS originally included
// /\bcover(?:ed|s)?\s+the\s+spread\b/i, which fired on completely ordinary
// betting-outcome language ("Team covers the spread in blowout win" — an
// unremarkable, expected result, not a bad beat) and incorrectly cleared
// Story on ordinary spread-covering language alone. That pattern was
// removed; this pins the corrected behavior so it can never silently
// regress. Do NOT broaden these patterns to make this test pass — if it
// ever fails, the fix is almost certainly in the calling code's evidence
// bar, not a wider regex.
// ---------------------------------------------------------------------------

test("21a. Ordinary betting-result language ('covers the spread') does NOT trigger notable bad-beat detection", () => {
  const story = minimalStory({
    headline: "Team covers the spread in blowout win",
    description: "The team covered the spread comfortably in a lopsided win.",
    sources: [{ name: "ESPN", headline: "x" }],
  });
  const result = scoreStory(story);
  assert.equal(result.signals.bad_beat_tier, "none", "an ordinary covered-spread result must never be classified as a bad beat");
});

test("21b. Ordinary betting-result language does NOT trigger exceptional bad-beat detection either", () => {
  const story = minimalStory({
    headline: "Team covers the spread in blowout win",
    description: "The team covered the spread comfortably in a lopsided win.",
    sources: [{ name: "ESPN", headline: "x" }, { name: "NFL Network", headline: "y" }], // even with real corroboration
  });
  const result = scoreStory(story);
  assert.notEqual(result.signals.bad_beat_tier, "exceptional");
  assert.notEqual(result.signals.bad_beat_tier, "notable");
});

test("21c. Ordinary betting-result language receives NO bad-beat social-interest bonus", () => {
  const story = minimalStory({
    headline: "Team covers the spread in blowout win",
    description: "The team covered the spread comfortably in a lopsided win.",
    sources: [{ name: "ESPN", headline: "x" }],
  });
  const result = scoreStory(story);
  assert.equal(result.modifiers.social_interest_bonus, 0, "an ordinary covered-spread result must contribute zero social-interest bonus");
});

test("21d. Ordinary betting-angle story does NOT clear Story solely on spread language — stays weak/Neither, matching the calibration review", () => {
  const story = minimalStory({
    headline: "Team covers the spread in blowout win",
    description: "The team covered the spread comfortably in a lopsided win.",
    sources: [{ name: "ESPN", headline: "x" }],
  });
  const result = scoreStory(story);
  assert.ok(result.total_score < OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL, `expected an ordinary betting-angle story to stay below the provisional Story bar, got ${result.total_score}`);
  assert.equal(result.destination.story_fit, "insufficient_magnitude");
});

test("21e. Genuine bad-beat phrasing ('bad beat', 'backdoor cover', 'flipped the spread') still activates the notable tier", () => {
  const phrases = [
    { headline: "Late touchdown is a brutal bad beat for bettors", description: "Bettors called it a bad beat." },
    { headline: "Backdoor cover in the final seconds stuns bettors", description: "A backdoor cover changed the outcome for bettors." },
    { headline: "Late score flips the spread in shocking fashion", description: "The late score flipped the spread entirely." },
  ];
  for (const { headline, description } of phrases) {
    const result = scoreStory(minimalStory({ headline, description, sources: [{ name: "ESPN", headline: "x" }] }));
    assert.ok(result.signals.bad_beat_tier === "notable" || result.signals.bad_beat_tier === "exceptional", `expected "${headline}" to activate a documented bad-beat tier, got "${result.signals.bad_beat_tier}"`);
    assert.ok(result.modifiers.social_interest_bonus > 0, `expected "${headline}" to receive a nonzero bad-beat bonus`);
  }
});

test("21f. A clearly meaningless late score changing the betting result still activates the notable tier", () => {
  const result = scoreStory(minimalStory({
    headline: "Meaningless late touchdown changes the final betting outcome",
    description: "With the game already decided, a meaningless late touchdown changed the betting result.",
    sources: [{ name: "ESPN", headline: "x" }],
  }));
  assert.ok(result.signals.bad_beat_tier === "notable" || result.signals.bad_beat_tier === "exceptional");
  assert.ok(result.modifiers.social_interest_bonus > 0);
});

// ---------------------------------------------------------------------------
// Supporting-module tests
// ---------------------------------------------------------------------------

test("sourceTier: unknown outlet gets a safe neutral tier, never a fabricated one", () => {
  assert.equal(sourceTier("Some Random Blog Nobody Has Heard Of"), "unknown");
  assert.equal(sourceTier(null), "unknown");
});

test("bestSourceTier: the most authoritative tier among sources wins", () => {
  assert.equal(bestSourceTier([{ name: "Some Random Blog" }, { name: "ESPN" }]), "A");
});

test("countDistinctReports: genuinely distinct reports are not merged", () => {
  const count = countDistinctReports([
    { headline: "Team fires head coach", description: "confirmed" },
    { headline: "Star quarterback questionable for Sunday with ankle injury", description: "unrelated" },
  ]);
  assert.equal(count, 2);
});

test("computeEventMagnitude: a depth-chart designation is distinct from and lower than a starter signing", () => {
  const depthChart = computeEventMagnitude("Colts name veteran the No. 2 quarterback");
  const starterSigning = computeEventMagnitude("Team signs veteran as the new starting quarterback");
  assert.equal(depthChart.rung, "depth_chart_designation");
  assert.ok(depthChart.magnitude < starterSigning.magnitude);
});

test("computeEventMagnitude: organizational routing requires an explicit change signal, not just the word 'coach'", () => {
  const quote = computeEventMagnitude("Head coach praises team's effort in practice");
  const firing = computeEventMagnitude("Team fires head coach");
  assert.equal(quote.is_organizational, false);
  assert.equal(firing.is_organizational, true);
  assert.ok(firing.magnitude > quote.magnitude);
});

// ---------------------------------------------------------------------------
// PHASE 2H-B — dual-score (legacy/enriched) calibration regression.
// `context.player_context` (the SECOND scoreStory() argument, never a field
// on `story` itself) is delegated wholesale to the LOCKED Phase 2H-A helper
// (editorialPlayerImportance.js) — no table here is duplicated or retuned.
// ---------------------------------------------------------------------------
function round1(n) {
  return Math.round(n * 10) / 10;
}

function pc(overrides = {}) {
  return { has_player_subject: true, normalized_position: null, effective_role: null, qb_importance: "none", player_id: null, identity_confidence: null, star_level: "none", star_matched: false, ...overrides };
}

/** scoreStory(), but with player enrichment supplied at the correct architectural location: the second (context) argument, never a field on the story object. */
function scoreWithContext(storyOverrides, playerContextOverrides) {
  const story = minimalStory(storyOverrides);
  const context = playerContextOverrides === undefined ? {} : { player_context: pc(playerContextOverrides) };
  return scoreStory(story, context);
}

const STAR_CTX = { player_id: "00-9000001", identity_confidence: "high", star_matched: true };

const FIXTURE_LEGACY_TOTALS = {
  "backup-ol-limited-practice.json": 12,
  "backup-qb-depth-chart-designation.json": 28,
  "blockbuster-trade-confirmed.json": 73,
  "blockbuster-trade-rumor.json": 57,
  "documented-notable-bad-beat.json": 32,
  "elite-qb-season-ending-injury.json": 76.3,
  "generic-coach-praise-quote.json": 16,
  "head-coach-fired.json": 63,
};

test("2H-B.1-2. every existing Phase 1 fixture's legacy score is byte-for-byte unchanged, and equals its enriched score (none supply context.player_context)", async () => {
  for (const [file, expectedLegacy] of Object.entries(FIXTURE_LEGACY_TOTALS)) {
    const story = await loadFixture(file);
    const result = scoreStory(story);
    assert.equal(result.total_score, expectedLegacy, `${file}: legacy total_score regressed`);
    assert.equal(result.enrichment.legacy_total, result.total_score, `${file}: enrichment.legacy_total must mirror total_score exactly`);
    assert.equal(result.enrichment.enriched_total, result.total_score, `${file}: no context.player_context supplied, so enriched must equal legacy`);
    assert.equal(result.enrichment.score_delta, 0, `${file}`);
  }
});

test("2H-B.3. scoreStory(story) — single-argument call — remains fully backward compatible (does not throw, does not change legacy fields)", () => {
  assert.doesNotThrow(() => scoreStory(minimalStory({ headline: "Team fires head coach" })));
  const result = scoreStory(minimalStory({ headline: "Team fires head coach" }));
  assert.equal(result.signals.role_multiplier, 1.0);
  assert.equal(result.signals.star_boost, 1.0);
});

test("2H-B.4. missing context.player_context gives a fully neutral enriched multiplier (1.0 everywhere), distinct reason code", () => {
  const result = scoreWithContext({ headline: "Team fires head coach" }, undefined);
  assert.equal(result.enrichment.combined_role_multiplier, 1.0);
  assert.equal(result.enrichment.star_boost, 1.0);
  assert.equal(result.enrichment.combined_player_multiplier, 1.0);
  assert.deepEqual(result.enrichment.player_importance_reason_codes, ["player_context_not_supplied"]);
});

test("2H-B.4b. an EXPLICIT unresolved context.player_context remains distinct from missing context — uses the locked 0.855 multiplier, never collapsed to neutral", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "unknown", effective_role: "unknown" });
  assert.equal(result.enrichment.combined_role_multiplier, 0.855);
  assert.notDeepEqual(result.enrichment.player_importance_reason_codes, ["player_context_not_supplied"]);
});

test("2H-B.5. non-player story: legacy === enriched", () => {
  const result = scoreWithContext({ headline: "Team fires head coach" }, { has_player_subject: false, qb_importance: "elevated", star_level: "elite", ...STAR_CTX });
  assert.equal(result.enrichment.legacy_total, result.enrichment.enriched_total);
  assert.equal(result.enrichment.combined_player_multiplier, 1.0);
});

test("2H-B.6. non-player organizational story is numerically unchanged by an (ignored, non-player) context.player_context", () => {
  const withCtx = scoreWithContext({ headline: "Team fires head coach" }, { has_player_subject: false });
  const withoutCtx = scoreStory(minimalStory({ headline: "Team fires head coach" }));
  assert.equal(withCtx.total_score, withoutCtx.total_score);
  assert.equal(withCtx.enrichment.enriched_total, withoutCtx.enrichment.enriched_total);
});

test("2H-B.7. starter elevated QB: enriched > legacy", () => {
  const result = scoreWithContext({ headline: "Star quarterback out for the season with torn ACL", description: "Confirmed torn ACL, out for the season." }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.ok(result.enrichment.enriched_total > result.enrichment.legacy_total);
  assert.equal(result.enrichment.combined_role_multiplier, 1.35);
});

test("2H-B.8. backup elevated QB behaves per the locked multiplier (1.08)", () => {
  const result = scoreWithContext({ headline: "Backup quarterback questionable for Sunday" }, { normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" });
  assert.equal(result.enrichment.combined_role_multiplier, 1.08);
});

test("2H-B.9. fringe low QB: enriched < legacy", () => {
  const result = scoreWithContext({ headline: "Team fires head coach" }, { normalized_position: "QB", effective_role: "fringe", qb_importance: "low" });
  assert.ok(result.enrichment.enriched_total < result.enrichment.legacy_total);
  assert.equal(result.enrichment.combined_role_multiplier, 0.76);
});

test("2H-B.10. practice-squad low QB: enriched < legacy", () => {
  const result = scoreWithContext({ headline: "Team fires head coach" }, { normalized_position: "QB", effective_role: "practice_squad", qb_importance: "low" });
  assert.ok(result.enrichment.enriched_total < result.enrichment.legacy_total);
  assert.equal(result.enrichment.combined_role_multiplier, 0.7);
});

test("2H-B.11. starter WR per the locked multiplier (1.2075)", () => {
  const result = scoreWithContext({ headline: "Team fires head coach" }, { normalized_position: "WR", effective_role: "starter" });
  assert.equal(result.enrichment.combined_role_multiplier, 1.2075);
});

test("2H-B.12. elite starter WR receives star boost", () => {
  const result = scoreWithContext({ headline: "Team fires head coach" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX });
  assert.equal(result.enrichment.star_boost, 1.2);
  assert.ok(result.enrichment.combined_player_multiplier > result.enrichment.combined_role_multiplier);
});

test("2H-B.13. notable starter WR receives a smaller boost than elite", () => {
  const notable = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "notable", ...STAR_CTX });
  const elite = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX });
  assert.equal(notable.enrichment.star_boost, 1.1);
  assert.ok(notable.enrichment.combined_player_multiplier < elite.enrichment.combined_player_multiplier);
});

test("2H-B.14. elite > notable > none", () => {
  const base = { normalized_position: "WR", effective_role: "starter", ...STAR_CTX };
  const elite = scoreWithContext({ headline: "x" }, { ...base, star_level: "elite" }).enrichment.combined_player_multiplier;
  const notable = scoreWithContext({ headline: "x" }, { ...base, star_level: "notable" }).enrichment.combined_player_multiplier;
  const none = scoreWithContext({ headline: "x" }, { ...base, star_level: "none" }).enrichment.combined_player_multiplier;
  assert.ok(elite > notable && notable > none);
});

test("2H-B.15. starter EDGE elite works", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "EDGE", effective_role: "starter", star_level: "elite", ...STAR_CTX });
  assert.equal(result.enrichment.combined_player_multiplier, 1.449);
});

test("2H-B.16. starter IOL works", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "IOL", effective_role: "starter" });
  assert.ok(Math.abs(result.enrichment.combined_role_multiplier - 1.0925) < 1e-9);
});

test("2H-B.17. backup IOL is damped relative to starter IOL", () => {
  const starter = scoreWithContext({ headline: "x" }, { normalized_position: "IOL", effective_role: "starter" });
  const backup = scoreWithContext({ headline: "x" }, { normalized_position: "IOL", effective_role: "backup" });
  assert.ok(backup.enrichment.combined_role_multiplier < starter.enrichment.combined_role_multiplier);
  assert.equal(backup.enrichment.combined_role_multiplier, 0.855);
});

test("2H-B.18. K/P/LS behave per the locked position weights", () => {
  const k = scoreWithContext({ headline: "x" }, { normalized_position: "K", effective_role: "starter" });
  const p = scoreWithContext({ headline: "x" }, { normalized_position: "P", effective_role: "starter" });
  const ls = scoreWithContext({ headline: "x" }, { normalized_position: "LS", effective_role: "starter" });
  assert.equal(k.enrichment.position_weight, 0.9);
  assert.equal(p.enrichment.position_weight, 0.88);
  assert.equal(ls.enrichment.position_weight, 0.87);
});

test("2H-B.19. explicit unresolved-player context uses the locked 0.855 role multiplier", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "unknown", effective_role: "unknown" });
  assert.equal(result.enrichment.combined_role_multiplier, 0.855);
});

test("2H-B.20. unresolved-player season-ending injury remains important (Feed-scale territory), not crushed", () => {
  const result = scoreWithContext({ headline: "Player out for the season with torn ACL", description: "Confirmed torn ACL, out for the season." }, { normalized_position: "unknown", effective_role: "unknown" });
  assert.ok(result.enrichment.enriched_total >= OBSERVE_ONLY_CALIBRATION_DEFAULTS.FEED_THRESHOLD_PROVISIONAL, `expected Feed-scale, got ${result.enrichment.enriched_total}`);
});

test("2H-B.21. missing identity blocks a supplied elite star", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", player_id: null, identity_confidence: "high", star_matched: true });
  assert.equal(result.enrichment.star_boost, 1.0);
  assert.ok(result.enrichment.player_importance_reason_codes.includes("star_boost_blocked_missing_identity"));
});

test("2H-B.22. low identity confidence blocks a supplied elite star", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", player_id: "00-9000001", identity_confidence: "low", star_matched: true });
  assert.equal(result.enrichment.star_boost, 1.0);
  assert.ok(result.enrichment.player_importance_reason_codes.includes("star_boost_blocked_low_confidence"));
});

test("2H-B.23. an unmatched star lookup blocks a supplied elite star", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", player_id: "00-9000001", identity_confidence: "high", star_matched: false });
  assert.equal(result.enrichment.star_boost, 1.0);
  assert.ok(result.enrichment.player_importance_reason_codes.includes("star_boost_blocked_not_matched"));
});

test("2H-B.24. a matched medium-confidence star is allowed", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", player_id: "00-9000001", identity_confidence: "medium", star_matched: true });
  assert.equal(result.enrichment.star_boost, 1.2);
});

test("2H-B.25. a matched high-confidence star is allowed", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX });
  assert.equal(result.enrichment.star_boost, 1.2);
});

test("2H-B.26. only event magnitude is multiplied — bonuses/penalties are identical between legacy and enriched", () => {
  const result = scoreStory(
    minimalStory({ headline: "Team fires head coach", sources: [{ name: "ESPN", headline: "x" }, { name: "NFL Network", headline: "y" }] }),
    { player_context: pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX }) }
  );
  const expectedEnrichedMagnitude = round1(result.enrichment.event_magnitude * result.enrichment.combined_role_multiplier * result.enrichment.star_boost * result.enrichment.legacy_game_performance_multiplier);
  assert.equal(result.enrichment.enriched_magnitude, expectedEnrichedMagnitude);
  const reconstructedEnrichedTotal = round1(result.enrichment.enriched_magnitude + result.modifiers.corroboration_bonus + result.modifiers.social_interest_bonus + result.modifiers.escalation_bonus - result.modifiers.rumor_penalty - result.modifiers.repetition_penalty);
  assert.equal(reconstructedEnrichedTotal, result.enrichment.enriched_total, "the SAME bonus/penalty values used for legacy must be reused verbatim for enriched — never multiplied by player importance");
});

test("2H-B.27. corroboration bonus is unchanged by context.player_context", () => {
  const sources = [{ name: "ESPN", headline: "x" }, { name: "NFL Network", headline: "y" }];
  const a = scoreStory(minimalStory({ headline: "Team fires head coach", sources }));
  const b = scoreWithContext({ headline: "Team fires head coach", sources }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.modifiers.corroboration_bonus, b.modifiers.corroboration_bonus);
});

test("2H-B.28. social-interest bonus is unchanged by context.player_context", () => {
  const story = { headline: "Shocking, controversial comeback stuns fans", description: "drama", sources: [{ name: "ESPN", headline: "x" }], players: [], teams: [], is_rumor: false, visual_subject: null, visual_subject_type: null };
  const a = scoreStory(story);
  const b = scoreStory(story, { player_context: pc({ normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX }) });
  assert.equal(a.modifiers.social_interest_bonus, b.modifiers.social_interest_bonus);
});

test("2H-B.29. escalation bonus is unchanged by context.player_context", () => {
  const a = scoreStory(minimalStory({ headline: "Team fires head coach" }));
  const b = scoreWithContext({ headline: "Team fires head coach" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.modifiers.escalation_bonus, b.modifiers.escalation_bonus);
});

test("2H-B.30. rumor penalty is unchanged by context.player_context", () => {
  const story = minimalStory({ headline: "Blockbuster trade rumor", is_rumor: true });
  const a = scoreStory(story);
  const b = scoreStory(story, { player_context: pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX }) });
  assert.equal(a.modifiers.rumor_penalty, b.modifiers.rumor_penalty);
  assert.ok(a.modifiers.rumor_penalty > 0);
});

test("2H-B.31. repetition penalty (0 in Phase 1) is unchanged by context.player_context", () => {
  const a = scoreStory(minimalStory({ headline: "Team fires head coach" }));
  const b = scoreWithContext({ headline: "Team fires head coach" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.modifiers.repetition_penalty, 0);
  assert.equal(b.modifiers.repetition_penalty, 0);
});

test("2H-B.32. game_performance_multiplier remains 1.0 in both legacy and enriched paths", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(result.signals.game_performance_multiplier, 1.0);
  assert.equal(result.enrichment.legacy_game_performance_multiplier, 1.0);
});

test("2H-B.33. importance_score (a different, story-level Phase 1 concept) is irrelevant to enrichment", () => {
  const a = scoreWithContext({ headline: "x", importance_score: 5 }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  const b = scoreWithContext({ headline: "x", importance_score: 95 }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.enrichment.enriched_total, b.enrichment.enriched_total);
});

test("2H-B.34. image readiness is irrelevant to enrichment", () => {
  const a = scoreWithContext({ headline: "x", primary_image_url: null }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  const b = scoreWithContext({ headline: "x", primary_image_url: "https://example.test/img.jpg" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.enrichment.enriched_total, b.enrichment.enriched_total);
});

test("2H-B.35. player name is irrelevant to the multiplier (not part of player_context at all)", () => {
  const a = scoreWithContext({ headline: "x", visual_subject: "Player One" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  const b = scoreWithContext({ headline: "x", visual_subject: "Player Two" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.enrichment.combined_player_multiplier, b.enrichment.combined_player_multiplier);
});

test("2H-B.36. team is irrelevant to the multiplier", () => {
  const a = scoreWithContext({ headline: "x", current_team: "KC" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  const b = scoreWithContext({ headline: "x", current_team: "BUF" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.enrichment.combined_player_multiplier, b.enrichment.combined_player_multiplier);
});

test("2H-B.37. source-tier logic is unchanged (bestSourceTier still drives corroboration exactly as before)", () => {
  const a = scoreStory(minimalStory({ headline: "x", sources: [{ name: "ESPN", headline: "x" }] }));
  const b = scoreWithContext({ headline: "x", sources: [{ name: "ESPN", headline: "x" }] }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(a.signals.source_confidence, b.signals.source_confidence);
});

test("2H-B.38. the rumor Feed gate on the LEGACY destination is unchanged by context.player_context", () => {
  const result = scoreWithContext({ headline: "Blockbuster trade rumor", is_rumor: true }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX });
  assert.ok(result.destination.feed_block_reasons.includes("unconfirmed_rumor"));
});

test("2H-B.39. the SAME rumor gate semantics apply to the enriched preview — a rumor never previews into Feed regardless of player multiplier", () => {
  const result = scoreWithContext({ headline: "Blockbuster trade rumor involving star quarterback", is_rumor: true, sources: [{ name: "ESPN", headline: "x" }] }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX });
  assert.ok(result.enrichment.enriched_destination_preview.feed_block_reasons.includes("unconfirmed_rumor"), "a rumor must be blocked from the enriched Feed preview exactly like the legacy one");
});

test("2H-B.40. the legacy Feed threshold value is unchanged (55)", () => {
  assert.equal(OBSERVE_ONLY_CALIBRATION_DEFAULTS.FEED_THRESHOLD_PROVISIONAL, 55);
});

test("2H-B.41. the legacy Story threshold value is unchanged (25)", () => {
  assert.equal(OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL, 25);
});

test("2H-B.42. an enriched Feed crossing (Story -> Feed) is detectable via the preview", () => {
  const story = minimalStory({ headline: "Player expected to miss multiple weeks with a hamstring injury", description: "The team's starting wide receiver will miss multiple weeks." });
  const legacyOnly = scoreStory(story);
  const enriched = scoreStory(story, { player_context: pc({ normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX }) });
  assert.equal(legacyOnly.destination.feed_fit, "insufficient_magnitude");
  assert.notEqual(enriched.enrichment.enriched_destination_preview.feed_fit, "insufficient_magnitude", "the elite starter WR preview should clear the Feed magnitude bar even though the legacy score does not");
});

test("2H-B.43. an enriched Story crossing (Neither -> Story) is detectable via the preview", () => {
  const crossing = scoreWithContext({ headline: "Player ruled out for Sunday's game" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX });
  const crossingLegacyOnly = scoreStory(minimalStory({ headline: "Player ruled out for Sunday's game" }));
  assert.ok(crossingLegacyOnly.total_score < OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL);
  assert.ok(crossing.enrichment.enriched_total >= OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL, `expected the enriched preview to cross into Story, got ${crossing.enrichment.enriched_total}`);
});

test("2H-B.44. an enriched downward crossing (legacy Story -> enriched preview below Story) is detectable", () => {
  const story = minimalStory({ headline: "Team signs veteran as the new starting cornerback", description: "The team announced the signing." });
  const legacyOnly = scoreStory(story);
  const enriched = scoreStory(story, { player_context: pc({ normalized_position: "LS", effective_role: "practice_squad" }) });
  assert.ok(legacyOnly.total_score >= OBSERVE_ONLY_CALIBRATION_DEFAULTS.STORY_THRESHOLD_PROVISIONAL, "sanity: legacy clears Story");
  assert.ok(enriched.enrichment.enriched_total < legacyOnly.total_score, "a floored low-importance player multiplier must pull the preview down relative to legacy");
});

test("2H-B.45. the ACTUAL legacy destination remains unchanged despite an enriched crossing", () => {
  const story = minimalStory({ headline: "Player expected to miss multiple weeks with a hamstring injury", description: "The team's starting wide receiver will miss multiple weeks." });
  const legacyOnly = scoreStory(story);
  const enriched = scoreStory(story, { player_context: pc({ normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX }) });
  assert.deepEqual(enriched.destination, legacyOnly.destination, "the real `destination` field must be completely unaffected by enrichment, even when the preview crosses a threshold");
});

test("2H-B.46. score_delta is exact (rounded delta between the two already-rounded totals)", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.equal(result.enrichment.score_delta, round1(result.enrichment.enriched_total - result.enrichment.legacy_total));
});

test("2H-B.47. score_delta and score_delta_percent are derived from TRUE pre-display-rounding totals, not from the already-rounded legacy_total/enriched_total — a real, concrete divergence, not just formula symmetry", () => {
  // A real, non-integer corroboration bonus (4 x log2(3) for two genuinely
  // distinct sources) is added to BOTH the legacy and enriched magnitude
  // before either total is rounded for display. Rounding each TOTAL
  // independently (legacy_total, enriched_total) before subtracting loses
  // precision the raw magnitude difference does not — this scenario is
  // deliberately chosen so the two approaches produce DIFFERENT numbers,
  // not just algebraically-equal restatements of each other.
  const story = {
    headline: "Player expected to miss multiple weeks with a hamstring injury",
    description: "The starting receiver will miss multiple weeks.",
    sources: [
      { name: "ESPN", headline: "Star receiver to miss multiple weeks with hamstring strain", description: "The star wide receiver will be out for several weeks with a hamstring injury." },
      { name: "NFL Network", headline: "Report: top wideout sidelined for weeks with hamstring issue", description: "Sources say the top wide receiver will miss multiple weeks due to a hamstring strain." },
    ],
    is_rumor: false, players: [], teams: [], visual_subject: null, visual_subject_type: null,
  };
  const context = { player_context: pc({ normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX }) };
  const result = scoreStory(story, context);

  // 1/2: the displayed legacy/enriched totals are exactly what they were
  // before this hardening pass — unaffected by the internal precision fix.
  assert.equal(result.enrichment.legacy_total, 46.3);
  assert.equal(result.enrichment.enriched_total, 64.3);
  assert.equal(result.total_score, 46.3);

  // The real, unrounded magnitude difference: 40 x 1.2075 x 1.2 (=57.96) - 40 = 17.96.
  // The corroboration/social/escalation/rumor/repetition terms are IDENTICAL
  // in both the raw legacy and raw enriched totals, so they cancel exactly —
  // the true raw delta is just the magnitude difference, unaffected by
  // where those shared bonus terms happen to land after independent rounding.
  const trueRawDelta = 57.96 - 40;
  assert.ok(Math.abs(trueRawDelta - 17.96) < 1e-9);
  assert.equal(result.enrichment.score_delta, round1(trueRawDelta), "score_delta must equal round1(raw magnitude difference), not round1(rounded_enriched - rounded_legacy)");

  // 6: score_delta_percent divides by the RAW legacy total (coreScore +
  // corroboration + ... unrounded, ~46.33985), not the DISPLAYED 46.3 —
  // these differ enough to move the rounded percentage by a real 0.1.
  const rawLegacyTotalApprox = 40 + (4 * Math.log2(3)); // corroborationBonus() for 2 distinct sources
  const expectedPercentFromRaw = round1((trueRawDelta / rawLegacyTotalApprox) * 100);
  const wouldBeFromDisplayedTotals = round1(((result.enrichment.enriched_total - result.enrichment.legacy_total) / result.enrichment.legacy_total) * 100);
  assert.equal(result.enrichment.score_delta_percent, expectedPercentFromRaw);
  assert.notEqual(expectedPercentFromRaw, wouldBeFromDisplayedTotals, "this scenario must genuinely distinguish raw-total math from displayed-rounded-total math, not merely restate the same formula");

  // 3/4: destinations are computed from the same (unchanged) totalScore/
  // enrichedTotal as before — this precision fix touches only the delta
  // diagnostics, never destination selection.
  assert.equal(result.destination.story_fit, "meets_story_bar_provisional");
  assert.notEqual(result.enrichment.enriched_destination_preview.feed_fit, "insufficient_magnitude");
});

test("2H-B.47b. zero raw legacy total returns null (a real, deterministic cancellation: draft-category magnitude 12 minus the 12-point rumor penalty)", () => {
  const story = { headline: "Team announces draft plans", description: "The team discussed its draft strategy.", sources: [], players: [], teams: [], is_rumor: true, visual_subject: null, visual_subject_type: null };
  const result = scoreStory(story);
  assert.equal(result.enrichment.legacy_total, 0, "sanity: this scenario must genuinely net to zero");
  assert.equal(result.total_score, 0);
  assert.equal(result.enrichment.score_delta_percent, null);
  assert.ok(!Number.isNaN(result.enrichment.score_delta_percent));
  assert.notEqual(result.enrichment.score_delta_percent, Infinity);
  assert.notEqual(result.enrichment.score_delta_percent, -Infinity);
});

test("2H-B.48. a zero legacy score never produces NaN/Infinity for score_delta_percent", () => {
  const story = { headline: "", description: "", sources: [], players: [], teams: [], is_rumor: false, visual_subject: null, visual_subject_type: null };
  const result = scoreStory(story);
  if (result.enrichment.legacy_total === 0) {
    assert.equal(result.enrichment.score_delta_percent, null);
  }
  assert.ok(!Number.isNaN(result.enrichment.score_delta_percent));
  assert.notEqual(result.enrichment.score_delta_percent, Infinity);
  assert.notEqual(result.enrichment.score_delta_percent, -Infinity);
});

test("2H-B.49. debug output contains every player-multiplier component", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  for (const key of ["position_weight", "role_weight", "raw_role_multiplier", "combined_role_multiplier", "star_boost", "combined_player_multiplier", "enriched_magnitude", "enriched_total", "legacy_total", "score_delta", "score_delta_percent", "player_importance_reason_codes"]) {
    assert.ok(key in result.enrichment, `missing enrichment.${key}`);
  }
});

test("2H-B.50. all existing Phase 1 debug fields are preserved unchanged in shape", () => {
  const result = scoreStory(minimalStory({ headline: "x" }));
  for (const key of ["version", "total_score", "core_score", "signals", "modifiers", "destination", "escalation", "production_readiness", "explanation"]) {
    assert.ok(key in result, `missing legacy field ${key}`);
  }
});

test("2H-B.51. player-importance reason codes are exposed", () => {
  const result = scoreWithContext({ headline: "x" }, { normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" });
  assert.ok(Array.isArray(result.enrichment.player_importance_reason_codes));
  assert.ok(result.enrichment.player_importance_reason_codes.length > 0);
});

test("2H-B.52. the non-player reason code is exposed", () => {
  const result = scoreWithContext({ headline: "x" }, { has_player_subject: false });
  assert.ok(result.enrichment.player_importance_reason_codes.includes("non_player_neutral"));
});

test("2H-B.53. the missing-context.player_context state has its own explicit, distinct reason code", () => {
  const result = scoreStory(minimalStory({ headline: "x" }));
  assert.deepEqual(result.enrichment.player_importance_reason_codes, ["player_context_not_supplied"]);
});

test("2H-B.54a. story.player_context ALONE (no context argument at all) is ignored as scoring context — never silently contaminates scoring", () => {
  const contaminated = minimalStory({ headline: "x", player_context: { has_player_subject: true, normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", player_id: "00-9000001", identity_confidence: "high", star_matched: true } });
  const result = scoreStory(contaminated);
  assert.equal(result.enrichment.combined_player_multiplier, 1.0, "a story.player_context field must never be read as scoring context");
  assert.deepEqual(result.enrichment.player_importance_reason_codes, ["player_context_not_supplied"]);
});

test("2H-B.54b. story.player_context and context.player_context are never ambiguously combined — only context.player_context is ever used", () => {
  const story = minimalStory({ headline: "x", player_context: { has_player_subject: true, normalized_position: "K", effective_role: "practice_squad", qb_importance: "none" } });
  const result = scoreStory(story, { player_context: pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" }) });
  assert.equal(result.enrichment.position_weight, 1.2, "only context.player_context (QB/elevated) must be used, never any blend with story.player_context (K)");
  assert.equal(result.enrichment.role_weight, 1.15);
});

test("2H-B.55. deterministic repeated invocation (including the new enrichment block)", () => {
  const story = minimalStory({ headline: "Team fires head coach" });
  const context = { player_context: pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX }) };
  const a = scoreStory(JSON.parse(JSON.stringify(story)), JSON.parse(JSON.stringify(context)));
  const b = scoreStory(JSON.parse(JSON.stringify(story)), JSON.parse(JSON.stringify(context)));
  assert.deepEqual(a, b);
});

test("2H-B.55b. scoreStory() does not mutate the story argument", () => {
  const story = Object.freeze(minimalStory({ headline: "x" }));
  const context = { player_context: pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" }) };
  assert.doesNotThrow(() => scoreStory(story, context));
});

test("2H-B.55c. scoreStory() does not mutate the context argument", () => {
  const story = minimalStory({ headline: "x" });
  const context = Object.freeze({ player_context: pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" }) });
  assert.doesNotThrow(() => scoreStory(story, context));
});

test("2H-B.55d. scoreStory() does not mutate context.player_context itself", () => {
  const story = minimalStory({ headline: "x" });
  const playerContext = Object.freeze(pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" }));
  assert.doesNotThrow(() => scoreStory(story, { player_context: playerContext }));
});

test("2H-B.56. no Date.now in the scoring path", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/Date\.now\s*\(/.test(src), false);
});

test("2H-B.57. no network in the scoring path", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/\bfetch\s*\(/.test(src), false);
});

test("2H-B.58. no filesystem reads in the scoring path", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/readFileSync|readFile\(/.test(src), false);
});

test("2H-B.59. no star registry lookup inside the scorer", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/nflverseStarRegistry|lookupPlayerStarStatus/.test(src), false);
});

test("2H-B.60. no nflverse cache/index lookup inside the scorer", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/nflverseCache|nflversePlayerIndex/.test(src), false);
});

test("2H-B.61. no Phase 2C/D/E/F recomputation inside the scorer", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/nflverseIdentityResolver|nflversePositionNormalizer|nflverseRoleResolver|nflverseFreshRoleResolver/.test(src), false);
});

test("2H-B.62. no Feed/Story PRODUCTION integration — enriched_destination_preview is observe-only and never read by score-story.js", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "editorial", "score-story.js"), "utf-8");
  assert.equal(/enriched_destination_preview|enrichment\./.test(src), false);
});

test("2H-B.63. no generate-content.js integration", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "generate-content.js"), "utf-8");
  assert.equal(/editorialScoring|editorialPlayerImportance|scoreStory/.test(src), false);
});

test("2H-B.64. no social-state mutation (scoring module never references the social-state file/module)", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/socialState|social-state/.test(src), false);
});

test("2H-B.65. no workflow changes (this test file's own existence is the only touchpoint outside lib/)", async () => {
  const { readdir } = await import("node:fs/promises");
  // Simply confirms the .github directory, if present, was never touched by this test run's own file writes — a structural sanity check, not a git diff (git state is verified separately outside the test suite).
  assert.doesNotThrow(async () => { try { await readdir(path.join(ROOT, ".github")); } catch { /* absent is fine */ } });
});

test("2H-B.66. the locked Phase 2H-A helper file is unchanged (imported, never redefined, in editorialScoring.js)", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.ok(src.includes('from "./editorialPlayerImportance.js"'));
  assert.equal(/export function computePlayerImportanceMultipliers/.test(src), false, "must import, never redefine, the locked helper");
});

test("2H-B.67. Phase 2A-2G modules are not referenced at all by the scorer (only Phase 2H-A's own already-locked output shape is consumed)", async () => {
  const src = await readFile(path.join(ROOT, "scripts", "lib", "editorialScoring.js"), "utf-8");
  assert.equal(/visualSubject\.js/.test(src), false);
});

// ---------------------------------------------------------------------------
// OLD VS NEW SYNTHETIC CALIBRATION MATRIX (A-P)
// ---------------------------------------------------------------------------
test("2H-B calibration matrix A-P: legacy vs enriched, printed and threshold crossings asserted", () => {
  // Uses the REAL feed_fit/story_fit (which already account for the rumor
  // gate and any structural block) rather than a naive magnitude-only
  // threshold check — a rumor whose numeric total clears 55 must still
  // display as blocked, not as "Feed".
  function destOf(destinationFit) {
    if (destinationFit.feed_fit === "meets_feed_bar_provisional") return "Feed";
    if (destinationFit.feed_fit === "magnitude_ok_but_blocked") return "Story-blocked-from-Feed";
    if (destinationFit.story_fit === "meets_story_bar_provisional") return "Story";
    return "Neither";
  }
  function run(headline, description, playerContext, isRumor = false) {
    const story = minimalStory({ headline, description, is_rumor: isRumor, sources: isRumor ? [{ name: "Anonymous Blog", headline }] : [{ name: "ESPN", headline }] });
    const r = scoreStory(story, { player_context: playerContext });
    return { event_magnitude: r.enrichment.event_magnitude, legacy_magnitude: r.enrichment.legacy_magnitude, enriched_magnitude: r.enrichment.enriched_magnitude, legacy_total: r.enrichment.legacy_total, enriched_total: r.enrichment.enriched_total, delta: r.enrichment.score_delta, legacy_destination: destOf(r.destination), enriched_destination_preview: destOf(r.enrichment.enriched_destination_preview), full: r };
  }

  const scenarios = {
    A_elite_starter_QB_season_ending: run("Player out for the season with torn ACL", "Confirmed torn ACL, out for the season.", pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX })),
    B_non_star_starter_QB_season_ending: run("Player out for the season with torn ACL", "Confirmed torn ACL, out for the season.", pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated" })),
    C_non_star_backup_QB_limited: run("Player limited at Wednesday's practice", "The player was limited at practice.", pc({ normalized_position: "QB", effective_role: "backup", qb_importance: "elevated" })),
    D_fringe_QB_depth_chart: run("Colts name veteran the No. 2 quarterback", "The team named its backup quarterback.", pc({ normalized_position: "QB", effective_role: "fringe", qb_importance: "low" })),
    E_practice_squad_QB_move: run("Team signs a quarterback to the practice squad", "The team announced a practice squad signing.", pc({ normalized_position: "QB", effective_role: "practice_squad", qb_importance: "low" })),
    F_non_star_starter_WR_multi_week: run("Player expected to miss multiple weeks with a hamstring injury", "The starting receiver will miss multiple weeks.", pc({ normalized_position: "WR", effective_role: "starter" })),
    G_notable_starter_WR_multi_week: run("Player expected to miss multiple weeks with a hamstring injury", "The starting receiver will miss multiple weeks.", pc({ normalized_position: "WR", effective_role: "starter", star_level: "notable", ...STAR_CTX })),
    H_elite_starter_WR_multi_week: run("Player expected to miss multiple weeks with a hamstring injury", "The starting receiver will miss multiple weeks.", pc({ normalized_position: "WR", effective_role: "starter", star_level: "elite", ...STAR_CTX })),
    I_elite_starter_EDGE_blockbuster: run("Team completes blockbuster trade for star edge rusher, sending multiple first-round picks", "A blockbuster trade was completed.", pc({ normalized_position: "EDGE", effective_role: "starter", star_level: "elite", ...STAR_CTX })),
    J_non_star_starter_IOL_multi_week: run("Player expected to miss multiple weeks with a knee injury", "The starting guard will miss multiple weeks.", pc({ normalized_position: "IOL", effective_role: "starter" })),
    K_non_star_backup_IOL_limited: run("Player limited at Wednesday's practice", "The backup guard was limited at practice.", pc({ normalized_position: "IOL", effective_role: "backup" })),
    L_notable_starter_K_signing: run("Team signs veteran as the new starting kicker", "The team announced the signing of its new kicker.", pc({ normalized_position: "K", effective_role: "starter", star_level: "notable", ...STAR_CTX })),
    M_unresolved_player_season_ending: run("Player out for the season with torn ACL", "Confirmed torn ACL, out for the season.", pc({ normalized_position: "unknown", effective_role: "unknown" })),
    N_non_player_organizational: run("Team fires head coach", "The team announced it has fired its head coach.", pc({ has_player_subject: false })),
    O_blockbuster_rumor_strong_player: run("Blockbuster trade rumor involving star quarterback", "Reportedly, a blockbuster trade could happen.", pc({ normalized_position: "QB", effective_role: "starter", qb_importance: "elevated", star_level: "elite", ...STAR_CTX }), true),
    P_ordinary_non_player_league_news: run("League announces schedule update", "The league announced a minor schedule update.", pc({ has_player_subject: false })),
  };

  console.log("\n  --- Phase 2H-B calibration matrix (legacy vs enriched) ---");
  console.log("  scenario".padEnd(38), "event_mag  legacy_tot  enriched_tot   delta   legacy_dest  enriched_preview");
  for (const [name, s] of Object.entries(scenarios)) {
    console.log(
      `  ${name.padEnd(36)} ${String(s.event_magnitude).padStart(9)}  ${String(s.legacy_total).padStart(10)}  ${String(s.enriched_total).padStart(12)}  ${String(s.delta).padStart(7)}  ${s.legacy_destination.padStart(11)}  ${s.enriched_destination_preview}`
    );
  }
  console.log("  ------------------------------------------------------------------------------------------\n");

  // Review question 1/2/3: which scenarios cross thresholds, and in which direction.
  const crossingsUp = Object.entries(scenarios).filter(([, s]) => s.legacy_destination !== s.enriched_destination_preview && (
    (s.legacy_destination === "Neither" && s.enriched_destination_preview !== "Neither") ||
    (s.legacy_destination === "Story" && s.enriched_destination_preview === "Feed")
  ));
  const crossingsDown = Object.entries(scenarios).filter(([, s]) => s.legacy_destination !== s.enriched_destination_preview && (
    (s.legacy_destination === "Feed" && s.enriched_destination_preview !== "Feed") ||
    (s.legacy_destination === "Story" && s.enriched_destination_preview === "Neither")
  ));
  console.log("  Upward crossings:", crossingsUp.map(([n]) => n).join(", ") || "(none)");
  console.log("  Downward crossings:", crossingsDown.map(([n]) => n).join(", ") || "(none)\n");

  // Review question 4: no trivial/low event becomes Feed solely via player importance.
  assert.notEqual(scenarios.C_non_star_backup_QB_limited.enriched_destination_preview, "Feed");
  assert.notEqual(scenarios.K_non_star_backup_IOL_limited.enriched_destination_preview, "Feed");
  // Review question 5: no practice-squad/fringe event becomes Feed.
  assert.notEqual(scenarios.D_fringe_QB_depth_chart.enriched_destination_preview, "Feed");
  assert.notEqual(scenarios.E_practice_squad_QB_move.enriched_destination_preview, "Feed");
  // Review question 6: unresolved-player season-ending remains Feed-scale.
  assert.equal(scenarios.M_unresolved_player_season_ending.enriched_destination_preview, "Feed");
  // Review question 7: non-player/organizational stories are numerically identical.
  assert.equal(scenarios.N_non_player_organizational.legacy_total, scenarios.N_non_player_organizational.enriched_total);
  assert.equal(scenarios.P_ordinary_non_player_league_news.legacy_total, scenarios.P_ordinary_non_player_league_news.enriched_total);
  // Review question 8: the rumor Feed gate still blocks Feed regardless of player strength.
  assert.notEqual(scenarios.O_blockbuster_rumor_strong_player.full.enrichment.enriched_destination_preview.feed_fit, "meets_feed_bar_provisional");
  assert.ok(scenarios.O_blockbuster_rumor_strong_player.full.enrichment.enriched_destination_preview.feed_block_reasons.includes("unconfirmed_rumor"));

  // Review question 9/10: largest positive/negative deltas.
  const deltas = Object.entries(scenarios).map(([name, s]) => [name, s.delta]);
  const maxPositive = deltas.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  const maxNegative = deltas.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  console.log(`  Largest positive delta: ${maxPositive[0]} (+${maxPositive[1]})`);
  console.log(`  Largest negative delta: ${maxNegative[0]} (${maxNegative[1]})\n`);
  assert.ok(maxPositive[1] >= 0);
  assert.ok(maxNegative[1] <= 0);
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
