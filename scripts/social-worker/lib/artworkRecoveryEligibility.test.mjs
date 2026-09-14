#!/usr/bin/env node
// Tests for the 2026-09-14 hands-off PRIMARY artwork-completion recovery
// eligibility check. Pure, no I/O. Mirrors captionRecoveryEligibility.test.mjs's
// own style exactly. Run with:
// node scripts/social-worker/lib/artworkRecoveryEligibility.test.mjs
import assert from "node:assert/strict";
import { githubSideArtworkRecoveryIssues, evaluateArtworkRecoveryEligibility } from "./artworkRecoveryEligibility.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** The EXACT proven-stuck shape: artwork_requested with a known claim_id, everything else clean. */
function stuckRecord(overrides = {}) {
  return {
    story_id: "0cba51db-8c38-436f-ae48-a4af46e9f6bd",
    status: "artwork_requested",
    merged_into: null,
    approval: { status: "pending" },
    claim: { claim_id: "9445bc04-b163-4c12-9ff3-1990ec82a014", processor_id: "local-codex-runnervmlun5p", claimed_at: "2026-09-14T16:59:41.788Z", claim_expires_at: "2026-09-14T17:49:41.788Z" },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
    ...overrides,
  };
}

/** The matching, genuinely-completed DO record for the record above. */
function completedDoRecord(overrides = {}) {
  return {
    status: "completed",
    claim_id: "9445bc04-b163-4c12-9ff3-1990ec82a014",
    processor_id: "local-codex-runnervmlun5p",
    dispatch_confirmed: true,
    payload: { story_id: "0cba51db-8c38-436f-ae48-a4af46e9f6bd", claim_id: "9445bc04-b163-4c12-9ff3-1990ec82a014", image_url: "https://example.test/x.png", storage_key: "social-artwork/x.png", width: 1080, height: 1920, mime_type: "image/png", size_bytes: 500000, provider: "deterministic-renderer" },
    ...overrides,
  };
}

test("1. the exact proven production stuck state is eligible for automatic replay", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord(), completedDoRecord());
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
  assert.equal(result.claimId, "9445bc04-b163-4c12-9ff3-1990ec82a014");
});

test("2. the GitHub-side pre-filter alone also recognizes the exact proven stuck state as a plausible candidate", () => {
  assert.deepEqual(githubSideArtworkRecoveryIssues(stuckRecord()), []);
});

test("3. a record not at artwork_requested is never eligible", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ status: "artwork_ready" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.some((i) => i.startsWith("not_artwork_requested")));
});

test("4. an already-approved record is never eligible", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ approval: { status: "approved" } }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("already_approved"));
});

test("5. a posting record is never eligible", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ status: "posting" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_posting"));
});

test("6. a posted record is never eligible", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ status: "posted" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_posted"));
});

test("7. a record with no existing artwork claim at all is never eligible — recovery only ever replays a KNOWN claim, never invents one", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ claim: { claim_id: null } }), null);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("no_existing_artwork_claim"));
});

test("8. an active posting claim blocks eligibility", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ publishing: { status: "not_posted", claim: { claim_id: "stray-claim" } } }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("active_posting_claim"));
});

test("9. a merged story is never eligible", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ merged_into: "other-story" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("story_merged"));
});

test("10. a null/undefined record is rejected without throwing", () => {
  assert.equal(evaluateArtworkRecoveryEligibility(null, completedDoRecord()).eligible, false);
  assert.equal(evaluateArtworkRecoveryEligibility(undefined, null).eligible, false);
});

test("11. no DO record at all blocks eligibility", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord(), null);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_record_not_found"));
});

test("12. a DO record whose claim_id does NOT match the GitHub record's claim_id blocks eligibility", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord(), completedDoRecord({ claim_id: "some-other-claim-id" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_claim_id_mismatch"));
});

test("13. a DO status of 'claimed' (still in flight) blocks eligibility", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord(), completedDoRecord({ status: "claimed" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_status_not_completed:claimed"));
});

test("14. a DO status of 'failed' blocks eligibility", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord(), completedDoRecord({ status: "failed" }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_status_not_completed:failed"));
});

test("15. a completed DO record with no stored payload blocks eligibility", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord(), completedDoRecord({ payload: null }));
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("do_payload_missing"));
});

test("16. every applicable issue is reported at once, not just the first one found", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ approval: { status: "approved" }, merged_into: "x" }), null);
  assert.equal(result.eligible, false);
  assert.ok(result.issues.includes("already_approved"));
  assert.ok(result.issues.includes("story_merged"));
  assert.ok(result.issues.includes("do_record_not_found"));
});

test("17. eligibility never returns a claimId when ineligible", () => {
  const result = evaluateArtworkRecoveryEligibility(stuckRecord({ status: "posted" }), completedDoRecord());
  assert.equal(result.eligible, false);
  assert.equal(result.claimId, null);
});

test("18. works identically for a Feed-primary record (destination-agnostic — this module never inspects selection.destination at all)", () => {
  const result = evaluateArtworkRecoveryEligibility(
    stuckRecord({ story_id: "feed-story", claim: { claim_id: "feed-claim-1" } }),
    completedDoRecord({ claim_id: "feed-claim-1", payload: { story_id: "feed-story", claim_id: "feed-claim-1", width: 1024, height: 1280 } })
  );
  assert.equal(result.eligible, true, JSON.stringify(result.issues));
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
