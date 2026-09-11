#!/usr/bin/env node
// Stage 4C JPEG derivative test matrix. All fixtures are synthesized
// in-memory via sharp — the real, live Drake Maye R2 asset is NEVER read,
// fetched, or used as a mutation target here. Run with:
// node scripts/social-worker/lib/jpegDerivative.test.mjs
import assert from "node:assert/strict";
import sharp from "sharp";
import { deriveJpegStorageKey, inspectAlpha, convertToJpegDerivative, validateJpegDerivative, deriveCornerBackgroundFill } from "./jpegDerivative.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const WIDTH = 1024;
const HEIGHT = 1280;

function opaqueRgbaPng() {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } } }).png().toBuffer();
}
function opaqueRgbPng() {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
}
function transparentPng() {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 0.4 } } }).png().toBuffer();
}
function wrongDimensionsPng() {
  return sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } } }).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Alpha safety (Step 5)
// ---------------------------------------------------------------------------

test("A. an opaque RGBA PNG (alpha channel present, every pixel fully opaque) is classified fullyOpaque", async () => {
  const result = await inspectAlpha(await opaqueRgbaPng());
  assert.equal(result.hasAlphaChannel, true);
  assert.equal(result.fullyOpaque, true);
});

test("A2. a PNG with no alpha channel at all is trivially treated as fullyOpaque", async () => {
  const result = await inspectAlpha(await opaqueRgbPng());
  assert.equal(result.hasAlphaChannel, false);
  assert.equal(result.fullyOpaque, true);
});

test("B. a PNG with genuine partial transparency is classified NOT fullyOpaque", async () => {
  const result = await inspectAlpha(await transparentPng());
  assert.equal(result.hasAlphaChannel, true);
  assert.equal(result.fullyOpaque, false);
});

test("9. actual transparency without an approved background-fill policy fails closed — never silently flattens onto a guessed color", async () => {
  const result = await convertToJpegDerivative(await transparentPng());
  assert.equal(result.ok, false);
  assert.equal(result.error, "transparency_requires_fill_policy");
});

test("B2. actual transparency WITH an explicit approved fill policy proceeds successfully", async () => {
  const result = await convertToJpegDerivative(await transparentPng(), { backgroundFillPolicy: { r: 255, g: 255, b: 255 } });
  assert.equal(result.ok, true);
  assert.ok(result.buffer.length > 0);
});

// ---------------------------------------------------------------------------
// Conversion / dimensions / determinism (matrix items 1-8, 10-13)
// ---------------------------------------------------------------------------

test("1. an opaque RGBA PNG converts successfully with no fill policy required", async () => {
  const result = await convertToJpegDerivative(await opaqueRgbaPng());
  assert.equal(result.ok, true);
});

test("2. the produced JPEG stays exactly 1024x1280", async () => {
  const png = await opaqueRgbaPng();
  const { buffer } = await convertToJpegDerivative(png);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 1280);
});

test("3. the produced JPEG is exactly 4:5", async () => {
  const png = await opaqueRgbaPng();
  const { buffer } = await convertToJpegDerivative(png);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width / meta.height, 4 / 5);
});

test("4. the produced JPEG has valid magic bytes", async () => {
  const png = await opaqueRgbaPng();
  const { buffer } = await convertToJpegDerivative(png);
  assert.deepEqual(buffer.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
});

test("5. converting the same PNG twice with the same policy is byte-for-byte deterministic", async () => {
  const png = await opaqueRgbaPng();
  const a = await convertToJpegDerivative(png);
  const b = await convertToJpegDerivative(png);
  assert.ok(a.buffer.equals(b.buffer), "identical input must produce identical output bytes");
});

test("6. metadata (EXIF/ICC) is not unintentionally retained in the derivative", async () => {
  const pngWithMeta = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
    .withMetadata({ exif: { IFD0: { Copyright: "should not survive" } } })
    .png()
    .toBuffer();
  const { buffer } = await convertToJpegDerivative(pngWithMeta);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.exif, undefined, "no EXIF block should be present on the derivative");
});

test("7. no crop occurs — output pixel dimensions exactly match input", async () => {
  const png = await opaqueRgbaPng();
  const inputMeta = await sharp(png).metadata();
  const { buffer } = await convertToJpegDerivative(png);
  const outputMeta = await sharp(buffer).metadata();
  assert.equal(outputMeta.width, inputMeta.width);
  assert.equal(outputMeta.height, inputMeta.height);
});

test("8. no resize occurs — dimensions are preserved exactly, not merely proportionally", async () => {
  const png = await opaqueRgbaPng();
  const { buffer } = await convertToJpegDerivative(png);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, WIDTH);
  assert.equal(meta.height, HEIGHT);
});

test("10. a malformed/garbage PNG buffer is rejected, not silently produced as a broken JPEG", async () => {
  const garbage = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await assert.rejects(() => convertToJpegDerivative(garbage));
});

