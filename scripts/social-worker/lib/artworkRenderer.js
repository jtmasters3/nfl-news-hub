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
//
// 2026-09-14 brand-system update: Feed changed from 1024x1280 to the
// production-specified 1080x1350 (same exact 4:5 ratio — this is a pixel
// upgrade, not a ratio change). resolveApprovedFeedJpeg.js now passes this
// SAME CANVAS.feed value into validateJpegDerivative()'s expected
// dimensions explicitly, rather than relying on that function's own
// (unchanged, independently-tested) 1024x1280 default — a single source
// of truth for what "the" Feed canvas size is, never two numbers that
// could silently drift apart.
export const CANVAS = {
  feed: { width: 1080, height: 1350 }, // exactly 4:5
  story: { width: 1080, height: 1920 }, // exactly 9:16
};

const BRAND_RED = "#e0102a";
// 2026-09-14 brand-system revision: raised substantially (0.074->0.11)
// after direct pixel measurement against the four canonical design
// references (assets/reference/) — their own headlines run roughly
// 0.09-0.11 of canvas width, and the prior ratio read as noticeably
// smaller/weaker than every reference. See fitHeadline(): this is only
// the STARTING attempt: a genuinely long headline still shrinks toward
// HEADLINE_MIN_SIZE_RATIO before ever truncating a word.
const HEADLINE_START_SIZE_RATIO = 0.11; // relative to canvas width
const HEADLINE_MIN_SIZE_RATIO = 0.055;
const HEADLINE_LINE_HEIGHT_RATIO = 1.0; // tightened from 1.08 — the references set lines almost touching cap-to-baseline
const HEADLINE_MAX_LINES = { editorial: 4, panel: 6 }; // panel's narrower column is expected to wrap into more, still-large lines, matching the vertical references' own 5-6 line headlines
// Fraction of canvas height reserved at the bottom for the logo
// compositeBrandOverlay.js adds afterward, PLUS breathing room above it —
// derived from the SAME PLACEMENT ratios that step itself uses (see
// brandOverlay.js), never a second, independently-guessed number. Tightened
// alongside PLACEMENT's own 2026-09-14 revision (bigger logo, smaller padding).
const LOGO_CLEARANCE_RATIO = { feed: 0.1, story: 0.12 };
// Anton is a very uniform-width condensed display font — this ratio
// (average glyph advance width ÷ font size) was empirically measured
// against its own metrics and is deliberately a slight OVERESTIMATE, so
// this wrapper only ever wraps a LINE EARLIER than strictly necessary,
// never later — the failure mode of an underestimate (text overflowing the
// canvas) is far worse than the failure mode of an overestimate (a
// slightly shorter line than technically possible).
export const AVG_CHAR_WIDTH_RATIO = 0.64;

// ==========================================================================
// 2026-09-14 Aggregate brand visual system (revised same day after visual
// review: the first pass's 3-layout system was rejected as too weak — too
// much empty space, headlines too small, accents that looked pasted on
// rather than designed. This revision replaces it with exactly TWO layout
// families, each rebuilt from concrete pixel measurements taken directly
// against the four canonical design references in assets/reference/
// (REFERENCE ONLY — never a content source; nothing in this pipeline ever
// reads a source photo from that directory, enforced by this file's own
// test suite).
// ==========================================================================
//
// Measurements taken (approximate, read off the actual reference pixels):
//   - Headline font size ~9-11% of canvas width, tight line spacing
//     (~1.0x font size cap-to-cap), full use of the available column width.
//   - Logo lockup ~32-38% of canvas width — a real branding element, not a
//     small footer mark (see brandOverlay.js's own 2026-09-14 PLACEMENT
//     revision, raised from 0.28/0.30 to 0.34 for both formats).
//   - Diagonal accents are THIN edge/corner marks (a few percent of canvas
//     width), never thick blocks laid over the subject's face or torso.
//   - The "editorial" family (Texans Trade / Calvin Austin square) is
//     full-bleed photography with a strong, fast-transitioning dark
//     gradient — by roughly 60% down the gradient span it is already
//     near-opaque black, not a slow 55%-opacity fade.
//   - The "panel" family (Calvin Austin vertical references) devotes
//     ~55-60% of canvas width to the photo and ~40-45% to a dark editorial
//     column that the headline fills aggressively — kicker sits close
//     above the headline, not floating with a large gap.
//
// Both families reuse the SAME "attention"-strategy cover-crop proven safe
// by imageMatch.js's direct-evidence gate (see this file's own
// pre-existing header above) — only "panel" departs from full-bleed,
// cropping the photo into a narrower side column instead of the full
// canvas, which is why it alone needs the crop-loss safety check below.
//
// A curated, non-exhaustive list of editorially meaningful status
// phrases — used for BOTH the kicker label (both layouts) and inline
// headline emphasis. Deliberately just a phrase-presence check against the
// ALREADY-WRITTEN headline text: never invents wording, never asserts
// urgency the headline doesn't already state, and (unlike the reference
// images' own "BREAKING: <date>" treatment) never displays a date, since
// this pipeline has no reliable, editorially-approved date to show.
// Ordered most-specific-first so a longer, more precise phrase is
// preferred over a shorter one it contains (e.g. "OUT FOR SEASON" is
// checked before a hypothetical bare "OUT").
export const EMPHASIS_PHRASES = Object.freeze([
  "OUT FOR SEASON",
  "ACL TEAR",
  "TORN ACL",
  "RULED OUT",
  "PLACED ON INJURED RESERVE",
  "INJURED RESERVE",
  "TRADED",
  "TRADE",
  "SIGNED",
  "RE-SIGNED",
  "RELEASED",
  "WAIVED",
  "CUT",
  "ACTIVATED",
  "SUSPENDED",
  "FIRED",
  "HIRED",
  "RETIRES",
  "RETIREMENT",
  "ARRESTED",
  "INVESTIGATION",
]);

