#!/usr/bin/env node
// Tests for the pre-generation static autonomous eligibility check.
// Run with: node scripts/social-worker/lib/staticAutonomousEligibility.test.mjs
import assert from "node:assert/strict";
import { evaluateStaticAutonomousEligibility } from "./staticAutonomousEligibility.js";
import { isSelectionExpired } from "../../lib/selectionEngine.js";

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
// 2026-09-14 durability fix — stale-selection leak (real production post,
// story_id 33e7e68f-3076-423d-abb9-ce9844426ee1, "EMMANUEL ACHO COMMENTS
// SPARK NFL INVESTIGATION OF DOM DISANDRO": selected 2026-09-10 for that
// day's 12:00 PM ET Feed slot, sat at "queued" for four days, then
// autonomously generated and posted on 2026-09-14 as if it were current).
// ---------------------------------------------------------------------------

test("23. isSelectionExpired: exactly at window_end + grace is expired (Feed, 20min grace)", () => {
  const windowEnd = "2026-09-10T16:00:00.000Z"; // the real record's own window_end
  const expiryMs = Date.parse(windowEnd) + 20 * 60 * 1000;
  assert.equal(isSelectionExpired({ destination: "feed", window_end: windowEnd }, expiryMs), true);
});

test("24. isSelectionExpired: one millisecond before window_end + grace is NOT yet expired (Feed)", () => {
  const windowEnd = "2026-09-10T16:00:00.000Z";
  const expiryMs = Date.parse(windowEnd) + 20 * 60 * 1000;
  assert.equal(isSelectionExpired({ destination: "feed", window_end: windowEnd }, expiryMs - 1), false);
});

test("25. isSelectionExpired: Feed and Story both use the SAME 20-minute grace (2026-09-14 tightening — no longer a longer Feed grace)", () => {
  const windowEnd = "2026-09-10T16:00:00.000Z";
  const nineteenMinLater = Date.parse(windowEnd) + 19 * 60 * 1000;
  const twentyOneMinLater = Date.parse(windowEnd) + 21 * 60 * 1000;
  assert.equal(isSelectionExpired({ destination: "story", window_end: windowEnd }, nineteenMinLater), false);
  assert.equal(isSelectionExpired({ destination: "feed", window_end: windowEnd }, nineteenMinLater), false);
  assert.equal(isSelectionExpired({ destination: "story", window_end: windowEnd }, twentyOneMinLater), true);
  assert.equal(isSelectionExpired({ destination: "feed", window_end: windowEnd }, twentyOneMinLater), true);
});

test("26. isSelectionExpired: no selection at all is never 'expired' — this predicate only applies once a selection exists", () => {
  assert.equal(isSelectionExpired(null, Date.now()), false);
  assert.equal(isSelectionExpired(undefined, Date.now()), false);
});

test("27. isSelectionExpired: a missing/invalid window_end never throws and is treated as not-expired", () => {
  assert.equal(isSelectionExpired({ destination: "feed" }, Date.now()), false);
  assert.equal(isSelectionExpired({ destination: "feed", window_end: "not-a-date" }, Date.now()), false);
});

test("28. THE EXACT PRODUCTION RECORD — a record shaped exactly like story_id 33e7e68f-3076-423d-abb9-ce9844426ee1 (selected 2026-09-10 for the 12:00 PM Feed slot, still 'queued' four days later on 2026-09-14) is REJECTED with selection_window_expired, never silently eligible", () => {
  const record = validQueuedRecord({
    selection: { destination: "feed", slot_id: "feed:2026-09-10T12:00:00-04:00", selected_at: "2026-09-10T16:00:27.781Z", window_start: "2026-09-10T14:00:00.000Z", window_end: "2026-09-10T16:00:00.000Z" },
  });
  const fourDaysLaterMs = Date.parse("2026-09-14T19:37:17.701Z"); // the real claim timestamp that actually occurred
  const result = evaluateStaticAutonomousEligibility(record, fourDaysLaterMs);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("selection_window_expired"), JSON.stringify(result.issues));
});

