#!/usr/bin/env node
// Local processor: claims exactly one queued story from the live artwork
// queue (or a specific story_id via --story-id), generates its Feed
// graphic AND (for content_package_version 2 stories) its Story graphic
// with the already-proven Codex workflow, uploads each through the
// Cloudflare Worker bridge, then — once BOTH required assets are durably
// valid — generates and submits its caption through a fully independent
// claim (see lib/apiClient.js's claim/complete/failCaption).
// Never writes to production state directly — every decision is made by
// the backend, reached only through lib/apiClient.js.
//
// Three entry paths, landing in the same eventual phases:
//   - No --story-id, or a --story-id currently in the live artwork queue:
//     runs the FULL pipeline (Feed, then Story if v2, then caption) for
//     one freshly queued story.
//   - A --story-id NOT in the live artwork queue, Feed already succeeded
//     but Story hasn't (v2 record only): Story-only recovery — never
//     touches Feed (its own claim is already completed and un-reclaimable
//     regardless), retries only Story, then proceeds to caption.
//   - A --story-id NOT in the live artwork queue, both required assets
//     already valid (or a legacy v1 record, where Story was never
//     required): caption-only recovery — unchanged from before.
//
// Usage:
//   node scripts/social-worker/process-one.js [--story-id=<id>]
//
// Required env: ARTWORK_WORKER_BASE_URL, AGGREGATE_ARTWORK_API_TOKEN.
// See scripts/social-worker/lib/codexRunner.js for CODEX_* env vars.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimStory,
  completeArtwork,
  failArtwork,
  claimStoryArtwork,
  completeStoryArtwork,
  failStoryArtwork,
  claimCaption,
  completeCaption,
  failCaption,
  fetchArtworkQueue,
  fetchSocialState,
} from "./lib/apiClient.js";
import { runCodex } from "./lib/codexRunner.js";
import { readPngDimensions } from "./lib/pngDimensions.js";
import { selectTarget, missingFixtureFields } from "./lib/selectTarget.js";
import { assertOutputProduced } from "./lib/codexOutcome.js";
import { downloadSourceImageWithRetries, cleanupSourceImage } from "./lib/sourceImage.js";
import { generateWithRetries, MAX_GENERATION_ATTEMPTS } from "./lib/generateWithRetries.js";
import { waitForCaptionClaim, CAPTION_CLAIM_POLL_MAX_ATTEMPTS, CAPTION_CLAIM_POLL_INTERVAL_MS } from "./lib/waitForCaptionClaim.js";
import { waitForStoryArtworkClaim, STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS, STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS } from "./lib/waitForStoryArtworkClaim.js";
import { shouldSkipArtwork } from "./lib/routeTarget.js";
import { determineRecoveryAction } from "./lib/routeRecovery.js";
import { validateCaption } from "../lib/captionValidation.js";
import { buildHashtags } from "./lib/captionFormatting.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOCIAL_OUTPUT_DIR = path.join(ROOT, "social-output");
const FEED_TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "automation-prompt.template.md");
const STORY_TEMPLATE_PATH = path.join(ROOT, "scripts", "social-worker", "templates", "story-prompt.template.md");
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
// Phase 1a: Content Creation — Feed (4:5)
// ---------------------------------------------------------------------------

async function buildFeedPrompt({ storyId, workDir, fixture, sourceImagePath }) {
  const template = await readFile(FEED_TEMPLATE_PATH, "utf-8");
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

  const promptFilePath = path.join(workDir, "prompt.md");
  await writeFile(promptFilePath, promptText, "utf-8");

  return { promptText, outputPath };
}