/**
 * Finds the first (most specific) EMPHASIS_PHRASES entry that appears
 * verbatim in `headline` — case-insensitive, but the returned string is
 * always the CANONICAL uppercase phrase text, never a caller-supplied
 * substring, so callers never need to re-derive casing. Returns null when
 * no phrase matches (the common case for a purely descriptive headline)
 * — callers must treat null as "no kicker/no emphasis," never fall back
 * to inventing one.
 * @param {string} headline
 * @returns {string|null}
 */
export function detectEmphasisPhrase(headline) {
  const upper = String(headline || "").toUpperCase();
  for (const phrase of EMPHASIS_PHRASES) {
    if (upper.includes(phrase)) return phrase;
  }
  return null;
}

// Fraction of the ORIGINAL source photo's area that a "cover" fit into a
// given target box would crop away. Pure geometry — no pixel inspection,
// no subject-location claim of any kind, just "how much of this photo
// survives this particular crop rectangle."
export function estimateCoverCropLoss(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  let visibleWidth;
  let visibleHeight;
  if (sourceAspect > targetAspect) {
    // Source is relatively WIDER than the target box: full height is kept, sides are cropped.
    visibleHeight = sourceHeight;
    visibleWidth = sourceHeight * targetAspect;
  } else {
    // Source is relatively TALLER than the target box: full width is kept, top/bottom are cropped.
    visibleWidth = sourceWidth;
    visibleHeight = sourceWidth / targetAspect;
  }
  const sourceArea = sourceWidth * sourceHeight;
  const visibleArea = visibleWidth * visibleHeight;
  return 1 - visibleArea / sourceArea;
}

// Fraction of canvas width the "panel" layout's photo column occupies —
// sized within the user-specified 55-65% range, with deliberate margin so
// the dark panel it leaves (1 - this ratio) is always wide enough to hold
// brandOverlay.js's own (now larger, 0.34-width) logo placement without
// the two ever overlapping: both formats' logos need
// >=0.39 of canvas width (0.05 padding + 0.34 logo width); the panel
// reserved here is 0.42 for both, a real but modest margin.
const PANEL_PHOTO_WIDTH_RATIO = { feed: 0.58, story: 0.58 };
// Beyond this fraction of the original photo discarded, a crop is
// considered too destructive to trust — chooseLayout() below falls back to
// the full-bleed "editorial" layout instead (which crops far less). Never a
// hard failure, since a safe fallback layout always exists for every real
// photo geometry. This is deliberately NOT a subject-detection claim: it
// is a plain, honest measurement of surviving photo area, used only to
// prefer the layout that keeps more of the actual photo on screen — and
// deliberately stricter than the first pass's 0.6 (lowered to 0.5) per the
// explicit direction to avoid enormous, over-tight subject crops: when in
// doubt, prefer full-bleed editorial over a narrow, aggressively-cropped panel.
const LAYOUT_CROP_LOSS_FAIL_THRESHOLD = 0.5;
// Feed source photos are, in practice, very often landscape-oriented press
// photography (see imageMeta.js) — a photo this much wider than the 4:5
// Feed canvas already loses a large fraction of itself to a full-bleed
// cover-crop, so cramming it into the panel layout's even-narrower column
// would only make that worse. Routing straight to the full-bleed
// "editorial" treatment for these photos is both simpler and safer than
// computing (and likely rejecting) the panel crop-loss check anyway.
const FEED_LANDSCAPE_ASPECT_THRESHOLD = 1.15;

