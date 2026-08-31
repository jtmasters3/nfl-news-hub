#!/usr/bin/env node
// Reproduces the 2026-08-31 Content Creation reliability investigation at
// the unit level: source images must be downloaded and validated LOCALLY
// before Codex ever runs — this tests that download/validation logic in
// isolation, with global fetch faked, no real network access and no real
// story. Run with: node scripts/social-worker/lib/sourceImage.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadSourceImage, downloadSourceImageWithRetries, cleanupSourceImage } from "./sourceImage.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function withFakeFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jpegBytes(size = 10_000) {
  const buf = new Uint8Array(size);
  buf.set([0xff, 0xd8, 0xff, 0xe0], 0); // real JPEG SOI + APP0 marker start
  return buf;
}

function pngBytes(size = 10_000) {
  const buf = new Uint8Array(size);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return buf;
}

test("downloadSourceImage saves a valid JPEG locally and reports its size/extension", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  const bytes = jpegBytes();
  await withFakeFetch(
    async () => new Response(bytes, { status: 200 }),
    async () => {
      const result = await downloadSourceImage("https://example.test/photo.jpg", dir);
      assert.equal(result.extension, "jpg");
      assert.equal(result.sizeBytes, bytes.length);
      const written = await readdir(dir);
      assert.deepEqual(written, ["source.jpg"]);
    }
  );
});

test("downloadSourceImage saves a valid PNG locally with the right extension", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  await withFakeFetch(
    async () => new Response(pngBytes(), { status: 200 }),
    async () => {
      const result = await downloadSourceImage("https://example.test/photo.png", dir);
      assert.equal(result.extension, "png");
      const written = await readdir(dir);
      assert.deepEqual(written, ["source.png"]);
    }
  );
});

test("A non-2xx response is rejected with the HTTP status in the message, nothing written to disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  await withFakeFetch(
    async () => new Response("Not Found", { status: 404 }),
    async () => {
      await assert.rejects(() => downloadSourceImage("https://example.test/gone.jpg", dir), /HTTP 404/);
      assert.deepEqual(await readdir(dir), [], "a failed download must never leave a partial/wrong file behind");
    }
  );
});

test("A non-image body (e.g. an HTML error page served with 200) is rejected, not silently accepted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  const html = new TextEncoder().encode("<html><body>not an image, but a real 200</body></html>".repeat(200));
  await withFakeFetch(
    async () => new Response(html, { status: 200 }),
    async () => {
      await assert.rejects(() => downloadSourceImage("https://example.test/oops.jpg", dir), /not a recognized PNG\/JPEG image/);
    }
  );
});

test("A suspiciously tiny body is rejected even if it has a valid-looking signature", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  await withFakeFetch(
    async () => new Response(jpegBytes(50), { status: 200 }), // real signature, but far too small to be a real photo
    async () => {
      await assert.rejects(() => downloadSourceImage("https://example.test/tiny.jpg", dir), /suspiciously small/);
    }
  );
});

test("downloadSourceImageWithRetries recovers from a transient failure on a later attempt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  let callCount = 0;
  const failedAttempts = [];
  await withFakeFetch(
    async () => {
      callCount++;
      if (callCount < 2) return new Response("Service Unavailable", { status: 503 });
      return new Response(jpegBytes(), { status: 200 });
    },
    async () => {
      const result = await downloadSourceImageWithRetries("https://example.test/flaky.jpg", dir, {
        attempts: 2,
        onAttemptFailure: (attempt, err) => failedAttempts.push({ attempt, message: err.message }),
      });
      assert.equal(result.extension, "jpg");
      assert.equal(callCount, 2);
      assert.equal(failedAttempts.length, 1);
      assert.ok(failedAttempts[0].message.includes("HTTP 503"));
    }
  );
});

test("downloadSourceImageWithRetries still fails after exhausting its bounded attempts (never retries forever)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  let callCount = 0;
  await withFakeFetch(
    async () => {
      callCount++;
      return new Response("Not Found", { status: 404 });
    },
    async () => {
      await assert.rejects(() => downloadSourceImageWithRetries("https://example.test/dead.jpg", dir, { attempts: 2 }), /HTTP 404/);
      assert.equal(callCount, 2, "must call exactly `attempts` times, not fewer and not indefinitely");
    }
  );
});

test("cleanupSourceImage deletes the file, and is a safe no-op if it's already gone or was never downloaded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "source-image-"));
  await withFakeFetch(
    async () => new Response(jpegBytes(), { status: 200 }),
    async () => {
      const result = await downloadSourceImage("https://example.test/photo.jpg", dir);
      await cleanupSourceImage(result.path);
      await assert.rejects(() => stat(result.path), /ENOENT/);
      await cleanupSourceImage(result.path); // deleting again must not throw
      await cleanupSourceImage(undefined); // never having downloaded anything must not throw
    }
  );
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
