#!/usr/bin/env node
// Runs as the LAST step of .github/workflows/social-artwork-event.yml,
// after "Commit and push" — the 2026-09-14 durability fix #3 companion to
// apply-artwork-event.js's own retry-budget increase (see that file's own
// header for the full incident this closes: story_id
// 0cba51db-8c38-436f-ae48-a4af46e9f6bd, claim_id
// bffb0dee-f833-4f7f-a7d2-3419eadedf18).
//
// apply-artwork-event.js's own success ("Applied caption-completed for
// <id> -> awaiting_approval") only proves this job's LOCAL write and the
// bash "Commit and push" step's own `git push` exit code succeeded — it
// does not, by itself, prove GitHub's REST API (the same authoritative
// surface every other reader in this system trusts, per
// githubStateReader.js's own header) actually reflects that content yet.
// This script closes that last gap: read DURABLE_EXPECTATION_PATH (written
// by apply-artwork-event.js only for a caption-completed event whose
// server-side validation passed — see that file's computeDurableExpectation()
// for exactly which events get this extra check and why it's scoped that
// narrowly), and if present, poll a genuinely fresh, SHA-pinned GitHub read
// until the expected field is actually there. If it never appears, this
// step — and therefore the whole job — fails RED, exactly as Section 4 of
// the 2026-09-14 investigation requires: "dispatch accepted" must never be
// reported as "durably committed" without this proof.
//
// No expectation file present (every other event type, or a caption
// rejected by server-side validation) is a normal, immediate no-op.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getLatestCommitSha, fetchStateAtCommit } from "../social-worker/lib/githubStateReader.js";
import { normalizeStateShape } from "../lib/socialState.js";
import { DURABLE_EXPECTATION_PATH } from "../lib/store.js";

export const VERIFY_PUSH_ATTEMPTS = 5;
export const VERIFY_PUSH_INTERVAL_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAtPath(obj, pathSegments) {
  return pathSegments.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Pure check: does this freshly-read state actually contain the expected
 * value at the expected path for the expected story_id? Extracted so the
 * comparison itself (not the network polling around it) is unit-testable
 * with no GitHub API call at all.
 * @param {object} state - a normalized data/social-state.json shape
 * @param {{story_id: string, path: string[], expected: unknown}} expectation
 * @returns {boolean}
 */
export function checkDurableExpectation(state, expectation) {
  const record = state?.stories?.[expectation.story_id];
  if (!record) return false;
  return getAtPath(record, expectation.path) === expectation.expected;
}

async function fetchFreshState() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN;
  const sha = await getLatestCommitSha({ token });
  const data = await fetchStateAtCommit({ commitSha: sha, token });
  return normalizeStateShape(data);
}

async function main() {
  if (!existsSync(DURABLE_EXPECTATION_PATH)) {
    console.log("No durable-push expectation recorded for this event — nothing to verify.");
    return;
  }

  const expectation = JSON.parse(await readFile(DURABLE_EXPECTATION_PATH, "utf-8"));
  console.log(`Verifying durable push for story_id=${expectation.story_id}: expecting ${expectation.path.join(".")} === ${JSON.stringify(expectation.expected)}`);

  for (let attempt = 1; attempt <= VERIFY_PUSH_ATTEMPTS; attempt++) {
    let state;
    try {
      state = await fetchFreshState();
    } catch (err) {
      console.error(`Fresh state fetch failed during durable-push verification (attempt ${attempt}/${VERIFY_PUSH_ATTEMPTS}): ${err.message}`);
      if (attempt < VERIFY_PUSH_ATTEMPTS) await sleep(VERIFY_PUSH_INTERVAL_MS);
      continue;
    }

    if (checkDurableExpectation(state, expectation)) {
      console.log(`Durable-push verification passed for story_id=${expectation.story_id} on attempt ${attempt}/${VERIFY_PUSH_ATTEMPTS}.`);
      return;
    }

    console.log(`Durable-push verification did not see the expected value yet (attempt ${attempt}/${VERIFY_PUSH_ATTEMPTS}) — retrying...`);
    if (attempt < VERIFY_PUSH_ATTEMPTS) await sleep(VERIFY_PUSH_INTERVAL_MS);
  }

  console.error(
    `Durable-push verification FAILED for story_id=${expectation.story_id}: expected ${expectation.path.join(".")} === ${JSON.stringify(expectation.expected)} was never observed via a fresh GitHub read, despite this job's own commit/push step reporting success. Failing the workflow rather than reporting a false success.`
  );
  process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("verify-durable-push.js")) {
  main().catch((err) => {
    console.error("verify-durable-push failed:", err);
    process.exitCode = 1;
  });
}
