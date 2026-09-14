#!/usr/bin/env node
// Tests for the fail-closed content-fidelity gate. Pure function, no I/O.
// Run with: node scripts/social-worker/lib/contentFidelityGate.test.mjs
import assert from "node:assert/strict";
import { evaluateContentFidelity } from "./contentFidelityGate.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function baseRecord(overrides = {}) {
  return {
    source_story: {
      post_headline: "JORDAN LOVE OUT WITH SHOULDER INJURY",
      description: "Jordan Love was hurt during practice with the Green Bay Packers.",
      source_name: "ESPN",
      category: "injury",
      teams: ["Green Bay Packers"],
      players: ["Jordan Love"],
    },
    caption: { text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: ESPN" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test("1. a fully consistent Feed-style record passes", () => {
  const result = evaluateContentFidelity(baseRecord());
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("2. a caption that only restates the headline/description in different words still passes", () => {
  const result = evaluateContentFidelity(
    baseRecord({ caption: { text: "The Green Bay Packers will be without Jordan Love, who was hurt at practice with a shoulder issue.\n\nSource: ESPN" } })
  );
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("3. multiple teams/players in the canonical data are all individually supported", () => {
  const record = baseRecord({
    source_story: { ...baseRecord().source_story, teams: ["Green Bay Packers", "Chicago Bears"], players: ["Jordan Love", "Justin Fields"] },
    caption: { text: "Jordan Love and the Green Bay Packers face Justin Fields and the Chicago Bears this week.\n\nSource: ESPN" },
  });
  const result = evaluateContentFidelity(record);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("4. the real A.J. Brown production caption passes (regression anchor against the one genuine live-tested record)", () => {
  const record = {
    source_story: {
      post_headline: "A.J. BROWN DOWNGRADED TO OUT WITH ANKLE INJURY",
      description: "A.J. Brown's first game with the New England Patriots was going well until the opening drive of the second half.",
      source_name: "FOX Sports",
      category: "injury",
      teams: ["New England Patriots", "Seattle Seahawks"],
      players: ["A.J. Brown"],
    },
    caption: {
      text: "A.J. Brown has been downgraded to out with an ankle injury. The injury interrupted his first game with the New England Patriots during the opening drive of the second half.\n\nSource: FOX Sports",
    },
  };
  const result = evaluateContentFidelity(record);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// Missing canonical data — fail closed, never guess
// ---------------------------------------------------------------------------

test("5. missing canonical headline fails closed", () => {
  const result = evaluateContentFidelity(baseRecord({ source_story: { ...baseRecord().source_story, post_headline: "" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("missing_canonical_headline"));
});

test("6. missing canonical teams list (not an array at all) fails closed", () => {
  const result = evaluateContentFidelity(baseRecord({ source_story: { ...baseRecord().source_story, teams: undefined } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("missing_canonical_teams_list"));
});

test("7. missing canonical players list fails closed", () => {
  const result = evaluateContentFidelity(baseRecord({ source_story: { ...baseRecord().source_story, players: undefined } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("missing_canonical_players_list"));
});

test("8. missing caption text fails closed", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: null } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("missing_caption_text"));
});

// ---------------------------------------------------------------------------
// Headline / entity consistency
// ---------------------------------------------------------------------------

test("9. a fabricated player name absent from headline/description/players is rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Patrick Mahomes is out with a shoulder injury.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_named_entity") && i.includes("Mahomes")));
});

test("10. a fabricated team name absent from headline/description/teams is rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Jordan Love and the Dallas Cowboys prepare for Sunday.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_named_entity") && i.includes("Cowboys")));
});

test("11. a headline/entity mismatch (caption discusses an entirely different, unsupported subject) is rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Aaron Rodgers announced his retirement from the New York Jets today.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_named_entity")));
});

// ---------------------------------------------------------------------------
// Unsupported factual claims: score / injury / transaction / quote
// ---------------------------------------------------------------------------

test("12. an unsupported score is rejected (numbers absent from headline+description)", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "The Packers lost 24-17 with Jordan Love out injured.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("caption_validation:unsupported_number")));
});