test("11. validateJpegDerivative rejects a derivative with incorrect dimensions", async () => {
  const wrongPng = await wrongDimensionsPng();
  const { buffer } = await convertToJpegDerivative(wrongPng);
  const result = await validateJpegDerivative(buffer, wrongPng);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.startsWith("unexpected_dimensions")));
});

test("11b. validateJpegDerivative passes a correctly-sized, correctly-converted derivative", async () => {
  const png = await opaqueRgbaPng();
  const { buffer } = await convertToJpegDerivative(png);
  const result = await validateJpegDerivative(buffer, png);
  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
});

test("12. deriveJpegStorageKey produces a stable, deterministic key for a given story_id", () => {
  assert.equal(deriveJpegStorageKey("3287b40b-d88e-44cb-a2d7-c11c97844664"), "social-artwork-jpeg/3287b40b-d88e-44cb-a2d7-c11c97844664.jpg");
  assert.equal(deriveJpegStorageKey("abc"), deriveJpegStorageKey("abc"));
});

test("13. one story's storage key can never collide with or path-traverse into another's", () => {
  assert.notEqual(deriveJpegStorageKey("story-a"), deriveJpegStorageKey("story-b"));
  assert.throws(() => deriveJpegStorageKey("../etc/passwd"));
  assert.throws(() => deriveJpegStorageKey("a/b"));
  assert.throws(() => deriveJpegStorageKey(""));
  assert.throws(() => deriveJpegStorageKey(undefined));
});

// ---------------------------------------------------------------------------
// Visual-equivalence corruption detection
// ---------------------------------------------------------------------------

test("14. validateJpegDerivative rejects a derivative that is visually nothing like its claimed source (gross corruption check)", async () => {
  const sourcePng = await opaqueRgbaPng(); // red-ish
  const unrelatedPng = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(); // solid black
  const { buffer: unrelatedJpeg } = await convertToJpegDerivative(unrelatedPng);
  const result = await validateJpegDerivative(unrelatedJpeg, sourcePng);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.startsWith("visual_equivalence_out_of_range")));
});

// ---------------------------------------------------------------------------
// deriveCornerBackgroundFill — deterministic, non-guessing background
// derivation for a PNG with genuine transparency but no known fixed
// template background color.
// ---------------------------------------------------------------------------

// Compositing a semi-transparent layer over an already-opaque base always
// yields an OPAQUE result (alpha blends toward 255) — sharp's ".composite()"
// itself performs the flatten. Genuine sub-255 alpha surviving in the final
// PNG must be written directly into the raw buffer instead.
const PATCH_ALPHA = 153; // ~60% opaque — clearly non-opaque, not a rounding-noise edge case
const PATCH_RGB = { r: 0, g: 0, b: 0 };

