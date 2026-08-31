#!/usr/bin/env node
// Local processor: claims exactly one queued story from the live artwork
// queue (or a specific story_id via --story-id), generates its graphic
// with the already-proven Codex workflow, uploads it through the
// Cloudflare Worker bridge, then — once artwork is durably at
// artwork_ready — generates and submits its caption through a fully
// independent claim (see lib/apiClient.js's claim/complete/failCaption).
// Never writes to production state directly — every decision is made by
// the backend, reached only through lib/apiClient.js.
//
// Two entry paths, both landing in the same two phases:
//   - No --story-id, or a --story-id currently in the live artwork queue:
//     runs the FULL pipeline (artwork phase, then caption phase) for one
//     freshly queued story.
//   - A --story-id NOT in the live artwork queue: assumed to already be
//     past Content Creation (artwork_ready, from an earlier run) — skips
//     the artwork phase entirely and attempts ONLY caption claiming/
//     generation for it. This is how a caption failure gets retried
//     later WITHOUT ever regenerating artwork — see lib/captionEvents.js.
//
// Usage:
//   node scripts/social-worker/process-one.js [--story-id=<id>]
//
// Required env: ARTWORK_WORKER_BASE_URL, AGGREGATE_ARTWORK_API_TOKEN.
// See scripts/social-worker/lib/codexRunner.js for CODEX_* env vars.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimStory, completeArtwork, failArtwork, claimCaption, completeCaption, failCaption, fetchArtworkQueue } from "./lib/apiClient.js";
import { runCodex } from "./lib/codexRunner.js";
import { readPngDimensions } from "./lib/pngDimensions.js";
import { selectTarget, missingFixtureFields } from "./lib/selectTarget.js";
import { assertOutputProduced } from "./lib/codexOutcome.js";
import { downloadSourceImageWithRetries, cleanupSourceImage } from "./lib/sourceImage.js";
import { generateWithRetries, MAX_GENERATION_ATTEMPTS } from "./lib/generateWithRetries.js";
import { waitForCaptionClaim, CAPTION_CLAIM_POLL_MAX_ATTEMPTS, CAPTION_CLAIM_POLL_INTERVAL_MS } from "./lib/waitForCaptionClaim.js";
import { shouldSkipArtwork } from "./lib/routeTarget.js";
import { validateCaption } from "../lib/captionValidation.js";
import { buildHashtags } from "./lib/captionFormatting.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCIAL_OUTPUT_DIR = path.join(ROOT, "social-output");
const TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "automation-prompt.template.md");
const CAPTION_TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "caption-prompt.template.md");
const DEFAULT_TEMPLATE_PACK_DIR =
  "C:\\Users\\jacks\\Documents\\Codex\\2026-08-26\\use-this-story-s-headline-and\\outputs\\aggregate-nfl-reference-pack";
const MAX_CAPTION_ATTEMPTS = 3;

