// Distinguishes "codex exec crashed" (already surfaced well — see
// codexRunner.js's attached stdout/stderr on a nonzero exit) from "codex
// exec exited 0 but never produced the promised output file" — which is
// Codex's OWN explicit signal that generation didn't meet requirements
// (e.g. its self-verification step catching a wrong-player render), not
// an unexpected crash. Before this, that case only ever surfaced as a
// generic downstream ENOENT from trying to read a file that was never
// written — discarding whatever Codex actually explained on stdout.
// Found on story 85696f0d-ef08-412b-afa1-9b1d7081d025, 2026-08-28: codex
// exited 0 and printed a clear explanation ("did not preserve the
// supplied NFL subject and instead produced an incorrect player"), but
// GitHub's committed last_error.message ended up as just the raw ENOENT.
import { stat } from "node:fs/promises";

const STDOUT_TAIL_LIMIT = 1500;

/**
 * @param {string} outputPath - the exact path Codex was told to write to
 * @param {string} stdout - codex exec's captured stdout (from a successful, exit-0 run)
 * @throws {Error} if outputPath doesn't exist, with Codex's own stdout explanation
 *   embedded in the message — never a bare ENOENT.
 */
export async function assertOutputProduced(outputPath, stdout) {
  try {
    await stat(outputPath);
    return;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const explanation = stdout?.trim() || "(codex exec produced no stdout explaining why)";
  throw new Error(
    `codex exec exited 0 but did not produce the expected output file. Codex reported: ${explanation.slice(-STDOUT_TAIL_LIMIT)}`
  );
}
