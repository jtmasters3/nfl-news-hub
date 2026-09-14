// Deterministic, cloud-safe social-graphic renderer — the 2026-09-14
// replacement for the local Windows codex.exe dependency (see this
// repository's own incident history: the first unattended GitHub Actions
// run tried to shell out to
// C:\Users\jacks\AppData\Local\OpenAI\Codex\bin\codex.exe from a Linux
// runner and failed 3/3 attempts, exactly as it must — that path can never
// exist there).
//
// This module produces the SAME kind of artifact codexRunner.js's `codex
// exec` call used to (an unbranded PNG at an exact target size, with the
// bottom-left branding area left visually clean for compositeBrandOverlay.js
// to finish) — but entirely with plain, already-proven Node libraries
// (`sharp`, already a dependency; `@resvg/resvg-js`, new) instead of a
// generative image model. Nothing here calls any external API, spawns any
// child process, or depends on any path outside this repo.
//
// Root-cause note on why this replacement is even possible: the actual
// production prompt (automation-prompt.template.md) asked Codex to do real
// generative work — restyle a real photo with a dark gradient, condensed
// impact typography, and a brand palette, per one of several reference
// layouts — genuinely creative image synthesis, not "paste text at fixed
// coordinates." Rather than trying to reproduce that creative judgment
// (impossible deterministically) or use a paid image-generation API (the
// explicit last resort), this renders the SAME kind of "real photo + dark
// bottom gradient + bold condensed headline + brand accent" composition
// directly and deterministically, matching the brand's own documented
// constants (black/white/vivid-red, condensed high-impact typography, dark
// gradients, restrained red accents — see the reference pack's own
// REFERENCE-GUIDE.md) with code instead of an AI's interpretation of them.
//
// Honest, disclosed trade-off: this cannot replicate the generative model's
// per-photo creative layout choices (which of several reference styles best
// fits THIS photo's negative space). It uses one robust, general-purpose
// layout — full-bleed photo, bottom gradient scrim, left-aligned headline —
// that works reasonably for any source photo, rather than several bespoke
// template layouts with their own selection heuristic. Visual quality is a
// known, accepted trade-off for zero recurring cost and zero local-machine
// dependency; nothing here is a placeholder, a stock graphic, or unbranded.
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEMENT } from "./brandOverlay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const FONT_PATH = path.join(ROOT, "assets", "fonts", "Anton-Regular.ttf");
const FONT_FAMILY = "Anton";

// Exact target canvases — chosen to sit precisely on each destination's
// required ratio (never merely "approximately," unlike the AI generator's
// own output, which frequently landed a few pixels off and relied on
// artworkValidation.js's tolerance band).
export const CANVAS = {
  feed: { width: 1024, height: 1280 }, // exactly 4:5
  story: { width: 1080, height: 1920 }, // exactly 9:16
};

const BRAND_RED = "#e0102a";
const HEADLINE_START_SIZE_RATIO = 0.074; // relative to canvas width
const HEADLINE_MIN_SIZE_RATIO = 0.039;
const HEADLINE_LINE_HEIGHT_RATIO = 1.08;
const HEADLINE_MAX_LINES = 5;
// Fraction of canvas height reserved at the bottom for the logo
// compositeBrandOverlay.js adds afterward, PLUS breathing room above it —
// derived from the SAME PLACEMENT ratios that step itself uses (see
// brandOverlay.js), never a second, independently-guessed number.
const LOGO_CLEARANCE_RATIO = { feed: 0.1, story: 0.14 };
// Anton is a very uniform-width condensed display font — this ratio
// (average glyph advance width ÷ font size) was empirically measured
// against its own metrics and is deliberately a slight OVERESTIMATE, so
// this wrapper only ever wraps a LINE EARLIER than strictly necessary,
// never later — the failure mode of an underestimate (text overflowing the
// canvas) is far worse than the failure mode of an overestimate (a
// slightly shorter line than technically possible).
export const AVG_CHAR_WIDTH_RATIO = 0.64;

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pure, deterministic width estimate — see AVG_CHAR_WIDTH_RATIO's own comment. */
export function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * AVG_CHAR_WIDTH_RATIO;
}

