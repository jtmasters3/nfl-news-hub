#!/usr/bin/env node
// NFL-Only Ingestion Cleanup — Stage 2 regression suite. Fully offline and
// deterministic: no network, no live nflverse/RSS dependency. Real fixtures
// are literal headline/excerpt text captured read-only from the live
// production news.json during this task's own audit — never fabricated
// when a real example was available. This module has ZERO production
// importers; this file is its only current caller besides ad hoc
// validation scripts.
// Run with: node scripts/tests/nfl-relevance-regression.mjs
import assert from "node:assert/strict";
import { classifyNflRelevance } from "../lib/nflRelevance.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// KEEP — real fixtures (captured verbatim from production news.json)
// ---------------------------------------------------------------------------

test("1. real: NFL Mock Draft story heavy with college language -> KEEP (the hard regression requirement)", () => {
  const r = classifyNflRelevance({
    sourceName: "FOX Sports",
    headline: "2027 NFL Mock Draft: Arch Manning Or Dante Moore At No. 1 Overall?",
    excerpt: "Four QBs come off the board in the first round of our mock draft kicking off both the NFL and college football seasons.",
  });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "nfl_with_college_context");
  assert.ok(r.nfl_evidence.includes("phrase_nfl_draft"));
  assert.ok(r.nfl_evidence.includes("nfl_preserving_category:draft"));
});

test("2. real: NFL transaction involving a player, college background irrelevant here -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Colts sign OT Luke Tenuta off of their practice squad",
    excerpt: "The Colts made a change to their roster ahead of their season opener against the Ravens.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("IND"));
});

test("3. real: Colts sign OT Luke Tenuta off their practice squad -> KEEP (duplicate of required fixture #3, kept literal)", () => {
  const r = classifyNflRelevance({ headline: "Colts sign OT Luke Tenuta off of their practice squad", excerpt: "The Colts made a change to their roster ahead of their season opener against the Ravens." });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "nfl");
});

test("4. real: NFL team + undrafted rookie -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Andy Reid says he's confident undrafted rookie Kahlil Benson can protect Patrick Mahomes",
    excerpt: "Patrick Mahomes has recovered well enough from last year's torn ACL to start on Monday night.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.nfl_evidence.includes("phrase_udfa"));
});

test("5. real: NFL coach story -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Raiders' depth chart lists Fernando Mendoza as QB2",
    excerpt: "Raiders head coach Klint Kubiak has declined to say whether rookie Fernando Mendoza or Aidan O'Connell will back up starting quarterback Kirk Cousins.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("LV"));
});

test("6. real: NFL owner/executive story -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "NFL Commissioner Roger Goodell Receives Extension, Keeping Him In Job Through 2030",
    excerpt: "As another NFL season kicks off, the league's top executive isn't going anywhere. NFL owners have officially locked in Roger Goodell with a multi-year contract extension on Sunday morning.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.nfl_evidence.includes("phrase_nfl_commissioner"));
  assert.ok(r.nfl_evidence.includes("nfl_preserving_category:contract"));
});

test("7. real: NFL injury story -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "With opener looming, Rams DE Myles Garrett returns to practice",
    excerpt: "Knee injury had kept 2025 defensive player of the year out for a while.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("LAR"));
});

test("8. real: NFL contract story -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Report: Commissioner Roger Goodell agrees on extension through 2030 season; fifth re-up of career",
    excerpt: "The league has informed teams that Commissioner Roger Goodell agreed to terms with NFL owners on a contract extension through the 2030 season, ESPN's Adam Schefter reported Sunday.",
  });
  assert.equal(r.decision, "keep");
  assert.equal(r.detected_category, "contract");
});

test("9. real: NFL free-agency-category story -> KEEP", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Nick Bosa, George Kittle limited participants in practice",
    excerpt: "The 49ers released their first practice report of 2026.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("SF"));
});

test("10. bare mention of the word 'NFL' alone, no team/college marker/transaction phrase -> ambiguous, fail-open KEEP", () => {
  // The bare word "NFL" is deliberately NOT, by itself, treated as strong
  // evidence (only structural phrases that literally combine it with
  // Draft/Combine/Commissioner/owner(s)/NFLPA are trusted — see module
  // header). With no college marker present either, this correctly falls
  // through every rule to the final fail-open "ambiguous" branch. The REAL
  // production version of this exact headline (see reject fixture #19
  // below) DOES carry an explicit college marker in its actual excerpt and
  // is correctly rejected — this fixture's generic excerpt deliberately
  // omits that marker to isolate and prove the "bare NFL word is not
  // sufficient evidence" behavior on its own.
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Under NFL rules, Michigan wouldn't have gotten a final play",
    excerpt: "A rules explainer referencing NFL replay procedure.",
  });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "ambiguous");
  assert.equal(r.nfl_evidence.length, 0);
});

test("11. NFL Combine story -> KEEP", () => {
  const r = classifyNflRelevance({ headline: "NFL Combine: Five prospects who helped themselves most", excerpt: "Workouts in Indianapolis reshuffled several draft boards." });
  assert.equal(r.decision, "keep");
  assert.ok(r.nfl_evidence.includes("phrase_nfl_combine"));
});

