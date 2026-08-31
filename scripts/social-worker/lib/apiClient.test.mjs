#!/usr/bin/env node
// Tests the pure cache-busting URL builder used by fetchSocialState's
// polling path (see waitForApprovalCommit.js for the incident this fixes:
// raw.githubusercontent.com's Fastly CDN cache, Cache-Control: max-age=300,
// keyed by full URL — cache: "no-store" alone never defeats it). No
// network, no real story. Run with:
// node scripts/social-worker/lib/apiClient.test.mjs
import assert from "node:assert/strict";
import { appendCacheBustParam } from "./apiClient.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("appends a cache-busting query parameter to a URL with no existing query string", () => {
  const result = appendCacheBustParam("https://raw.githubusercontent.com/owner/repo/main/data/social-state.json", "abc123");
  assert.equal(result, "https://raw.githubusercontent.com/owner/repo/main/data/social-state.json?approval_poll=abc123");
});

test("uses & (not ?) and preserves any existing query string", () => {
  const result = appendCacheBustParam("https://example.test/path?foo=bar", "xyz789");
  assert.equal(result, "https://example.test/path?foo=bar&approval_poll=xyz789");
});

test("preserves multiple existing query parameters exactly, appending only the new one at the end", () => {
  const result = appendCacheBustParam("https://example.test/path?a=1&b=2", "tok");
  assert.equal(result, "https://example.test/path?a=1&b=2&approval_poll=tok");
});

test("URL-encodes the cache-busting value so it can never break the query string or inject extra parameters", () => {
  const result = appendCacheBustParam("https://example.test/path", "value with spaces & special=chars");
  assert.equal(result, "https://example.test/path?approval_poll=value%20with%20spaces%20%26%20special%3Dchars");
  assert.equal(new URL(result).searchParams.get("approval_poll"), "value with spaces & special=chars", "must round-trip through a real URL parser correctly");
});

test("the resulting URL contains only the approval_poll parameter — no token, authorization, or secret-shaped parameter is ever added", () => {
  const result = appendCacheBustParam("https://raw.githubusercontent.com/owner/repo/main/data/social-state.json", "cache-bust-value");
  const parsed = new URL(result);
  assert.deepEqual([...parsed.searchParams.keys()], ["approval_poll"]);
  assert.equal(/token|secret|auth|bearer/i.test(result), false, "the built URL must never contain anything token/secret-shaped");
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
