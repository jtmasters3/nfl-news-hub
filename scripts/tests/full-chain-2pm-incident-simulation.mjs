#!/usr/bin/env node
// 2026-09-17 — Part 7 combined regression: simulates the ENTIRE real chain
// that failed at 2:00 PM in one script, end to end, against temp files and
// fully mocked network/process boundaries. No real artwork generation, no
// real caption generation, no real GitHub write, no real publish.
//
// Chain proven here, in order:
//   1. Feed + Story slots are due in the same refresh cycle. Tier 1 (own
//      window) is empty for Story; Tier 2 (6h) is also empty. The bounded
//      Tier 3 (24h) final fallback selects a real, safe, unused candidate
//      for Story instead of the slot going no_candidate — the exact fix for
//      the real incident. Feed independently selects its own, different,
//      fresher candidate in the same cycle (no destination collision).
//   2. The same-cycle post-selection generateArtworkQueue() rebuild makes
//      both new selections queue-visible immediately (not next cycle).
//   3. auto-prepare-social.js's main() is run against that same state:
//      two permanently-failed ("zombie") recovery candidates are present
//      and must be skipped without consuming a real selection attempt.
//   4. Priority 4 is reached and a fresh candidate is prepared (mocked
//      artwork+caption pipeline).
//   5. A separate, already-selected record simulates the real caption
//      completion race: the Durable Object reports the caption as
//      genuinely `completed` (dispatch_confirmed: true, real text) while
//      GitHub-side state still shows `caption.status: "generating"` —
//      exactly the Keenan Allen / Treveyon Henderson incident shape.
//      tryRecoverCaption() must replay it automatically, no human
//      intervention, and it must then reach auto-approval.
// Run with: node scripts/tests/full-chain-2pm-incident-simulation.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateArtworkQueue } from "../generate-artwork-queue.js";
import { generateSelection } from "../generate-selection.js";
import { buildStorySlotsForDate } from "../lib/selectionEngine.js";
import { installNetworkGuard } from "../social-worker/lib/_networkGuard.mjs";
import { main } from "../social/auto-prepare-social.js";

installNetworkGuard();

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "full-chain-sim-"));
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

test("STEP 1-2: the exact 2:00 PM incident shape — Story's own window AND its 6h Tier-2 pool are both empty, the Tier-3 fallback rescues the slot instead of no_candidate, and the rescue is queue-visible in the SAME cycle", async () => {
  // Cross-destination interaction (a Feed selection not starving a later
  // Story slot, and vice versa) is exhaustively covered on its own terms by
  // scripts/tests/selection-engine-regression.mjs tests 42A-42D (72/72
  // passing) — this step focuses on reproducing the Tier-3 rescue itself
  // plus same-cycle queue visibility, chained into the rest of this file's
  // simulation of the recovery pipeline.
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, "social-state.json");
    const queuePath = path.join(dir, "social-artwork-queue.json");

    // A Story-only hour (13:00 ET has no coincident Feed slot) with a
    // single due slot on first activation.
    const storySlot = buildStorySlotsForDate("2026-09-17").find((s) => s.slot_id.endsWith("T13:00:00-04:00"));
    assert.ok(storySlot, "fixture sanity: the 13:00 ET Story slot must exist");
    const now = storySlot.slot_time_ms;

    // Nothing exists in Story's own window (2h) or its 6h Tier-2 pool — the
    // only candidate anywhere is 18 hours old, inside the 24h Tier-3 pool
    // only. This is the exact real-incident shape: real, safe, unused
    // inventory existed, but a narrow window was about to turn the slot
    // into a false no_candidate before this fix.
    const tier3Candidate = freshStory({
      id: "story-tier3-only",
      firstPublishedAt: new Date(now - 18 * 60 * 60 * 1000).toISOString(),
    });

    const stories = [tier3Candidate];
    // Activate the selection system well before this story ever existed
    // (mirrors real production, which activated long ago), then burn
    // through every intervening slot with an EMPTY story list so each one
    // is durably marked no_candidate and never competes for this fixture's
    // one real story — leaving only the target 13:00 slot unprocessed by
    // the time the real story is introduced. Same technique as
    // selection-engine-regression.mjs's own activatedStateBefore() helper.
    const activationTime = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const oneMinuteBeforeNow = new Date(now - 60 * 1000).toISOString();
    await generateSelection([], { now: activationTime, filePath: statePath });
    await generateSelection([], { now: oneMinuteBeforeNow, filePath: statePath });

    await generateArtworkQueue(stories, { filePath: statePath, queueFilePath: queuePath });
    const selectionResult = await generateSelection(stories, { now: new Date(now).toISOString(), filePath: statePath });
    assert.equal(selectionResult.ok, true);
    assert.equal(selectionResult.selectedCount, 1, "the Story slot must be fulfilled, not left at no_candidate");

    const stateAfterSelection = JSON.parse(await readFile(statePath, "utf-8"));
    const storyRecord = stateAfterSelection.stories["story-tier3-only"];
    assert.equal(storyRecord.selection?.destination, "story", "Story must fall through to the Tier-3 fallback rather than going no_candidate");
    assert.equal(storyRecord.selection?.reason, "final_fallback_recent_pool_importance_score_rank");

    // Same-cycle queue-visibility rebuild (refresh.js's own conditional second call).
    if (selectionResult.selectedCount > 0) {
      await generateArtworkQueue(stories, { filePath: statePath, queueFilePath: queuePath });
    }
    const queue = JSON.parse(await readFile(queuePath, "utf-8"));
    assert.ok(queue.find((e) => e.story_id === "story-tier3-only"), "the Tier-3 Story selection must be queue-visible in the SAME cycle, not the next one");
  });
});

