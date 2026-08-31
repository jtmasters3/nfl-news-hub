#!/usr/bin/env node
// Local processor: claims exactly one queued story from the live artwork
// queue (or a specific story_id via --story-id, for the controlled STEP 15
// test), generates its graphic with the already-proven Codex workflow, and
// uploads it through the Cloudflare Worker bridge. Never writes to
// production state directly — every decision (is this claimable? did the
// upload succeed?) is made by the backend, reached only through
// lib/apiClient.js. Exits nonzero only on a TRUE processing failure (a
// claim rejection because nothing is queued, or the requested story isn't
// claimable, is normal and exits 0).
//
// Usage:
//   node scripts/social-worker/process-one.js [--story-id=<id>]
//
// Required env: ARTWORK_WORKER_BASE_URL, AGGREGATE_ARTWORK_API_TOKEN.
// See scripts/social-worker/lib/codexRunner.js for CODEX_* env vars.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimStory, completeArtwork, failArtwork, fetchArtworkQueue } from "./lib/apiClient.js";
import { runCodex } from "./lib/codexRunner.js";
import { readPngDimensions } from "./lib/pngDimensions.js";
import { selectTarget, missingFixtureFields } from "./lib/selectTarget.js";
import { assertOutputProduced } from "./lib/codexOutcome.js";
import { downloadSourceImageWithRetries, cleanupSourceImage } from "./lib/sourceImage.js";
import { generateWithRetries, MAX_GENERATION_ATTEMPTS } from "./lib/generateWithRetries.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCIAL_OUTPUT_DIR = path.join(ROOT, "social-output");
const TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "automation-prompt.template.md");
const DEFAULT_TEMPLATE_PACK_DIR =
  "C:\\Users\\jacks\\Documents\\Codex\\2026-08-26\\use-this-story-s-headline-and\\outputs\\aggregate-nfl-reference-pack";

function parseArgs(argv) {
  const args = { storyId: null };
  for (const arg of argv) {
    if (arg.startsWith("--story-id=")) args.storyId = arg.slice("--story-id=".length);
  }
  return args;
}

async function pickTarget(storyId) {
  // Always fetch the queue, even for an explicit --story-id — the 2026-08-28
  // f4328222-... incident happened because this used to skip the fetch
  // entirely and return a bare {story_id}, silently discarding the real
  // post_headline/base_image_url. See lib/selectTarget.js.
  const queue = await fetchArtworkQueue();
  return selectTarget(queue, storyId);
}

