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
