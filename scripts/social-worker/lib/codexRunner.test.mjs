#!/usr/bin/env node
// Tests the Codex runner's CONFIGURATION against the proven PowerShell
// invocation — never spawns a real codex.exe, never generates an image,
// never touches the artwork queue or any production story. Run with:
// node scripts/social-worker/lib/codexRunner.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodexArgs, findCodexExe, codexWorkspaceDir, codexInstallDir } from "./codexRunner.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("buildCodexArgs matches the proven invocation exactly", () => {
  const args = buildCodexArgs({
    workspaceDir: "C:\\Users\\jacks\\Documents\\Codex\\2026-08-26\\use-this-story-s-headline-and",
    addDir: "C:\\Users\\jacks\\Desktop\\Claude\\nfl-news-hub\\social-output",
  });
  assert.deepEqual(args, [
    "-a",
    "never",
    "-s",
    "workspace-write",
    "-C",
    "C:\\Users\\jacks\\Documents\\Codex\\2026-08-26\\use-this-story-s-headline-and",
    "--add-dir",
    "C:\\Users\\jacks\\Desktop\\Claude\\nfl-news-hub\\social-output",
    "exec",
    "--skip-git-repo-check",
    "-",
  ]);
});

test("codexWorkspaceDir/codexInstallDir default to the proven paths and respect env overrides", () => {
  assert.equal(codexWorkspaceDir(), "C:\\Users\\jacks\\Documents\\Codex\\2026-08-26\\use-this-story-s-headline-and");
  assert.equal(codexInstallDir(), "C:\\Users\\jacks\\AppData\\Local\\OpenAI\\Codex\\bin");

  process.env.CODEX_WORKSPACE_DIR = "C:\\override\\workspace";
  process.env.CODEX_INSTALL_DIR = "C:\\override\\install";
  assert.equal(codexWorkspaceDir(), "C:\\override\\workspace");
  assert.equal(codexInstallDir(), "C:\\override\\install");
  delete process.env.CODEX_WORKSPACE_DIR;
  delete process.env.CODEX_INSTALL_DIR;
});

test("findCodexExe recursively locates the NEWEST codex.exe among several fakes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-install-"));
  const older = path.join(root, "v1", "bin");
  const newer = path.join(root, "v2", "nested", "bin");
  await mkdir(older, { recursive: true });
  await mkdir(newer, { recursive: true });

  const olderExe = path.join(older, "codex.exe");
  const newerExe = path.join(newer, "codex.exe");
  await writeFile(olderExe, "fake-old");
  await writeFile(newerExe, "fake-new");

  const oldTime = new Date(Date.now() - 60_000);
  const newTime = new Date();
  await utimes(olderExe, oldTime, oldTime);
  await utimes(newerExe, newTime, newTime);

  const found = await findCodexExe(root);
  assert.equal(found, newerExe);
});

test("findCodexExe ignores non-codex.exe files and ONLY matches the exact filename", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-install-"));
  await writeFile(path.join(root, "codex-helper.exe"), "not it");
  await writeFile(path.join(root, "notes.txt"), "not it either");
  await assert.rejects(() => findCodexExe(root), /No codex\.exe found/);
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
