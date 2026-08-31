#!/usr/bin/env node
// Tests the conservative hashtag strategy — no real story, no network.
// Run with: node scripts/social-worker/lib/captionFormatting.test.mjs
import assert from "node:assert/strict";
import { buildHashtags, MAX_HASHTAGS } from "./captionFormatting.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("No teams: just #NFL alone", () => {
  assert.deepEqual(buildHashtags([]), ["#NFL"]);
  assert.deepEqual(buildHashtags(undefined), ["#NFL"]);
});

test("One known team: #NFL plus its nickname hashtag", () => {
  assert.deepEqual(buildHashtags(["Carolina Panthers"]), ["#NFL", "#Panthers"]);
});

test("Two known teams (e.g. a trade): both nickname hashtags included, capped at 3 total", () => {
  const tags = buildHashtags(["Carolina Panthers", "Buffalo Bills"]);
  assert.equal(tags.length, 3);
  assert.deepEqual(tags, ["#NFL", "#Panthers", "#Bills"]);
});

test("Three or more teams: capped at MAX_HASHTAGS, never a giant block", () => {
  const tags = buildHashtags(["Carolina Panthers", "Buffalo Bills", "Kansas City Chiefs", "Dallas Cowboys"]);
  assert.equal(MAX_HASHTAGS, 3);
  assert.equal(tags.length, 3);
});

test("An unrecognized team name is silently skipped, never fabricates a hashtag", () => {
  assert.deepEqual(buildHashtags(["Some Made Up Team"]), ["#NFL"]);
});

test("Duplicate team names never produce a duplicate hashtag", () => {
  assert.deepEqual(buildHashtags(["Carolina Panthers", "Carolina Panthers"]), ["#NFL", "#Panthers"]);
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
