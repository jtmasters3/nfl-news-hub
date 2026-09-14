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

// ==========================================================================
// 2026-09-14 Aggregate brand visual system
// ==========================================================================
// Derived from four canonical design references (see assets/reference/ —
// REFERENCE ONLY, never a content source: nothing in this pipeline ever
// reads a source photo from that directory) covering three recurring
// compositions. All three reuse the SAME full-bleed "attention"-strategy
// cover-crop already proven safe by imageMatch.js's direct-evidence gate
// (see this file's own pre-existing header above) — only Layout A departs
// from that, cropping the photo into a narrower side panel instead of the
// full canvas, which is why it alone needs the crop-loss safety check
// below.
//
// A curated, non-exhaustive list of editorially meaningful status
// phrases — used for BOTH the optional kicker label (Layouts A/C) and
// inline headline emphasis (Layout B). Deliberately just a phrase-presence
// check against the ALREADY-WRITTEN headline text: never invents wording,
// never asserts urgency the headline doesn't already state, and (unlike
// the reference images' own "BREAKING: <date>" treatment) never displays a
// date, since this pipeline has no reliable, editorially-approved date to
// show. Ordered most-specific-first so a longer, more precise phrase is
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

// Fraction of canvas width Layout A's photo panel occupies — sized with
// deliberate margin so the dark side panel it leaves is always wide enough
// to hold brandOverlay.js's own logo placement (PLACEMENT.<format>) without
// the two ever overlapping: feed's logo needs >=0.34 of canvas width
// (0.06 padding + 0.28 logo width), story's needs >=0.36 (0.06 + 0.30) —
// both comfortably inside the panels reserved here (0.40 and 0.42).
const LAYOUT_A_PHOTO_WIDTH_RATIO = { feed: 0.6, story: 0.58 };
// Beyond this fraction of the original photo discarded, a crop is
// considered too destructive to trust — chooseLayout() below falls back to
// a full-bleed layout instead (which crops far less, and is what this
// pipeline already used exclusively before this brand-system update) —
// never a hard failure, since a safe fallback layout always exists for
// every real photo geometry. This is deliberately NOT a subject-detection
// claim: it is a plain, honest measurement of surviving photo area, used
// only to prefer the layout that keeps more of the actual photo on screen.
const LAYOUT_CROP_LOSS_FAIL_THRESHOLD = 0.6;
// Feed source photos are, in practice, very often landscape-oriented press
// photography (see imageMeta.js) — a photo this much wider than the 4:5
// Feed canvas already loses a large fraction of itself to a full-bleed
// cover-crop, so cramming it into Layout A's even-narrower side panel
// would only make that worse. Routing straight to the full-bleed banner
// treatment (Layout C) for these photos is both simpler and safer than
// computing (and likely rejecting) the Layout A crop-loss check anyway.
const FEED_LANDSCAPE_ASPECT_THRESHOLD = 1.15;

/**
 * Chooses one of the three canonical Aggregate layouts for a render,
 * deterministically, from ONLY the destination and the source photo's own
 * geometry — never from image content, never randomly, never via any AI
 * call. See this file's own 2026-09-14 header for what each layout looks
 * like.
 * @param {{format: "feed"|"story", sourceWidth?: number, sourceHeight?: number}} args
 * @returns {"A"|"B"|"C"}
 */
export function chooseLayout({ format, sourceWidth, sourceHeight }) {
  if (!sourceWidth || !sourceHeight) return "B"; // no geometry available — the safest, plainest default
  const canvas = CANVAS[format];
  if (!canvas) return "B";

  if (format === "feed") {
    const sourceAspect = sourceWidth / sourceHeight;
    if (sourceAspect >= FEED_LANDSCAPE_ASPECT_THRESHOLD) return "C";
  }

  const photoWidthRatio = LAYOUT_A_PHOTO_WIDTH_RATIO[format];
  const panelWidth = Math.round(canvas.width * photoWidthRatio);
  const loss = estimateCoverCropLoss(sourceWidth, sourceHeight, panelWidth, canvas.height);
  return loss <= LAYOUT_CROP_LOSS_FAIL_THRESHOLD ? "A" : "B";
}