async function buildPrompt({ storyId, workDir, fixture, sourceImagePath }) {
  const template = await readFile(TEMPLATE_PATH, "utf-8");
  const fixturePath = path.join(workDir, "fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  const outputPath = path.join(SOCIAL_OUTPUT_DIR, `${storyId}.png`);
  const templatePackDir = process.env.AGGREGATE_TEMPLATE_PACK_DIR || DEFAULT_TEMPLATE_PACK_DIR;

  const promptText = template
    .replaceAll("{{fixture_path}}", fixturePath)
    .replaceAll("{{template_pack_dir}}", templatePackDir)
    .replaceAll("{{output_path}}", outputPath)
    .replaceAll("{{base_image_path}}", sourceImagePath)
    .replaceAll("{{source_name}}", fixture.source_name || "the original source");

  // Written for logs/debugging only — codex exec itself receives promptText
  // via stdin, matching the proven invocation exactly (see codexRunner.js).
  const promptFilePath = path.join(workDir, "prompt.md");
  await writeFile(promptFilePath, promptText, "utf-8");

  return { promptText, outputPath };
}

async function main() {
  const { storyId: requestedStoryId } = parseArgs(process.argv.slice(2));

  const target = await pickTarget(requestedStoryId);
  if (!target) {
    console.log("No queued stories to process.");
    return;
  }

  const storyId = target.story_id;

  // Fail fast, before ever claiming — a claim burns a real lease and a
  // generation attempt, so an incomplete target (e.g. an explicit
  // --story-id not found in the live queue, such as a lease-recovery case
  // this processor doesn't yet fetch source data for) must be caught here,
  // not discovered only after Codex has already run.
  const missing = missingFixtureFields(target);
  if (missing.length) {
    console.error(`Refusing to claim ${storyId}: missing required fixture field(s): ${missing.join(", ")}.`);
    console.error("This usually means the story wasn't found in the live artwork queue (e.g. a lease-recovery case) — this processor doesn't yet have a way to fetch its source data outside the queue.");
    process.exitCode = 1;
    return;
  }

  console.log(`Claiming ${storyId}...`);
  const claimResult = await claimStory(storyId);

  if (!claimResult.claimed) {
    // claimResult.reason is set for a normal rejection (e.g. "already_claimed").
    // Anything else (a 5xx, a network-level failure) means the Worker threw
    // before it could return a proper claim response — surface whatever it
    // did send (claimResult.error/message) instead of hiding it behind
    // "unknown", so a real bug is visible immediately rather than silently.
    const detail = claimResult.reason ?? claimResult.error ?? `http_${claimResult.httpStatus ?? "?"}`;
    console.log(`Not claimed (${detail}).`);
    if (claimResult.message) console.log(`Detail: ${claimResult.message}`);
    if (requestedStoryId) process.exitCode = 1; // an explicitly requested story really should have been claimable
    return;
  }

  const claimId = claimResult.claim_id;
  console.log(`Claimed. claim_id=${claimId}`);

  const workDir = path.join(SOCIAL_OUTPUT_DIR, "work", storyId);
  await mkdir(workDir, { recursive: true });
  await mkdir(SOCIAL_OUTPUT_DIR, { recursive: true });

  const fixture = {
    story_id: storyId,
    post_headline: target.post_headline,
    base_image_url: target.base_image_url,
    source_name: target.source_name,
    source_url: target.source_url,
  };

  let sourceImagePath;
  try {
    // Download the base photograph ourselves BEFORE ever invoking Codex —
    // see lib/sourceImage.js for why: two consecutive "could not access
    // the supplied base photograph" failures (2026-08-28/31) both turned
    // out to be fully reachable URLs when fetched from a normal,
    // unsandboxed process. Codex now reads a local file, never a URL.
    console.log("Downloading source image locally...");
    const sourceImage = await downloadSourceImageWithRetries(target.base_image_url, workDir, {
      onAttemptFailure: (attempt, err) => console.error(`Source image download attempt ${attempt} failed: ${err.message}`),
    });
    sourceImagePath = sourceImage.path;
    console.log(`Source image saved locally: ${sourceImagePath} (${sourceImage.sizeBytes} bytes)`);

    const { promptText, outputPath } = await buildPrompt({ storyId, workDir, fixture, sourceImagePath });

    await generateWithRetries(
      async (attempt) => {
        console.log(`Running codex exec (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS})...`);
        // A stale file from a prior attempt in this same run must never be
        // mistaken for this attempt's output.
        await rm(outputPath, { force: true });

        let codexResult;
        try {
          codexResult = await runCodex({ promptText, addDir: SOCIAL_OUTPUT_DIR });
        } catch (codexErr) {
          // Persist whatever output Codex produced even on a crash/timeout —
          // codexRunner.js attaches the full stdout/stderr to the error for
          // exactly this, not just the truncated tail in the message.
          await writeFile(path.join(workDir, `codex.attempt${attempt}.stdout.log`), codexErr.codexStdout ?? "", "utf-8");
          await writeFile(path.join(workDir, `codex.attempt${attempt}.stderr.log`), codexErr.codexStderr ?? "", "utf-8");
          console.error(`codex exec failed (exit code ${codexErr.codexExitCode ?? "n/a"}) — see ${workDir}\\codex.attempt${attempt}.std{out,err}.log`);
          throw codexErr;
        }
        await writeFile(path.join(workDir, `codex.attempt${attempt}.stdout.log`), codexResult.stdout, "utf-8");
        await writeFile(path.join(workDir, `codex.attempt${attempt}.stderr.log`), codexResult.stderr, "utf-8");
        console.log(`codex exec exited 0 (attempt ${attempt}). stdout/stderr written to ${workDir}`);

        // A clean exit 0 does NOT mean generation succeeded — Codex's own
        // self-verification can (correctly) decline to save a bad result
        // and exit 0 anyway, explaining why on stdout. This surfaces THAT
        // explanation as the actual failure reason instead of letting the
        // downstream "file doesn't exist" become a bare, uninformative ENOENT.
        await assertOutputProduced(outputPath, codexResult.stdout);

        const attemptDims = await readPngDimensions(outputPath);
        if (!attemptDims || attemptDims.sizeBytes === 0) {
          throw new Error(`Output PNG missing or empty at ${outputPath}`);
        }
        console.log(`Generated on attempt ${attempt}: ${outputPath} (${attemptDims.width}x${attemptDims.height}, ${attemptDims.sizeBytes} bytes)`);
      },
      { onAttemptFailure: (attempt, err) => console.error(`Attempt ${attempt} failed: ${err.message}`) }
    );

    console.log("Uploading...");
    const completeResult = await completeArtwork(storyId, claimId, outputPath);
    if (!completeResult.uploaded) {
      throw new Error(`Upload rejected: ${completeResult.reason ?? "unknown"}`);
    }

    console.log("Done:");
    console.log(
      JSON.stringify(
        {
          story_id: storyId,
          claim_id: claimId,
          image_url: completeResult.image_url,
          storage_key: completeResult.storage_key,
          width: completeResult.width,
          height: completeResult.height,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(`Processing failed: ${err.message}`);
    const stage = err.message.includes("Upload rejected") ? "upload" : "generation";
    try {
      await failArtwork(storyId, claimId, stage, err.message.slice(0, 2000));
    } catch (failErr) {
      console.error(`Also failed to report the failure: ${failErr.message}`);
    }
    process.exitCode = 1;
  } finally {
    // Publisher source photography is temporary working input only —
    // never rehosted, never left accumulating locally — deleted whether
    // this run succeeded or exhausted every retry.
    await cleanupSourceImage(sourceImagePath);
  }
}

main().catch((err) => {
  console.error("process-one failed:", err);
  process.exitCode = 1;
});