function buildPngWithAlpha({ width = WIDTH, height = HEIGHT, colorAt, patch } = {}) {
  const channels = 4;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const { r, g, b } = colorAt(x, y);
      raw[idx] = r; raw[idx + 1] = g; raw[idx + 2] = b; raw[idx + 3] = 255;
    }
  }
  if (patch) {
    for (let y = patch.y0; y < patch.y1; y++) {
      for (let x = patch.x0; x < patch.x1; x++) {
        const idx = (y * width + x) * channels;
        raw[idx] = patch.r; raw[idx + 1] = patch.g; raw[idx + 2] = patch.b; raw[idx + 3] = patch.alpha;
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

const CENTER_PATCH = { x0: Math.round(WIDTH / 2 - 30), y0: Math.round(HEIGHT / 2 - 30), x1: Math.round(WIDTH / 2 + 30), y1: Math.round(HEIGHT / 2 + 30), alpha: PATCH_ALPHA, ...PATCH_RGB };

/** A flat-background image with a small, genuinely semi-transparent patch near the CENTER (well away from all four corners). */
function flatBackgroundWithCenterTransparency(bg = { r: 10, g: 10, b: 10 }) {
  return buildPngWithAlpha({ colorAt: () => bg, patch: CENTER_PATCH });
}

/** A genuinely two-tone image (left half one flat color, right half another) — corners on the same side agree, but left vs right disagree, simulating a real gradient/lighting design like the actual Drake Maye artwork. */
function twoToneWithCenterTransparency() {
  return buildPngWithAlpha({ colorAt: (x) => (x < WIDTH / 2 ? { r: 1, g: 1, b: 1 } : { r: 90, g: 100, b: 150 }), patch: CENTER_PATCH });
}

test("15. deriveCornerBackgroundFill returns the agreed corner color for a flat-background image", async () => {
  const png = await flatBackgroundWithCenterTransparency({ r: 12, g: 34, b: 56 });
  const fill = await deriveCornerBackgroundFill(png);
  assert.ok(fill);
  assert.ok(Math.abs(fill.r - 12) <= 2 && Math.abs(fill.g - 34) <= 2 && Math.abs(fill.b - 56) <= 2);
});

test("16. deriveCornerBackgroundFill is deterministic — the exact same input always produces the exact same output", async () => {
  const png = await flatBackgroundWithCenterTransparency({ r: 200, g: 20, b: 20 });
  const first = await deriveCornerBackgroundFill(png);
  const second = await deriveCornerBackgroundFill(png);
  assert.deepEqual(first, second);
});

test("17. deriveCornerBackgroundFill returns null (never guesses) when the four corners genuinely disagree — a real gradient/two-tone design, matching the actual Drake Maye artwork's own left-black/right-blue corners", async () => {
  const png = await twoToneWithCenterTransparency();
  const fill = await deriveCornerBackgroundFill(png);
  assert.equal(fill, null);
});

test("deriveCornerBackgroundFill returns null when a sampled corner is itself non-opaque (e.g. real transparency reaching into the corner region)", async () => {
  // Compositing a semi-transparent layer over an opaque base always yields
  // an opaque RESULT (alpha blends toward 1.0) — real sub-255 alpha at a
  // specific pixel must be constructed directly in the raw buffer instead.
  const width = WIDTH, height = HEIGHT, channels = 4;
  const raw = Buffer.alloc(width * height * channels, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      raw[idx] = 5; raw[idx + 1] = 5; raw[idx + 2] = 5;
      raw[idx + 3] = 255;
    }
  }
  // Make the sampled top-left corner pixel (inset=8, i.e. (8,8)) non-opaque.
  const cornerIdx = (8 * width + 8) * channels;
  raw[cornerIdx + 3] = 180;
  const png = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  const fill = await deriveCornerBackgroundFill(png);
  assert.equal(fill, null);
});

// ---------------------------------------------------------------------------
// End-to-end: a source with minor real alpha AND an unambiguous background
// converts successfully once resolveApprovedFeedJpeg-style derivation
// supplies a fill — exercised here directly against convertToJpegDerivative
// to confirm the primitive itself behaves correctly once given the derived
// policy (the full wiring is tested in resolveApprovedFeedJpeg.test.mjs).
// ---------------------------------------------------------------------------

test("18. minor real alpha + an unambiguous derived background converts successfully, stays 1024x1280, and the flattened patch matches the mathematically-correct alpha blend against the TRUE background (no visible halo from a wrong fill)", async () => {
  const bg = { r: 12, g: 34, b: 56 };
  const png = await flatBackgroundWithCenterTransparency(bg);
  const fill = await deriveCornerBackgroundFill(png);
  assert.ok(fill);
  const result = await convertToJpegDerivative(png, { backgroundFillPolicy: fill });
  assert.equal(result.ok, true);
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, WIDTH);
  assert.equal(meta.height, HEIGHT);
  const validation = await validateJpegDerivative(result.buffer, png);
  assert.equal(validation.passed, true);

  // The correct flatten of a semi-transparent patch is a BLEND toward the
  // background, not the background itself: result = patch*a + bg*(1-a).
  const a = PATCH_ALPHA / 255;
  const expected = { r: PATCH_RGB.r * a + bg.r * (1 - a), g: PATCH_RGB.g * a + bg.g * (1 - a), b: PATCH_RGB.b * a + bg.b * (1 - a) };
  const patchPixel = await sharp(result.buffer)
    .extract({ left: Math.round(WIDTH / 2), top: Math.round(HEIGHT / 2), width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.ok(
    Math.abs(patchPixel[0] - expected.r) < 15 && Math.abs(patchPixel[1] - expected.g) < 15 && Math.abs(patchPixel[2] - expected.b) < 15,
    `flattened patch pixel [${patchPixel[0]},${patchPixel[1]},${patchPixel[2]}] must match the correct blend against the true background [${expected.r.toFixed(1)},${expected.g.toFixed(1)},${expected.b.toFixed(1)}], not a wrong-color halo`
  );
});

test("18b. flattening the SAME transparent patch against a WRONG background color produces a visibly different result — proving the derived fill actually matters, not merely 'any fill produces something similar'", async () => {
  const bg = { r: 12, g: 34, b: 56 };
  const wrongBg = { r: 255, g: 255, b: 255 };
  const png = await flatBackgroundWithCenterTransparency(bg);
  const correct = await convertToJpegDerivative(png, { backgroundFillPolicy: bg });
  const wrong = await convertToJpegDerivative(png, { backgroundFillPolicy: wrongBg });
  const pixelOf = async (buf) => sharp(buf).extract({ left: Math.round(WIDTH / 2), top: Math.round(HEIGHT / 2), width: 1, height: 1 }).raw().toBuffer();
  const correctPixel = await pixelOf(correct.buffer);
  const wrongPixel = await pixelOf(wrong.buffer);
  const diff = Math.abs(correctPixel[0] - wrongPixel[0]) + Math.abs(correctPixel[1] - wrongPixel[1]) + Math.abs(correctPixel[2] - wrongPixel[2]);
  assert.ok(diff > 60, "a materially wrong background must produce a visibly different flattened pixel, confirming fill choice is not cosmetic");
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