/** @returns {Promise<boolean>} whether Feed completed successfully */
async function processFeedArtwork({ storyId, workDir, fixture, sourceImagePath }) {
  console.log(`Claiming ${storyId} (Feed)...`);
  const claimResult = await claimStory(storyId);

  if (!claimResult.claimed) {
    const detail = claimResult.reason ?? claimResult.error ?? `http_${claimResult.httpStatus ?? "?"}`;
    console.log(`Feed not claimed (${detail}).`);
    if (claimResult.message) console.log(`Detail: ${claimResult.message}`);
    return false;
  }

  const claimId = claimResult.claim_id;
  console.log(`Feed claimed. claim_id=${claimId}`);

  try {
    const { promptText, outputPath } = await buildFeedPrompt({ storyId, workDir, fixture, sourceImagePath });

    await generateWithRetries(
      async (attempt) => {
        console.log(`Running codex exec for Feed (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS})...`);
        await rm(outputPath, { force: true });

        let codexResult;
        try {
          codexResult = await runCodex({ promptText, addDir: SOCIAL_OUTPUT_DIR });
        } catch (codexErr) {
          await writeFile(path.join(workDir, `codex.feed.attempt${attempt}.stdout.log`), codexErr.codexStdout ?? "", "utf-8");
          await writeFile(path.join(workDir, `codex.feed.attempt${attempt}.stderr.log`), codexErr.codexStderr ?? "", "utf-8");
          console.error(`codex exec (Feed) failed (exit code ${codexErr.codexExitCode ?? "n/a"}) — see ${workDir}\\codex.feed.attempt${attempt}.std{out,err}.log`);
          throw codexErr;
        }
        await writeFile(path.join(workDir, `codex.feed.attempt${attempt}.stdout.log`), codexResult.stdout, "utf-8");
        await writeFile(path.join(workDir, `codex.feed.attempt${attempt}.stderr.log`), codexResult.stderr, "utf-8");
        console.log(`codex exec (Feed) exited 0 (attempt ${attempt}). stdout/stderr written to ${workDir}`);

        await assertOutputProduced(outputPath, codexResult.stdout);

        const attemptDims = await readPngDimensions(outputPath);
        if (!attemptDims || attemptDims.sizeBytes === 0) {
          throw new Error(`Output PNG missing or empty at ${outputPath}`);
        }
        console.log(`Feed generated on attempt ${attempt}: ${outputPath} (${attemptDims.width}x${attemptDims.height}, ${attemptDims.sizeBytes} bytes)`);
      },
      { onAttemptFailure: (attempt, err) => console.error(`Feed attempt ${attempt} failed: ${err.message}`) }
    );

    console.log("Uploading Feed...");
    const completeResult = await completeArtwork(storyId, claimId, outputPath);
    if (!completeResult.uploaded) {
      throw new Error(`Upload rejected: ${completeResult.reason ?? "unknown"}`);
    }
    if (completeResult.dispatch_confirmed === false) {
      console.warn(`WARNING: Feed artwork for ${storyId} is safely stored (R2 + claim), but GitHub was never notified after retries — needs manual reconciliation.`);
    }

    console.log("Feed done:");
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
    console.error(`Feed processing failed: ${err.message}`);
    const stage = err.message.includes("Upload rejected") ? "upload" : "generation";
    try {
      await failArtwork(storyId, claimId, stage, err.message.slice(0, 2000));
    } catch (failErr) {
      console.error(`Also failed to report the Feed failure: ${failErr.message}`);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 1b: Content Creation — Story (9:16). A fully independent claim
// (story-artwork:{story_id}), never touching Feed's own claim/upload.
// ---------------------------------------------------------------------------

async function buildStoryPrompt({ storyId, workDir, fixture, sourceImagePath }) {
  const template = await readFile(STORY_TEMPLATE_PATH, "utf-8");
  const fixturePath = path.join(workDir, "story-fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  const outputPath = path.join(SOCIAL_OUTPUT_DIR, "story", `${storyId}.png`);
  const templatePackDir = process.env.AGGREGATE_TEMPLATE_PACK_DIR || DEFAULT_TEMPLATE_PACK_DIR;

  const promptText = template
    .replaceAll("{{fixture_path}}", fixturePath)
    .replaceAll("{{template_pack_dir}}", templatePackDir)
    .replaceAll("{{output_path}}", outputPath)
    .replaceAll("{{base_image_path}}", sourceImagePath)
    .replaceAll("{{source_name}}", fixture.source_name || "the original source");

  const promptFilePath = path.join(workDir, "story-prompt.md");
  await writeFile(promptFilePath, promptText, "utf-8");

  return { promptText, outputPath };
}

/** @returns {Promise<boolean>} whether Story completed successfully. Never touches Feed. */
async function processStoryArtwork({ storyId, workDir, fixture, sourceImagePath }) {
  console.log(`Claiming ${storyId} (Story)...`);
  // Feed's own /complete returning dispatch_confirmed:true only means
  // GitHub ACCEPTED the repository_dispatch webhook, not that the Action
  // has finished committing artwork_ready into data/social-state.json —
  // the exact same gap already fixed for captions (2026-08-31 incident),
  // now recurring here (2026-09-03 incident, story
  // 6a443992-55a9-4ac5-b57d-ba2993a740e3) because this claim path was
  // built without the same bounded-polling protection. Poll the same
  // authoritative endpoint instead of assuming — never touches Feed.
  const claimResult = await waitForStoryArtworkClaim(claimStoryArtwork, storyId, {
    onWaiting: (attempt, attempts) =>
      console.log(`artwork_ready not yet committed — waiting ${STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS}ms before retrying Story claim (attempt ${attempt}/${attempts})...`),
  });

  if (!claimResult.claimed) {
    if (claimResult.reason === "not_artwork_ready_timeout") {
      const totalSeconds = (STORY_ARTWORK_CLAIM_POLL_MAX_ATTEMPTS * STORY_ARTWORK_CLAIM_POLL_INTERVAL_MS) / 1000;
      console.log(
        `Story not claimed: artwork_ready was not committed within ~${totalSeconds}s. ` +
          `Feed is preserved and untouched — rerun with --story-id=${storyId} later to retry Story ` +
          `(it will use the Story-only recovery path and will NOT regenerate Feed).`
      );
      return false;
    }
    const detail = claimResult.reason ?? claimResult.error ?? `http_${claimResult.httpStatus ?? "?"}`;
    console.log(`Story not claimed (${detail}).`);
    if (claimResult.message) console.log(`Detail: ${claimResult.message}`);
    return false;
  }

  const claimId = claimResult.claim_id;
  console.log(`Story claimed. claim_id=${claimId}`);

  await mkdir(path.join(SOCIAL_OUTPUT_DIR, "story"), { recursive: true });

  try {
    const { promptText, outputPath } = await buildStoryPrompt({ storyId, workDir, fixture, sourceImagePath });

    await generateWithRetries(
      async (attempt) => {
        console.log(`Running codex exec for Story (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS})...`);
        await rm(outputPath, { force: true });

        let codexResult;
        try {
          codexResult = await runCodex({ promptText, addDir: SOCIAL_OUTPUT_DIR });
        } catch (codexErr) {
          await writeFile(path.join(workDir, `codex.story.attempt${attempt}.stdout.log`), codexErr.codexStdout ?? "", "utf-8");
          await writeFile(path.join(workDir, `codex.story.attempt${attempt}.stderr.log`), codexErr.codexStderr ?? "", "utf-8");
          console.error(`codex exec (Story) failed (exit code ${codexErr.codexExitCode ?? "n/a"}) — see ${workDir}\\codex.story.attempt${attempt}.std{out,err}.log`);
          throw codexErr;
        }
        await writeFile(path.join(workDir, `codex.story.attempt${attempt}.stdout.log`), codexResult.stdout, "utf-8");
        await writeFile(path.join(workDir, `codex.story.attempt${attempt}.stderr.log`), codexResult.stderr, "utf-8");
        console.log(`codex exec (Story) exited 0 (attempt ${attempt}). stdout/stderr written to ${workDir}`);

        await assertOutputProduced(outputPath, codexResult.stdout);

        const attemptDims = await readPngDimensions(outputPath);
        if (!attemptDims || attemptDims.sizeBytes === 0) {
          throw new Error(`Output PNG missing or empty at ${outputPath}`);
        }
        console.log(`Story generated on attempt ${attempt}: ${outputPath} (${attemptDims.width}x${attemptDims.height}, ${attemptDims.sizeBytes} bytes)`);
      },
      { onAttemptFailure: (attempt, err) => console.error(`Story attempt ${attempt} failed: ${err.message}`) }
    );

    console.log("Uploading Story...");
    const completeResult = await completeStoryArtwork(storyId, claimId, outputPath);
    if (!completeResult.uploaded) {
      throw new Error(`Upload rejected: ${completeResult.reason ?? "unknown"}`);
    }
    if (completeResult.dispatch_confirmed === false) {
      console.warn(`WARNING: Story artwork for ${storyId} is safely stored (R2 + claim), but GitHub was never notified after retries — needs manual reconciliation.`);
    }

    console.log("Story done:");
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
    console.error(`Story processing failed: ${err.message}`);
    try {
      await failStoryArtwork(storyId, claimId, err.message.slice(0, 2000));
    } catch (failErr) {
      console.error(`Also failed to report the Story failure: ${failErr.message}`);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestrates Feed then (for v2 stories) Story, sharing ONE downloaded
// source image for the whole lifecycle. Story failure never deletes or
// regenerates a successful Feed — Feed's own claim is already "completed"
// and permanently un-reclaimable by the time Story is even attempted.
// @returns {Promise<boolean>} whether the story is now ready for caption.
// ---------------------------------------------------------------------------
async function processArtwork(target) {
  const storyId = target.story_id;

  const missing = missingFixtureFields(target);
  if (missing.length) {
    console.error(`Refusing to claim ${storyId}: missing required fixture field(s): ${missing.join(", ")}.`);
    return false;
  }

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
    // see lib/sourceImage.js for why. Reused for BOTH Feed and Story, per
    // "download once per processing lifecycle where practical."
    console.log("Downloading source image locally...");
    const sourceImage = await downloadSourceImageWithRetries(target.base_image_url, workDir, {
      onAttemptFailure: (attempt, err) => console.error(`Source image download attempt ${attempt} failed: ${err.message}`),
    });
    sourceImagePath = sourceImage.path;
    console.log(`Source image saved locally: ${sourceImagePath} (${sourceImage.sizeBytes} bytes)`);

    const feedSucceeded = await processFeedArtwork({ storyId, workDir, fixture, sourceImagePath });
    if (!feedSucceeded) return false;

    const version = target.content_package_version ?? 1;
    if (version !== 2) {
      console.log(`content_package_version ${version} — legacy story, Story asset is not required.`);
      return true;
    }

    return await processStoryArtwork({ storyId, workDir, fixture, sourceImagePath });
  } finally {
    await cleanupSourceImage(sourceImagePath);
  }
}

/**
 * Story-only recovery: Feed already succeeded in an earlier run; Story
 * hasn't. Downloads a fresh copy of the source image (a new processing
 * lifecycle), attempts ONLY Story, and on success proceeds to caption.
 * Never calls claimStory/processFeedArtwork — Feed is never touched.
 */
async function processStoryArtworkRecovery(storyId, record) {
  const s = record.source_story || {};
  const fixture = {
    story_id: storyId,
    post_headline: s.post_headline,
    base_image_url: s.base_image_url,
    source_name: s.source_name,
    source_url: s.source_url,
  };

  const missing = missingFixtureFields(fixture);
  if (missing.length) {
    console.error(`Refusing Story-only recovery for ${storyId}: missing required fixture field(s): ${missing.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const workDir = path.join(SOCIAL_OUTPUT_DIR, "work", storyId);
  await mkdir(workDir, { recursive: true });
  await mkdir(SOCIAL_OUTPUT_DIR, { recursive: true });

  let sourceImagePath;
  let storySucceeded = false;
  try {
    console.log("Downloading source image locally (Story-only recovery)...");
    const sourceImage = await downloadSourceImageWithRetries(fixture.base_image_url, workDir, {
      onAttemptFailure: (attempt, err) => console.error(`Source image download attempt ${attempt} failed: ${err.message}`),
    });
    sourceImagePath = sourceImage.path;
    console.log(`Source image saved locally: ${sourceImagePath} (${sourceImage.sizeBytes} bytes)`);

    storySucceeded = await processStoryArtwork({ storyId, workDir, fixture, sourceImagePath });
  } finally {
    await cleanupSourceImage(sourceImagePath);
  }

  if (!storySucceeded) {
    process.exitCode = 1;
    return;
  }

  await processCaption(storyId);
}

// ---------------------------------------------------------------------------
// Phase 2: Caption — a fully independent claim (caption:{story_id} on the
// Durable Object), only ever legal once artwork_ready (and, for v2
// stories, once Story artwork has also passed validation — enforced
// server-side by the Worker's caption/claim guard). Never touches artwork
// in any way — a caption failure here cannot regenerate or lose it.
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
    if (claimResult.reason === "story_artwork_not_ready") {
      console.log(
        `Caption not claimed: Story artwork is not yet valid for ${storyId}. ` +
          `Rerun with --story-id=${storyId} to retry Story generation (Story-only recovery — Feed will NOT be regenerated).`
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
    // not in the live artwork queue, so Content Creation already made
    // SOME progress on this story in an earlier run. Which recovery path
    // applies depends on whether Story artwork (v2 only) is also already
    // valid — see lib/routeRecovery.js. Artwork that already succeeded is
    // never regenerated on either path.
    const state = await fetchSocialState();
    const record = state?.stories?.[target.story_id];
    const route = determineRecoveryAction(record);

    if (route === "story_only") {
      console.log(`${target.story_id} is not in the live artwork queue — Feed already succeeded, Story artwork still needed. Attempting Story-only recovery.`);
      await processStoryArtworkRecovery(target.story_id, record);
      return;
    }

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
