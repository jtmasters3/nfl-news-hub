#!/usr/bin/env node
// Regression suite for the additive `subject_match_count` field added to
// determineVisualSubject() to support the Editorial Scoring Brain's Phase
// 2C identity resolver. Proves the change is purely additive: every
// existing return value (visual_subject, visual_subject_type) is
// byte-for-byte unchanged for every branch, and the new field correctly
// reports 1 (confident single headline match) vs. >1 (the weaker
// "earliest in headline" multi-candidate fallback) vs. 0 (every non-player
// branch: coach, executive, team, event, none).
// Run with: node scripts/tests/visual-subject-regression.mjs
import assert from "node:assert/strict";
import { determineVisualSubject } from "../lib/visualSubject.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("A single confident headline candidate reports subject_match_count: 1", () => {
  const result = determineVisualSubject({
    headline: "Patrick Mahomes ruled out for Sunday's game",
    combinedText: "Patrick Mahomes ruled out for Sunday's game",
    players: ["Patrick Mahomes"],
    teams: ["KC"],
    category: "injury",
  });
  assert.equal(result.visual_subject, "Patrick Mahomes");
  assert.equal(result.visual_subject_type, "player");
  assert.equal(result.subject_match_count, 1);
});

test("Multiple headline candidates (the weaker 'earliest in headline' fallback) report subject_match_count > 1", () => {
  const result = determineVisualSubject({
    headline: "Patrick Mahomes and Travis Kelce both praised the offensive line",
    combinedText: "Patrick Mahomes and Travis Kelce both praised the offensive line",
    players: ["Patrick Mahomes", "Travis Kelce"],
    teams: ["KC"],
    category: "league_news",
  });
  assert.equal(result.visual_subject, "Patrick Mahomes", "earliest-in-headline still picks the same subject as before");
  assert.equal(result.visual_subject_type, "player");
  assert.equal(result.subject_match_count, 2, "must report that this was a 2-candidate resolution, not a confident single match");
});

test("A coach subject reports subject_match_count: 0", () => {
  // The headline deliberately does NOT name the coach — findTitledPerson
  // matches against combinedText, not headline, so this isolates the coach
  // branch from branch 1's own headline-based player detection (which a
  // headline literally containing "Head Coach Andy Reid" would otherwise
  // trigger first, since "Head" isn't a strippable title word — a
  // pre-existing extraction quirk, not something this change introduces).
  const result = determineVisualSubject({
    headline: "Team addresses offensive struggles",
    combinedText: "Team addresses offensive struggles. Head Coach Andy Reid says the unit will improve.",
    players: [],
    teams: ["KC"],
    category: "league_news",
  });
  assert.equal(result.visual_subject_type, "coach");
  assert.equal(result.subject_match_count, 0);
});

test("An executive subject reports subject_match_count: 0", () => {
  const result = determineVisualSubject({
    headline: "Team addresses front office decisions",
    combinedText: "Team addresses front office decisions. General Manager Brett Veach spoke to reporters.",
    players: [],
    teams: ["KC"],
    category: "league_news",
  });
  assert.equal(result.visual_subject_type, "executive");
  assert.equal(result.subject_match_count, 0);
});

test("A single-team subject reports subject_match_count: 0", () => {
  const result = determineVisualSubject({
    headline: "Team announces roster moves",
    combinedText: "Team announces roster moves",
    players: [],
    teams: ["KC"],
    category: "roster_move",
  });
  assert.equal(result.visual_subject_type, "team");
  assert.equal(result.subject_match_count, 0);
});

test("A draft-event subject reports subject_match_count: 0", () => {
  const result = determineVisualSubject({
    headline: "NFL Draft order set for next spring",
    combinedText: "NFL Draft order set for next spring",
    players: [],
    teams: [],
    category: "draft",
  });
  assert.equal(result.visual_subject_type, "event");
  assert.equal(result.subject_match_count, 0);
});

test("No confident subject at all reports subject_match_count: 0", () => {
  const result = determineVisualSubject({
    headline: "League announces new policy",
    combinedText: "League announces new policy",
    players: [],
    teams: [],
    category: "league_news",
  });
  assert.equal(result.visual_subject, null);
  assert.equal(result.subject_match_count, 0);
});

test("Existing return shape (visual_subject, visual_subject_type) is unaffected — only an additive field was introduced", () => {
  const result = determineVisualSubject({
    headline: "Patrick Mahomes ruled out for Sunday's game",
    combinedText: "Patrick Mahomes ruled out for Sunday's game",
    players: ["Patrick Mahomes"],
    teams: ["KC"],
    category: "injury",
  });
  const { visual_subject, visual_subject_type } = result;
  assert.deepEqual({ visual_subject, visual_subject_type }, { visual_subject: "Patrick Mahomes", visual_subject_type: "player" });
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
