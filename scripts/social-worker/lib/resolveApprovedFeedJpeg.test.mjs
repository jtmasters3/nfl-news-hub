#!/usr/bin/env node
// Tests for the production-capable Feed-JPEG resolver. Every network call
// (PNG download, reuse check, Worker upload) is mocked via an explicitly
// injected fetchImpl/uploadJpeg — no real network call is possible from
// this suite. installNetworkGuard() additionally makes any accidental use
// of the real globalThis.fetch throw immediately. Run with:
// node scripts/social-worker/lib/resolveApprovedFeedJpeg.test.mjs
import assert from "node:assert/strict";
import sharp from "sharp";
import { installNetworkGuard } from "./_networkGuard.mjs";
import { resolveApprovedFeedJpeg, checkExistingApprovedFeedJpeg } from "./resolveApprovedFeedJpeg.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const WIDTH = 1024;
const HEIGHT = 1280;
const PNG_URL = "https://pub-1705b19e159c4434ba94af4ae6799f97.r2.dev/social-artwork/story-1.png";
const EXPECTED_JPEG_URL = "https://pub-1705b19e159c4434ba94af4ae6799f97.r2.dev/social-artwork-jpeg/story-1.jpg";

function opaquePng(width = WIDTH, height = HEIGHT) {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
}

function approvedRecord(overrides = {}) {
  return {
    story_id: "story-1",
    artwork: { status: "created", image_url: PNG_URL },
    ...overrides,
  };
}

function jsonHeaders(contentType) {
  return { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) };
}

/** A fetchImpl router: reuse-check GET returns 404 (nothing exists yet), PNG download returns the given buffer. */
function fetchRouter({ pngBuffer, reuseStatus = 404, reuseContentType = null } = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u === EXPECTED_JPEG_URL) {
      return { ok: reuseStatus >= 200 && reuseStatus < 300, status: reuseStatus, headers: jsonHeaders(reuseContentType) };
    }
    if (u === PNG_URL) {
      return { ok: true, status: 200, arrayBuffer: async () => pngBuffer };
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };
}

function okUploadJpeg(overrides = {}) {
  return async ({ storyId }) => ({ ok: true, publicUrl: `https://pub-1705b19e159c4434ba94af4ae6799f97.r2.dev/social-artwork-jpeg/${storyId}.jpg`, storageKey: `social-artwork-jpeg/${storyId}.jpg`, ...overrides });
}

// ---------------------------------------------------------------------------
// 1-3. artwork URL requirements
// ---------------------------------------------------------------------------

test("1. an approved HTTPS PNG resolves successfully end-to-end", async () => {
  const pngBuffer = await opaquePng();
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg: okUploadJpeg() });
  assert.equal(result.ok, true);
  assert.equal(result.jpegUrl, EXPECTED_JPEG_URL);
});

test("2. an HTTP (non-HTTPS) artwork URL is rejected before any fetch is attempted", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const result = await resolveApprovedFeedJpeg(approvedRecord({ artwork: { status: "created", image_url: "http://example.test/x.png" } }), { fetchImpl, uploadJpeg: okUploadJpeg() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "artwork_not_https");
  assert.equal(called, false);
});

test("3. missing artwork (no image_url) is rejected before any fetch is attempted", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const result = await resolveApprovedFeedJpeg(approvedRecord({ artwork: { status: "created" } }), { fetchImpl, uploadJpeg: okUploadJpeg() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "artwork_missing");
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// 4. deterministic stable key
// ---------------------------------------------------------------------------

test("4. the JPEG storage key and public URL are deterministic — social-artwork-jpeg/{story_id}.jpg, no other shape possible", async () => {
  const pngBuffer = await opaquePng();
  let captured;
  const uploadJpeg = async (args) => { captured = args; return okUploadJpeg()(args); };
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg });
  assert.equal(result.storageKey, "social-artwork-jpeg/story-1.jpg");
  assert.equal(captured.storyId, "story-1");
});

// ---------------------------------------------------------------------------
// 5. real conversion primitive is used
// ---------------------------------------------------------------------------

test("5. the PNG is genuinely converted through the existing deterministic convertToJpegDerivative primitive — the uploaded bytes are a real, valid JPEG", async () => {
  const pngBuffer = await opaquePng();
  let uploadedBuffer;
  const uploadJpeg = async ({ jpegBuffer, storyId }) => { uploadedBuffer = jpegBuffer; return okUploadJpeg()({ storyId }); };
  await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg });
  assert.ok(uploadedBuffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "the uploaded bytes must start with the real JPEG magic bytes");
  const meta = await sharp(uploadedBuffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, WIDTH);
  assert.equal(meta.height, HEIGHT);
});

