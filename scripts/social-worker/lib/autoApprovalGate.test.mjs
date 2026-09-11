#!/usr/bin/env node
// Tests for the fail-closed automatic-approval gate. Pure function, no I/O
// — every test constructs an in-memory record and asserts eligible/issues.
// Run with: node scripts/social-worker/lib/autoApprovalGate.test.mjs
import assert from "node:assert/strict";
import { evaluateAutoApprovalGate } from "./autoApprovalGate.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function baseFeedRecord(overrides = {}) {
  return {
    story_id: "s1",
    status: "awaiting_approval",
    merged_into: null,
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    source_story: {
      post_headline: "JORDAN LOVE OUT WITH SHOULDER INJURY",
      description: "Jordan Love was hurt during practice with the Green Bay Packers.",
      base_image_url: "https://example.test/base.jpg",
      source_name: "ESPN",
      source_url: "https://espn.com/story/jordan-love-out",
      category: "injury",
      teams: ["Green Bay Packers"],
      players: ["Jordan Love"],
    },
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    story_artwork: { status: "not_created", image_url: null },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: ESPN" },
    approval: { status: "pending" },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

function baseStoryRecord(overrides = {}) {
  return baseFeedRecord({
    selection: { destination: "story", slot_id: "story:test", selected_at: "2026-01-01T00:00:00Z" },
    artwork: { status: "not_created", image_url: null },
    story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 941, height: 1672, mime_type: "image/png", size_bytes: 500000 },
    source_story: { ...baseFeedRecord().source_story, source_name: "FOX Sports" },
    caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: FOX Sports" },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test("1. a fully valid Feed record IS eligible", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord());
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("2. a fully valid Story record IS eligible", () => {
  const result = evaluateAutoApprovalGate(baseStoryRecord());
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

test("3. a source on the explicit auto-approval allowlist (e.g. NFL.com) is eligible", () => {
  const result = evaluateAutoApprovalGate(
    baseFeedRecord({
      source_story: { ...baseFeedRecord().source_story, source_name: "NFL.com" },
      caption: { status: "ready", text: "Jordan Love is out with a shoulder injury suffered during Green Bay Packers practice.\n\nSource: NFL.com" },
    })
  );
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// Fail-closed: state machine / lifecycle
// ---------------------------------------------------------------------------

test("4. a record not at awaiting_approval is rejected (e.g. still 'queued')", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ status: "queued" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("not_awaiting_approval")));
});

test("5. an already-posted record is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ status: "posted", approval: { status: "approved" }, publishing: { status: "posted" } }));
  assert.equal(result.eligible, false);
});

test("6. an already-approved record is rejected (nothing to approve again)", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ status: "approved", approval: { status: "approved" } }));
  assert.equal(result.eligible, false);
});

test("7. a rejected record is rejected (never auto-approved after a terminal rejection)", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ status: "rejected", approval: { status: "rejected" } }));
  assert.equal(result.eligible, false);
});

test("8. a failed record is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ status: "failed", approval: { status: "pending" } }));
  assert.equal(result.eligible, false);
});

test("9. approval.status inconsistent with awaiting_approval (defense in depth) is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ approval: { status: "approved" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("approval_not_pending")));
});

test("10. a merged story is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ merged_into: "other-story-id" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_merged"));
});

// ---------------------------------------------------------------------------
// Fail-closed: destination / selection
// ---------------------------------------------------------------------------

test("11. no selection at all is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ selection: undefined }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("no_selection"));
});

test("12. an invalid destination (neither feed nor story) is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ selection: { destination: "reel", selected_at: "2026-01-01T00:00:00Z" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("invalid_destination")));
});

// ---------------------------------------------------------------------------
// Fail-closed: source-article fixture data
// ---------------------------------------------------------------------------

test("13. missing headline is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ source_story: { ...baseFeedRecord().source_story, post_headline: "" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("headline_missing"));
});

test("14. missing base_image_url is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ source_story: { ...baseFeedRecord().source_story, base_image_url: null } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("base_image_url_missing"));
});

