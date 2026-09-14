#!/usr/bin/env node
// Tests for the 2026-09-14 hands-off caption-completion recovery
// eligibility check. Pure, no I/O — every case constructs its own
// record/doRecord fixtures. Run with:
// node scripts/social-worker/lib/captionRecoveryEligibility.test.mjs
import assert from "node:assert/strict";
import { githubSideCaptionRecoveryIssues, evaluateCaptionRecoveryEligibility } from "./captionRecoveryEligibility.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** The EXACT proven-stuck shape: artwork_ready, caption stuck at "generating" with a known claim_id, everything else clean. */
function stuckRecord(overrides = {}) {
  return {
    story_id: "8e0f60e2-3e8e-4028-b141-05f8286466ce",
    status: "artwork_ready",
    merged_into: null,
    approval: { status: "pending" },
    caption: {
      status: "generating",
      text: null,
      claim: { claim_id: "feb3591f-fab7-41c7-8bd8-72b6984f3da0", processor_id: "local-codex-LAPTOP-H4IOBCTP", claimed_at: "2026-09-11T22:08:47.249Z", claim_expires_at: "2026-09-11T22:58:47.249Z" },
    },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

/** The matching, genuinely-completed DO record for the record above. */
function completedDoRecord(overrides = {}) {
  return {
    status: "completed",
    claim_id: "feb3591f-fab7-41c7-8bd8-72b6984f3da0",
    processor_id: "local-codex-LAPTOP-H4IOBCTP",
    dispatch_confirmed: true,
    payload: { story_id: "8e0f60e2-3e8e-4028-b141-05f8286466ce", claim_id: "feb3591f-fab7-41c7-8bd8-72b6984f3da0", text: "A caption.", provider: "chatgpt-codex-local" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The exact proven-stuck state — must be recognized as eligible
// ---------------------------------------------------------------------------

test("1. the exact proven production stuck state is eligible for automatic replay", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord(), completedDoRecord());
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
  assert.equal(result.claimId, "feb3591f-fab7-41c7-8bd8-72b6984f3da0");
});

test("2. the GitHub-side pre-filter alone also recognizes the exact proven stuck state as a plausible candidate", () => {
  const issues = githubSideCaptionRecoveryIssues(stuckRecord());
  assert.deepEqual(issues, []);
});

// ---------------------------------------------------------------------------
// GitHub-side rejections
// ---------------------------------------------------------------------------

test("3. a record not at artwork_ready is never eligible", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ status: "awaiting_approval" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("not_artwork_ready")));
});

test("4. an already-approved record is never eligible (even if somehow still artwork_ready)", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ approval: { status: "approved" } }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("already_approved"));
});

test("5. a posting record is never eligible", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ status: "posting" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_posting"));
});

test("6. a posted record is never eligible", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ status: "posted" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_posted"));
});

test("7. a record whose caption is ALREADY ready is never eligible — nothing to recover, never re-replay", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ caption: { status: "ready", text: "Already done." } }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("caption_already_ready"));
});

test("8. a record with no existing caption claim at all is never eligible — recovery only ever replays a KNOWN claim, never invents one", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ caption: { status: "not_created" } }), null);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("no_existing_caption_claim"));
});

test("9. an active posting claim blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ publishing: { status: "not_posted", claim: { claim_id: "stray-claim" } } }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("active_posting_claim"));
});

test("10. a publishing.status that isn't not_posted blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ publishing: { status: "posting" } }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("publishing_status_not_clean")));
});

test("11. an already-recorded publish_attempted_at blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(
    stuckRecord({ publishing: { status: "not_posted", instagram: { feed: { status: "not_posted", publish_attempted_at: "2026-01-01T00:00:00Z" } } } }),
    completedDoRecord()
  );
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("publish_attempted_already_recorded"));
});

test("12. an ambiguous posting outcome blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(
    stuckRecord({ publishing: { status: "not_posted", instagram: { feed: { status: "ambiguous" } } } }),
    completedDoRecord()
  );
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("ambiguous_posting_outcome"));
});

test("13. a merged story is never eligible", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ merged_into: "other-story" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_merged"));
});

test("14. a null/undefined record is rejected without throwing", () => {
  assert.equal(evaluateCaptionRecoveryEligibility(null, completedDoRecord()).eligible, false);
  assert.equal(evaluateCaptionRecoveryEligibility(undefined, null).eligible, false);
});

// ---------------------------------------------------------------------------
// Durable Object-side rejections
// ---------------------------------------------------------------------------

test("15. no DO record at all blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord(), null);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_record_not_found"));
});

test("16. a DO record whose claim_id does NOT match the GitHub record's claim_id blocks eligibility — never replays under a wrong/stale claim", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord(), completedDoRecord({ claim_id: "some-other-claim-id" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_claim_id_mismatch"));
});

test("17. a DO status of 'claimed' (still in flight, not yet completed) blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord(), completedDoRecord({ status: "claimed" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_status_not_completed:claimed"));
});

test("18. a DO status of 'failed' blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord(), completedDoRecord({ status: "failed" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_status_not_completed:failed"));
});

test("19. a completed DO record with no stored payload blocks eligibility", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord(), completedDoRecord({ payload: null }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_payload_missing"));
});

test("20. every applicable issue is reported at once, not just the first one found", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ approval: { status: "approved" }, merged_into: "x" }), null);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("already_approved"));
  assert.ok(result.issues.includes("story_merged"));
  assert.ok(result.issues.includes("do_record_not_found"));
});

test("21. eligibility never returns a claimId when ineligible — a caller must never accidentally replay using it", () => {
  const result = evaluateCaptionRecoveryEligibility(stuckRecord({ status: "posted" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.equal(result.claimId, null);
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
