#!/usr/bin/env node
// Stage 4C caption assembly test matrix. Uses only local fixture copies —
// never reads or mutates the real production Drake Maye record. Run with:
// node scripts/social-worker/lib/captionAssembly.test.mjs
import assert from "node:assert/strict";
import { assembleInstagramCaption } from "./captionAssembly.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function readyRecord(overrides = {}) {
  return {
    caption: {
      status: "ready",
      text: "A caption body.\n\nSource: ESPN",
      hashtags: ["#NFL", "#Patriots"],
      attribution_line: "Source: ESPN",
      ...overrides,
    },
  };
}

test("1. exact caption.text is retained verbatim in the assembled output", () => {
  const result = assembleInstagramCaption(readyRecord());
  assert.equal(result.ok, true);
  assert.ok(result.caption.startsWith("A caption body.\n\nSource: ESPN"));
});

test("2. attribution is not duplicated — caption.attribution_line is never separately appended", () => {
  const result = assembleInstagramCaption(readyRecord());
  const occurrences = result.caption.split("Source: ESPN").length - 1;
  assert.equal(occurrences, 1, "the Source line must appear exactly once, not twice");
});

test("3. hashtags are appended once, space-separated, after a blank line", () => {
  const result = assembleInstagramCaption(readyRecord());
  assert.equal(result.caption, "A caption body.\n\nSource: ESPN\n\n#NFL #Patriots");
});

test("4. hashtag order is preserved exactly as stored", () => {
  const result = assembleInstagramCaption(readyRecord({ hashtags: ["#Zebra", "#Alpha", "#Mid"] }));
  assert.ok(result.caption.endsWith("#Zebra #Alpha #Mid"));
});

test("5. no AI call or rewriting occurs — the function is a pure, synchronous string assembly", () => {
  const result = assembleInstagramCaption(readyRecord());
  assert.equal(typeof result.caption, "string");
  // Purity/determinism: calling twice with the same input yields the same output.
  const again = assembleInstagramCaption(readyRecord());
  assert.equal(result.caption, again.caption);
});

test("6. a missing caption (status not_created) is rejected", () => {
  const result = assembleInstagramCaption({ caption: { status: "not_created", text: null, hashtags: [] } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "caption_not_ready");
});

test("7. a non-ready caption (status generating or failed) is rejected", () => {
  assert.equal(assembleInstagramCaption({ caption: { status: "generating", text: "partial", hashtags: [] } }).ok, false);
  assert.equal(assembleInstagramCaption({ caption: { status: "failed", text: null, hashtags: [] } }).ok, false);
});

test("8. malformed hashtags (non-string or empty entries) are rejected", () => {
  assert.equal(assembleInstagramCaption(readyRecord({ hashtags: ["#NFL", 12345] })).error, "malformed_hashtags");
  assert.equal(assembleInstagramCaption(readyRecord({ hashtags: ["#NFL", "   "] })).error, "malformed_hashtags");
  assert.equal(assembleInstagramCaption(readyRecord({ hashtags: "not-an-array" })).error, "malformed_hashtags");
});

test("8b. an empty hashtags array is valid and simply omits the hashtag line", () => {
  const result = assembleInstagramCaption(readyRecord({ hashtags: [] }));
  assert.equal(result.ok, true);
  assert.equal(result.caption, "A caption body.\n\nSource: ESPN");
});

test("8c. a ready caption with empty/whitespace text is rejected", () => {
  assert.equal(assembleInstagramCaption(readyRecord({ text: "   " })).error, "caption_missing");
  assert.equal(assembleInstagramCaption(readyRecord({ text: null })).error, "caption_missing");
});

test("9. the returned string is an immutable snapshot value — mutating the source record afterward does not change it", () => {
  const record = readyRecord();
  const result = assembleInstagramCaption(record);
  record.caption.text = "MUTATED AFTER THE FACT";
  assert.notEqual(result.caption, "MUTATED AFTER THE FACT\n\n#NFL #Patriots");
  assert.ok(result.caption.startsWith("A caption body."));
});

test("10. a Drake Maye SAMPLE fixture (a local copy, not the live production record) produces the expected exact string", () => {
  // This is a hand-copied fixture matching the real approved record's shape
  // as of this stage — NOT a read of data/social-state.json.
  const drakeMayeFixture = readyRecord({
    text: "The Patriots took a 7-0 lead on a 2-yard touchdown pass from Drake Maye. The score marked the first touchdown of the 2026 season.\n\nSource: Pro Football Talk",
    hashtags: ["#NFL", "#Patriots"],
    attribution_line: "Source: Pro Football Talk",
  });
  const result = assembleInstagramCaption(drakeMayeFixture);
  assert.equal(
    result.caption,
    "The Patriots took a 7-0 lead on a 2-yard touchdown pass from Drake Maye. The score marked the first touchdown of the 2026 season.\n\nSource: Pro Football Talk\n\n#NFL #Patriots"
  );
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
