// The Story sibling of resolveApprovedFeedJpeg.js — same deterministic
// PNG->JPEG pipeline (jpegDerivative.js), same "the approved PNG remains
// canonical forever, the JPEG is a disposable, always-re-derivable
// publishing convenience" contract, same background-fill decision tree.
// Differs only in: the storage key (deriveStoryJpegStorageKey, a separate
// prefix from Feed's), the upload adapter used (bridge.uploadStoryJpeg ->
// the Worker's separate /social/artwork/jpeg-story route), and the
// dimension/aspect-ratio expectations passed to validateJpegDerivative —
// Story's approved artwork is only ratio/floor-constrained (9:16 +/- 6%,
// >=400px — see scripts/lib/storyArtworkValidation.js), never a single
// fixed exact width/height the way Feed's 1024x1280 is, so this resolver
// derives its expected width/height from the record's OWN already-approved
// artwork.width/artwork.height rather than a hardcoded constant — the
// point of this validation step is to catch conversion corruption, not to
// re-assert a target the artwork-approval stage already checked.
//
// This module makes NO Buffer/Meta call and performs NO social-state
// mutation — it only ever downloads a public PNG, transforms it in memory,
// and uploads a JPEG to the Worker's artwork storage. Every network call is
// via the explicitly injected `fetchImpl`; there is no live-network
// fallback.
import { convertToJpegDerivative, validateJpegDerivative, deriveStoryJpegStorageKey, inspectAlpha, deriveCornerBackgroundFill, flattenPerimeterAlpha } from "./jpegDerivative.js";
import { ASPECT_RATIO_TARGET, ASPECT_RATIO_TOLERANCE, MIN_DIMENSION } from "../../lib/storyArtworkValidation.js";

