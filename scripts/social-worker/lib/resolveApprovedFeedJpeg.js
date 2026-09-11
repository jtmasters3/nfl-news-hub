// Production-capable Feed-JPEG resolver — the final missing piece the
// Stage 5B orchestrator has always taken as an injected `resolveJpeg`
// dependency (see bufferFeedOrchestrator.js). Wires the already-existing,
// already-tested deterministic PNG->JPEG pipeline (jpegDerivative.js) to
// real I/O: download the approved PNG, convert it, validate it, and upload
// it through the Worker's deterministic storage endpoint
// (bufferPostingBridge.js's uploadJpeg, -> POST /social/artwork/jpeg).
//
// The approved PNG remains canonical forever. The JPEG produced here is a
// disposable, fully-deterministic publishing derivative — re-deriving it
// from the same PNG always produces the same bytes (modulo JPEG's own
// deterministic encoder), so it is always safe to skip re-creating it if a
// valid one already exists at the stable key.
//
// This module makes NO Buffer/Meta call and performs NO social-state
// mutation — it only ever downloads a public PNG, transforms it in memory,
// and uploads a JPEG to the Worker's artwork storage. Every network call is
// via the explicitly injected `fetchImpl`; there is no live-network
// fallback.
import { convertToJpegDerivative, validateJpegDerivative, deriveJpegStorageKey, inspectAlpha, deriveCornerBackgroundFill, flattenPerimeterAlpha } from "./jpegDerivative.js";

/**
 * Best-effort, read-only check for an already-uploaded, reusable JPEG at
 * the exact deterministic public URL. Any failure (network error, non-200,
 * wrong content-type) is treated as "not reusable" — never as an error —
 * since the safe fallback is simply to (re)derive it.
 */
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
 * Derives the deterministic JPEG storage key/public URL for a record and
 * cheaply checks (one read-only GET, no PNG download, no conversion, no
 * upload capability needed at all) whether a valid derivative already
 * exists there. Exported standalone so a read-only caller (e.g. the CLI
 * launcher's dry-run/preflight mode) can report "already exists" or "would
 * need to be created" without ever holding an uploadJpeg function.
 * @param {object} record
 * @param {{fetchImpl: Function}} dependencies
 * @returns {Promise<{ok: true, exists: boolean, jpegUrl: string, storageKey: string}|{ok: false, error: string}>}
 */
export async function checkExistingApprovedFeedJpeg(record, { fetchImpl } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("checkExistingApprovedFeedJpeg requires an explicit fetchImpl function — no live-network fallback exists.");

  const storyId = record?.story_id;
  const pngUrl = record?.artwork?.image_url;
  if (!pngUrl || typeof pngUrl !== "string") return { ok: false, error: "artwork_missing" };
  if (!pngUrl.startsWith("https://")) return { ok: false, error: "artwork_not_https" };

  let storageKey;
  try {
    storageKey = deriveJpegStorageKey(storyId);
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
 * @param {(args: {storyId: string, jpegBuffer: Buffer}) => Promise<{ok: true, publicUrl: string, storageKey: string}|{ok: false, error: string}>} dependencies.uploadJpeg - injected Worker-upload adapter (bufferPostingBridge.js's uploadJpeg)
 * @param {{r: number, g: number, b: number}} [dependencies.backgroundFillPolicy] - explicit override; if omitted and the source has genuine transparency, this tries flattenPerimeterAlpha first (a known 1px edge-export artifact), then deriveCornerBackgroundFill, failing closed with background_fill_ambiguous if neither applies
 * @returns {Promise<{ok: true, jpegUrl: string, storageKey: string, reused: boolean}|{ok: false, error: string}>}
 */
export async function resolveApprovedFeedJpeg(record, { fetchImpl, uploadJpeg, backgroundFillPolicy } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("resolveApprovedFeedJpeg requires an explicit fetchImpl function — no live-network fallback exists.");
  if (typeof uploadJpeg !== "function") throw new Error("resolveApprovedFeedJpeg requires an explicit uploadJpeg function — no live-network fallback exists.");

  // 1-2, 9: reuses checkExistingApprovedFeedJpeg for both the artwork/HTTPS
  // requirement and the reuse check, so the two functions can never drift.
  const existing = await checkExistingApprovedFeedJpeg(record, { fetchImpl });
  if (!existing.ok) return existing;
  if (existing.exists) return { ok: true, jpegUrl: existing.jpegUrl, storageKey: existing.storageKey, reused: true };

  const { storageKey } = existing;
  const storyId = record.story_id;
  const pngUrl = record.artwork.image_url;

  // 3. Download the approved PNG.
  let pngRes;
  try {
    pngRes = await fetchImpl(pngUrl);
  } catch (err) {
    return { ok: false, error: "png_download_failed" };
  }
  if (!pngRes.ok) return { ok: false, error: "png_download_failed" };
  const pngBuffer = Buffer.from(await pngRes.arrayBuffer());

  // 3b. Determine how to handle genuine transparency. Opaque PNGs (the
  // overwhelming common case) are never affected by any of this. When real
  // alpha exists and the caller didn't explicitly supply a policy, try —
  // in order, never guessing at any step:
  //   1. (implicit above) fully opaque -> nothing to do
  //   2. transparency confined strictly to the outermost 1px perimeter (a
  //      known PNG-export anti-alias/feather artifact) -> flattenPerimeterAlpha,
  //      which is gradient-aware (each edge pixel is composited against ITS
  //      OWN nearest inward opaque neighbor, never one global color)
  //   3. other transparency with a clearly uniform background -> the
  //      existing deriveCornerBackgroundFill single-fill derivation
  //   4. otherwise -> fail closed with background_fill_ambiguous, never a
  //      guessed white/black default
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

  // 4. Run the existing deterministic conversion. A malformed/undecodable
  // source (never expected for a genuinely approved PNG, but never trusted
  // blindly either) fails closed instead of throwing out of this function.
  let converted;
  try {
    converted = await convertToJpegDerivative(bufferToConvert, { backgroundFillPolicy: effectiveFillPolicy });
  } catch {
    return { ok: false, error: "png_decode_failed" };
  }
  if (!converted.ok) return { ok: false, error: converted.error };

  // 5. Validate with the existing deterministic validator before ever uploading.
  const validation = await validateJpegDerivative(converted.buffer, bufferToConvert);
  if (!validation.passed) return { ok: false, error: `jpeg_invalid:${validation.issues.join(",")}` };

  // 7. Upload through the Worker/R2 architecture — never direct R2 credentials here.
  // The Worker is authoritative for collision safety: even though this
  // function's own cheap pre-check (above) found nothing reusable, a
  // concurrent caller may have uploaded a valid derivative in the
  // meantime — the Worker's own GET-then-PUT check catches that race and
  // reports reused:true, which must be honored here, never overridden.
  const uploadResult = await uploadJpeg({ storyId, jpegBuffer: converted.buffer });
  if (!uploadResult.ok) return { ok: false, error: uploadResult.error ?? "upload_failed" };

  // 8. Return a public HTTPS JPEG URL and storage key.
  return { ok: true, jpegUrl: uploadResult.publicUrl, storageKey: uploadResult.storageKey, reused: !!uploadResult.reused };
}