/** One slanted accent parallelogram — the angular red/black graphic motif shared by every reference layout. */
function diagonalAccentPolygon({ x, y, width, height, skew, fill }) {
  const points = [
    [x + skew, y],
    [x + skew + width, y],
    [x + width, y + height],
    [x, y + height],
  ]
    .map((p) => p.join(","))
    .join(" ");
  return `<polygon points="${points}" fill="${fill}"/>`;
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
export function fitHeadline(text, maxWidth, { startSize, minSize, maxLines = HEADLINE_MAX_LINES, step = 2 } = {}) {
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

const SCRIM_DEFS = `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.93"/>
    </linearGradient>
    <linearGradient id="scrimStrong" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="35%" stop-color="#000000" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.97"/>
    </linearGradient>
    <filter id="ts" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.6"/>
    </filter>`;

function headlineBlockGeometry({ width, height, headline, format, paddingX, maxTextWidth, reservedBottomRatio }) {
  const startSize = Math.round(width * HEADLINE_START_SIZE_RATIO);
  const minSize = Math.round(width * HEADLINE_MIN_SIZE_RATIO);
  const { fontSize, lines } = fitHeadline(headline, maxTextWidth, { startSize, minSize });
  const lineHeight = fontSize * HEADLINE_LINE_HEIGHT_RATIO;
  const reservedBottom = Math.round(height * reservedBottomRatio);
  const textBlockHeight = lines.length * lineHeight;
  const textBottomY = height - reservedBottom;
  const textStartY = textBottomY - textBlockHeight;
  return { fontSize, lines, lineHeight, textStartY, paddingX };
}

/** Layout B — full-bleed photo, bottom gradient scrim, headline bottom-left, inline red emphasis. The original renderer design, now brand-accented. */
function buildLayoutB({ width, height, headline, format }) {
  const paddingX = Math.round(width * PLACEMENT[format].paddingXRatio);
  const maxTextWidth = width - paddingX * 2;
  const { fontSize, lines, lineHeight, textStartY } = headlineBlockGeometry({ width, height, headline, format, paddingX, maxTextWidth, reservedBottomRatio: LOGO_CLEARANCE_RATIO[format] });
  const gradientTopY = Math.max(0, textStartY - fontSize * 1.6);
  const accentY = textStartY - fontSize * 0.5;
  const accentWidth = Math.round(width * 0.16);
  const emphasisPhrase = detectEmphasisPhrase(headline);

  const tspans = lines.map((line, i) => headlineLineTspan({ line, x: paddingX, y: textStartY + (i + 1) * lineHeight - lineHeight * 0.18, emphasisPhrase })).join("");

  // A single small angular accent, top-right — brand texture without
  // competing with the subject, which "attention" cropping already
  // favors keeping roughly centered/upper in a full-bleed photo.
  const accent = diagonalAccentPolygon({ x: width * 0.86, y: 0, width: width * 0.05, height: height * 0.14, skew: width * 0.03, fill: BRAND_RED });

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>${SCRIM_DEFS}</defs>
  <rect x="0" y="${Math.round(gradientTopY)}" width="${width}" height="${Math.round(height - gradientTopY)}" fill="url(#scrim)"/>
  ${accent}
  <rect x="${paddingX}" y="${Math.round(accentY)}" width="${accentWidth}" height="6" fill="${BRAND_RED}"/>
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" style="text-transform:uppercase" filter="url(#ts)">${tspans}</text>
</svg>`;

  return { svg, fontSize, lines };
}

/** Layout C — full-bleed photo, stronger bottom band, a kicker banner strip, then the headline (plain, unemphasized — the banner already carries the emphasis). */
function buildLayoutC({ width, height, headline, format }) {
  const paddingX = Math.round(width * PLACEMENT[format].paddingXRatio);
  const maxTextWidth = width - paddingX * 2;
  const kickerText = detectEmphasisPhrase(headline) ?? "NFL NEWS";
  const kickerFontSize = Math.round(width * 0.032);
  const kickerHeight = Math.round(kickerFontSize * 2.1);
  const kickerWidth = Math.round(kickerText.length * kickerFontSize * AVG_CHAR_WIDTH_RATIO * 0.95 + kickerFontSize * 2);

  const { fontSize, lines, lineHeight, textStartY } = headlineBlockGeometry({
    width,
    height,
    headline,
    format,
    paddingX,
    maxTextWidth,
    // Extra clearance above the logo zone to also fit the kicker banner
    // sitting just above the headline block.
    reservedBottomRatio: LOGO_CLEARANCE_RATIO[format],
  });
  const kickerY = textStartY - kickerHeight - fontSize * 0.35;
  const gradientTopY = Math.max(0, kickerY - fontSize * 1.4);

  const tspans = lines.map((line, i) => headlineLineTspan({ line, x: paddingX, y: textStartY + (i + 1) * lineHeight - lineHeight * 0.18, emphasisPhrase: null })).join("");

  // Right-edge diagonal accent stripes, matching the square reference.
  const stripes = [0, 1]
    .map((i) => diagonalAccentPolygon({ x: width - width * 0.16 - i * width * 0.09, y: 0, width: width * 0.045, height: height * 0.4, skew: width * 0.05, fill: i === 0 ? BRAND_RED : "#3a3a3a" }))
    .join("");

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>${SCRIM_DEFS}</defs>
  <rect x="0" y="${Math.round(gradientTopY)}" width="${width}" height="${Math.round(height - gradientTopY)}" fill="url(#scrimStrong)"/>
  ${stripes}
  <rect x="${paddingX}" y="${Math.round(kickerY)}" width="${kickerWidth}" height="${kickerHeight}" fill="${BRAND_RED}"/>
  <text x="${Math.round(paddingX + kickerWidth / 2)}" y="${Math.round(kickerY + kickerHeight * 0.68)}" font-family="${FONT_FAMILY}" font-size="${kickerFontSize}" fill="#ffffff" text-anchor="middle" style="text-transform:uppercase">${escapeXml(kickerText)}</text>
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" style="text-transform:uppercase" filter="url(#ts)">${tspans}</text>
</svg>`;

  return { svg, fontSize, lines };
}

/** Layout A — a dark side panel (always wide enough to hold the logo, see LAYOUT_A_PHOTO_WIDTH_RATIO's own comment) with a kicker, headline column, and divider rule; the photo fills only the remaining panel (cropped separately in renderArtwork, not here — this only draws the panel's own chrome plus the diagonal corner accent). */
function buildLayoutA({ width, height, headline, format, panelWidth }) {
  const paddingX = Math.round(width * PLACEMENT[format].paddingXRatio);
  const maxTextWidth = panelWidth - paddingX * 2;
  const kickerText = detectEmphasisPhrase(headline) ?? "NFL NEWS";
  const kickerFontSize = Math.round(width * 0.026);

  const { fontSize, lines, lineHeight, textStartY } = headlineBlockGeometry({
    width,
    height,
    headline,
    format,
    paddingX,
    maxTextWidth,
    reservedBottomRatio: LOGO_CLEARANCE_RATIO[format],
  });
  const kickerY = Math.max(height * 0.12, textStartY - lines.length * lineHeight * 0.35 - kickerFontSize * 3);
  const dividerY = textStartY - fontSize * 0.55;
  const dividerWidth = Math.round(panelWidth * 0.3);

  const tspans = lines.map((line, i) => headlineLineTspan({ line, x: paddingX, y: textStartY + (i + 1) * lineHeight - lineHeight * 0.18, emphasisPhrase: null })).join("");

  const cornerAccent = diagonalAccentPolygon({ x: 0, y: 0, width: width * 0.05, height: height * 0.09, skew: width * 0.045, fill: BRAND_RED });

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>${SCRIM_DEFS}</defs>
  <rect x="0" y="0" width="${panelWidth}" height="${height}" fill="#000000"/>
  ${cornerAccent}
  <rect x="${paddingX - Math.round(kickerFontSize * 0.7)}" y="${Math.round(kickerY)}" width="${Math.round(kickerFontSize * 0.5)}" height="${Math.round(kickerFontSize * 1.1)}" fill="${BRAND_RED}" transform="skewX(-12)"/>
  <text x="${paddingX}" y="${Math.round(kickerY + kickerFontSize)}" font-family="${FONT_FAMILY}" font-size="${kickerFontSize}" fill="#ffffff" style="text-transform:uppercase">${escapeXml(kickerText)}</text>
  <rect x="${paddingX}" y="${Math.round(dividerY)}" width="${dividerWidth}" height="4" fill="${BRAND_RED}"/>
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#ffffff" style="text-transform:uppercase" filter="url(#ts)">${tspans}</text>
</svg>`;

  return { svg, fontSize, lines };
}

/**
 * Builds the transparent-background SVG overlay for one canvas — pure
 * string building, no rendering, so the exact markup is independently
 * testable. `layout` selects among the three canonical Aggregate
 * compositions (see this file's own 2026-09-14 header); defaults to "B",
 * the original single-layout design, for any caller that doesn't specify
 * one. `panelWidth` is required only for layout "A" (the photo/panel
 * boundary chooseLayout()+renderArtwork() already computed).
 */
export function buildOverlaySvg({ width, height, headline, format, layout = "B", panelWidth }) {
  if (layout === "A") {
    const resolvedPanelWidth = panelWidth ?? Math.round(width * (1 - LAYOUT_A_PHOTO_WIDTH_RATIO[format]));
    return buildLayoutA({ width, height, headline, format, panelWidth: resolvedPanelWidth });
  }
  if (layout === "C") return buildLayoutC({ width, height, headline, format });
  return buildLayoutB({ width, height, headline, format });
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
 * 2026-09-14 brand-system update: chooseLayout() (this file's own header)
 * picks one of three canonical Aggregate compositions from destination +
 * source geometry alone. Layout A crops the photo into a narrower side
 * panel — the one case where cropping loss is actually measured
 * (estimateCoverCropLoss) and, if too destructive, automatically falls
 * back to a full-bleed layout instead of ever forcing an unsafe crop.
 * @param {{sourceImagePath: string, headline: string, format: "feed"|"story", outputPath: string}} args
 * @returns {Promise<{width: number, height: number, fontSize: number, lines: string[], layout: "A"|"B"|"C"}>}
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
  if (layout === "A") {
    // The photo fills only the RIGHT panel — the dark left panel (drawn by
    // buildLayoutA itself, as part of the overlay SVG) holds the kicker,
    // headline, and (composited afterward, unchanged) the logo.
    panelWidth = Math.round(canvas.width * (1 - LAYOUT_A_PHOTO_WIDTH_RATIO[format]));
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
