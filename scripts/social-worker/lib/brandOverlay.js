// Deterministic post-generation brand compositing — the fix for the
// 2026-09-03 branding-defect incident: Codex (a generative image model)
// cannot guarantee pixel fidelity to a reference logo no matter how the
// prompt is worded, because its output is a single flattened, freshly
// generated image, not a compositing operation. The prompt templates now
// tell it to leave the branding area clean; the ACTUAL official logo is
// pasted on afterward, here, by code — the only way to guarantee the
// exact correct asset appears, byte-sourced from a hash-verified file,
// never an AI approximation.
//
// Canonical asset: the SAME file already committed for the site's own
// dark-background header slot — confirmed byte-identical (SHA-256) to the
// file the user independently verified as the official logo, so it is
// referenced directly rather than duplicated to a second path (avoiding
// any future drift between two copies of "the same" asset).
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const CANONICAL_LOGO_PATH = path.join(ROOT, "assets", "aggregate-logo-dark.png");
export const CANONICAL_LOGO_SHA256 = "d73259067ad43caf33c4eff5950c7e3d5d8a3fb54154c3020684d435bcbdc455";

// Ratio-based, not fixed pixel values, since Feed is a fixed 1024x1280 but
// Story's exact dimensions vary within its ratio tolerance (e.g. 941x1672)
// — a canvas-relative rule scales correctly regardless of the generator's
// exact output size. Story gets a larger bottom safe-zone specifically
// because a phone Story viewer's own UI (reply bar, progress indicator)
// sits closer to the bottom edge than a Feed post ever does.
const PLACEMENT = {
  feed: { widthRatio: 0.28, paddingXRatio: 0.06, paddingBottomRatio: 0.05 },
  story: { widthRatio: 0.3, paddingXRatio: 0.06, paddingBottomRatio: 0.1 },
};

async function sha256File(filePath) {
  const buf = await readFile(filePath);
  return { buf, hash: createHash("sha256").update(buf).digest("hex") };
}

/**
 * Composites the canonical official logo onto a finished base image
 * (bottom-left, ratio-scaled, aspect-preserved) and writes the result to
 * `outputPath` — a DIFFERENT path from `baseImagePath` (sharp does not
 * support reading and writing the same file in one pipeline). Throws —
 * never silently falls back to an unbranded or partially-branded image —
 * on: a missing/unreadable logo file, a logo whose SHA-256 doesn't match
 * `expectedLogoSha256` (default: the real canonical hash — a corrupted or
 * swapped file is rejected exactly like a missing one), an unreadable/
 * corrupt base image, or any compositing failure. The caller (process-one.js)
 * treats this identically to a generation failure — the SAME artwork
 * claim is failed, nothing is uploaded.
 *
 * @param {object} args
 * @param {string} args.baseImagePath - the raw, AI-generated PNG with a clean branding area
 * @param {string} args.outputPath - where the branded result is written (must differ from baseImagePath)
 * @param {"feed"|"story"} args.format
 * @param {string} [args.logoPath] - overridable for tests only; production callers use the default
 * @param {string} [args.expectedLogoSha256] - overridable for tests only
 * @returns {Promise<{width: number, height: number, logoWidth: number, logoHeight: number, logoLeft: number, logoTop: number}>}
 */
export async function compositeBrandOverlay({ baseImagePath, outputPath, format, logoPath = CANONICAL_LOGO_PATH, expectedLogoSha256 = CANONICAL_LOGO_SHA256 }) {
  if (baseImagePath === outputPath) {
    throw new Error("compositeBrandOverlay: outputPath must differ from baseImagePath (sharp cannot read and write the same file in one pipeline)");
  }
  const placement = PLACEMENT[format];
  if (!placement) throw new Error(`compositeBrandOverlay: unknown format "${format}" (expected "feed" or "story")`);

  // Hash-verify BEFORE ever touching the base image — a corrupted or
  // accidentally-swapped logo file must never silently degrade to "some
  // other image got composited," it must fail loudly and immediately.
  let logo;
  try {
    logo = await sha256File(logoPath);
  } catch (err) {
    throw new Error(`compositeBrandOverlay: canonical logo asset unreadable at ${logoPath}: ${err.message}`);
  }
  if (logo.hash !== expectedLogoSha256) {
    throw new Error(`compositeBrandOverlay: canonical logo asset hash mismatch at ${logoPath} — expected ${expectedLogoSha256}, got ${logo.hash}. Refusing to composite a wrong/corrupted logo.`);
  }

  const baseImage = sharp(await readFile(baseImagePath));
  const baseMeta = await baseImage.metadata();
  if (!baseMeta.width || !baseMeta.height) {
    throw new Error(`compositeBrandOverlay: could not read base image dimensions at ${baseImagePath}`);
  }

  const logoMeta = await sharp(logo.buf).metadata();
  if (!logoMeta.width || !logoMeta.height) {
    throw new Error(`compositeBrandOverlay: could not read logo dimensions at ${logoPath}`);
  }

  // Resize by width ONLY — sharp preserves the source aspect ratio
  // automatically when height is omitted, which is what guarantees the
  // logo is never stretched or distorted, by construction, not just by
  // our own arithmetic.
  const targetLogoWidth = Math.round(baseMeta.width * placement.widthRatio);
  const resizedLogo = sharp(logo.buf).resize({ width: targetLogoWidth });
  const resizedLogoBuffer = await resizedLogo.png().toBuffer();
  const resizedMeta = await sharp(resizedLogoBuffer).metadata();
  const logoWidth = resizedMeta.width;
  const logoHeight = resizedMeta.height;

  const paddingX = Math.round(baseMeta.width * placement.paddingXRatio);
  const paddingBottom = Math.round(baseMeta.height * placement.paddingBottomRatio);
  const logoLeft = paddingX;
  const logoTop = baseMeta.height - paddingBottom - logoHeight;

  if (logoLeft < 0 || logoTop < 0 || logoLeft + logoWidth > baseMeta.width || logoTop + logoHeight > baseMeta.height) {
    throw new Error(
      `compositeBrandOverlay: computed logo placement (${logoLeft},${logoTop} ${logoWidth}x${logoHeight}) falls outside the ${baseMeta.width}x${baseMeta.height} canvas — refusing to composite out of bounds`
    );
  }

  await baseImage
    .composite([{ input: resizedLogoBuffer, left: logoLeft, top: logoTop }])
    .png()
    .toFile(outputPath);

  const finalMeta = await sharp(await readFile(outputPath)).metadata();
  if (finalMeta.width !== baseMeta.width || finalMeta.height !== baseMeta.height) {
    throw new Error(`compositeBrandOverlay: output dimensions ${finalMeta.width}x${finalMeta.height} do not match input ${baseMeta.width}x${baseMeta.height} — canvas must never be resized by this step`);
  }

  return { width: finalMeta.width, height: finalMeta.height, logoWidth, logoHeight, logoLeft, logoTop };
}
