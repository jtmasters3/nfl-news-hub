// Invokes codex exec using the exact invocation pattern proven working in
// this environment on 2026-08-26 (see the fixture/prompt this workflow
// grew out of, under C:\Users\jacks\Documents\Codex\2026-08-26\...):
//
//   $codex = <newest codex.exe under CODEX_INSTALL_DIR>
//   Get-Content -Raw <prompt> | & $codex -a never -s workspace-write
//     -C <CODEX_WORKSPACE_DIR> --add-dir <social-output dir>
//     exec --skip-git-repo-check -
//
// Deliberately NOT re-guessed or made "more flexible" than that — every
// flag below is fixed to match the proven run. The only configurable
// pieces are the two paths (CODEX_INSTALL_DIR / CODEX_WORKSPACE_DIR),
// overridable for testing without touching this file, both defaulting to
// exactly what was proven.
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CODEX_INSTALL_DIR = "C:\\Users\\jacks\\AppData\\Local\\OpenAI\\Codex\\bin";
const DEFAULT_CODEX_WORKSPACE_DIR = "C:\\Users\\jacks\\Documents\\Codex\\2026-08-26\\use-this-story-s-headline-and";

export function codexInstallDir() {
  return process.env.CODEX_INSTALL_DIR || DEFAULT_CODEX_INSTALL_DIR;
}

export function codexWorkspaceDir() {
  return process.env.CODEX_WORKSPACE_DIR || DEFAULT_CODEX_WORKSPACE_DIR;
}

async function walkForFile(dir, fileName) {
  const matches = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await walkForFile(full, fileName)));
    } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      matches.push(full);
    }
  }
  return matches;
}

/**
 * Recursively finds every codex.exe under the install dir and returns the
 * most recently modified one — mirrors:
 *   Get-ChildItem ... -Filter codex.exe -File -Recurse |
 *     Sort-Object LastWriteTimeUtc -Descending | Select -First 1
 */
export async function findCodexExe(installDir = codexInstallDir()) {
  const candidates = await walkForFile(installDir, "codex.exe");
  if (candidates.length === 0) {
    throw new Error(`No codex.exe found under ${installDir}`);
  }
  const withTimes = await Promise.all(candidates.map(async (p) => ({ path: p, mtimeMs: (await stat(p)).mtimeMs })));
  withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withTimes[0].path;
}

/**
 * Pure arg-list builder — kept separate from spawn() so it's directly
 * unit-testable without invoking a real codex.exe.
 */
export function buildCodexArgs({ workspaceDir, addDir }) {
  return ["-a", "never", "-s", "workspace-write", "-C", workspaceDir, "--add-dir", addDir, "exec", "--skip-git-repo-check", "-"];
}

/**
 * @param {{ promptText: string, addDir: string, timeoutMs?: number, codexExePath?: string }} opts
 *   addDir must be the writable output directory (social-output) — the
 *   sandbox is workspace-write, scoped to the codex workspace dir plus
 *   exactly this one extra directory, matching the proven invocation.
 */
export async function runCodex({ promptText, addDir, timeoutMs = 20 * 60 * 1000, codexExePath }) {
  const bin = codexExePath || (await findCodexExe());
  const workspaceDir = codexWorkspaceDir();
  const args = buildCodexArgs({ workspaceDir, addDir });

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: workspaceDir, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdin.write(promptText);
    child.stdin.end();

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, exitCode: code });
      else reject(new Error(`codex exec exited with code ${code}. stderr tail: ${stderr.slice(-2000)}`));
    });
  });
}
