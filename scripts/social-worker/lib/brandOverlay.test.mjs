#!/usr/bin/env node
// Tests deterministic brand compositing (see brandOverlay.js) — the fix
// for the 2026-09-03 branding-defect incident where the image generator
// drew its own approximation of The Aggregate logo instead of the real
// asset. Uses synthetic sharp-generated canvases and a synthetic fixture
// logo for isolation (fast, no real files mutated), PLUS a handful of
// tests against the real committed canonical asset to prove the actual
// production path works, read-only. Run with:
// node scripts/social-worker/lib/brandOverlay.test.mjs
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { compositeBrandOverlay, CANONICAL_LOGO_PATH, CANONICAL_LOGO_SHA256 } from "./brandOverlay.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

let workDir;
async function setup() {
  workDir = await mkdtemp(path.join(tmpdir(), "brand-overlay-test-"));
}
async function teardown() {
  await rm(workDir, { recursive: true, force: true });
}

async function makeCanvas(name, width, height, background = { r: 15, g: 15, b: 18 }) {
  const filePath = path.join(workDir, name);
  await sharp({ create: { width, height, channels: 3, background } }).png().toFile(filePath);
  return filePath;
}

/** A small synthetic wide "logo" (not the real asset) — genuinely transparent, real aspect ratio to test against. */
async function makeFixtureLogo(name = "fixture-logo.png", width = 500, height = 100) {
  const filePath = path.join(workDir, name);
  const svg = `<svg width="${width}" height="${height}"><rect x="10" y="10" width="${width - 20}" height="${height - 20}" fill="red"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  const buf = await readFile(filePath);
  const hash = createHash("sha256").update(buf).digest("hex");
  return { path: filePath, hash, width, height };
}

// ---------------------------------------------------------------------------
// 1/2. Feed and Story both use deterministic compositing (fixture logo).
// ---------------------------------------------------------------------------
test("1. Feed: compositing succeeds, returns expected shape, output differs from a bare canvas", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "feed-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: logo.path, expectedLogoSha256: logo.hash });
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1280);
    assert.ok(result.logoWidth > 0 && result.logoHeight > 0);
    const outStat = await readFile(out);
    const baseStat = await readFile(base);
    assert.notEqual(outStat.length, baseStat.length, "the branded output must actually differ from the unbranded base");
  } finally {
    await teardown();
  }
});

test("2. Story: compositing succeeds on a 9:16-ish canvas with independent placement", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("story-base.png", 941, 1672);
    const out = path.join(workDir, "story-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "story", logoPath: logo.path, expectedLogoSha256: logo.hash });
    assert.equal(result.width, 941);
    assert.equal(result.height, 1672);
    assert.ok(result.logoWidth > 0 && result.logoHeight > 0);
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// 3. Exact canonical logo asset — the real production defaults.
// ---------------------------------------------------------------------------
test("3. Default args use the REAL canonical logo asset (path + hash) and succeed against it, read-only", async () => {
  await setup();
  try {
    const base = await makeCanvas("feed-base-real-logo.png", 1024, 1280);
    const out = path.join(workDir, "feed-real-logo-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed" }); // no logoPath/expectedLogoSha256 override
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1280);
  } finally {
    await teardown();
  }
});

test("CANONICAL_LOGO_SHA256 constant matches the user-verified hash exactly", () => {
  assert.equal(CANONICAL_LOGO_SHA256, "d73259067ad43caf33c4eff5950c7e3d5d8a3fb54154c3020684d435bcbdc455");
});

test("CANONICAL_LOGO_PATH points at the existing repo-committed asset, not a temporary/Downloads/Desktop path", () => {
  assert.ok(CANONICAL_LOGO_PATH.includes(path.join("assets", "aggregate-logo-dark.png")));
  assert.ok(!/downloads|desktop\\(?!.*nfl-news-hub)/i.test(CANONICAL_LOGO_PATH) || CANONICAL_LOGO_PATH.includes("nfl-news-hub"));
});

// ---------------------------------------------------------------------------
// 4/5. Missing/corrupt logo asset fails safely — no fallback, no partial output.
// ---------------------------------------------------------------------------
test("4. Missing logo asset fails safely: throws, and no output file is created", async () => {
  await setup();
  try {
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "should-not-exist.png");
    await assert.rejects(() => compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: path.join(workDir, "nope.png") }), /unreadable/i);
    await assert.rejects(() => readFile(out), /ENOENT/);
  } finally {
    await teardown();
  }
});

test("5. Corrupt/wrong logo asset (hash mismatch) fails safely: throws, never composites a different image than expected", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "should-not-exist-2.png");
    await assert.rejects(
      () => compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: logo.path, expectedLogoSha256: "0000000000000000000000000000000000000000000000000000000000000" }),
      /hash mismatch/i
    );
    await assert.rejects(() => readFile(out), /ENOENT/);
  } finally {
    await teardown();
  }
});

test("5b. Genuinely corrupt (non-image) logo bytes fail safely, distinct from a hash mismatch", async () => {
  await setup();
  try {
    const { writeFile } = await import("node:fs/promises");
    const corruptPath = path.join(workDir, "corrupt.png");
    const garbage = Buffer.from("this is not a png file at all");
    await writeFile(corruptPath, garbage);
    const corruptHash = createHash("sha256").update(garbage).digest("hex");
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "should-not-exist-3.png");
    // Hash matches (so it passes the hash gate) but sharp cannot decode it — must still fail.
    await assert.rejects(() => compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: corruptPath, expectedLogoSha256: corruptHash }));
    await assert.rejects(() => readFile(out), /ENOENT/);
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// 6/7. Dimensions unchanged after compositing.
// ---------------------------------------------------------------------------
test("6. Feed dimensions remain unchanged after compositing (1024x1280 in, 1024x1280 out)", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "feed-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: logo.path, expectedLogoSha256: logo.hash });
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1280);
  } finally {
    await teardown();
  }
});

test("7. Story dimensions remain unchanged after compositing, including a nearby-not-exact 9:16 resolution", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("story-base.png", 1080, 1908);
    const out = path.join(workDir, "story-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "story", logoPath: logo.path, expectedLogoSha256: logo.hash });
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1908);
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// 8. Logo aspect ratio preserved — never stretched or distorted.
// ---------------------------------------------------------------------------
test("8. Logo aspect ratio is preserved after resizing (never stretched/distorted)", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo("wide-logo.png", 500, 100); // 5:1
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "feed-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: logo.path, expectedLogoSha256: logo.hash });
    const originalRatio = logo.width / logo.height;
    const resultRatio = result.logoWidth / result.logoHeight;
    assert.ok(Math.abs(originalRatio - resultRatio) < 0.05, `expected ratio ~${originalRatio}, got ${resultRatio}`);
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// 9/10. Logo placement stays within canvas bounds for both formats.
// ---------------------------------------------------------------------------
test("9. Feed logo placement stays fully within canvas bounds", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "feed-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "feed", logoPath: logo.path, expectedLogoSha256: logo.hash });
    assert.ok(result.logoLeft >= 0);
    assert.ok(result.logoTop >= 0);
    assert.ok(result.logoLeft + result.logoWidth <= result.width);
    assert.ok(result.logoTop + result.logoHeight <= result.height);
  } finally {
    await teardown();
  }
});

test("10. Story logo placement stays fully within canvas bounds, with a larger bottom safe-zone than Feed", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const canvasHeight = 1672;
    const base = await makeCanvas("story-base.png", 941, canvasHeight);
    const out = path.join(workDir, "story-branded.png");
    const result = await compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "story", logoPath: logo.path, expectedLogoSha256: logo.hash });
    assert.ok(result.logoLeft >= 0);
    assert.ok(result.logoTop >= 0);
    assert.ok(result.logoLeft + result.logoWidth <= result.width);
    assert.ok(result.logoTop + result.logoHeight <= result.height);
    const bottomMargin = canvasHeight - (result.logoTop + result.logoHeight);
    assert.ok(bottomMargin / canvasHeight > 0.05, "Story must keep a comfortably larger bottom safe-zone than a flat minimum");
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
test("outputPath must differ from baseImagePath — sharp cannot read/write the same file", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("same.png", 1024, 1280);
    await assert.rejects(() => compositeBrandOverlay({ baseImagePath: base, outputPath: base, format: "feed", logoPath: logo.path, expectedLogoSha256: logo.hash }), /must differ/);
  } finally {
    await teardown();
  }
});

test("an unknown format is rejected", async () => {
  await setup();
  try {
    const logo = await makeFixtureLogo();
    const base = await makeCanvas("feed-base.png", 1024, 1280);
    const out = path.join(workDir, "out.png");
    await assert.rejects(() => compositeBrandOverlay({ baseImagePath: base, outputPath: out, format: "square", logoPath: logo.path, expectedLogoSha256: logo.hash }), /unknown format/);
  } finally {
    await teardown();
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