// ---------------------------------------------------------------------------
// 6. validation required before upload
// ---------------------------------------------------------------------------

test("6. a source PNG that would produce an invalid derivative (wrong dimensions) never reaches upload — validateJpegDerivative gates it", async () => {
  const wrongSizePng = await opaquePng(800, 800);
  let uploadCalled = false;
  const uploadJpeg = async (args) => { uploadCalled = true; return okUploadJpeg()(args); };
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer: wrongSizePng }), uploadJpeg });
  assert.equal(result.ok, false);
  assert.ok(result.error.startsWith("jpeg_invalid:"));
  assert.equal(uploadCalled, false);
});

// ---------------------------------------------------------------------------
// 7. correct public URL returned
// ---------------------------------------------------------------------------

test("7. the exact public JPEG URL returned by the Worker upload is what this function returns", async () => {
  const pngBuffer = await opaquePng();
  const uploadJpeg = async () => ({ ok: true, publicUrl: "https://artwork.example.test/social-artwork-jpeg/story-1.jpg", storageKey: "social-artwork-jpeg/story-1.jpg" });
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg });
  assert.equal(result.jpegUrl, "https://artwork.example.test/social-artwork-jpeg/story-1.jpg");
});

// ---------------------------------------------------------------------------
// 8. upload failure stops the path
// ---------------------------------------------------------------------------

test("8. an upload failure is surfaced as ok:false and stops the publish path here — never silently treated as success", async () => {
  const pngBuffer = await opaquePng();
  const uploadJpeg = async () => ({ ok: false, error: "network_error" });
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network_error");
});

// ---------------------------------------------------------------------------
// 15-17. Worker collision-safety hardening — the Worker is authoritative,
// this resolver's own reuse check is only a client-side optimization that
// can always race against a concurrent uploader.
// ---------------------------------------------------------------------------

test("15. a Worker response reporting reused:true (the client's own pre-check missed an existing derivative, but the Worker's authoritative GET-then-PUT caught it) is accepted as success, not an error", async () => {
  const pngBuffer = await opaquePng();
  const uploadJpeg = async ({ storyId }) => ({ ok: true, reused: true, publicUrl: `https://pub-1705b19e159c4434ba94af4ae6799f97.r2.dev/social-artwork-jpeg/${storyId}.jpg`, storageKey: `social-artwork-jpeg/${storyId}.jpg` });
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.jpegUrl, EXPECTED_JPEG_URL);
});

test("16. a Worker-reported collision conflict (an existing object that doesn't match — malformed/wrong dimensions) fails the resolver, never silently accepted", async () => {
  const pngBuffer = await opaquePng();
  const uploadJpeg = async () => ({ ok: false, error: "existing_object_conflict" });
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }), uploadJpeg });
  assert.equal(result.ok, false);
  assert.equal(result.error, "existing_object_conflict");
});

test("17. this resolver still runs its own local validateJpegDerivative gate before ever calling uploadJpeg, regardless of what the Worker would ultimately decide", async () => {
  const wrongSizePng = await opaquePng(800, 800);
  let uploadCalled = false;
  const uploadJpeg = async (args) => { uploadCalled = true; return { ok: true, reused: false, publicUrl: "x", storageKey: "x" }; };
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer: wrongSizePng }), uploadJpeg });
  assert.equal(result.ok, false);
  assert.ok(result.error.startsWith("jpeg_invalid:"));
  assert.equal(uploadCalled, false, "local validation must gate the call — the Worker must never even be asked to consider an invalid derivative");
});

// ---------------------------------------------------------------------------
// 9. malformed source fails closed
// ---------------------------------------------------------------------------

test("9. a malformed/undecodable downloaded PNG fails closed with a clear error, never throws out of this function", async () => {
  const garbage = Buffer.from("this is not a png at all");
  const uploadJpeg = async () => { throw new Error("must never be called"); };
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer: garbage }), uploadJpeg });
  assert.equal(result.ok, false);
  assert.equal(result.error, "png_decode_failed");
});

