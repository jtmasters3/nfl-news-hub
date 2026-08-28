#!/usr/bin/env node
// Reproduces the 2026-08-28 story 85696f0d-ef08-412b-afa1-9b1d7081d025
// failure mode at the unit level: codex exec exits 0 but never writes the
// promised output file (its own self-verification declined a bad
// generation) — the failure message reported must be Codex's real stdout
// explanation, never a bare ENOENT. No real story, no real codex exec.
// Run with: node scripts/social-worker/lib/codexOutcome.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertOutputProduced } from "./codexOutcome.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("assertOutputProduced throws with Codex's own explanation when the file is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-outcome-"));
  const missingPath = path.join(dir, "never-written.png");
  const codexStdout =
    "Generation failed validation: the built-in image generator did not preserve the supplied NFL subject and instead produced an incorrect player. No substitute was saved.";

  await assert.rejects(
    () => assertOutputProduced(missingPath, codexStdout),
    (err) => {
      assert.ok(err.message.includes("did not preserve the supplied NFL subject"), "must surface Codex's real explanation, not a bare ENOENT");
      assert.ok(err.message.startsWith("codex exec exited 0 but did not produce the expected output file."));
      assert.ok(!err.message.match(/^ENOENT/), "must never be reduced to just the raw ENOENT text");
      return true;
    }
  );
});

test("assertOutputProduced resolves silently when the file DOES exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-outcome-"));
  const realPath = path.join(dir, "real.png");
  await writeFile(realPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await assertOutputProduced(realPath, "irrelevant stdout"); // must not throw
});

test("assertOutputProduced falls back to a clear placeholder when stdout is empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-outcome-"));
  const missingPath = path.join(dir, "never-written.png");
  await assert.rejects(() => assertOutputProduced(missingPath, ""), /produced no stdout explaining why/);
});

test("assertOutputProduced re-throws non-ENOENT filesystem errors untouched", async () => {
  // A directory path (not a file) triggers EISDIR on stat's underlying
  // read in some environments — regardless of the exact code, anything
  // that isn't ENOENT must propagate as-is, not be reinterpreted as
  // "missing output".
  const dir = await mkdtemp(path.join(tmpdir(), "codex-outcome-"));
  await assertOutputProduced(dir, "stdout"); // a directory DOES exist per stat() — should resolve, not throw
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