test("13. an unsupported injury-status claim not present in the source and inconsistent with the record's own category is rejected", () => {
  const transactionRecord = baseRecord({
    source_story: { ...baseRecord().source_story, category: "transaction", description: "The Packers announced a roster move involving Jordan Love." },
    caption: { text: "Jordan Love is questionable for the Green Bay Packers this week.\n\nSource: ESPN" },
  });
  const result = evaluateContentFidelity(transactionRecord);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_injury_claim")));
});

test("14. an unsupported transaction/status claim not present in the source and inconsistent with the record's own category is rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Jordan Love was traded to the Green Bay Packers today.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_transaction_claim")));
});

test("14b. a status keyword that IS already present in the source headline/description is never flagged, regardless of category — it's source-supported by definition", () => {
  const record = baseRecord({
    source_story: { ...baseRecord().source_story, category: "injury", description: "Jordan Love was hurt during practice with the Green Bay Packers after being signed to a new deal." },
    caption: { text: "Jordan Love, recently signed, is out with a shoulder injury.\n\nSource: ESPN" },
  });
  const result = evaluateContentFidelity(record);
  assert.ok(!result.issues.some((i) => i.includes("unsupported_transaction_claim")));
});

test("15. an unsupported/fabricated quote is rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: 'Jordan Love said "I will be back stronger than ever" after the injury.\n\nSource: ESPN' } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("caption_validation:unsupported_quote")));
});

test("16. a quote verbatim from the description is NOT rejected as unsupported", () => {
  const record = baseRecord({
    source_story: { ...baseRecord().source_story, description: 'Jordan Love said "I will be back stronger than ever" after the injury.' },
    caption: { text: 'Jordan Love said "I will be back stronger than ever" after the injury.\n\nSource: ESPN' },
  });
  const result = evaluateContentFidelity(record);
  assert.ok(!result.issues.some((i) => i.includes("unsupported_quote")));
});

// ---------------------------------------------------------------------------
// Unsupported date/time claims (numeric proxy — see honest limits in the module header)
// ---------------------------------------------------------------------------

test("17. an unsupported specific date/timeline claim (a bare number absent from the source) is rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Jordan Love is expected to miss 3 games with the injury.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("caption_validation:unsupported_number")));
});

// ---------------------------------------------------------------------------
// Re-run of existing caption validation against CURRENT canonical data
// ---------------------------------------------------------------------------

test("18. an incorrect/missing source attribution is caught via the re-run of the existing caption validator", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Jordan Love is out with a shoulder injury.\n\nSource: NFL.com" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("caption_validation:missing_or_incorrect_attribution")));
});

test("19. an empty caption is caught via the re-run of the existing caption validator", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "   " } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("missing_caption_text"), "an all-whitespace caption is caught by this gate's own missing-text check first");
});

// ---------------------------------------------------------------------------
// 2026-09-14 sentence-boundary tokenization fix
// ---------------------------------------------------------------------------
// Proven root cause: extractCandidateEntities()'s old multi-word regex had
// no concept of a sentence boundary and would run a candidate phrase
// straight through a real sentence-ending period into the next sentence's
// own capitalized first word — "A.J. Brown. The nature..." matched as one
// candidate, "A.J. Brown. The". A second bug sat right behind it:
// isPhraseSupported() never stripped a genuine trailing sentence period
// before comparing a word against the vocabulary, so even a correctly
// extracted "A.J. Brown." would still fail to match the vocabulary's
// period-free "brown". Both are fixed together — see contentFidelityGate.js's
// own 2026-09-14 header for the exact distinction (initial period vs
// sentence-ending period) both halves of the fix rest on.

test("20. the EXACT recovered production caption for story_id 8e0f60e2-3e8e-4028-b141-05f8286466ce no longer false-positives on 'A.J. Brown. The' — the exact bug this fix closes", () => {
  const record = {
    source_story: {
      post_headline: "MIKE VRABEL HAD NO POSTGAME UPDATE ON A.J. BROWN",
      description: "It's still unclear what kind of injury and recovery Patriots receiver A.J.",
      source_name: "Pro Football Talk",
      category: "injury",
      teams: ["New England Patriots"],
      players: [],
    },
    caption: {
      text: "Mike Vrabel had no postgame update on Patriots receiver A.J. Brown. The nature of the injury and recovery remains unclear.\n\nSource: Pro Football Talk",
    },
  };
  const result = evaluateContentFidelity(record);
  assert.ok(!result.issues.some((i) => i.includes("A.J. Brown. The")), `must never produce the exact false-positive entity: ${JSON.stringify(result.issues)}`);
  assert.equal(result.passed, true, `no OTHER legitimate fidelity issue should remain either: ${JSON.stringify(result.issues)}`);
});

