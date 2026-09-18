#!/usr/bin/env node
// 2026-09-18 — live-game/play-by-play state classification. Real incident:
// story 1d456179 ("LIONS ON THE BOARD, TRAIL 21-7", published mid-game
// 2026-09-17) was selected for the 12 PM Feed slot the next day via the
// 24-hour Tier-3 fallback, hours after the game it described had ended.
// classifyCategory() (scripts/lib/extraction.js) is the ONLY categorization
// path (deterministic keyword rules, no AI) — this suite proves the new
// "live_game_state" category catches transient game-state/play-by-play
// headlines and transient in-game player status, while never touching
// final results, postgame analysis, or durable injury/roster news.
// Run with: node scripts/tests/live-game-state-classification-regression.mjs
import assert from "node:assert/strict";
import { classifyCategory } from "../lib/extraction.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Transient live-game/play-by-play state — MUST be excluded
// ---------------------------------------------------------------------------

test("1. the exact real incident headline is excluded", () => {
  assert.equal(classifyCategory("LIONS ON THE BOARD, TRAIL 21-7"), "live_game_state");
});

test("2. a lead-change score update is excluded", () => {
  assert.equal(classifyCategory("Chiefs take a 14-10 lead"), "live_game_state");
});

test("3. a scoring-play verb with no numeric score at all is still excluded", () => {
  assert.equal(classifyCategory("Ravens strike first"), "live_game_state");
});

test("4. a deficit-cutting update (word-form number, no digits) is excluded", () => {
  assert.equal(classifyCategory("Team cuts the deficit to three"), "live_game_state");
});

test("5. an in-game player-status update, clearly framed as in-game, is excluded", () => {
  assert.equal(classifyCategory("Player questionable to return"), "live_game_state");
});

test("'tie it at' scoreline update is excluded", () => {
  assert.equal(classifyCategory("Bills tie it at 21"), "live_game_state");
});

test("'take the lead' with no score is excluded", () => {
  assert.equal(classifyCategory("Packers take the lead"), "live_game_state");
});

test("'trails by' update is excluded", () => {
  assert.equal(classifyCategory("Team trails by 10"), "live_game_state");
});

test("halftime lead state is excluded", () => {
  assert.equal(classifyCategory("Team leads at halftime"), "live_game_state");
});

test("'makes it <score>' scoring update is excluded", () => {
  assert.equal(classifyCategory("Touchdown makes it 24-17"), "live_game_state");
});

test("in-progress drive state is excluded", () => {
  assert.equal(classifyCategory("Team driving late in the fourth"), "live_game_state");
});

test("a field goal handing over the lead is excluded", () => {
  assert.equal(classifyCategory("Field goal gives Dallas the lead"), "live_game_state");
});

test("an answering score is excluded", () => {
  assert.equal(classifyCategory("Team answers with a touchdown"), "live_game_state");
});

test("a personal scoring tally update is excluded", () => {
  assert.equal(classifyCategory("Player scores his second TD"), "live_game_state");
});

test("a tied-game clock state is excluded", () => {
  assert.equal(classifyCategory("Game tied entering fourth quarter"), "live_game_state");
});

test("a player ruled out mid-game is excluded", () => {
  assert.equal(classifyCategory("Star receiver will not return"), "live_game_state");
});

test("a player returning to the field mid-game is excluded", () => {
  assert.equal(classifyCategory("Quarterback has returned to the game"), "live_game_state");
});

// ---------------------------------------------------------------------------
// Durable NFL news — MUST remain eligible (never classified as live_game_state)
// ---------------------------------------------------------------------------

test("6. a final game result, containing a score, is NOT excluded (the critical false-positive guard)", () => {
  assert.notEqual(classifyCategory("Lions defeat Packers 31-21"), "live_game_state");
});

test("6b. another final-result phrasing with a score is NOT excluded", () => {
  assert.notEqual(classifyCategory("Chiefs beat Raiders 27-17"), "live_game_state");
});

test("6c. 'tops' as a final-result verb is NOT excluded", () => {
  assert.notEqual(classifyCategory("Bengals top Steelers to stay unbeaten"), "live_game_state");
});

test("7. postgame analysis is NOT excluded", () => {
  assert.notEqual(classifyCategory("Five takeaways from Lions-Packers"), "live_game_state");
});

test("7b. a coach explaining a game decision after the fact is NOT excluded", () => {
  assert.notEqual(classifyCategory("Dan Campbell explains fourth-quarter decision"), "live_game_state");
});

test("8. a pre-game/weekly injury status ('questionable FOR <game>') is NOT excluded — the critical durable-vs-transient distinction", () => {
  assert.notEqual(classifyCategory("Player questionable for Week 3"), "live_game_state");
  assert.notEqual(classifyCategory("DJ Moore questionable for Sunday's game"), "live_game_state");
});

test("9. a diagnosed injury is NOT excluded, even though it can follow an in-game injury", () => {
  assert.notEqual(classifyCategory("Player diagnosed with torn ACL"), "live_game_state");
  assert.equal(classifyCategory("Player diagnosed with torn ACL"), "injury");
});

test("10a. ordinary roster/transaction news is NOT excluded", () => {
  assert.notEqual(classifyCategory("Team signs veteran receiver"), "live_game_state");
  assert.notEqual(classifyCategory("Team releases cornerback"), "live_game_state");
});

test("10b. ordinary trade news is NOT excluded", () => {
  assert.notEqual(classifyCategory("Team trades star receiver to division rival"), "live_game_state");
});

test("10c. ordinary discipline/suspension news is NOT excluded", () => {
  assert.equal(classifyCategory("Player suspended four games"), "suspension");
});

test("10d. ordinary coaching news is NOT excluded", () => {
  assert.notEqual(classifyCategory("Coach addresses quarterback situation"), "live_game_state");
});

test("10e. analysis/betting/preview content is NOT excluded", () => {
  assert.notEqual(classifyCategory("Five things to watch Sunday"), "live_game_state");
  assert.notEqual(classifyCategory("Week 3 best bets"), "live_game_state");
  assert.notEqual(classifyCategory("Why Detroit's defense struggled Thursday"), "live_game_state");
});

test("10f. a records/milestone headline containing game-adjacent language is NOT excluded", () => {
  assert.notEqual(classifyCategory("Patrick Mahomes breaks franchise touchdown record"), "live_game_state");
  assert.notEqual(classifyCategory("Player becomes first rookie since 2018 to record 300 receiving yards"), "live_game_state");
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