test("29. a FRESH selection (well within its own slot + the 20-minute grace) remains fully eligible — this fix must never block legitimate, timely autonomous processing", () => {
  const record = validQueuedRecord({
    selection: { destination: "feed", slot_id: "feed:2026-09-14T16:00:00-04:00", selected_at: "2026-09-14T16:00:05.000Z", window_start: "2026-09-14T14:00:00.000Z", window_end: "2026-09-14T16:00:00.000Z" },
  });
  const fiveMinutesLaterMs = Date.parse("2026-09-14T16:05:00.000Z"); // a single normal 10-minute cron tick, well inside the grace
  const result = evaluateStaticAutonomousEligibility(record, fiveMinutesLaterMs);
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// 2026-09-14 tightening — exact user-specified boundary cases (20-minute
// grace, matching a real 16:00 ET Feed slot and hourly Story slot).
// ---------------------------------------------------------------------------

test("30. 16:19 (Feed): a 16:00 Feed slot selection is STILL VALID 19 minutes after window_end", () => {
  const record = validQueuedRecord({
    selection: { destination: "feed", slot_id: "feed:2026-09-14T16:00:00-04:00", selected_at: "2026-09-14T20:00:05.000Z", window_start: "2026-09-14T18:00:00.000Z", window_end: "2026-09-14T20:00:00.000Z" },
  });
  const at1619Ms = Date.parse("2026-09-14T20:19:00.000Z"); // 16:19 ET = 20:19 UTC
  const result = evaluateStaticAutonomousEligibility(record, at1619Ms);
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("31. 16:21 (Feed): the SAME 16:00 Feed slot selection is EXPIRED 21 minutes after window_end", () => {
  const record = validQueuedRecord({
    selection: { destination: "feed", slot_id: "feed:2026-09-14T16:00:00-04:00", selected_at: "2026-09-14T20:00:05.000Z", window_start: "2026-09-14T18:00:00.000Z", window_end: "2026-09-14T20:00:00.000Z" },
  });
  const at1621Ms = Date.parse("2026-09-14T20:21:00.000Z"); // 16:21 ET = 20:21 UTC
  const result = evaluateStaticAutonomousEligibility(record, at1621Ms);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("selection_window_expired"), JSON.stringify(result.issues));
});

test("32. Story +19 min: a Story slot selection is STILL VALID 19 minutes after window_end", () => {
  const record = validQueuedRecord({
    selection: { destination: "story", slot_id: "story:2026-09-14T16:00:00-04:00", selected_at: "2026-09-14T20:00:05.000Z", window_start: "2026-09-14T19:00:00.000Z", window_end: "2026-09-14T20:00:00.000Z" },
  });
  const plus19Ms = Date.parse("2026-09-14T20:19:00.000Z");
  const result = evaluateStaticAutonomousEligibility(record, plus19Ms);
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("33. Story +21 min: the SAME Story slot selection is EXPIRED 21 minutes after window_end", () => {
  const record = validQueuedRecord({
    selection: { destination: "story", slot_id: "story:2026-09-14T16:00:00-04:00", selected_at: "2026-09-14T20:00:05.000Z", window_start: "2026-09-14T19:00:00.000Z", window_end: "2026-09-14T20:00:00.000Z" },
  });
  const plus21Ms = Date.parse("2026-09-14T20:21:00.000Z");
  const result = evaluateStaticAutonomousEligibility(record, plus21Ms);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("selection_window_expired"), JSON.stringify(result.issues));
});

test("34. an expired record at 'queued' fails closed via this pre-generation filter regardless of every other field being otherwise perfect", () => {
  const record = validQueuedRecord({
    status: "queued",
    selection: { destination: "feed", slot_id: "feed:2026-09-14T16:00:00-04:00", window_end: "2026-09-14T16:00:00.000Z" },
  });
  const wayLaterMs = Date.parse("2026-09-14T16:00:00.000Z") + 21 * 60 * 1000;
  assert.equal(evaluateStaticAutonomousEligibility(record, wayLaterMs).eligible, false);
});

test("35. an expired record at 'awaiting_approval' (approve-only mode's own candidate pool) ALSO fails closed via this same filter", () => {
  const record = validQueuedRecord({
    status: "awaiting_approval",
    selection: { destination: "feed", slot_id: "feed:2026-09-14T16:00:00-04:00", window_end: "2026-09-14T16:00:00.000Z" },
  });
  const wayLaterMs = Date.parse("2026-09-14T16:00:00.000Z") + 21 * 60 * 1000;
  const result = evaluateStaticAutonomousEligibility(record, wayLaterMs);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("selection_window_expired"), JSON.stringify(result.issues));
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
