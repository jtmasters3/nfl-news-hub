#!/usr/bin/env node
// Regression suite proving the Feed and Story prompt templates no longer
// ask image generation to render/recreate The Aggregate logo (the
// 2026-09-03 branding-defect fix) — branding is now composited
// deterministically by scripts/social-worker/lib/brandOverlay.js instead.
// Run with: node scripts/tests/prompt-templates-regression.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FEED_TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "automation-prompt.template.md");
const STORY_TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "story-prompt.template.md");

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("12. Feed template no longer instructs Codex to read/use the official logo file", async () => {
  const text = await readFile(FEED_TEMPLATE_PATH, "utf-8");
  assert.ok(!/read and use.*official-logo\.png/i.test(text), "must not instruct reading the logo file for AI rendering");
  assert.ok(!text.includes("the-aggregate-official-logo.png"), "the logo filename must not appear at all — nothing should reference it for generation purposes");
});

test("12. Feed template explicitly forbids rendering/recreating the logo and tells Codex to leave the area clean", async () => {
  const text = await readFile(FEED_TEMPLATE_PATH, "utf-8");
  assert.ok(/do not render[\s\S]*?logo/i.test(text));
  assert.ok(/leave\s+the\s+bottom-left\s+branding\s+area\s+visually\s+clean/i.test(text));
  assert.ok(/composited.*afterward/i.test(text) || /deterministic/i.test(text));
});

test("12. Story template no longer instructs Codex to read/use the official logo file", async () => {
  const text = await readFile(STORY_TEMPLATE_PATH, "utf-8");
  assert.ok(!/read and use.*official-logo\.png/i.test(text));
  assert.ok(!text.includes("the-aggregate-official-logo.png"));
});

test("12. Story template explicitly forbids rendering/recreating the logo and tells Codex to leave the area clean", async () => {
  const text = await readFile(STORY_TEMPLATE_PATH, "utf-8");
  assert.ok(/do not render[\s\S]*?logo/i.test(text));
  assert.ok(/leave\s+the\s+bottom-left\s+branding\s+area\s+visually\s+clean/i.test(text));
});

test("neither template's final verification step still requires the AI's own output to visibly contain the logo", async () => {
  for (const templatePath of [FEED_TEMPLATE_PATH, STORY_TEMPLATE_PATH]) {
    const text = await readFile(templatePath, "utf-8");
    assert.ok(!/visibly uses the aggregate branding and official logo/i.test(text), `${templatePath} must not still ask the AI to self-verify it drew the logo`);
    assert.ok(/leaves\s+the\s+bottom-left\s+branding\s+area\s+clean/i.test(text), `${templatePath} must instead ask the AI to verify the area was left clean`);
  }
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