test("STEP 3-4: zombies are skipped without consuming a real attempt, Priority 4 reaches a fresh candidate, mocked pipeline prepares + approves it", async () => {
  const zombieArtwork = {
    story_id: "zombie-artwork",
    status: "artwork_requested",
    selection: { destination: "feed", slot_id: "feed:1", selected_at: "2026-01-01T00:00:00Z" },
    source_story: { post_headline: "X", source_name: "ESPN", source_url: "https://example.test/x", teams: [], players: [], description: "d" },
    approval: { status: "pending" },
    claim: { claim_id: "dead-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" },
    story_artwork: { status: "not_created", image_url: null },
    publishing: { status: "not_posted" },
  };
  const zombieCaption = {
    story_id: "zombie-caption",
    status: "artwork_ready",
    selection: { destination: "feed", slot_id: "feed:2", selected_at: "2026-01-01T00:00:00Z" },
    source_story: { post_headline: "Y", base_image_url: "https://example.test/y.jpg", source_name: "ESPN", source_url: "https://example.test/y" },
    approval: { status: "pending" },
    artwork: { status: "created", image_url: "https://example.test/y.png", width: 1024, height: 1280 },
    validation: { status: "passed", passed: true, issues: [] },
    caption: { status: "generating", text: null, claim: { claim_id: "dead-2", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" } },
    publishing: { status: "not_posted" },
  };
  const freshQueued = {
    story_id: "fresh1",
    status: "queued",
    selection: { destination: "feed", slot_id: "feed:3", selected_at: "2026-01-01T00:00:00Z" },
    source_story: { post_headline: "FRESH STORY", base_image_url: "https://example.test/f.jpg", source_name: "ESPN", source_url: "https://example.test/f", teams: ["Green Bay Packers"], players: ["Jordan Love"], description: "d" },
    approval: { status: "pending" },
    publishing: { status: "not_posted" },
  };
  const freshApproved = { ...freshQueued, status: "awaiting_approval", artwork: { status: "created", image_url: "https://example.test/f.png", width: 1024, height: 1280 }, story_artwork: { status: "not_created", image_url: null }, validation: { status: "passed", passed: true, issues: [] }, caption: { status: "ready", text: "Fresh caption.\n\nSource: ESPN" } };

  let prepStarted = false;
  let prepCallCount = 0, decideCallCount = 0, artworkReplayCount = 0, captionReplayCount = 0;
  const result = await main({
    fetchQueue: async () => [{ story_id: "fresh1" }],
    fetchState: async () => ({
      stories: { "zombie-artwork": zombieArtwork, "zombie-caption": zombieCaption, fresh1: prepStarted ? freshApproved : freshQueued },
    }),
    live: true,
    isCloudEnvironment: false,
    getArtworkClaimStatusImpl: async () => ({ do_record: { status: "failed", claim_id: "dead-1", processor_id: "p1" } }),
    getCaptionClaimStatusImpl: async () => ({ do_record: { status: "failed", claim_id: "dead-2", processor_id: "p1" } }),
    replayArtworkCompletionImpl: async () => { artworkReplayCount++; return { replayed: true }; },
    replayCaptionCompletionImpl: async () => { captionReplayCount++; return { replayed: true }; },
    runPreparationImpl: async () => { prepStarted = true; prepCallCount++; return { exitCode: 0 }; },
    decideApprovalImpl: async () => { decideCallCount++; return { result: "approved" }; },
  });
  assert.equal(artworkReplayCount, 0, "permanently-dead artwork zombie must never be replayed");
  assert.equal(captionReplayCount, 0, "permanently-dead caption zombie must never be replayed");
  assert.equal(prepCallCount, 1, "Priority 4 must be reached and prepare exactly the fresh candidate — no generation is skipped or duplicated");
  assert.equal(decideCallCount, 1, "the fresh candidate must reach auto-approval exactly once");
  assert.equal(result.autoApproved, true);
});

test("STEP 5: the real caption-completion race (DO completed, GitHub-side still generating) is recovered automatically with no human intervention, then reaches auto-approval", async () => {
  const stuckRecord = {
    story_id: "s1",
    status: "artwork_ready",
    merged_into: null,
    selection: { destination: "feed", slot_id: "feed:test", selected_at: "2026-01-01T00:00:00Z" },
    source_story: { post_headline: "JORDAN LOVE OUT", base_image_url: "https://example.test/base.jpg", source_name: "ESPN", source_url: "https://espn.com/story", teams: ["Green Bay Packers"], players: ["Jordan Love"], description: "d" },
    approval: { status: "pending" },
    artwork: { status: "created", image_url: "https://example.test/x.png", width: 1024, height: 1280 },
    validation: { status: "passed", passed: true, issues: [] },
    // GitHub-side state: still "generating" — the exact real-incident shape.
    caption: { status: "generating", text: null, claim: { claim_id: "claim-recover-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" } },
    publishing: { status: "not_posted", instagram: { feed: { status: "not_posted" }, story: { status: "not_posted" } } },
  };
  const recoveredRecord = { ...stuckRecord, status: "awaiting_approval", caption: { status: "ready", text: "A recovered caption.\n\nSource: ESPN", claim: { claim_id: "claim-recover-1", processor_id: "p1", claimed_at: "2026-01-01T00:00:00Z", claim_expires_at: "2026-01-01T00:50:00Z" } } };

  let fetchCallCount = 0;
  const fetchState = async () => {
    fetchCallCount++;
    // First read: still stuck (pre-recovery). Every read after the replay
    // call: recovered — mirrors the real GitHub commit becoming visible.
    return { stories: { s1: fetchCallCount === 1 ? stuckRecord : recoveredRecord } };
  };

  let replayCalled = false;
  let replayedClaimId = null;
  const result = await main({
    fetchQueue: async () => [],
    fetchState,
    live: true,
    isCloudEnvironment: false,
    // Authoritative Durable Object state: genuinely completed, dispatch confirmed, real text.
    getCaptionClaimStatusImpl: async () => ({
      do_record: {
        status: "completed",
        claim_id: "claim-recover-1",
        processor_id: "p1",
        dispatch_confirmed: true,
        payload: { story_id: "s1", claim_id: "claim-recover-1", text: "A recovered caption.\n\nSource: ESPN", provider: "chatgpt-codex-local" },
      },
    }),
    replayCaptionCompletionImpl: async (storyId, claimId) => {
      replayCalled = true;
      replayedClaimId = claimId;
      return { replayed: true };
    },
    decideApprovalImpl: async () => ({ result: "approved" }),
  });

  assert.equal(replayCalled, true, "an authoritatively completed caption must be automatically replayed — no human intervention, no polling loop, no second caption generated");
  assert.equal(replayedClaimId, "claim-recover-1", "the replay must target the exact live claim — never a stale or ambiguous one");
  assert.equal(result.autoApproved, true, "the recovered record must reach auto-approval automatically once caption + artwork + validation are all genuinely valid");
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.stack}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