test("15. a missing source URL is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ source_story: { ...baseFeedRecord().source_story, source_url: null } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("source_url_invalid"));
});

test("16. a non-HTTPS source URL is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ source_story: { ...baseFeedRecord().source_story, source_url: "http://example.test/x" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("source_url_invalid"));
});

test("17. a source not on the explicit auto-approval allowlist is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ source_story: { ...baseFeedRecord().source_story, source_name: "Random Blogspot Site" } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("unrecognized_source")));
});

test("17b. a missing source_name is rejected as unrecognized, never silently allowed", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ source_story: { ...baseFeedRecord().source_story, source_name: null } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("unrecognized_source")));
});

// ---------------------------------------------------------------------------
// Fail-closed: artwork/caption readiness (delegates to assessApprovalReadiness)
// ---------------------------------------------------------------------------

test("18. Feed artwork not created is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ artwork: { status: "not_created", image_url: null } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("readiness:")));
});

test("19. Story artwork not created is rejected", () => {
  const result = evaluateAutoApprovalGate(baseStoryRecord({ story_artwork: { status: "not_created", image_url: null } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("readiness:")));
});

test("20. failed artwork validation (validation.passed=false) is rejected for Feed", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ validation: { status: "failed", passed: false, issues: ["aspect_ratio_out_of_range:0.5"] } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("readiness:")));
});

test("21. failed artwork validation is rejected for Story", () => {
  const result = evaluateAutoApprovalGate(baseStoryRecord({ validation: { status: "failed", passed: false, issues: [] } }));
  assert.equal(result.eligible, false);
});

test("22. a Feed record using record.story_artwork instead of record.artwork is never approved via the wrong field — canonical field must match destination", () => {
  // A malformed record with the Feed asset accidentally under story_artwork
  // and record.artwork left not_created must still be rejected — the gate
  // must never fall back to the wrong canonical field for the destination.
  const result = evaluateAutoApprovalGate(
    baseFeedRecord({ artwork: { status: "not_created", image_url: null }, story_artwork: { status: "created", image_url: "https://example.test/x.png", width: 941, height: 1672 } })
  );
  assert.equal(result.eligible, false);
});

test("23. caption not ready is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ caption: { status: "not_created", text: null } }));
  assert.equal(result.eligible, false);
});

test("24. empty caption text is rejected even if status claims ready", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ caption: { status: "ready", text: "   " } }));
  assert.equal(result.eligible, false);
});

// ---------------------------------------------------------------------------
// Fail-closed: in-flight / ambiguous posting state (defense in depth)
// ---------------------------------------------------------------------------

test("25. an active posting claim (should be structurally unreachable pre-approval, but never trusted blindly) is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ publishing: { status: "not_posted", claim: { claim_id: "stray-claim-1" }, instagram: { feed: { status: "not_posted" } } } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("active_posting_claim"));
});

test("26. publishing.status not 'not_posted' is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ publishing: { status: "posting", instagram: { feed: { status: "claimed" } } } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("publishing_status_not_clean")));
});

test("27. an already-recorded publish_attempted_at is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ publishing: { status: "not_posted", instagram: { feed: { status: "not_posted", publish_attempted_at: "2026-01-01T00:00:00Z" } } } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("publish_attempted_already_recorded"));
});

test("28. an ambiguous posting outcome on the record's own channel is rejected", () => {
  const result = evaluateAutoApprovalGate(baseStoryRecord({ publishing: { status: "not_posted", instagram: { story: { status: "ambiguous" } } } }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("ambiguous_posting_outcome"));
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

test("29. a null/undefined record is rejected without throwing", () => {
  assert.equal(evaluateAutoApprovalGate(null).eligible, false);
  assert.equal(evaluateAutoApprovalGate(undefined).eligible, false);
});

test("30. a record with no story_id is rejected", () => {
  const result = evaluateAutoApprovalGate(baseFeedRecord({ story_id: "" }));
  assert.equal(result.eligible, false);
  assert.deepEqual(result.issues, ["invalid_record"]);
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
