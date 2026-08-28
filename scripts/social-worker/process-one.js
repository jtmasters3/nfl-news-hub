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
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimStory, completeArtwork, failArtwork, fetchArtworkQueue } from "./lib/apiClient.js";
import { runCodex } from "./lib/codexRunner.js";
import { readPngDimensions } from "./lib/pngDimensions.js";

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
  if (storyId) return { story_id: storyId };
  const queue = await fetchArtworkQueue();
  if (!queue.length) return null;
  return queue[0];
}

async function buildPrompt({ storyId, workDir, fixture }) {
  const template = await readFile(TEMPLATE_PATH, "utf-8");
  const fixturePath = path.join(workDir, "fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  const outputPath = path.join(SOCIAL_OUTPUT_DIR, `${storyId}.png`);
  const templatePackDir = process.env.AGGREGATE_TEMPLATE_PACK_DIR || DEFAULT_TEMPLATE_PACK_DIR;

  const promptText = template
    .replaceAll("{{fixture_path}}", fixturePath)
    .replaceAll("{{template_pack_dir}}", templatePackDir)
    .replaceAll("{{output_path}}", outputPath);

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
  console.log(`Claiming ${storyId}...`);
  const claimResult = await claimStory(storyId);

  if (!claimResult.claimed) {
    console.log(`Not claimed (${claimResult.reason ?? "unknown"}).`);
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

  try {
    const { promptText, outputPath } = await buildPrompt({ storyId, workDir, fixture });

    console.log("Running codex exec...");
    const codexResult = await runCodex({ promptText, addDir: SOCIAL_OUTPUT_DIR });
    await writeFile(path.join(workDir, "codex.stdout.log"), codexResult.stdout, "utf-8");
    await writeFile(path.join(workDir, "codex.stderr.log"), codexResult.stderr, "utf-8");

    const dims = await readPngDimensions(outputPath);
    if (!dims || dims.sizeBytes === 0) {
      throw new Error(`Output PNG missing or empty at ${outputPath}`);
    }
    console.log(`Generated ${outputPath} (${dims.width}x${dims.height}, ${dims.sizeBytes} bytes)`);

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
  }
}

main().catch((err) => {
  console.error("process-one failed:", err);
  process.exitCode = 1;
});