/**
 * Chooses one of the two canonical Aggregate layouts for a render,
 * deterministically, from ONLY the destination and the source photo's own
 * geometry — never from image content, never randomly, never via any AI
 * call. See this file's own 2026-09-14 header for what each layout looks
 * like.
 * @param {{format: "feed"|"story", sourceWidth?: number, sourceHeight?: number}} args
 * @returns {"editorial"|"panel"}
 */
export function chooseLayout({ format, sourceWidth, sourceHeight }) {
  if (!sourceWidth || !sourceHeight) return "editorial"; // no geometry available — the safest, plainest default
  const canvas = CANVAS[format];
  if (!canvas) return "editorial";

  if (format === "feed") {
    const sourceAspect = sourceWidth / sourceHeight;
    if (sourceAspect >= FEED_LANDSCAPE_ASPECT_THRESHOLD) return "editorial";
  }

  const photoWidthRatio = PANEL_PHOTO_WIDTH_RATIO[format];
  const panelPhotoWidth = Math.round(canvas.width * photoWidthRatio);
  const loss = estimateCoverCropLoss(sourceWidth, sourceHeight, panelPhotoWidth, canvas.height);
  return loss <= LAYOUT_CROP_LOSS_FAIL_THRESHOLD ? "panel" : "editorial";
}

/** One THIN slanted accent stripe — a restrained edge/corner mark, never a thick block laid over the subject. */
function diagonalAccentStripe({ x, y, width, height, skew, fill, opacity = 1 }) {
  const points = [
    [x + skew, y],
    [x + skew + width, y],
    [x + width, y + height],
    [x, y + height],
  ]
    .map((p) => p.join(","))
    .join(" ");
  return `<polygon points="${points}" fill="${fill}" opacity="${opacity}"/>`;
}

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
export function fitHeadline(text, maxWidth, { startSize, minSize, maxLines = 5, step = 2 } = {}) {
  for (let size = startSize; size >= minSize; size -= step) {
    const lines = wrapLines(text, maxWidth, size);
    if (lines.length <= maxLines) return { fontSize: size, lines };
  }
  return { fontSize: minSize, lines: wrapLines(text, maxWidth, minSize) };
}

/** Splits one already-wrapped line into {text, emphasis} runs around a single (case-insensitive) phrase match, if it fully appears within this one line. */
function splitLineForEmphasis(line, phrase) {
  if (!phrase) return [{ text: line, emphasis: false }];
  const idx = line.toUpperCase().indexOf(phrase);
  if (idx === -1) return [{ text: line, emphasis: false }];
  const parts = [];
  const before = line.slice(0, idx);
  const match = line.slice(idx, idx + phrase.length);
  const after = line.slice(idx + phrase.length);
  if (before) parts.push({ text: before, emphasis: false });
  parts.push({ text: match, emphasis: true });
  if (after) parts.push({ text: after, emphasis: false });
  return parts;
}

/** Renders one wrapped headline line as a positioned <tspan>, with an optional emphasized (red) run inside it. */
function headlineLineTspan({ line, x, y, emphasisPhrase }) {
  const runs = splitLineForEmphasis(line, emphasisPhrase)
    .map((part) => `<tspan fill="${part.emphasis ? BRAND_RED : "#ffffff"}">${escapeXml(part.text)}</tspan>`)
    .join("");
  return `<tspan x="${x}" y="${Math.round(y)}">${runs}</tspan>`;
}

const SHADOW_FILTER_DEFS = `<filter id="ts" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000000" flood-opacity="0.7"/>
    </filter>`;