/** Identical reuse-check strategy to resolveApprovedFeedJpeg.js's own. */
async function tryReuseExistingJpeg(fetchImpl, publicUrl) {
  try {
    const res = await fetchImpl(publicUrl, { method: "GET" });
    if (!res.ok) return false;
    const contentType = typeof res.headers?.get === "function" ? res.headers.get("content-type") : null;
    if (contentType && !contentType.includes("image/jpeg")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only existence check for the deterministic Story JPEG URL — the
 * Story sibling of checkExistingApprovedFeedJpeg().
 * @param {object} record
 * @param {{fetchImpl: Function}} dependencies
 * @returns {Promise<{ok: true, exists: boolean, jpegUrl: string, storageKey: string}|{ok: false, error: string}>}
 */
export async function checkExistingApprovedStoryJpeg(record, { fetchImpl } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("checkExistingApprovedStoryJpeg requires an explicit fetchImpl function — no live-network fallback exists.");

  const storyId = record?.story_id;
  const pngUrl = record?.artwork?.image_url;
  if (!pngUrl || typeof pngUrl !== "string") return { ok: false, error: "artwork_missing" };
  if (!pngUrl.startsWith("https://")) return { ok: false, error: "artwork_not_https" };

  let storageKey;
  try {
    storageKey = deriveStoryJpegStorageKey(storyId);
  } catch {
    return { ok: false, error: "invalid_story_id" };
  }

  let origin;
  try {
    origin = new URL(pngUrl).origin;
  } catch {
    return { ok: false, error: "artwork_not_https" };
  }
  const publicUrl = `${origin}/${storageKey}`;
  const exists = await tryReuseExistingJpeg(fetchImpl, publicUrl);
  return { ok: true, exists, jpegUrl: publicUrl, storageKey };
}

/**
 * @param {object} record - the story's current social-state record (read-only input)
 * @param {object} dependencies
 * @param {Function} dependencies.fetchImpl - explicit fetch, used for downloading the PNG and the reuse check (both public HTTPS URLs, no auth needed)
 * @param {(args: {storyId: string, jpegBuffer: Buffer}) => Promise<{ok: true, publicUrl: string, storageKey: string}|{ok: false, error: string}>} dependencies.uploadJpeg - injected Worker-upload adapter targeting the Story route (bufferPostingBridge.js's uploadStoryJpeg)
 * @param {{r: number, g: number, b: number}} [dependencies.backgroundFillPolicy]
 * @returns {Promise<{ok: true, jpegUrl: string, storageKey: string, reused: boolean}|{ok: false, error: string}>}
 */
export async function resolveApprovedStoryJpeg(record, { fetchImpl, uploadJpeg, backgroundFillPolicy } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("resolveApprovedStoryJpeg requires an explicit fetchImpl function — no live-network fallback exists.");
  if (typeof uploadJpeg !== "function") throw new Error("resolveApprovedStoryJpeg requires an explicit uploadJpeg function — no live-network fallback exists.");

  const existing = await checkExistingApprovedStoryJpeg(record, { fetchImpl });
  if (!existing.ok) return existing;
  if (existing.exists) return { ok: true, jpegUrl: existing.jpegUrl, storageKey: existing.storageKey, reused: true };

  const { storageKey } = existing;
  const storyId = record.story_id;
  const pngUrl = record.artwork.image_url;
  const approvedWidth = record.artwork?.width;
  const approvedHeight = record.artwork?.height;
  if (!Number.isFinite(approvedWidth) || !Number.isFinite(approvedHeight)) {
    return { ok: false, error: "artwork_dimensions_missing" };
  }

  let pngRes;
  try {
    pngRes = await fetchImpl(pngUrl);
  } catch {
    return { ok: false, error: "png_download_failed" };
  }
  if (!pngRes.ok) return { ok: false, error: "png_download_failed" };
  const pngBuffer = Buffer.from(await pngRes.arrayBuffer());

  let effectiveFillPolicy = backgroundFillPolicy;
  let bufferToConvert = pngBuffer;
  if (!effectiveFillPolicy) {
    let alphaInfo;
    try {
      alphaInfo = await inspectAlpha(pngBuffer);
    } catch {
      return { ok: false, error: "png_decode_failed" };
    }
    if (alphaInfo.hasAlphaChannel && !alphaInfo.fullyOpaque) {
      let perimeterResult;
      try {
        perimeterResult = await flattenPerimeterAlpha(pngBuffer);
      } catch {
        return { ok: false, error: "png_decode_failed" };
      }
      if (perimeterResult.ok) {
        bufferToConvert = perimeterResult.buffer;
      } else {
        const derived = await deriveCornerBackgroundFill(pngBuffer);
        if (!derived) return { ok: false, error: "background_fill_ambiguous" };
        effectiveFillPolicy = derived;
      }
    }
  }

  let converted;
  try {
    converted = await convertToJpegDerivative(bufferToConvert, { backgroundFillPolicy: effectiveFillPolicy });
  } catch {
    return { ok: false, error: "png_decode_failed" };
  }
  if (!converted.ok) return { ok: false, error: converted.error };

  // Validate against the record's OWN approved dimensions (never a fixed
  // 1080x1920 constant — see this file's header) plus Story's ratio/floor
  // tolerance, never Feed's 4:5 defaults.
  const validation = await validateJpegDerivative(converted.buffer, bufferToConvert, {
    expectedWidth: approvedWidth,
    expectedHeight: approvedHeight,
    expectedAspectRatio: ASPECT_RATIO_TARGET,
    aspectRatioTolerance: ASPECT_RATIO_TOLERANCE,
    minDimension: MIN_DIMENSION,
  });
  if (!validation.passed) return { ok: false, error: `jpeg_invalid:${validation.issues.join(",")}` };

  const uploadResult = await uploadJpeg({ storyId, jpegBuffer: converted.buffer });
  if (!uploadResult.ok) return { ok: false, error: uploadResult.error ?? "upload_failed" };

  return { ok: true, jpegUrl: uploadResult.publicUrl, storageKey: uploadResult.storageKey, reused: !!uploadResult.reused };
}
