#!/usr/bin/env node
// Tests the UI-side readiness check used by approval-console.js to decide
// whether a card gets live Approve/Reject controls or a disabled
// "Not actionable" card. Mirrors cloudflare-worker's approvalDecide.js's
// storyReadyForApproval() — this test suite does NOT touch the Worker or
// any network; it only proves the console's own gate matches the
// production readiness contract. Run with:
// node scripts/social-worker/lib/approvalReadiness.test.mjs
import assert from "node:assert/strict";
import { assessApprovalReadiness } from "./approvalReadiness.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function fullyReadyRecord(overrides = {}) {
  return {
    merged_into: null,
    artwork: { status: "created" },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "ready", text: "A caption. Source: ESPN" },
    ...overrides,
  };
}

test("a fully-ready record (artwork created, validation passed, caption ready with text) is actionable", () => {
  const result = assessApprovalReadiness(fullyReadyRecord());
  assert.equal(result.ready, true);
  assert.deepEqual(result.issues, []);
});

test("legacy record: caption never created (pre-Caption-phase awaiting_approval) is NOT actionable — matches the real Josh Allen / Puka Nacua record shape", () => {
  const result = assessApprovalReadiness(
    fullyReadyRecord({
      caption: { status: "not_created", text: null },
    })
  );
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((i) => i.includes("caption not ready")));
  assert.ok(result.issues.some((i) => i.includes("caption text missing")));
});

test("legacy record: validation.passed is null (not exactly true) is NOT actionable — matches the real Josh Allen record shape", () => {
  const result = assessApprovalReadiness(
    fullyReadyRecord({
      validation: { status: "not_run", passed: null, issues: [] },
      caption: { status: "not_created", text: null },
    })
  );
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((i) => i.includes("artwork validation not passed")));
});

test("record with validation passed but caption still not created is NOT actionable — matches the real Puka Nacua record shape", () => {
  const result = assessApprovalReadiness(
    fullyReadyRecord({
      validation: { status: "passed", passed: true, issues: [] },
      caption: { status: "not_created", text: null },
    })
  );
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, ["caption not ready", "caption text missing"]);
});

test("caption.status is 'ready' but text is an empty/whitespace string is still NOT actionable", () => {
  const result = assessApprovalReadiness(fullyReadyRecord({ caption: { status: "ready", text: "   " } }));
  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("caption text missing"));
});

test("artwork.status other than 'created' is NOT actionable", () => {
  const result = assessApprovalReadiness(fullyReadyRecord({ artwork: { status: "not_created" } }));
  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("artwork not created"));
});

test("a merged (non-canonical) record is NOT actionable", () => {
  const result = assessApprovalReadiness(fullyReadyRecord({ merged_into: "some-other-story-id" }));
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((i) => i.includes("merged")));
});

test("the real Jets story (34195a7b) is actionable", () => {
  const result = assessApprovalReadiness({
    merged_into: null,
    artwork: { status: "created" },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "ready", text: "The Jets plan to stick with Cade Klubnik as their backup quarterback.\n\nSource: Pro Football Talk" },
  });
  assert.equal(result.ready, true);
});

// ---------------------------------------------------------------------------
// Feed+Story phase: content_package_version 2 readiness.
// ---------------------------------------------------------------------------

function fullyReadyV2Record(overrides = {}) {
  return fullyReadyRecord({
    content_package_version: 2,
    story_artwork: { status: "created", validation: { status: "passed", passed: true, issues: [] } },
    ...overrides,
  });
}

test("a v2 record with valid Feed + valid Story + ready caption is actionable", () => {
  const result = assessApprovalReadiness(fullyReadyV2Record());
  assert.equal(result.ready, true);
  assert.deepEqual(result.issues, []);
});

test("Caption-ready + only Feed artwork (no Story) is NOT approval-ready for a v2 record", () => {
  const result = assessApprovalReadiness(fullyReadyV2Record({ story_artwork: { status: "not_created", validation: { status: "not_run", passed: null, issues: [] } } }));
  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("Story artwork not created"));
  assert.ok(result.issues.includes("Story artwork validation not passed"));
});

test("a v2 record whose Story artwork was created but failed validation is NOT actionable", () => {
  const result = assessApprovalReadiness(fullyReadyV2Record({ story_artwork: { status: "failed", validation: { status: "failed", passed: false, issues: ["aspect_ratio_out_of_range:1.250"] } } }));
  assert.equal(result.ready, false);
  assert.ok(result.issues.includes("Story artwork validation not passed"));
});

test("a v1-explicit record (content_package_version: 1) is unaffected by the Story requirement even with no story_artwork object", () => {
  const record = fullyReadyRecord({ content_package_version: 1 });
  const result = assessApprovalReadiness(record);
  assert.equal(result.ready, true, "explicit v1 must behave exactly like a legacy record with no field at all");
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
