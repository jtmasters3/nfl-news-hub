#!/usr/bin/env node
// Stage 4C JPEG derivative test matrix. All fixtures are synthesized
// in-memory via sharp — the real, live Drake Maye R2 asset is NEVER read,
// fetched, or used as a mutation target here. Run with:
// node scripts/social-worker/lib/jpegDerivative.test.mjs
import assert from "node:assert/strict";
import sharp from "sharp";
import { deriveJpegStorageKey, inspectAlpha, convertToJpegDerivative, validateJpegDerivative } from "./jpegDerivative.js";

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
