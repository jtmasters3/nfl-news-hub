// Bounded retry loop for a single generation attempt. Per the 2026-08-31
// Content Creation reliability investigation: a wrong-player/uniform-
// fidelity miss is often transient (model variance on a hard photo, e.g.
// an awkward camera angle) and worth retrying with the SAME verified
// local source image, but only up to a fixed budget — never indefinitely.
// A story with no usable subject in its source photo at all (e.g. a bare
// helmet stock photo) will legitimately exhaust every attempt and end up
// "failed" for manual review, which is the correct outcome, not a bug.
export const MAX_GENERATION_ATTEMPTS = 3;

/**
 * @param {(attempt: number) => Promise<T>} attemptFn - attempt is 1-based
 * @param {{ maxAttempts?: number, onAttemptFailure?: (attempt: number, err: Error) => void }} [opts]
 * @returns {Promise<T>}
 * @throws combining every attempt's error message once maxAttempts is exhausted
 */
export async function generateWithRetries(attemptFn, { maxAttempts = MAX_GENERATION_ATTEMPTS, onAttemptFailure } = {}) {
  const errors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptFn(attempt);
    } catch (err) {
      errors.push(err);
      onAttemptFailure?.(attempt, err);
      if (attempt === maxAttempts) {
        const summary = errors.map((e, i) => `attempt ${i + 1}: ${e.message}`).join(" | ");
        throw new Error(`Generation failed after ${maxAttempts} attempts. ${summary}`);
      }
    }
  }
}
