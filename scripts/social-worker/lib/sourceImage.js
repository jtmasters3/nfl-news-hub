// Downloads the story's base photograph to a LOCAL file before generation,
// so Codex reads local bytes instead of fetching a remote URL itself.
//
// Why: investigating two consecutive "could not access the supplied base
// photograph" failures (stories 9ab76efd-e209-4066-a58c-d5dfa3e9faf8 and,
// less directly, 85696f0d-ef08-412b-afa1-9b1d7081d025 — 2026-08-28/31)
// found both base_image_urls fully reachable from a normal, unsandboxed
// process on this same machine (200 OK, valid JPEG, no redirects, no
// hotlink/expiry protection) — strong evidence the unreliability lives in
// Codex's own sandboxed fetch path, not the source URL. Localizing removes
// that whole class of failure and lets us validate the image BEFORE ever
// spending a generation attempt on it.
//
// Deliberately local-only: the downloaded file lives under the story's
// social-output/work/{story_id}/ dir (gitignored, never uploaded to R2,
// never committed) and is deleted by the caller once processing finishes
// — this never rehosts publisher photography anywhere durable.
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MIN_BYTES = 5000; // a real news photo is never this small — catches truncated downloads/error pages

function matchesSignature(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function detectExtension(bytes) {
  if (matchesSignature(bytes, PNG_SIGNATURE)) return "png";
  if (matchesSignature(bytes, JPEG_SIGNATURE)) return "jpg";
  return null;
}

/**
 * Single download attempt. Throws a specific, descriptive error — never
 * silently substitutes anything — for a non-2xx response, a body that
 * isn't a recognized PNG/JPEG image, or a suspiciously tiny body. Nothing
 * is written to disk unless the bytes pass validation.
 * @returns {{ path: string, sizeBytes: number, extension: 'png'|'jpg' }}
 */
export async function downloadSourceImage(url, workDir, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new Error(`source image download failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`source image download failed: HTTP ${res.status}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < MIN_BYTES) {
    throw new Error(`source image download failed: only ${bytes.byteLength} bytes returned (suspiciously small)`);
  }

  const extension = detectExtension(bytes);
  if (!extension) {
    throw new Error("source image download failed: response body is not a recognized PNG/JPEG image");
  }

  const destPath = path.join(workDir, `source.${extension}`);
  await writeFile(destPath, bytes);
  return { path: destPath, sizeBytes: bytes.byteLength, extension };
}

/**
 * Bounded retry around downloadSourceImage — covers a genuinely transient
 * blip (momentary CDN/network hiccup), NOT a substitute fetch mechanism.
 * If the source is truly unreachable or invalid, this still fails after
 * `attempts` tries — treated as non-retryable by the caller (no Codex
 * invocation is ever wasted on a story with no valid local image).
 */
export async function downloadSourceImageWithRetries(url, workDir, { attempts = 2, timeoutMs, onAttemptFailure } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await downloadSourceImage(url, workDir, { timeoutMs });
    } catch (err) {
      lastErr = err;
      onAttemptFailure?.(attempt, err);
    }
  }
  throw lastErr;
}

/** Deletes the downloaded source image — always called once processing finishes, success or failure, per the "temporary working input only" requirement. */
export async function cleanupSourceImage(sourceImagePath) {
  if (!sourceImagePath) return;
  await rm(sourceImagePath, { force: true });
}