test("21. T.J. Watt followed by a new sentence is correctly split at the sentence boundary, not fused with the next sentence's capitalized word", () => {
  const record = baseRecord({
    source_story: { ...baseRecord().source_story, post_headline: "T.J. WATT RETURNS TO PRACTICE", description: "T.J. Watt practiced Wednesday with the Green Bay Packers.", players: ["T.J. Watt"] },
    caption: { text: "T.J. Watt returned to practice Wednesday. The Packers hope he plays Sunday.\n\nSource: ESPN" },
  });
  const result = evaluateContentFidelity(record);
  assert.ok(!result.issues.some((i) => i.includes("T.J. Watt. The")), `must never fuse the initial+surname with the next sentence: ${JSON.stringify(result.issues)}`);
});

test("22. D.J. Moore followed by a new sentence is correctly split at the sentence boundary", () => {
  const record = baseRecord({
    source_story: { ...baseRecord().source_story, post_headline: "D.J. MOORE PRACTICES IN FULL", description: "D.J. Moore was a full participant for the Chicago Bears.", teams: ["Chicago Bears"], players: ["D.J. Moore"] },
    caption: { text: "D.J. Moore was a full participant Wednesday. The Bears are optimistic for Sunday.\n\nSource: ESPN" },
  });
  const result = evaluateContentFidelity(record);
  assert.ok(!result.issues.some((i) => i.includes("D.J. Moore. The")), `must never fuse the initial+surname with the next sentence: ${JSON.stringify(result.issues)}`);
});

test("23. a plain (non-initial) name followed by a new sentence is correctly split at the sentence boundary — proves this is a general fix, not an initials-only special case", () => {
  const record = baseRecord({
    source_story: { ...baseRecord().source_story, post_headline: "PATRICK MAHOMES PRACTICES IN FULL", description: "Patrick Mahomes returned to practice with the Kansas City Chiefs.", teams: ["Kansas City Chiefs"], players: ["Patrick Mahomes"] },
    caption: { text: "Patrick Mahomes returned to practice Wednesday. The Chiefs are hopeful for Sunday.\n\nSource: ESPN" },
  });
  const result = evaluateContentFidelity(record);
  assert.ok(!result.issues.some((i) => i.includes("Mahomes. The")), `must never fuse a plain surname with the next sentence: ${JSON.stringify(result.issues)}`);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("24. normal sentence boundaries with ordinary lowercase-continuation prose are completely unaffected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Jordan Love is out with a shoulder injury. He is expected to miss time.\n\nSource: ESPN" } }));
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("25. a GENUINELY unsupported entity immediately followed by a sentence boundary is STILL rejected — the fix must never weaken real detection at exactly the position it touches", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Justin Herbert practiced Wednesday. The Chargers are hopeful.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_named_entity") && i.includes("Herbert")), JSON.stringify(result.issues));
});

test("26. a genuinely unsupported initial-style name (A.J. Someone, not in canonical data) immediately followed by a sentence boundary is still rejected", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "A.J. Someone practiced Wednesday. The Packers are hopeful.\n\nSource: ESPN" } }));
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.includes("unsupported_named_entity") && i.includes("Someone")), JSON.stringify(result.issues));
});

test("27. the caption's own 'Source: X' attribution line never chains into a following capitalized word as a false multi-word entity (the colon must break the run, not extend it)", () => {
  const result = evaluateContentFidelity(baseRecord({ caption: { text: "Jordan Love is out with a shoulder injury.\n\nSource: ESPN" } }));
  assert.ok(!result.issues.some((i) => i.includes("Source: ESPN")), `'Source:' must never be treated as chaining into the following capitalized word: ${JSON.stringify(result.issues)}`);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("28. an ALL-CAPS acronym immediately after a real sentence boundary is still handled correctly (e.g. a caption ending '...practice. NFL Network reported it first.')", () => {
  const record = baseRecord({ source_story: { ...baseRecord().source_story, description: "Jordan Love was hurt during practice with the Green Bay Packers, per NFL Network." } });
  const result = evaluateContentFidelity(record);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
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