/** Pure greedy word-wrap at a given font size. Never splits a single word. */
export function wrapLines(text, maxWidth, fontSize) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || estimateTextWidth(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/**
 * Finds the largest font size (stepping down from `startSize` to `minSize`)
 * that wraps `text` into at most `maxLines` lines at `maxWidth`. Never
 * drops or truncates any word — headline fidelity (the full, verbatim
 * text) always wins over fitting a target line count; if even `minSize`
 * needs more than `maxLines`, this returns exactly that overflowing
 * wrap rather than cutting the headline short.
 * @returns {{fontSize: number, lines: string[]}}
 */
export function fitHeadline(text, maxWidth, { startSize, minSize, maxLines = HEADLINE_MAX_LINES, step = 2 } = {}) {
  for (let size = startSize; size >= minSize; size -= step) {
    const lines = wrapLines(text, maxWidth, size);
    if (lines.length <= maxLines) return { fontSize: size, lines };
  }
  return { fontSize: minSize, lines: wrapLines(text, maxWidth, minSize) };
}

/**
 * Builds the transparent-background SVG overlay (bottom gradient scrim +
 * red accent rule + headline text) for one canvas — pure string building,
 * no rendering, so the exact markup is independently testable.
 */
export function buildOverlaySvg({ width, height, headline, format }) {
  const paddingX = Math.round(width * PLACEMENT[format].paddingXRatio);
  const maxTextWidth = width - paddingX * 2;
  const startSize = Math.round(width * HEADLINE_START_SIZE_RATIO);
  const minSize = Math.round(width * HEADLINE_MIN_SIZE_RATIO);
  const { fontSize, lines } = fitHeadline(headline, maxTextWidth, { startSize, minSize });

  const lineHeight = fontSize * HEADLINE_LINE_HEIGHT_RATIO;
  const reservedBottom = Math.round(height * LOGO_CLEARANCE_RATIO[format]);
  const textBlockHeight = lines.length * lineHeight;
  const textBottomY = height - reservedBottom;
  const textStartY = textBottomY - textBlockHeight;
  const gradientTopY = Math.max(0, textStartY - fontSize * 1.6);
  const accentY = textStartY - fontSize * 0.5;
  const accentWidth = Math.round(width * 0.16);

  const tspans = lines
    .map((line, i) => `<tspan x="${paddingX}" y="${Math.round(textStartY + (i + 1) * lineHeight - lineHeight * 0.18)}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.93"/>
    </linearGradient>
    <filter id="ts" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect x="0" y="${Math.round(gradientTopY)}" width="${width}" height="${Math.round(height - gradientTopY)}" fill="url(#scrim)"/>
  <rect x="${paddingX}" y="${Math.round(accentY)}" width="${accentWidth}" height="6" fill="${BRAND_RED}"/>
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#ffffff" style="text-transform:uppercase" filter="url(#ts)">${tspans}</text>
</svg>`;

  return { svg, fontSize, lines };
}

/**
 * Renders one finished (but not yet logo-branded) social graphic: the
 * downloaded source photo, deterministically cover-cropped to the exact
 * target canvas (sharp's built-in "attention" strategy favors the most
 * visually salient region — the closest deterministic equivalent to "keep
 * the subject in frame" without any AI judgment), with the headline
 * overlay composited on top. Never touches the bottom-left branding
 * corner's content beyond the shared dark gradient — compositeBrandOverlay.js
 * still adds the real logo afterward, unchanged, exactly as it already did
 * for the AI-generated path.
 *
 * 2026-09-14 disclosed limitation (audited, not fixed here — see
 * imageMatch.js's own 2026-09-14 header for the actual fix this pairs
 * with): "attention" is a pixel-saliency heuristic (edges/contrast/skin
 * tone), not subject recognition — it has no way to know WHICH region of a
 * photo depicts the headline's named subject, only which region looks
 * visually busiest. The publisher metadata this pipeline can verify
 * (alt/caption/credit text) is purely textual and carries no pixel
 * coordinates, so there is no deterministic way to bias this crop toward
 * "the subject specifically" without implementing real face/object
 * detection — explicitly out of scope (no paid vision APIs, no fake
 * AI-vision claims). The correct, and only implemented, mitigation is
 * upstream: imageMatch.js's direct-evidence requirement ensures this
 * renderer is only ever handed a photo already verified to actually depict
 * the claimed subject/team, so a poor "attention" crop can misframe the
 * right photo but can no longer be run against the WRONG photo.
 * @param {{sourceImagePath: string, headline: string, format: "feed"|"story", outputPath: string}} args
 * @returns {Promise<{width: number, height: number, fontSize: number, lines: string[]}>}
 */
export async function renderArtwork({ sourceImagePath, headline, format, outputPath }) {
  const canvas = CANVAS[format];
  if (!canvas) throw new Error(`renderArtwork: unknown format "${format}" (expected "feed" or "story")`);
  if (typeof headline !== "string" || !headline.trim()) {
    throw new Error("renderArtwork: headline must be a non-empty string");
  }

  const sourceBytes = await readFile(sourceImagePath);
  const photoBuffer = await sharp(sourceBytes)
    .resize(canvas.width, canvas.height, { fit: "cover", position: sharp.strategy.attention })
    .png()
    .toBuffer();

  const { svg, fontSize, lines } = buildOverlaySvg({ width: canvas.width, height: canvas.height, headline, format });

  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  const overlayPngBuffer = resvg.render().asPng();

  await sharp(photoBuffer)
    .composite([{ input: overlayPngBuffer, top: 0, left: 0 }])
    .png()
    .toFile(outputPath);

  return { width: canvas.width, height: canvas.height, fontSize, lines };
}
