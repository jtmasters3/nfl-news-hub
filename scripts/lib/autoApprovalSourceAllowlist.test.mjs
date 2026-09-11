#!/usr/bin/env node
// Tests for the explicit auto-approval source allowlist.
// Run with: node scripts/lib/autoApprovalSourceAllowlist.test.mjs
import assert from "node:assert/strict";
import { isAutoApprovalAllowedSource, AUTO_APPROVAL_ALLOWED_SOURCES } from "./autoApprovalSourceAllowlist.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("1. ESPN is allowed", () => {
  assert.equal(isAutoApprovalAllowedSource("ESPN"), true);
});

test("2. NFL.com is allowed", () => {
  assert.equal(isAutoApprovalAllowedSource("NFL.com"), true);
});

test("3. FOX Sports (exact production casing) is allowed", () => {
  assert.equal(isAutoApprovalAllowedSource("FOX Sports"), true);
});

test("4. Pro Football Talk is allowed", () => {
  assert.equal(isAutoApprovalAllowedSource("Pro Football Talk"), true);
});

test("5. the lowercase-x casing variant 'Fox Sports' is NOT allowed — exact match only, never fuzzy/case-insensitive", () => {
  assert.equal(isAutoApprovalAllowedSource("Fox Sports"), false);
});

test("6. the alias 'PFT' is NOT allowed — never verified in real production data, deliberately not guessed", () => {
  assert.equal(isAutoApprovalAllowedSource("PFT"), false);
});

test("7. the alias 'NBC Sports' is NOT allowed — same reasoning as PFT", () => {
  assert.equal(isAutoApprovalAllowedSource("NBC Sports"), false);
});

test("8. an entirely unrelated/unknown source is not allowed", () => {
  assert.equal(isAutoApprovalAllowedSource("Random Blogspot Site"), false);
});

test("9. null/undefined/empty source names are not allowed", () => {
  assert.equal(isAutoApprovalAllowedSource(null), false);
  assert.equal(isAutoApprovalAllowedSource(undefined), false);
  assert.equal(isAutoApprovalAllowedSource(""), false);
});

test("10. non-string input never throws and is not allowed", () => {
  assert.equal(isAutoApprovalAllowedSource(123), false);
  assert.equal(isAutoApprovalAllowedSource({}), false);
});

test("11. the allowlist contains exactly the four intended, audited identifiers — no silent extras", () => {
  assert.deepEqual([...AUTO_APPROVAL_ALLOWED_SOURCES].sort(), ["ESPN", "FOX Sports", "NFL.com", "Pro Football Talk"].sort());
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