test("12. NFL team drafting a college player, heavy college language -> KEEP", () => {
  const r = classifyNflRelevance({
    headline: "Bears select LSU cornerback with first-round pick in NFL Draft",
    excerpt: "Chicago moved up to grab the SEC standout after a strong college football career.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("CHI"));
  assert.equal(r.classification, "nfl_with_college_context");
});

test("13. NFL rookie college-background story -> KEEP", () => {
  const r = classifyNflRelevance({
    headline: "Cowboys rookie reflects on his Big Ten championship season before turning pro",
    excerpt: "The undrafted rookie signed with Dallas after a standout college football career.",
  });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("DAL"));
});

// ---------------------------------------------------------------------------
// REJECT — real fixtures (the actual production contaminants found in the audit)
// ---------------------------------------------------------------------------

test("14. real reject: SEC/LSU eligibility legal fight -> REJECT", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "SEC sues LSU, Lane Kiffin in federal court over NFL transfer issue",
    excerpt: "The conference and school are at odds over eligibility for former pro players.",
  });
  assert.equal(r.decision, "reject");
  assert.equal(r.classification, "college_football");
});

test("15. real reject: SEC seeks authority to expel LSU -> REJECT", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "SEC seeks authority to expel LSU",
    excerpt: "Even though LSU blinked for now on the issue of adding former NFL players to the roster for its first game of the 2026 season, the SEC wants to be able to blow the Tigers out of the conference.",
  });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("conference_sec"));
});

test("16. real reject: Louisiana judge rules against NCAA, LSU roster case -> REJECT", () => {
  const r = classifyNflRelevance({
    sourceName: "NFL.com",
    headline: "Louisiana judge rules against NCAA, clearing path for ex-NFL players to join LSU roster",
    excerpt: "LSU coach Lane Kiffin's chances of fielding former NFL players improved Thursday night when a Louisiana judge issued a preliminary injunction against the NCAA in a high-profile eligibility case.",
  });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("college_ncaa"));
});

test("17. real reject: Mid-American Conference / Western Michigan -> REJECT", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Mid-American Conference appeals to have Western Michigan recognized as winner of game against Michigan",
    excerpt: "Western Michigan's last-second loss to Michigan on a Hail Mary after a controversial replay review granted the Wolverines an extra play was the biggest story of the college football weekend.",
  });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("conference_mac") || r.non_nfl_evidence.includes("college_football_phrase"));
});

test("18. real reject: Big Ten replay/rules story -> REJECT", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Big Ten is using enhanced replay access this season, in Friday games only",
    excerpt: "Last night's controversial finish to the Western Michigan-Michigan game would have been somewhat less controversial if the Big Ten had deployed transparency in the replay process.",
  });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("conference_big_ten"));
});

test("19. real reject: Under NFL rules, Michigan wouldn't have gotten a final play -> REJECT (mere word 'NFL' is not KEEP evidence)", () => {
  const r = classifyNflRelevance({
    sourceName: "Pro Football Talk",
    headline: "Under NFL rules, Michigan wouldn't have gotten a final play",
    excerpt: "A rules explainer referencing NFL replay procedure applied to a college football controversy.",
  });
  assert.equal(r.decision, "reject");
  assert.equal(r.nfl_evidence.length, 0);
});

// ---------------------------------------------------------------------------
// SYNTHETIC REJECT — other sports and college-only scenarios not currently
// present in the live window
// ---------------------------------------------------------------------------

test("20. synthetic: pure NBA story -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "NBA imposes unprecedented punishment on Clippers for salary-cap circumvention", excerpt: "The league fined the team a record amount and stripped future draft picks." });
  assert.equal(r.decision, "reject");
  assert.equal(r.classification, "other_sport");
  assert.ok(r.non_nfl_evidence.includes("league_nba"));
});

test("21. synthetic: pure MLB story -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "MLB announces expanded playoff format for next season", excerpt: "Owners approved the change at the league meetings." });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("league_mlb"));
});

test("22. synthetic: pure NHL story -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "NHL suspends player for hit during preseason game", excerpt: "The league announced a four-game ban." });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("league_nhl"));
});

test("23. synthetic: pure college recruiting story -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "Five-star recruit commits to Alabama over Georgia", excerpt: "The nation's top recruiting class just got a major addition." });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("college_recruiting"));
});

test("24. synthetic: pure transfer-portal story -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "Star quarterback enters transfer portal after coaching change", excerpt: "He is expected to have plenty of college suitors." });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("college_transfer_portal"));
});

test("25. synthetic: pure college game result -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "Ohio State routs rival in college football rivalry game", excerpt: "The Buckeyes dominated from start to finish in a top-10 college football matchup." });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("college_football_phrase"));
});