test("a failed PNG download (non-200) fails closed without attempting conversion or upload", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === EXPECTED_JPEG_URL) return { ok: false, status: 404, headers: jsonHeaders(null) };
    if (u === PNG_URL) return { ok: false, status: 500 };
    throw new Error(`Unexpected fetch: ${u}`);
  };
  const uploadJpeg = async () => { throw new Error("must never be called"); };
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl, uploadJpeg });
  assert.equal(result.ok, false);
  assert.equal(result.error, "png_download_failed");
});

// ---------------------------------------------------------------------------
// 10. reuse of an existing valid derivative
// ---------------------------------------------------------------------------

test("10. an existing, valid JPEG at the stable key is reused instead of re-downloading/re-converting/re-uploading", async () => {
  let pngFetched = false;
  let uploadCalled = false;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === EXPECTED_JPEG_URL) return { ok: true, status: 200, headers: jsonHeaders("image/jpeg") };
    if (u === PNG_URL) { pngFetched = true; throw new Error("must never download the PNG when a valid derivative already exists"); }
    throw new Error(`Unexpected fetch: ${u}`);
  };
  const uploadJpeg = async () => { uploadCalled = true; throw new Error("must never be called"); };
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl, uploadJpeg });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.jpegUrl, EXPECTED_JPEG_URL);
  assert.equal(pngFetched, false);
  assert.equal(uploadCalled, false);
});

test("an existing object at the stable key with the WRONG content-type is not treated as reusable — falls through to real conversion", async () => {
  const pngBuffer = await opaquePng();
  const result = await resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer, reuseStatus: 200, reuseContentType: "text/html" }), uploadJpeg: okUploadJpeg() });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
});

// ---------------------------------------------------------------------------
// 11-12. no Buffer call, no social-state mutation
// ---------------------------------------------------------------------------

test("11. no Buffer call occurs during JPEG resolution — the module never imports or references a Buffer client", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./resolveApprovedFeedJpeg.js", import.meta.url), "utf-8");
  assert.ok(!/createBufferClient|createBufferPublisherClient|api\.buffer\.com/i.test(src));
});

test("12. no social-state mutation occurs during JPEG resolution — the module never imports fetchSocialState/writeSocialState/postingEvents", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./resolveApprovedFeedJpeg.js", import.meta.url), "utf-8");
  assert.ok(!/writeSocialState|fetchSocialState|postingEvents\.js/i.test(src));
});

// ---------------------------------------------------------------------------
// checkExistingApprovedFeedJpeg — the standalone read-only existence check
// used by the CLI launcher's dry-run/preflight mode (never has upload
// capability, structurally).
// ---------------------------------------------------------------------------

test("checkExistingApprovedFeedJpeg reports exists:true for a valid existing derivative, with no PNG download at all", async () => {
  let pngFetched = false;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === EXPECTED_JPEG_URL) return { ok: true, status: 200, headers: jsonHeaders("image/jpeg") };
    if (u === PNG_URL) { pngFetched = true; throw new Error("must never fetch the PNG for a read-only existence check"); }
    throw new Error(`Unexpected fetch: ${u}`);
  };
  const result = await checkExistingApprovedFeedJpeg(approvedRecord(), { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.exists, true);
  assert.equal(result.jpegUrl, EXPECTED_JPEG_URL);
  assert.equal(pngFetched, false);
});

test("checkExistingApprovedFeedJpeg reports exists:false when nothing is at the stable key yet", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === EXPECTED_JPEG_URL) return { ok: false, status: 404, headers: jsonHeaders(null) };
    throw new Error(`Unexpected fetch: ${u}`);
  };
  const result = await checkExistingApprovedFeedJpeg(approvedRecord(), { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.exists, false);
  assert.equal(result.storageKey, "social-artwork-jpeg/story-1.jpg");
});

test("checkExistingApprovedFeedJpeg fails closed without an explicit fetchImpl", async () => {
  await assert.rejects(() => checkExistingApprovedFeedJpeg(approvedRecord(), {}));
});

test("construction fails closed without an explicit fetchImpl", async () => {
  await assert.rejects(() => resolveApprovedFeedJpeg(approvedRecord(), { uploadJpeg: okUploadJpeg() }));
});

test("construction fails closed without an explicit uploadJpeg", async () => {
  const pngBuffer = await opaquePng();
  await assert.rejects(() => resolveApprovedFeedJpeg(approvedRecord(), { fetchImpl: fetchRouter({ pngBuffer }) }));
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