/** "editorial" layout's gradient — fast-transitioning, near-opaque well before the bottom, matching the Texans Trade / breaking-square references' punchy dark lower section (not a slow 55%-opacity fade). */
function editorialScrimDefs() {
  return `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="28%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#000000" stop-opacity="0.92"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.97"/>
    </linearGradient>${SHADOW_FILTER_DEFS}`;
}

/** "panel" layout's dark column — a subtle top-to-bottom gradient (never flat #000, which reads as a cheap cutout) plus a soft feather where the photo meets the panel, so the two never look like two rectangles glued together. */
function panelScrimDefs() {
  return `<linearGradient id="panelFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d0d0d"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="panelFeather" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </linearGradient>${SHADOW_FILTER_DEFS}`;
}

function headlineBlockGeometry({ headline, maxTextWidth, maxLines, startSizeRatio, canvasWidth }) {
  const startSize = Math.round(canvasWidth * startSizeRatio);
  const minSize = Math.round(canvasWidth * HEADLINE_MIN_SIZE_RATIO);
  const { fontSize, lines } = fitHeadline(headline, maxTextWidth, { startSize, minSize, maxLines });
  const lineHeight = fontSize * HEADLINE_LINE_HEIGHT_RATIO;
  return { fontSize, lines, lineHeight, blockHeight: lines.length * lineHeight };
}

/**
 * "editorial" layout — full-bleed photo, a fast, strong dark gradient, a
 * red kicker banner (the detected status phrase, or a neutral "NFL NEWS"
 * fallback — never inline emphasis here, the banner already carries that
 * hierarchy), then a LARGE headline anchored to the bottom-left. Matches
 * the Texans Trade / Calvin Austin square Breaking News references.
 */