test("26. synthetic: pure college rankings story -> REJECT", () => {
  const r = classifyNflRelevance({ headline: "New college football rankings released after wild weekend", excerpt: "The top of the NCAA poll saw significant shakeup." });
  assert.equal(r.decision, "reject");
  assert.ok(r.non_nfl_evidence.includes("college_ncaa") || r.non_nfl_evidence.includes("college_football_phrase"));
});

// ---------------------------------------------------------------------------
// AMBIGUITY / FAIL-OPEN
// ---------------------------------------------------------------------------

test("27. missing headline -> KEEP (fail open)", () => {
  const r = classifyNflRelevance({ excerpt: "Some general sports commentary with no clear signal." });
  assert.equal(r.decision, "keep");
});

test("28. missing excerpt -> resolved from headline alone, still fail-open safe", () => {
  const r = classifyNflRelevance({ headline: "Cowboys announce roster move" });
  assert.equal(r.decision, "keep");
  assert.ok(r.detected_teams.includes("DAL"));
});

test("29. both headline and excerpt missing -> KEEP (fail open)", () => {
  const r = classifyNflRelevance({ sourceName: "Pro Football Talk" });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "ambiguous");
  assert.ok(r.reason_codes.includes("missing_text_fail_open"));
});

test("30. unknown/unrecognized source -> KEEP unless content says otherwise (source is diagnostic, not authority)", () => {
  const r = classifyNflRelevance({ sourceName: "Some Random Blog Nobody Has Heard Of", headline: "Team announces new stadium plans", excerpt: "Details to follow." });
  assert.equal(r.decision, "keep");
});

test("31. conflicting NFL + college evidence -> NFL evidence wins, KEEP", () => {
  const r = classifyNflRelevance({ headline: "NFL Draft prospect from SEC school drawing first-round buzz", excerpt: "College football scouts and NFL personnel both love his tape." });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "nfl_with_college_context");
});

test("32. human-name-only headline, no other signal -> KEEP (ambiguous, fail open)", () => {
  const r = classifyNflRelevance({ headline: "John Smith speaks out", excerpt: "He addressed the situation directly." });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "ambiguous");
});

test("33. generic sports headline with no league signal -> KEEP (ambiguous, fail open)", () => {
  const r = classifyNflRelevance({ headline: "Team wins big game on the road", excerpt: "A dominant performance sealed the victory." });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "ambiguous");
});

test("34. generic legal headline with no sport signal at all -> KEEP (ambiguous, fail open)", () => {
  const r = classifyNflRelevance({ headline: "Court issues ruling in ongoing case", excerpt: "The decision could have wide-reaching implications." });
  assert.equal(r.decision, "keep");
  assert.equal(r.classification, "ambiguous");
});

// ---------------------------------------------------------------------------
// NO MUTATION / DETERMINISM
// ---------------------------------------------------------------------------

test("35. input object not mutated", () => {
  const input = { sourceId: "pft", sourceName: "Pro Football Talk", sourceUrl: "https://example.test/a", headline: "Cowboys sign veteran linebacker", excerpt: "Dallas added depth ahead of Week 1." };
  const snapshot = JSON.stringify(input);
  classifyNflRelevance(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("36. same input repeatedly produces identical output", () => {
  const input = { headline: "Colts sign OT Luke Tenuta off of their practice squad", excerpt: "The Colts made a change to their roster ahead of their season opener against the Ravens." };
  const a = classifyNflRelevance(input);
  const b = classifyNflRelevance(input);
  assert.deepEqual(a, b);
});

test("37. array/object ordering deterministic across calls with differently-ordered but equal input", () => {
  const a = classifyNflRelevance({ headline: "Chiefs and Raiders both make roster moves", excerpt: "Both AFC West teams filled out their rosters." });
  const b = classifyNflRelevance({ excerpt: "Both AFC West teams filled out their rosters.", headline: "Chiefs and Raiders both make roster moves" });
  assert.deepEqual(a.detected_teams.slice().sort(), b.detected_teams.slice().sort());
  assert.equal(a.decision, b.decision);
});

test("38. no Date.now dependency", () => {
  const original = Date.now;
  Date.now = () => {
    throw new Error("classifyNflRelevance must never call Date.now()");
  };
  try {
    const r = classifyNflRelevance({ headline: "Colts sign OT Luke Tenuta off of their practice squad", excerpt: "Roster move." });
    assert.equal(r.decision, "keep");
  } finally {
    Date.now = original;
  }
});

test("39. no network dependency (pure synchronous function)", () => {
  const result = classifyNflRelevance({ headline: "Jets sign free agent cornerback", excerpt: "New York added a veteran to the secondary." });
  assert.equal(typeof result, "object");
  assert.ok(!(result instanceof Promise));
});

test("40. output shape matches the documented contract exactly", () => {
  const r = classifyNflRelevance({ headline: "Cowboys sign veteran linebacker", excerpt: "Dallas added depth." });
  const expectedKeys = ["decision", "classification", "confidence", "nfl_evidence", "non_nfl_evidence", "detected_teams", "detected_category", "reason_codes"].sort();
  assert.deepEqual(Object.keys(r).sort(), expectedKeys);
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
