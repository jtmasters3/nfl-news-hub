// Minimal local sanity check on the Codex-generated file before uploading
// it — the Worker (../../../../cloudflare-worker/src/imageValidation.js)
// does the authoritative inspection on upload; this is just "did Codex
// actually produce a real, roughly-4:5 PNG" so a bad generation fails fast
// via /social/artwork/fail (stage: "generation") instead of burning an
// upload attempt.
import { readFile } from "node:fs/promises";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function readPngDimensions(filePath) {
  const buf = await readFile(filePath);
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), sizeBytes: buf.length };
}