function parseArgs(argv) {
  const args = { storyId: null };
  for (const arg of argv) {
    if (arg.startsWith("--story-id=")) args.storyId = arg.slice("--story-id=".length);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Phase 1: Content Creation (artwork)
// ---------------------------------------------------------------------------

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

/** @returns {Promise<boolean>} whether artwork completed successfully (caption phase should follow) */
async function processArtwork(target) {
  const storyId = target.story_id;

  const missing = missingFixtureFields(target);
  if (missing.length) {
    console.error(`Refusing to claim ${storyId}: missing required fixture field(s): ${missing.join(", ")}.`);
    return false;
  }

  console.log(`Claiming ${storyId}...`);
  const claimResult = await claimStory(storyId);

  if (!claimResult.claimed) {
    const detail = claimResult.reason ?? claimResult.error ?? `http_${claimResult.httpStatus ?? "?"}`;
    console.log(`Not claimed (${detail}).`);
    if (claimResult.message) console.log(`Detail: ${claimResult.message}`);
    return false;
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
    if (completeResult.dispatch_confirmed === false) {
      console.warn(`WARNING: artwork for ${storyId} is safely stored (R2 + claim), but GitHub was never notified after retries — needs manual reconciliation.`);
    }

    console.log("Artwork done:");
    console.log(
      JSON.stringify(
        {
          story_id: storyId,
          claim_id: claimId,
          image_url: completeResult.image_url,
          storage_key: completeResult.storage_key,
          width: completeResult.width,
          height: completeResult.height,
          dispatch_confirmed: completeResult.dispatch_confirmed,
        },
        null,
        2
      )
    );
    return true;
  } catch (err) {
    console.error(`Artwork processing failed: ${err.message}`);
    const stage = err.message.includes("Upload rejected") ? "upload" : "generation";
    try {
      await failArtwork(storyId, claimId, stage, err.message.slice(0, 2000));
    } catch (failErr) {
      console.error(`Also failed to report the artwork failure: ${failErr.message}`);
    }
    return false;
  } finally {
    // Publisher source photography is temporary working input only —
    // never rehosted, never left accumulating locally — deleted whether
    // this run succeeded or exhausted every retry.
    await cleanupSourceImage(sourceImagePath);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Caption — a fully independent claim (caption:{story_id} on the
// Durable Object), only ever legal once artwork_ready. Never touches
// artwork in any way — a caption failure here cannot regenerate or lose it.
// ---------------------------------------------------------------------------

async function buildCaptionPrompt({ workDir, captionFixture, feedback }) {
  const template = await readFile(CAPTION_TEMPLATE_PATH, "utf-8");
  const fixturePath = path.join(workDir, "caption-fixture.json");
  await writeFile(fixturePath, JSON.stringify(captionFixture, null, 2) + "\n", "utf-8");

  const outputPath = path.join(workDir, "caption.txt");
  const feedbackSection = feedback
    ? `\nYour previous attempt was rejected for: ${feedback}. Fix this and try again — do not repeat the same mistake.\n`
    : "";

  const promptText = template
    .replaceAll("{{fixture_path}}", fixturePath)
    .replaceAll("{{output_path}}", outputPath)
    .replaceAll("{{source_name}}", captionFixture.source_name || "the original source")
    .replace("{{feedback_section}}", feedbackSection);

  const promptFilePath = path.join(workDir, "caption-prompt.md");
  await writeFile(promptFilePath, promptText, "utf-8");

  return { promptText, outputPath };
}

async function processCaption(storyId) {
  console.log(`Claiming caption work for ${storyId}...`);
  // /social/artwork/complete's dispatch_confirmed:true only means GitHub
  // ACCEPTED the repository_dispatch webhook, not that the Action has
  // finished committing artwork_ready into data/social-state.json (2026-08-31
  // incident: story 34195a7b-69d8-4225-b58b-757febe23f4d's one-shot claim
  // hit "not_artwork_ready" ~1s after acceptance, ~20s before the commit
  // landed). Poll the same authoritative endpoint instead of assuming.
  const claimResult = await waitForCaptionClaim(claimCaption, storyId, {
    onWaiting: (attempt, attempts) =>
      console.log(`artwork_ready not yet committed — waiting ${CAPTION_CLAIM_POLL_INTERVAL_MS}ms before retrying caption claim (attempt ${attempt}/${attempts})...`),
  });

  if (!claimResult.claimed) {
    if (claimResult.reason === "not_artwork_ready_timeout") {
      const totalSeconds = (CAPTION_CLAIM_POLL_MAX_ATTEMPTS * CAPTION_CLAIM_POLL_INTERVAL_MS) / 1000;
      console.log(
        `Caption not claimed: artwork_ready was not committed within ~${totalSeconds}s. ` +
          `Artwork is preserved and untouched — rerun with --story-id=${storyId} later to retry captioning ` +
          `(it will use the caption-only recovery path and will NOT regenerate artwork).`
      );
      process.exitCode = 1;
      return;
    }
    const detail = claimResult.reason ?? claimResult.error ?? `http_${claimResult.httpStatus ?? "?"}`;
    console.log(`Caption not claimed (${detail}).`);
    if (claimResult.message) console.log(`Detail: ${claimResult.message}`);
    process.exitCode = 1;
    return;
  }

  const claimId = claimResult.claim_id;
  console.log(`Caption claimed. claim_id=${claimId}`);

  const sourceStory = claimResult.source_story || {};
  const captionFixture = {
    story_id: storyId,
    post_headline: sourceStory.post_headline,
    source_name: sourceStory.source_name,
    source_url: sourceStory.source_url,
    category: sourceStory.category,
    teams: sourceStory.teams || [],
    players: sourceStory.players || [],
    description: sourceStory.description,
    is_rumor: sourceStory.is_rumor || false,
  };

  const workDir = path.join(SOCIAL_OUTPUT_DIR, "work", storyId);
  await mkdir(workDir, { recursive: true });

  let feedback = null;
  let lastCandidateText = null;
  let finalCaptionText = null;

  try {
    await generateWithRetries(
      async (attempt) => {
        console.log(`Running codex exec for caption (attempt ${attempt}/${MAX_CAPTION_ATTEMPTS})...`);
        const { promptText, outputPath } = await buildCaptionPrompt({ workDir, captionFixture, feedback });
        await rm(outputPath, { force: true });

        let codexResult;
        try {
          codexResult = await runCodex({ promptText, addDir: SOCIAL_OUTPUT_DIR });
        } catch (codexErr) {
          await writeFile(path.join(workDir, `caption.attempt${attempt}.stdout.log`), codexErr.codexStdout ?? "", "utf-8");
          await writeFile(path.join(workDir, `caption.attempt${attempt}.stderr.log`), codexErr.codexStderr ?? "", "utf-8");
          console.error(`codex exec (caption) failed (exit code ${codexErr.codexExitCode ?? "n/a"}) — see ${workDir}\\caption.attempt${attempt}.std{out,err}.log`);
          throw codexErr;
        }
        await writeFile(path.join(workDir, `caption.attempt${attempt}.stdout.log`), codexResult.stdout, "utf-8");
        await writeFile(path.join(workDir, `caption.attempt${attempt}.stderr.log`), codexResult.stderr, "utf-8");

        await assertOutputProduced(outputPath, codexResult.stdout);
        const text = (await readFile(outputPath, "utf-8")).trim();
        lastCandidateText = text;

        // Local validation (bounded retry loop, feedback-driven) — the
        // SAME shared validateCaption() the server-side gate uses (see
        // scripts/lib/captionValidation.js), imported directly since this
        // processor lives in the same repo. Passing here is a strong
        // signal, not a guarantee — the server-side pass in
        // scripts/lib/captionEvents.js is still the authoritative one.
        const { passed, issues } = validateCaption(text, captionFixture);
        if (!passed) {
          feedback = issues.join("; ");
          throw new Error(`Local caption validation rejected: ${feedback}`);
        }
        console.log(`Caption generated and locally validated on attempt ${attempt}.`);
        finalCaptionText = text;
      },
      { onAttemptFailure: (attempt, err) => console.error(`Caption attempt ${attempt} failed: ${err.message}`), maxAttempts: MAX_CAPTION_ATTEMPTS }
    );

    console.log("Submitting caption...");
    const completeResult = await completeCaption(storyId, claimId, {
      text: finalCaptionText,
      hashtags: buildHashtags(captionFixture.teams),
      attributionLine: `Source: ${captionFixture.source_name}`,
      sourceUrl: captionFixture.source_url,
    });
    if (!completeResult.completed) {
      throw new Error(`Caption submission rejected: ${completeResult.reason ?? "unknown"}`);
    }
    if (completeResult.dispatch_confirmed === false) {
      console.warn(`WARNING: caption for ${storyId} is safely stored (claim completed), but GitHub was never notified after retries — needs manual reconciliation.`);
    }

    console.log("Caption done:");
    console.log(JSON.stringify({ story_id: storyId, claim_id: claimId, dispatch_confirmed: completeResult.dispatch_confirmed }, null, 2));
  } catch (err) {
    console.error(`Caption processing failed: ${err.message}`);
    try {
      await failCaption(storyId, claimId, err.message.slice(0, 2000), lastCandidateText);
    } catch (failErr) {
      console.error(`Also failed to report the caption failure: ${failErr.message}`);
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const { storyId: requestedStoryId } = parseArgs(process.argv.slice(2));

  // Always fetch the queue, even for an explicit --story-id — the
  // 2026-08-28 f4328222-... incident happened because a bare story_id was
  // once used without ever looking it up. See lib/selectTarget.js.
  const queue = await fetchArtworkQueue();
  const target = selectTarget(queue, requestedStoryId);

  if (!target) {
    console.log("No queued stories to process.");
    return;
  }

  if (shouldSkipArtwork(queue, target.story_id)) {
    // Only reachable when --story-id was explicitly given (selectTarget's
    // no-argument path only ever returns a real queue entry or null) —
    // not in the live artwork queue, so assume Content Creation already
    // succeeded for this story in an earlier run and this is a caption
    // retry/recovery. Artwork is never regenerated on this path.
    console.log(`${target.story_id} is not in the live artwork queue — attempting caption-only processing (artwork already complete?).`);
    await processCaption(target.story_id);
    return;
  }

  const artworkSucceeded = await processArtwork(target);
  if (!artworkSucceeded) {
    process.exitCode = process.exitCode || (requestedStoryId ? 1 : 0);
    return;
  }

  await processCaption(target.story_id);
}

main().catch((err) => {
  console.error("process-one failed:", err);
  process.exitCode = 1;
});
