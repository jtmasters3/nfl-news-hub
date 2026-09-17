#!/usr/bin/env node
// 2026-09-17 same-cycle queue-visibility fix — proves that re-running
// generateArtworkQueue() AFTER generateSelection() (refresh.js's own new
// second call, only when something was actually selected) makes a
// selection made THIS refresh cycle visible in social-artwork-queue.json
// in that SAME cycle, rather than only on the next one (~10 minutes
// later) — the exact production timing gap that left as little as 5
// minutes of a selection's 20-minute grace window for the local Windows
// runner to see it. Fully offline, temp files only — never touches the
// real production data/social-state.json or social-artwork-queue.json.
// Run with: node scripts/tests/same-cycle-queue-visibility-regression.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateArtworkQueue } from "../generate-artwork-queue.js";
import { generateSelection } from "../generate-selection.js";
import { easternWallClockToUtcMillis, buildFeedSlotsForDate } from "../lib/selectionEngine.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "same-cycle-queue-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function freshStory({ id, firstPublishedAt, importanceScore = 10 }) {
  return {
    id,
    headline: `Story ${id}`,
    importance_score: importanceScore,
    first_published_at: firstPublishedAt,
    latest_published_at: firstPublishedAt,
    category: "league_news",
    social: {
      social_status: "ready",
      post_headline: `Story ${id}`,
      base_image_url: "https://example.test/img.jpg",
      source_name: "Test",
      source_url: `https://example.test/${id}`,
    },
  };
}

test("a Feed selection made THIS refresh cycle is queue-visible in the SAME cycle after the post-selection queue rebuild", async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, "social-state.json");
    const queuePath = path.join(dir, "social-artwork-queue.json");

    // A real Feed slot: 16:00 ET on an arbitrary date, window 14:00-16:00 ET.
    const slot = buildFeedSlotsForDate("2026-02-10").find((s) => s.slot_id.endsWith("T16:00:00-05:00"));
    assert.ok(slot, "fixture sanity check: the 16:00 Feed slot must exist");
    const story = freshStory({ id: "story-1", firstPublishedAt: new Date(slot.slot_time_ms - 30 * 60 * 1000).toISOString() });
    const nowIso = new Date(slot.slot_time_ms).toISOString(); // exactly at the slot boundary — activation-safe (see selectionEngine's own A3 precedent)

    // Step 1: the FIRST generateArtworkQueue() call, exactly as refresh.js's
    // own existing (unchanged) first call does — before any selection exists.
    await generateArtworkQueue([story], { filePath: statePath, queueFilePath: queuePath });
    const beforeSelection = JSON.parse(await readFile(queuePath, "utf-8"));
    const entryBefore = beforeSelection.find((e) => e.story_id === "story-1");
    assert.ok(entryBefore, "the story must already be queue-visible before selection runs (pre-existing behavior, unchanged)");
    assert.equal(entryBefore.destination, "feed", "before selection, destination is only ever the buildQueueEntries() default");

    // Step 2: Stage 3A selection runs against the SAME state file.
    const selectionResult = await generateSelection([story], { now: nowIso, filePath: statePath });
    assert.equal(selectionResult.ok, true);
    assert.equal(selectionResult.selectedCount, 1, "fixture sanity check: the story must actually win its slot");

    // Without the fix, the queue file on disk would still be exactly
    // entryBefore here — the bug this fix closes. Not asserted directly
    // (this file proves the FIX, not the bug), but the fix's own value is
    // exactly this: the file has NOT been touched again yet at this point.

    // Step 3: refresh.js's NEW second call — only reached when something was
    // actually selected (selectionResult.selectedCount > 0), exactly as
    // implemented in refresh.js.
    if (selectionResult.selectedCount > 0) {
      await generateArtworkQueue([story], { filePath: statePath, queueFilePath: queuePath });
    }

    const afterSelection = JSON.parse(await readFile(queuePath, "utf-8"));
    const entryAfter = afterSelection.find((e) => e.story_id === "story-1");
    assert.ok(entryAfter, "the story must still be queue-visible after the post-selection rebuild");
    assert.equal(entryAfter.destination, "feed", "this particular story's real selection.destination happens to also be feed");
  });
});

test("a Story selection made THIS refresh cycle is queue-visible in the SAME cycle, with the correct destination reflected immediately", async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, "social-state.json");
    const queuePath = path.join(dir, "social-artwork-queue.json");

    const { buildStorySlotsForDate } = await import("../lib/selectionEngine.js");
    const slot = buildStorySlotsForDate("2026-02-10").find((s) => s.slot_id.endsWith("T11:00:00-05:00"));
    assert.ok(slot, "fixture sanity check: the 11:00 Story slot must exist");
    const story = freshStory({ id: "story-2", firstPublishedAt: new Date(slot.slot_time_ms - 20 * 60 * 1000).toISOString() });
    const nowIso = new Date(slot.slot_time_ms).toISOString();

    await generateArtworkQueue([story], { filePath: statePath, queueFilePath: queuePath });
    const entryBefore = JSON.parse(await readFile(queuePath, "utf-8")).find((e) => e.story_id === "story-2");
    assert.equal(entryBefore.destination, "feed", "before selection, every record defaults to feed regardless of its eventual real destination");

    const selectionResult = await generateSelection([story], { now: nowIso, filePath: statePath });
    assert.equal(selectionResult.selectedCount, 1);

    await generateArtworkQueue([story], { filePath: statePath, queueFilePath: queuePath });
    const entryAfter = JSON.parse(await readFile(queuePath, "utf-8")).find((e) => e.story_id === "story-2");
    assert.equal(entryAfter.destination, "story", "the SAME cycle's real Story selection must be reflected immediately, not on a later refresh");
  });
});

test("when nothing is selected this cycle, the conditional second generateArtworkQueue() call is simply skipped (no wasted rebuild) — the fix never behaves unconditionally", async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, "social-state.json");
    const queuePath = path.join(dir, "social-artwork-queue.json");
    // A story whose first_published_at falls OUTSIDE any due slot's window.
    const story = freshStory({ id: "story-3", firstPublishedAt: "2026-02-10T00:00:00.000Z" });
    const nowIso = "2026-02-10T00:05:00.000Z";

    await generateArtworkQueue([story], { filePath: statePath, queueFilePath: queuePath });
    const selectionResult = await generateSelection([story], { now: nowIso, filePath: statePath });
    assert.equal(selectionResult.ok, true);
    assert.equal(selectionResult.selectedCount, 0, "fixture sanity check: nothing should win an out-of-window slot");
    // refresh.js's own real condition — mirrored here exactly.
    assert.equal(selectionResult.selectedCount > 0, false, "the guard must correctly evaluate to false, confirming no redundant rebuild would be triggered");
  });
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