function buildEditorialLayout({ width, height, headline, format }) {
  const paddingX = Math.round(width * PLACEMENT[format].paddingXRatio);
  const maxTextWidth = width - paddingX * 2;
  const kickerText = detectEmphasisPhrase(headline) ?? "NFL NEWS";
  const kickerFontSize = Math.round(width * 0.034);
  const kickerHeight = Math.round(kickerFontSize * 1.9);
  const kickerWidth = Math.round(kickerText.length * kickerFontSize * AVG_CHAR_WIDTH_RATIO * 0.95 + kickerFontSize * 1.8);

  const { fontSize, lines, lineHeight, blockHeight } = headlineBlockGeometry({
    headline,
    maxTextWidth,
    maxLines: HEADLINE_MAX_LINES.editorial,
    startSizeRatio: HEADLINE_START_SIZE_RATIO,
    canvasWidth: width,
  });

  const reservedBottom = Math.round(height * LOGO_CLEARANCE_RATIO[format]);
  const textBottomY = height - reservedBottom;
  const textStartY = textBottomY - blockHeight;
  // Tight gap between banner and headline — no floating kicker.
  const kickerY = textStartY - kickerHeight - fontSize * 0.22;
  const gradientTopY = Math.max(0, kickerY - fontSize * 1.1);

  const tspans = lines.map((line, i) => headlineLineTspan({ line, x: paddingX, y: textStartY + (i + 1) * lineHeight - lineHeight * 0.12, emphasisPhrase: null })).join("");

  // One thin corner accent, top-right — restrained brand texture, never
  // over the subject (attention-cropping keeps the subject roughly
  // centered/upper in a full-bleed photo, and this stays clear of that zone).
  const accent = diagonalAccentStripe({ x: width * 0.9, y: 0, width: width * 0.018, height: height * 0.1, skew: width * 0.02, fill: BRAND_RED });

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>${editorialScrimDefs()}</defs>
  <rect x="0" y="${Math.round(gradientTopY)}" width="${width}" height="${Math.round(height - gradientTopY)}" fill="url(#scrim)"/>
  ${accent}
  <rect x="${paddingX}" y="${Math.round(kickerY)}" width="${kickerWidth}" height="${kickerHeight}" fill="${BRAND_RED}"/>
  <text x="${Math.round(paddingX + kickerWidth / 2)}" y="${Math.round(kickerY + kickerHeight * 0.68)}" font-family="${FONT_FAMILY}" font-size="${kickerFontSize}" fill="#ffffff" text-anchor="middle" style="text-transform:uppercase">${escapeXml(kickerText)}</text>
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#ffffff" style="text-transform:uppercase" filter="url(#ts)">${tspans}</text>
</svg>`;

  return { svg, fontSize, lines };
}

/**
 * "panel" layout — a dark editorial column (subtle gradient, never flat
 * black) with a kicker set tight above a LARGE headline that fills the
 * column aggressively, a red divider rule, and a thin corner accent; the
 * photo fills only the remaining column (cropped separately in
 * renderArtwork, not here — this only draws the panel's own chrome plus a
 * feathered seam so the two halves read as one designed composition
 * rather than two rectangles glued together). The whole kicker+divider+
 * headline block is VERTICALLY CENTERED within the available space
 * (between a small top margin and the logo clearance) rather than pinned
 * to a fixed top anchor — this is what prevents a short headline from
 * leaving a large, unintentional-looking empty gap in the middle of the
 * panel. Matches the Calvin Austin vertical references.
 */
function buildPanelLayout({ width, height, headline, format, panelWidth }) {
  const paddingX = Math.round(width * PLACEMENT[format].paddingXRatio);
  const maxTextWidth = panelWidth - paddingX * 2;
  const kickerText = detectEmphasisPhrase(headline) ?? "NFL NEWS";
  const kickerFontSize = Math.round(width * 0.03);
  const emphasisPhrase = detectEmphasisPhrase(headline);

  const { fontSize, lines, lineHeight, blockHeight } = headlineBlockGeometry({
    headline,
    maxTextWidth,
    maxLines: HEADLINE_MAX_LINES.panel,
    // Slightly larger starting attempt than editorial: this column is
    // narrower, but the references still run large, tightly-wrapped text
    // rather than shrinking to fit — see this file's own 2026-09-14 header.
    startSizeRatio: HEADLINE_START_SIZE_RATIO * 1.05,
    canvasWidth: width,
  });

  const dividerHeight = Math.round(height * 0.004);
  const kickerBlockHeight = kickerFontSize * 1.3;
  const dividerGap = fontSize * 0.3;
  const contentBlockHeight = kickerBlockHeight + dividerGap + dividerHeight + dividerGap + blockHeight;

  const topMargin = Math.round(height * 0.08);
  const bottomClearance = Math.round(height * LOGO_CLEARANCE_RATIO[format]);
  const availableHeight = height - topMargin - bottomClearance;
  // Center the whole kicker+divider+headline unit within the available
  // space when it doesn't fill it (short headline); anchor at the top
  // margin when it does (long headline, matching the reference's own
  // long-headline case, which already fills nearly the whole column).
  const blockTop = topMargin + Math.max(0, (availableHeight - contentBlockHeight) / 2);

  const kickerY = blockTop;
  const dividerY = kickerY + kickerBlockHeight + dividerGap;
  const textStartY = dividerY + dividerHeight + dividerGap;

  const tspans = lines.map((line, i) => headlineLineTspan({ line, x: paddingX, y: textStartY + (i + 1) * lineHeight - lineHeight * 0.12, emphasisPhrase })).join("");

  const dividerWidth = Math.round(panelWidth * 0.26);
  const cornerAccent = diagonalAccentStripe({ x: 0, y: 0, width: width * 0.016, height: height * 0.07, skew: width * 0.02, fill: BRAND_RED });
  // Soft feather where the panel meets the photo — drawn on the OVERLAY
  // (which composites on top of the photo layer), fading from the panel's
  // own black into transparent moving rightward into the photo, so the
  // seam reads as an intentional transition rather than a hard cut.
  //
  // 2026-09-14: an earlier draft also added a large low-opacity diagonal
  // "texture band" across the panel for depth — removed after visual
  // review: it read as an arbitrary floating shape rather than subtle
  // texture, exactly the "scattered decorative bar" problem this revision
  // was meant to fix. The panel's own subtle top-to-bottom gradient
  // (panelFill, above) already avoids the flat-black "cutout" look without it.
  const featherWidth = Math.round(width * 0.06);

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>${panelScrimDefs()}</defs>
  <rect x="0" y="0" width="${panelWidth}" height="${height}" fill="url(#panelFill)"/>
  <rect x="${panelWidth}" y="0" width="${featherWidth}" height="${height}" fill="url(#panelFeather)"/>
  ${cornerAccent}
  <rect x="${paddingX - Math.round(kickerFontSize * 0.6)}" y="${Math.round(kickerY)}" width="${Math.round(kickerFontSize * 0.42)}" height="${Math.round(kickerFontSize * 1.05)}" fill="${BRAND_RED}" transform="skewX(-12)"/>
  <text x="${paddingX}" y="${Math.round(kickerY + kickerFontSize)}" font-family="${FONT_FAMILY}" font-size="${kickerFontSize}" fill="#ffffff" style="text-transform:uppercase">${escapeXml(kickerText)}</text>
  <rect x="${paddingX}" y="${Math.round(dividerY)}" width="${dividerWidth}" height="${Math.max(3, dividerHeight)}" fill="${BRAND_RED}"/>
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#ffffff" style="text-transform:uppercase" filter="url(#ts)">${tspans}</text>
</svg>`;

  return { svg, fontSize, lines };
}

