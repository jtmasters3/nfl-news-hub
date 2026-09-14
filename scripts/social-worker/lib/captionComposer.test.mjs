#!/usr/bin/env node
// Tests for the deterministic caption composer — the 2026-09-14
// cloud-safe replacement for the local codex.exe caption-writing call.
// Pure function, no I/O — every test constructs its own fixture and runs
// the SAME shared validateCaption()/evaluateContentFidelity() the
// production pipeline uses, proving the composed caption is safe by
// construction, not merely by inspection.
// Run with: node scripts/social-worker/lib/captionComposer.test.mjs
import assert from "node:assert/strict";
import { buildDeterministicCaption } from "./captionComposer.js";
import { validateCaption } from "../../lib/captionValidation.js";
import { evaluateContentFidelity } from "./contentFidelityGate.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function fixture(overrides = {}) {
  return {
    post_headline: "JORDAN LOVE OUT WITH SHOULDER INJURY",
    description: "Jordan Love was hurt during practice with the Green Bay Packers.",
    source_name: "ESPN",
    category: "injury",
    teams: ["Green Bay Packers"],
    players: ["Jordan Love"],
    is_rumor: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Structural correctness (captionValidation.js)
// ---------------------------------------------------------------------------

test("1. a normal fixture produces a caption that passes captionValidation.js", () => {
  const f = fixture();
  const { text } = buildDeterministicCaption(f);
  const result = validateCaption(text, f);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("2. the caption ends with the exact required 'Source: {source_name}' line", () => {
  const f = fixture({ source_name: "Pro Football Talk" });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.trim().endsWith("Source: Pro Football Talk"));
});

test("3. the headline appears verbatim in the caption text", () => {
  const f = fixture({ post_headline: "PANTHERS RESTRUCTURE DL TERSHAWN WHARTON'S CONTRACT" });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.includes("PANTHERS RESTRUCTURE DL TERSHAWN WHARTON'S CONTRACT"));
});

test("4. hashtags are returned separately, never concatenated into the caption text — matching the real production shape", () => {
  const f = fixture();
  const { text, hashtags } = buildDeterministicCaption(f);
  assert.ok(Array.isArray(hashtags));
  assert.ok(hashtags.includes("#NFL"));
  for (const tag of hashtags) {
    assert.ok(!text.includes(tag), `hashtag ${tag} must not appear inside the caption text field`);
  }
});

test("5. the caption never contains a URL, a markdown construct, or an @handle", () => {
  const f = fixture({ source_name: "NBC Sports (nbcsports.com)" });
  const { text } = buildDeterministicCaption(f);
  assert.ok(!/https?:\/\/|www\./i.test(text));
  assert.ok(!/@\w+/.test(text));
  assert.ok(!/```|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text));
});

test("6. a headline missing terminal punctuation gets exactly one period appended", () => {
  const f = fixture({ post_headline: "NO PUNCTUATION HERE" });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.startsWith("NO PUNCTUATION HERE."));
  assert.ok(!text.startsWith("NO PUNCTUATION HERE.."));
});

test("7. a headline that already ends with punctuation is not given a second one", () => {
  const f = fixture({ post_headline: "IS THIS A QUESTION?" });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.startsWith("IS THIS A QUESTION?"));
  assert.ok(!text.startsWith("IS THIS A QUESTION?."));
});

// ---------------------------------------------------------------------------
// Fidelity — never introduces a fact/number/quote/name beyond the fixture
// ---------------------------------------------------------------------------

test("8. the composed caption always passes contentFidelityGate.js — every word traces back to the canonical fixture by construction", () => {
  const f = fixture();
  const { text } = buildDeterministicCaption(f);
  const record = { source_story: f, caption: { text } };
  const result = evaluateContentFidelity(record);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("9. a fixture with numbers in the description never triggers unsupported_number (every number came from the fixture itself)", () => {
  const f = fixture({ description: "The Panthers created $4.2 million in cap room ahead of Week 1." });
  const { text } = buildDeterministicCaption(f);
  const result = validateCaption(text, f);
  assert.ok(!result.issues.some((i) => i.startsWith("unsupported_number")), JSON.stringify(result.issues));
});

test("10. a fixture with a quoted phrase in the description never triggers unsupported_quote", () => {
  const f = fixture({ description: 'Coach Matt LaFleur said "we like where Jordan is at" during Wednesday\'s presser.' });
  const { text } = buildDeterministicCaption(f);
  const result = validateCaption(text, f);
  assert.ok(!result.issues.some((i) => i.startsWith("unsupported_quote")), JSON.stringify(result.issues));
});

test("11. no candidate proper-noun phrase in the caption is ever missing from the fixture's own vocabulary — a real production regression anchor (A.J. Brown case)", () => {
  const f = {
    post_headline: "MIKE VRABEL HAD NO POSTGAME UPDATE ON A.J. BROWN",
    description: "It's still unclear what kind of injury and recovery Patriots receiver A.J.",
    source_name: "Pro Football Talk",
    category: "injury",
    teams: ["New England Patriots"],
    players: [],
    is_rumor: false,
  };
  const { text } = buildDeterministicCaption(f);
  const record = { source_story: f, caption: { text } };
  const result = evaluateContentFidelity(record);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// Description handling
// ---------------------------------------------------------------------------

test("12. a genuinely new description is appended after the headline", () => {
  const f = fixture({ description: "The Green Bay Packers expect a multi-week absence." });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.includes("The Green Bay Packers expect a multi-week absence."));
});

test("13. a description that just restates the headline is NOT redundantly appended", () => {
  const f = fixture({ post_headline: "JORDAN LOVE OUT WITH SHOULDER INJURY", description: "jordan love out with shoulder injury" });
  const { text } = buildDeterministicCaption(f);
  const occurrences = (text.match(/shoulder injury/gi) || []).length;
  assert.equal(occurrences, 1, "a purely redundant description must not be duplicated into the caption");
});

test("14. a missing/empty description never crashes and produces a valid, headline-only caption", () => {
  const f = fixture({ description: null });
  const { text } = buildDeterministicCaption(f);
  const result = validateCaption(text, f);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("15. an unusually long description that would push the caption over MAX_LENGTH is dropped rather than truncated mid-sentence", () => {
  const f = fixture({ description: "X".repeat(1000) });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.length < 900, "the caption must stay under captionValidation.js's own hard cap");
  assert.ok(!text.includes("X".repeat(1000)), "an oversized description must be omitted, never silently truncated into the caption");
  const result = validateCaption(text, f);
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

// ---------------------------------------------------------------------------
// is_rumor framing
// ---------------------------------------------------------------------------

test("16. is_rumor:true prefixes the caption with a qualifying 'Report:' — never states the story as confirmed fact", () => {
  const f = fixture({ is_rumor: true });
  const { text } = buildDeterministicCaption(f);
  assert.ok(text.startsWith("Report: "));
});

test("17. is_rumor:false never adds the qualifying prefix", () => {
  const f = fixture({ is_rumor: false });
  const { text } = buildDeterministicCaption(f);
  assert.ok(!text.startsWith("Report: "));
});

// ---------------------------------------------------------------------------
// Hashtags — delegates to the existing, already-proven buildHashtags()
// ---------------------------------------------------------------------------

test("18. hashtags always include #NFL and a matching team hashtag, capped at 3, matching captionFormatting.js's own contract", () => {
  const f = fixture({ teams: ["Green Bay Packers", "Chicago Bears", "Detroit Lions", "Minnesota Vikings"] });
  const { hashtags } = buildDeterministicCaption(f);
  assert.ok(hashtags.includes("#NFL"));
  assert.ok(hashtags.length <= 3);
});

// ---------------------------------------------------------------------------
// No local/AI-process dependency
// ---------------------------------------------------------------------------

test("19. captionComposer.js never spawns a child process and never calls any AI/network API", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./captionComposer.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/child_process|spawn\(|execFile|exec\(/.test(codeOnly));
  assert.ok(!/fetch\(|anthropic|openai/i.test(codeOnly));
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
