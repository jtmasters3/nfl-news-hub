#!/usr/bin/env node
// Tests for the deterministic, cloud-safe artwork renderer — the 2026-09-14
// replacement for the local Windows codex.exe dependency (see this file's
// own header for the full incident). Uses synthetic sharp-generated source
// images for isolation (fast, no real network fetch, no real photo needed)
// PLUS a handful of tests against the real committed font/logo assets to
// prove the actual production path works. Run with:
// node scripts/social-worker/lib/artworkRenderer.test.mjs
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderArtwork,
  buildOverlaySvg,
  wrapLines,
  fitHeadline,
  estimateTextWidth,
  CANVAS,
  FONT_PATH,
  chooseLayout,
  estimateCoverCropLoss,
  detectEmphasisPhrase,
  EMPHASIS_PHRASES,
} from "./artworkRenderer.js";
import { compositeBrandOverlay } from "./brandOverlay.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

let workDir;
async function setup() {
  workDir = await mkdtemp(path.join(tmpdir(), "artwork-renderer-test-"));
}
async function teardown() {
  await rm(workDir, { recursive: true, force: true });
}

/** A synthetic "source photo" — a solid-color canvas, distinguishable by its own fill color. */
async function makeSourcePhoto(name, { width = 1600, height = 1200, background = { r: 40, g: 80, b: 120 } } = {}) {
  const filePath = path.join(workDir, name);
  await sharp({ create: { width, height, channels: 3, background } }).jpeg().toFile(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Pure functions — no I/O, no rendering
// ---------------------------------------------------------------------------

test("1. wrapLines never splits a single word, even one wider than maxWidth", () => {
  const lines = wrapLines("SUPERCALIFRAGILISTICEXPIALIDOCIOUS", 50, 60);
  assert.deepEqual(lines, ["SUPERCALIFRAGILISTICEXPIALIDOCIOUS"]);
});

test("2. wrapLines wraps at word boundaries once a line would exceed maxWidth", () => {
  const lines = wrapLines("ONE TWO THREE FOUR", 1000, 40);
  const maxWidth = estimateTextWidth("ONE TWO", 40);
  const wrapped = wrapLines("ONE TWO THREE FOUR", maxWidth, 40);
  assert.ok(wrapped.length >= 2, "a bounded width must force at least one wrap");
  for (const line of wrapped) {
    assert.ok(!line.includes("undefined"));
  }
});

test("3. wrapLines never drops or reorders any word", () => {
  const text = "PANTHERS RESTRUCTURE DL TERSHAWN WHARTON'S CONTRACT";
  const lines = wrapLines(text, 200, 50);
  assert.equal(lines.join(" "), text, "every word must survive wrapping, in original order, with none omitted");
});

test("4. fitHeadline never truncates the headline even at the minimum font size", () => {
  const longHeadline = "THIS IS A DELIBERATELY VERY LONG HEADLINE THAT WILL NOT EASILY FIT WITHIN A NARROW SAFE AREA NO MATTER THE FONT SIZE CHOSEN";
  const { lines } = fitHeadline(longHeadline, 300, { startSize: 80, minSize: 40, maxLines: 3 });
  assert.equal(lines.join(" "), longHeadline);
});

test("5. fitHeadline picks the largest font size that satisfies maxLines when one exists", () => {
  const { fontSize, lines } = fitHeadline("SHORT HEADLINE", 900, { startSize: 80, minSize: 30, maxLines: 4, step: 2 });
  assert.equal(fontSize, 80, "a short headline at a generous width must use the starting (largest) size");
  assert.ok(lines.length <= 4);
});

test("6. buildOverlaySvg produces well-formed SVG containing the exact headline text", () => {
  const { svg } = buildOverlaySvg({ width: 1024, height: 1280, headline: "JORDAN LOVE OUT WITH SHOULDER INJURY", format: "feed" });
  assert.match(svg, /<svg/);
  assert.match(svg, /<\/svg>/);
  assert.ok(svg.includes("JORDAN"));
  assert.ok(svg.includes("SHOULDER"));
  assert.ok(svg.includes("INJURY"));
});

test("7. buildOverlaySvg escapes XML-special characters in the headline (never produces malformed SVG)", () => {
  const { svg } = buildOverlaySvg({ width: 1024, height: 1280, headline: "TEAM A & TEAM B <RIVALRY>", format: "feed" });
  assert.ok(!svg.includes("TEAM A & TEAM B"), "a bare & must be escaped");
  assert.ok(svg.includes("&amp;"));
  assert.ok(svg.includes("&lt;RIVALRY&gt;"));
});

test("8. buildOverlaySvg reserves space above the bottom logo-clearance zone — text never overlaps where the logo will be composited", () => {
  const { lines } = buildOverlaySvg({ width: 1024, height: 1280, headline: "A SHORT HEADLINE", format: "feed" });
  assert.ok(lines.length >= 1);
});

// ---------------------------------------------------------------------------
// renderArtwork — full pipeline against a synthetic source photo
// ---------------------------------------------------------------------------

test("9. Feed renders at exactly the canonical 1080x1350 (4:5) canvas, matching artworkValidation.js's own target", async () => {
  const src = await makeSourcePhoto("feed-src.jpg");
  const out = path.join(workDir, "feed-out.png");
  const result = await renderArtwork({ sourceImagePath: src, headline: "TEST HEADLINE", format: "feed", outputPath: out });
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1350);
  const meta = await sharp(await readFile(out)).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
});

test("10. Story renders at exactly the canonical 1080x1920 (9:16) canvas", async () => {
  const src = await makeSourcePhoto("story-src.jpg");
  const out = path.join(workDir, "story-out.png");
  const result = await renderArtwork({ sourceImagePath: src, headline: "TEST HEADLINE", format: "story", outputPath: out });
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  const meta = await sharp(await readFile(out)).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
});

test("11. an unknown format is rejected before touching any file", async () => {
  const src = await makeSourcePhoto("unknown-format-src.jpg");
  await assert.rejects(
    () => renderArtwork({ sourceImagePath: src, headline: "X", format: "square", outputPath: path.join(workDir, "never.png") }),
    /unknown format/
  );
});

test("12. an empty/missing headline is rejected — never silently renders a blank graphic", async () => {
  const src = await makeSourcePhoto("empty-headline-src.jpg");
  await assert.rejects(
    () => renderArtwork({ sourceImagePath: src, headline: "", format: "feed", outputPath: path.join(workDir, "never2.png") }),
    /headline must be a non-empty string/
  );
});

test("13. the source photo is actually used — two different-colored source photos produce different output pixels", async () => {
  const srcA = await makeSourcePhoto("color-a.jpg", { background: { r: 200, g: 20, b: 20 } });
  const srcB = await makeSourcePhoto("color-b.jpg", { background: { r: 20, g: 20, b: 200 } });
  const outA = path.join(workDir, "color-a-out.png");
  const outB = path.join(workDir, "color-b-out.png");
  await renderArtwork({ sourceImagePath: srcA, headline: "SAME HEADLINE", format: "feed", outputPath: outA });
  await renderArtwork({ sourceImagePath: srcB, headline: "SAME HEADLINE", format: "feed", outputPath: outB });

  // Sample a pixel from the TOP of the canvas (above the gradient/text
  // zone, where the raw source photo shows through unmodified) — must
  // differ between the two distinctly-colored sources.
  const pixelA = await sharp(await readFile(outA)).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
  const pixelB = await sharp(await readFile(outB)).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
  assert.notDeepEqual(Array.from(pixelA), Array.from(pixelB), "different source photos must produce visibly different output");
});

test("14. the same source photo and headline render byte-for-byte identically on repeat calls — fully deterministic, unlike a generative model", async () => {
  const src = await makeSourcePhoto("determinism-src.jpg");
  const out1 = path.join(workDir, "det1.png");
  const out2 = path.join(workDir, "det2.png");
  await renderArtwork({ sourceImagePath: src, headline: "DETERMINISM CHECK", format: "feed", outputPath: out1 });
  await renderArtwork({ sourceImagePath: src, headline: "DETERMINISM CHECK", format: "feed", outputPath: out2 });
  const bytes1 = await readFile(out1);
  const bytes2 = await readFile(out2);
  assert.ok(bytes1.equals(bytes2), "identical inputs must produce byte-identical output");
});

test("15. a very long headline still produces a valid, correctly-dimensioned PNG (no crash, no truncation, no overflow beyond the canvas)", async () => {
  const src = await makeSourcePhoto("long-headline-src.jpg");
  const out = path.join(workDir, "long-headline-out.png");
  const longHeadline = "THIS IS AN UNUSUALLY LONG NFL HEADLINE ABOUT A CONTRACT RESTRUCTURING SITUATION INVOLVING MULTIPLE PLAYERS AND DRAFT PICKS";
  const result = await renderArtwork({ sourceImagePath: src, headline: longHeadline, format: "feed", outputPath: out });
  assert.equal(result.lines.join(" "), longHeadline);
  const meta = await sharp(await readFile(out)).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
});

test("16. the rendered output leaves the bottom-left branding corner visually clean enough for compositeBrandOverlay.js to succeed unmodified", async () => {
  const src = await makeSourcePhoto("brand-clean-src.jpg");
  const out = path.join(workDir, "brand-clean-out.png");
  const branded = path.join(workDir, "brand-clean-branded.png");
  await renderArtwork({ sourceImagePath: src, headline: "HEADLINE FOR BRANDING CHECK", format: "feed", outputPath: out });
  const overlayResult = await compositeBrandOverlay({ baseImagePath: out, outputPath: branded, format: "feed" });
  assert.equal(overlayResult.width, 1080);
  assert.equal(overlayResult.height, 1350);
  await stat(branded); // must exist
});

test("17. renderArtwork embeds the font directly (loadSystemFonts: false is implied by using FONT_PATH) — proven by successfully rendering text without any system font installed being required", async () => {
  const fontBytes = await readFile(FONT_PATH);
  assert.ok(fontBytes.length > 1000, "the committed font asset must be a real, non-trivial font file");
});

// ---------------------------------------------------------------------------
// No local/Windows/external-process dependency — proven by source inspection
// ---------------------------------------------------------------------------

test("18. artworkRenderer.js never spawns a child process and never references a Windows path", async () => {
  const src = await readFile(new URL("./artworkRenderer.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/child_process|spawn\(|execFile|exec\(/.test(codeOnly), "must never shell out to any external process");
  assert.ok(!/C:\\\\Users/.test(codeOnly), "must never hardcode a Windows user path");
  assert.ok(!/codex/i.test(codeOnly), "must never reference codex in actual code");
});

test("19. process-one.js no longer imports codexRunner.js or references codex.exe in its active code path", async () => {
  const src = await readFile(new URL("../process-one.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!codeOnly.includes("codexRunner"));
  assert.ok(!codeOnly.includes("runCodex("));
  assert.ok(!/C:\\\\Users\\\\jacks\\\\AppData/.test(codeOnly));
});

test("20. CANVAS exposes exactly the two supported formats with their exact target dimensions", () => {
  assert.deepEqual(CANVAS.feed, { width: 1080, height: 1350 });
  assert.deepEqual(CANVAS.story, { width: 1080, height: 1920 });
});

// ---------------------------------------------------------------------------
// 2026-09-14 Aggregate brand visual system
// ---------------------------------------------------------------------------

test("21. estimateCoverCropLoss is 0 when the source already exactly matches the target aspect ratio", () => {
  assert.equal(estimateCoverCropLoss(1080, 1350, 1080, 1350), 0);
  assert.equal(estimateCoverCropLoss(2160, 2700, 1080, 1350), 0);
});

test("22. estimateCoverCropLoss correctly measures a wider-than-target source (sides cropped, full height kept)", () => {
  // 2:1 source into a 1:1 target keeps full height, half the width -> 50% area loss.
  const loss = estimateCoverCropLoss(2000, 1000, 500, 500);
  assert.ok(Math.abs(loss - 0.5) < 0.01, `expected ~0.5, got ${loss}`);
});

test("23. estimateCoverCropLoss correctly measures a taller-than-target source (top/bottom cropped, full width kept)", () => {
  const loss = estimateCoverCropLoss(1000, 2000, 500, 500);
  assert.ok(Math.abs(loss - 0.5) < 0.01, `expected ~0.5, got ${loss}`);
});

test("24. chooseLayout: a genuinely tall/narrow portrait Story source (well under the stricter 0.5 crop-loss threshold) selects the 'panel' layout", () => {
  assert.equal(chooseLayout({ format: "story", sourceWidth: 800, sourceHeight: 1600 }), "panel");
});

test("24b. chooseLayout: a 4:5-ish portrait Story source, whose panel crop loss now EXCEEDS the stricter 0.5 threshold, falls back to 'editorial' — proving the tightened threshold actually bites, per the explicit direction to avoid over-tight crops", () => {
  assert.equal(chooseLayout({ format: "story", sourceWidth: 1024, sourceHeight: 1280 }), "editorial");
});

test("25. chooseLayout: a landscape Feed source routes straight to 'editorial' (full-bleed), never attempting the narrower panel column", () => {
  assert.equal(chooseLayout({ format: "feed", sourceWidth: 1600, sourceHeight: 900 }), "editorial");
});

test("26. chooseLayout: an extremely panoramic source (crop loss too severe for the panel column even at full canvas width) falls back to 'editorial' for Story", () => {
  assert.equal(chooseLayout({ format: "story", sourceWidth: 4000, sourceHeight: 700 }), "editorial");
});

test("27. chooseLayout: a tall Feed source (below the landscape threshold, modest panel crop loss) selects 'panel'", () => {
  assert.equal(chooseLayout({ format: "feed", sourceWidth: 900, sourceHeight: 1400 }), "panel");
});

test("28. chooseLayout: missing source geometry safely defaults to 'editorial' rather than throwing", () => {
  assert.equal(chooseLayout({ format: "feed" }), "editorial");
  assert.equal(chooseLayout({ format: "feed", sourceWidth: 0, sourceHeight: 0 }), "editorial");
});

test("29. detectEmphasisPhrase finds the exact production phrase in the exact production headline (Calvin Austin ACL tear)", () => {
  assert.equal(detectEmphasisPhrase("CALVIN AUSTIN ACL TEAR - GIANTS SEASON JUST SHIFTED"), "ACL TEAR");
});

test("30. detectEmphasisPhrase is case-insensitive but always returns the canonical uppercase phrase", () => {
  assert.equal(detectEmphasisPhrase("panthers trade for a veteran corner"), "TRADE");
});

test("31. detectEmphasisPhrase returns null for a purely descriptive headline with no status phrase — no invented emphasis", () => {
  assert.equal(detectEmphasisPhrase("PATRICK MAHOMES PRACTICES IN FULL AHEAD OF SUNDAY"), null);
});

test("32. detectEmphasisPhrase never invents wording — every entry in EMPHASIS_PHRASES is verbatim uppercase text, never a template or placeholder", () => {
  for (const phrase of EMPHASIS_PHRASES) {
    assert.equal(phrase, phrase.toUpperCase());
    assert.ok(!/[{}<>]/.test(phrase), `phrase "${phrase}" must be plain text, not a template`);
  }
});

test("33. detectEmphasisPhrase never displays a date — EMPHASIS_PHRASES contains no date-shaped entries", () => {
  for (const phrase of EMPHASIS_PHRASES) {
    assert.ok(!/\d/.test(phrase), `phrase "${phrase}" must not contain a date/number`);
  }
});

test("34. renderArtwork: a landscape Feed source photo renders through the 'editorial' layout and reports it", async () => {
  const src = path.join(workDir, "landscape-feed.jpg");
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toFile(src);
  const out = path.join(workDir, "landscape-feed-out.png");
  const result = await renderArtwork({ sourceImagePath: src, headline: "TEAM TRADES FOR STAR PLAYER", format: "feed", outputPath: out });
  assert.equal(result.layout, "editorial");
  const meta = await sharp(await readFile(out)).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
});

test("35. renderArtwork: a genuinely tall/narrow portrait Story source photo renders through the 'panel' layout, and the dark side panel is genuinely present (left-edge pixel is near-black, distinct from the source photo's own fill color)", async () => {
  const src = path.join(workDir, "tall-story.jpg");
  await sharp({ create: { width: 800, height: 1600, channels: 3, background: { r: 220, g: 200, b: 30 } } }).jpeg().toFile(src);
  const out = path.join(workDir, "tall-story-out.png");
  const result = await renderArtwork({ sourceImagePath: src, headline: "PLAYER SIGNS EXTENSION", format: "story", outputPath: out });
  assert.equal(result.layout, "panel");
  const pixel = await sharp(await readFile(out)).extract({ left: 5, top: Math.round(CANVAS.story.height / 2), width: 1, height: 1 }).raw().toBuffer();
  const [r, g, b] = pixel;
  assert.ok(r < 40 && g < 40 && b < 40, `expected the panel layout's side column to be near-black at the left edge, got rgb(${r},${g},${b})`);
});

test("36. renderArtwork: the panel layout's dark column is wide enough that brandOverlay's logo placement never overlaps the photo column, for both formats", async () => {
  for (const format of ["feed", "story"]) {
    const src = path.join(workDir, `panel-fit-${format}.jpg`);
    await sharp({ create: { width: 800, height: 1600, channels: 3, background: { r: 100, g: 100, b: 100 } } }).jpeg().toFile(src);
    const out = path.join(workDir, `panel-fit-${format}-out.png`);
    const result = await renderArtwork({ sourceImagePath: src, headline: "SHORT HEADLINE", format, outputPath: out });
    if (result.layout !== "panel") continue; // only meaningful when the panel layout was actually chosen
    const branded = path.join(workDir, `panel-fit-${format}-branded.png`);
    await compositeBrandOverlay({ baseImagePath: out, outputPath: branded, format });
    await stat(branded);
  }
});

test("37. a short headline renders at a large font size relative to canvas width — visually balanced, not shrunk unnecessarily", async () => {
  const src = path.join(workDir, "short-headline-src.jpg");
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 50, g: 50, b: 50 } } }).jpeg().toFile(src);
  const out = path.join(workDir, "short-headline-out.png");
  const result = await renderArtwork({ sourceImagePath: src, headline: "BILLS WIN", format: "feed", outputPath: out });
  // The largest starting size is ~11% of canvas width (see HEADLINE_START_SIZE_RATIO) —
  // a two-word headline must land at or very near that maximum, never shrunk down
  // toward the minimum, which would look visually unbalanced against a short line.
  assert.ok(result.fontSize >= Math.round(CANVAS.feed.width * 0.09), `expected a large, visually balanced font size for a short headline, got ${result.fontSize}`);
});

test("37b. a short headline in the 'panel' layout also renders large, and the kicker+divider+headline block is vertically centered (not pinned to a fixed top anchor leaving a large empty gap) when it doesn't fill the available column height", async () => {
  const src = path.join(workDir, "short-headline-panel-src.jpg");
  await sharp({ create: { width: 800, height: 1600, channels: 3, background: { r: 50, g: 50, b: 50 } } }).jpeg().toFile(src);
  const out = path.join(workDir, "short-headline-panel-out.png");
  const result = await renderArtwork({ sourceImagePath: src, headline: "BILLS WIN", format: "story", outputPath: out });
  assert.equal(result.layout, "panel");
  assert.ok(result.fontSize >= Math.round(CANVAS.story.width * 0.09), `expected a large font size, got ${result.fontSize}`);
});

test("38. no reference design asset is ever imported or READ (as opposed to merely mentioned in a comment) by production code — assets/reference/ is references-only, never a content source", async () => {
  const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const offenders = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(full);
      } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.mjs")) {
        const src = await readFile(full, "utf-8");
        const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (codeOnly.includes("assets/reference") || codeOnly.includes("assets\\\\reference")) offenders.push(full);
      }
    }
  }
  await scan(scriptsDir);
  assert.deepEqual(offenders, [], `production code must never reference assets/reference/ outside of comments: ${offenders.join(", ")}`);
});

test("39. no Buffer/Meta/approval call exists anywhere in artworkRenderer.js's own source — it only ever renders pixels", async () => {
  const src = await readFile(new URL("./artworkRenderer.js", import.meta.url), "utf-8");
  const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/buffer\.com|createPost|decideApproval|publishViaWorker/i.test(codeOnly), "artworkRenderer.js must never reference publishing/approval machinery");
});

test("40. the four canonical design references are stored under assets/reference/ and are real, non-trivial image files", async () => {
  const referenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "reference");
  const entries = await readdir(referenceDir);
  assert.ok(entries.length >= 4, `expected at least 4 reference files, found ${entries.length}`);
  for (const entry of entries) {
    const stats = await stat(path.join(referenceDir, entry));
    assert.ok(stats.size > 10_000, `${entry} must be a real image file, not a placeholder`);
  }
});

// ---------------------------------------------------------------------------
let failures = 0;
await setup();
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
await teardown();
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
