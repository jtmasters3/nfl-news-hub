// Invokes the already-proven noninteractive `codex exec` workflow. The
// exact CLI invocation that was proven working in this environment wasn't
// captured verbatim, so this is deliberately configurable rather than
// guessed at with false confidence — set CODEX_EXEC_MODE to match whatever
// was actually proven:
//   "arg"   (default) — codex exec <extra args...> "<full prompt text>"
//   "stdin"            — codex exec <extra args...>, prompt piped via stdin
//   "file"             — codex exec <extra args...> <promptFilePath>
// CODEX_BIN (default "codex") and CODEX_EXTRA_ARGS (space-separated, e.g.
// "--full-auto") are also both overridable without touching this file.
import { spawn } from "node:child_process";

export async function runCodex({ promptText, promptFilePath, cwd, timeoutMs = 20 * 60 * 1000 }) {
  const bin = process.env.CODEX_BIN || "codex";
  const extraArgs = process.env.CODEX_EXTRA_ARGS ? process.env.CODEX_EXTRA_ARGS.split(" ").filter(Boolean) : [];
  const mode = process.env.CODEX_EXEC_MODE || "arg";

  const args = ["exec", ...extraArgs];
  if (mode === "arg") args.push(promptText);
  else if (mode === "file") args.push(promptFilePath);
  else if (mode !== "stdin") throw new Error(`Unknown CODEX_EXEC_MODE: ${mode}`);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (mode === "stdin") {
      child.stdin.write(promptText);
      child.stdin.end();
    }

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
