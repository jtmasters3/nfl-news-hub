#!/usr/bin/env node
// Tests for the pre-generation static autonomous eligibility check.
// Run with: node scripts/social-worker/lib/staticAutonomousEligibility.test.mjs
import assert from "node:assert/strict";
import { evaluateStaticAutonomousEligibility } from "./staticAutonomousEligibility.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function validQueuedRecord(overrides = {}) {
  return {
    story_id: "s1",
    status: "queued",
    merged_into: null,
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    source_story: {
      post_headline: "JORDAN LOVE OUT WITH SHOULDER INJURY",
      description: "Jordan Love was hurt during practice with the Green Bay Packers.",
      source_name: "ESPN",
      source_url: "https://espn.com/story/jordan-love-out",
      teams: ["Green Bay Packers"],
      players: ["Jordan Love"],
    },
    approval: { status: "pending" },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test("1. a valid, fresh queued Feed record is eligible", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord());
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("2. a valid, fresh queued Story record is eligible", () => {
  const result = evaluateStaticAutonomousEligibility(
    validQueuedRecord({ selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" }, source_story: { ...validQueuedRecord().source_story, source_name: "FOX Sports" } })
  );
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("3. an already-prepared, still-pending awaiting_approval record is statically eligible too (the approve-only fast path relies on this)", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ status: "awaiting_approval" }));
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("4. an EMPTY (but present) teams[] array is legitimate and does not disqualify a record — the canonical extraction pipeline's own way of saying 'no teams extracted'", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, teams: [] } }));
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("5. an EMPTY (but present) players[] array is legitimate and does not disqualify a record", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, players: [] } }));
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// Legacy / missing canonical data — the actual audited backlog shape
// ---------------------------------------------------------------------------

test("6. a legacy record with NO selection object at all is skipped (the real, audited backlog shape)", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ selection: undefined }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("no_selection"));
});

test("7. a legacy record missing the teams FIELD entirely (not an array at all) is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, teams: undefined } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("teams_field_missing"));
});

test("8. a legacy record missing the players FIELD entirely is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, players: undefined } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("players_field_missing"));
});

test("9. a record with an invalid destination is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ selection: { destination: "reel", selected_at: "2026-01-01T00:00:00Z" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("invalid_destination")));
});

test("10. missing canonical headline is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, post_headline: "" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("headline_missing"));
});

test("11. missing canonical description is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, description: null } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("description_missing"));
});

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

test("12. an unsupported source is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, source_name: "Random Blog" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("unrecognized_source")));
});

test("13. an invalid/non-HTTPS source URL is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ source_story: { ...validQueuedRecord().source_story, source_url: "http://example.test/x" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("source_url_invalid"));
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("14. an already-approved record is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ status: "approved", approval: { status: "approved" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("already_approved"));
});

test("15. an already-rejected record is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ status: "rejected", approval: { status: "rejected" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("already_rejected"));
});

test("16. a currently-posting record is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ status: "posting", publishing: { status: "posting" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("not_autonomous_actionable_status")));
});

test("17. an already-posted record is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ status: "posted", publishing: { status: "posted" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("not_autonomous_actionable_status")));
});

test("18. an ambiguous posting outcome is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(
    validQueuedRecord({ status: "posting", publishing: { status: "posting", instagram: { feed: { status: "ambiguous" } } } })
  );
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("ambiguous_posting_outcome"));
});

test("19. a record with an already-recorded publish_attempted_at is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(
    validQueuedRecord({ publishing: { status: "not_posted", instagram: { feed: { status: "not_posted", publish_attempted_at: "2026-01-01T00:00:00Z" } } } })
  );
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("publish_attempted_already_recorded"));
});

test("20. a record with an active posting claim is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ publishing: { status: "not_posted", claim: { claim_id: "stray-claim-1" } } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("active_posting_claim"));
});

test("21. a merged story is skipped", () => {
  const result = evaluateStaticAutonomousEligibility(validQueuedRecord({ merged_into: "other-story-id" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_merged"));
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

test("22. a null/undefined record is rejected without throwing", () => {
  assert.equal(evaluateStaticAutonomousEligibility(null).eligible, false);
  assert.equal(evaluateStaticAutonomousEligibility(undefined).eligible, false);
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