/**
 * Builds the transparent-background SVG overlay for one canvas — pure
 * string building, no rendering, so the exact markup is independently
 * testable. `layout` selects between the two canonical Aggregate
 * compositions (see this file's own 2026-09-14 header); defaults to
 * "editorial" for any caller that doesn't specify one. `panelWidth` is
 * required only for layout "panel" (the photo/panel boundary
 * chooseLayout()+renderArtwork() already computed).
 */
export function buildOverlaySvg({ width, height, headline, format, layout = "editorial", panelWidth }) {
  if (layout === "panel") {
    const resolvedPanelWidth = panelWidth ?? Math.round(width * (1 - PANEL_PHOTO_WIDTH_RATIO[format]));
    return buildPanelLayout({ width, height, headline, format, panelWidth: resolvedPanelWidth });
  }
  return buildEditorialLayout({ width, height, headline, format });
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
 *
 * 2026-09-14 brand-system update (revised same day after visual review):
 * chooseLayout() (this file's own header) picks one of TWO canonical
 * Aggregate compositions from destination + source geometry alone.
 * "panel" crops the photo into a narrower side column — the one case
 * where cropping loss is actually measured (estimateCoverCropLoss) and,
 * if too destructive, automatically falls back to the full-bleed
 * "editorial" layout instead of ever forcing an unsafe, over-tight crop.
 * @param {{sourceImagePath: string, headline: string, format: "feed"|"story", outputPath: string}} args
 * @returns {Promise<{width: number, height: number, fontSize: number, lines: string[], layout: "editorial"|"panel"}>}
 */
export async function renderArtwork({ sourceImagePath, headline, format, outputPath }) {
  const canvas = CANVAS[format];
  if (!canvas) throw new Error(`renderArtwork: unknown format "${format}" (expected "feed" or "story")`);
  if (typeof headline !== "string" || !headline.trim()) {
    throw new Error("renderArtwork: headline must be a non-empty string");
  }

  const sourceBytes = await readFile(sourceImagePath);
  const sourceMeta = await sharp(sourceBytes).metadata();
  const layout = chooseLayout({ format, sourceWidth: sourceMeta.width, sourceHeight: sourceMeta.height });

  let photoBuffer;
  let panelWidth;
  if (layout === "panel") {
    // The photo fills only the RIGHT column — the dark left panel (drawn
    // by buildPanelLayout itself, as part of the overlay SVG) holds the
    // kicker, headline, and (composited afterward, unchanged) the logo.
    panelWidth = Math.round(canvas.width * (1 - PANEL_PHOTO_WIDTH_RATIO[format]));
    const photoPanelWidth = canvas.width - panelWidth;
    const croppedPhoto = await sharp(sourceBytes)
      .resize(photoPanelWidth, canvas.height, { fit: "cover", position: sharp.strategy.attention })
      .png()
      .toBuffer();
    photoBuffer = await sharp({ create: { width: canvas.width, height: canvas.height, channels: 3, background: "#000000" } })
      .composite([{ input: croppedPhoto, left: panelWidth, top: 0 }])
      .png()
      .toBuffer();
  } else {
    photoBuffer = await sharp(sourceBytes)
      .resize(canvas.width, canvas.height, { fit: "cover", position: sharp.strategy.attention })
      .png()
      .toBuffer();
  }

  const { svg, fontSize, lines } = buildOverlaySvg({ width: canvas.width, height: canvas.height, headline, format, layout, panelWidth });

  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  const overlayPngBuffer = resvg.render().asPng();

  await sharp(photoBuffer)
    .composite([{ input: overlayPngBuffer, top: 0, left: 0 }])
    .png()
    .toFile(outputPath);

  return { width: canvas.width, height: canvas.height, fontSize, lines, layout };
}
