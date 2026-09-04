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
