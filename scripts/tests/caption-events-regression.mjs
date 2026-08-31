#!/usr/bin/env node
// Regression suite for the Phase 2C caption-bridge event handlers (see
// scripts/lib/captionEvents.js + scripts/lib/captionValidation.js).
// Exercises the real pure functions in-memory — no file I/O, no HTTP, no
// real story ever touches data/social-state.json.
// Run with: node scripts/tests/caption-events-regression.mjs
import assert from "node:assert/strict";
import { emptyState, syncStories, promoteEligible, transition } from "../lib/socialState.js";
import { applyClaimEvent, applyCompleteEvent } from "../lib/artworkEvents.js";
import { applyCaptionClaimEvent, applyCaptionCompleteEvent, applyCaptionFailEvent, MAX_CAPTION_CLAIM_ATTEMPTS } from "../lib/captionEvents.js";
import { validateCaption } from "../lib/captionValidation.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function eligibleStory(id) {
  return {
    id,
    category: "trade",
    social: {
      social_status: "ready",
      post_headline: `HEADLINE FOR ${id}`,
      base_image_url: `https://example.test/${id}.jpg`,
      source_name: "ESPN",
      source_url: `https://example.test/${id}`,
    },
  };
}

function goodArtworkPayload(storyId, claimId, overrides = {}) {
  return {
    story_id: storyId,
    claim_id: claimId,
    image_url: `https://artwork.example.test/social-artwork/${storyId}.png`,
    storage_key: `social-artwork/${storyId}.png`,
    width: 1024,
    height: 1280,
    mime_type: "image/png",
    size_bytes: 500_000,
    provider: "chatgpt-codex-local",
    ...overrides,
  };
}

/** Builds a real artwork_ready record via the actual production functions, not a shortcut. */
function artworkReadyState(id) {
  let state = emptyState();
  state = syncStories(state, [eligibleStory(id)]).state;
  state = promoteEligible(state, [eligibleStory(id)]).state;
  state = applyClaimEvent(state, { story_id: id, claim_id: "artwork-claim-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const result = applyCompleteEvent(state, goodArtworkPayload(id, "artwork-claim-1"), { reachable: true });
  assert.equal(result.record.status, "artwork_ready", "test fixture setup must actually reach artwork_ready");
  return result.state;
}

const GOOD_CAPTION_TEXT = "The move addresses depth on the roster. Source: ESPN";

// ---------------------------------------------------------------------------
test("Caption cannot claim before artwork_ready (still artwork_requested)", () => {
  let state = emptyState();
  state = syncStories(state, [eligibleStory("TEST-A")]).state;
  state = promoteEligible(state, [eligibleStory("TEST-A")]).state;
  state = applyClaimEvent(state, { story_id: "TEST-A", claim_id: "c1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  // Still "artwork_requested" — artwork was never completed.

  const result = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:artwork_requested");
});

test("Caption claim is independent of the (historical) artwork claim namespace", () => {
  let state = artworkReadyState("TEST-A");
  const artworkClaim = state.stories["TEST-A"].claim;
  assert.equal(artworkClaim.claim_id, "artwork-claim-1");

  const result = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p2", claimed_at: "t2", claim_expires_at: "t3" });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "artwork_ready", "claiming a caption must never change top-level status");
  assert.deepEqual(result.record.claim, artworkClaim, "the historical artwork claim must be completely untouched");
  assert.equal(result.record.caption.claim.claim_id, "cap-1");
  assert.equal(result.record.caption.status, "generating");
});

test("Successful caption completion: artwork_ready -> awaiting_approval, caption.text populated", () => {
  let state = artworkReadyState("TEST-A");
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyCaptionCompleteEvent(state, {
    story_id: "TEST-A",
    claim_id: "cap-1",
    text: GOOD_CAPTION_TEXT,
    hashtags: ["#NFL"],
    attribution_line: "Source: ESPN",
    source_url: "https://example.test/TEST-A",
    provider: "chatgpt-codex-local",
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "awaiting_approval");
  assert.equal(result.record.caption.status, "ready");
  assert.equal(result.record.caption.text, GOOD_CAPTION_TEXT);
  assert.equal(result.record.caption.last_candidate_text, null);
  // Artwork from the earlier phase must still be fully intact.
  assert.equal(result.record.artwork.status, "created");
  assert.equal(result.record.artwork.image_url, "https://artwork.example.test/social-artwork/TEST-A.png");
});

test("Server-side caption validation rejection: caption.text stays null, last_candidate_text holds the rejected output", () => {
  let state = artworkReadyState("TEST-A");
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const badText = "This is unverified. Source: WrongSource"; // wrong attribution
  const result = applyCaptionCompleteEvent(state, { story_id: "TEST-A", claim_id: "cap-1", text: badText, provider: "chatgpt-codex-local" });
  assert.equal(result.ok, true); // the FAIL path itself succeeds in recording the rejection
  assert.equal(result.record.status, "artwork_ready", "rejected candidate must not reach awaiting_approval");
  assert.equal(result.record.caption.status, "failed");
  assert.equal(result.record.caption.text, null, "REJECTED output must never become caption.text");
  assert.equal(result.record.caption.last_candidate_text, badText);
  assert.equal(result.record.caption.claim_attempt_count, 1);
});

test("A rejected candidate can never become publishable text even after a LATER successful attempt", () => {
  let state = artworkReadyState("TEST-A");
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const badText = "Unsupported claim with no source line at all.";
  state = applyCaptionCompleteEvent(state, { story_id: "TEST-A", claim_id: "cap-1", text: badText, provider: "chatgpt-codex-local" }).state;
  assert.equal(state.stories["TEST-A"].caption.text, null);

  // A fresh claim + a good completion afterward.
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-2", processor_id: "p", claimed_at: "t2", claim_expires_at: "t3" }).state;
  const final = applyCaptionCompleteEvent(state, { story_id: "TEST-A", claim_id: "cap-2", text: GOOD_CAPTION_TEXT, provider: "chatgpt-codex-local" });
  assert.equal(final.record.caption.text, GOOD_CAPTION_TEXT);
  assert.notEqual(final.record.caption.text, badText);
});

test("Incorrect claim_id is rejected on caption completion, and does not mutate the record", () => {
  let state = artworkReadyState("TEST-A");
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;

  const result = applyCaptionCompleteEvent(state, { story_id: "TEST-A", claim_id: "wrong-claim", text: GOOD_CAPTION_TEXT, provider: "chatgpt-codex-local" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claim_mismatch");
  assert.equal(state.stories["TEST-A"].status, "artwork_ready");
  assert.equal(state.stories["TEST-A"].caption.status, "generating");
});

test("Duplicate caption-completed event after a real success is a harmless no-op, never corrupts the record", () => {
  let state = artworkReadyState("TEST-A");
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  const first = applyCaptionCompleteEvent(state, { story_id: "TEST-A", claim_id: "cap-1", text: GOOD_CAPTION_TEXT, provider: "chatgpt-codex-local" });
  assert.equal(first.ok, true);

  const second = applyCaptionCompleteEvent(first.state, { story_id: "TEST-A", claim_id: "cap-1", text: GOOD_CAPTION_TEXT, provider: "chatgpt-codex-local" });
  assert.equal(second.ok, false);
  assert.equal(second.error, "invalid_state:awaiting_approval");
  assert.equal(second.state.stories["TEST-A"].caption.text, GOOD_CAPTION_TEXT, "the real success must be completely untouched");
});

test("A late caption-fail event after a real success is also a harmless no-op", () => {
  let state = artworkReadyState("TEST-A");
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  state = applyCaptionCompleteEvent(state, { story_id: "TEST-A", claim_id: "cap-1", text: GOOD_CAPTION_TEXT, provider: "chatgpt-codex-local" }).state;

  const lateFail = applyCaptionFailEvent(state, { story_id: "TEST-A", claim_id: "cap-1", message: "stale timeout" });
  assert.equal(lateFail.ok, false);
  assert.equal(lateFail.error, "invalid_state:awaiting_approval");
  assert.equal(state.stories["TEST-A"].caption.text, GOOD_CAPTION_TEXT);
});

// ---------------------------------------------------------------------------
// claim_attempt_count: 3 LOCAL attempts (inside one claim run) vs 3
// SEPARATE claim runs — these are deliberately different concepts. Local
// attempts are handled entirely by the local processor's own retry loop
// (generateWithRetries) and never reach the server until the run gives
// up; each such give-up is ONE caption-fail EVENT, i.e. one claim run.
// ---------------------------------------------------------------------------
test("First and second exhausted CLAIM RUNS stay at artwork_ready — artwork and diagnostics preserved", () => {
  let state = artworkReadyState("TEST-A");

  // Claim run 1: claims, exhausts its local attempts, reports ONE fail event.
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-1", processor_id: "p", claimed_at: "t0", claim_expires_at: "t1" }).state;
  let result = applyCaptionFailEvent(state, { story_id: "TEST-A", claim_id: "cap-1", message: "3 local attempts exhausted", last_candidate_text: "bad-1" });
  state = result.state;
  assert.equal(result.escalatedToFailed, false);
  assert.equal(state.stories["TEST-A"].status, "artwork_ready");
  assert.equal(state.stories["TEST-A"].caption.claim_attempt_count, 1);
  assert.equal(state.stories["TEST-A"].artwork.status, "created", "artwork must survive claim run 1's exhaustion");

  // Claim run 2: a DIFFERENT claim_id (new run), also exhausts.
  state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-2", processor_id: "p", claimed_at: "t2", claim_expires_at: "t3" }).state;
  result = applyCaptionFailEvent(state, { story_id: "TEST-A", claim_id: "cap-2", message: "3 local attempts exhausted", last_candidate_text: "bad-2" });
  state = result.state;
  assert.equal(result.escalatedToFailed, false);
  assert.equal(state.stories["TEST-A"].status, "artwork_ready", "still retryable after only 2 exhausted claim runs");
  assert.equal(state.stories["TEST-A"].caption.claim_attempt_count, 2);
  assert.equal(state.stories["TEST-A"].caption.last_candidate_text, "bad-2");
  assert.equal(state.stories["TEST-A"].artwork.image_url, "https://artwork.example.test/social-artwork/TEST-A.png", "artwork must survive claim run 2's exhaustion too");
});

test("The THIRD separate exhausted claim run escalates artwork_ready -> failed, preserving artwork + caption diagnostics", () => {
  let state = artworkReadyState("TEST-A");
  assert.equal(MAX_CAPTION_CLAIM_ATTEMPTS, 3, "this test assumes the documented cap");

  for (let run = 1; run <= 3; run++) {
    const claimId = `cap-${run}`;
    state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: claimId, processor_id: "p", claimed_at: `t${run}`, claim_expires_at: `t${run}+1` }).state;
    const result = applyCaptionFailEvent(state, { story_id: "TEST-A", claim_id: claimId, message: `run ${run} exhausted`, last_candidate_text: `bad-${run}` });
    state = result.state;
    if (run < 3) {
      assert.equal(result.escalatedToFailed, false, `run ${run} must not escalate yet`);
      assert.equal(state.stories["TEST-A"].status, "artwork_ready");
    } else {
      assert.equal(result.escalatedToFailed, true, "the third exhausted run must escalate");
      assert.equal(state.stories["TEST-A"].status, "failed");
    }
  }

  const finalRecord = state.stories["TEST-A"];
  assert.equal(finalRecord.caption.claim_attempt_count, 3);
  assert.equal(finalRecord.caption.last_candidate_text, "bad-3", "the most recent rejected candidate is preserved for diagnosis");
  assert.equal(finalRecord.caption.text, null, "never publishable, even in the terminal failed state");
  assert.equal(finalRecord.artwork.status, "created", "artwork survives even a fully-escalated caption failure");
  assert.equal(finalRecord.artwork.image_url, "https://artwork.example.test/social-artwork/TEST-A.png");
  assert.equal(finalRecord.last_error.stage, "caption");
  assert.equal(finalRecord.last_error.retry_count, 3);
});

test("A 4th claim attempt after escalation to failed is rejected as invalid_state — no automatic retry past the cap", () => {
  let state = artworkReadyState("TEST-A");
  for (let run = 1; run <= 3; run++) {
    const claimId = `cap-${run}`;
    state = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: claimId, processor_id: "p", claimed_at: "t", claim_expires_at: "t+1" }).state;
    state = applyCaptionFailEvent(state, { story_id: "TEST-A", claim_id: claimId, message: "exhausted" }).state;
  }
  assert.equal(state.stories["TEST-A"].status, "failed");

  const result = applyCaptionClaimEvent(state, { story_id: "TEST-A", claim_id: "cap-4", processor_id: "p", claimed_at: "t", claim_expires_at: "t+1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state:failed");
});

// ---------------------------------------------------------------------------
// validateCaption() unit-level checks, independent of the transition plumbing.
// ---------------------------------------------------------------------------
test("validateCaption: accepts a clean, well-formed caption", () => {
  const { passed, issues } = validateCaption(GOOD_CAPTION_TEXT, { post_headline: "HEADLINE FOR TEST-A", source_name: "ESPN", description: null });
  assert.equal(passed, true);
  assert.deepEqual(issues, []);
});

test("validateCaption: rejects missing/incorrect source attribution", () => {
  const { passed, issues } = validateCaption("A caption with no attribution line at all here.", { post_headline: "H", source_name: "ESPN", description: null });
  assert.equal(passed, false);
  assert.ok(issues.includes("missing_or_incorrect_attribution"));
});

test("validateCaption: rejects any URL", () => {
  const { passed, issues } = validateCaption("Read more at https://example.com. Source: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.equal(passed, false);
  assert.ok(issues.includes("contains_url"));
});

test("validateCaption: rejects @handles", () => {
  const { passed, issues } = validateCaption("Great update from @teamreporter. Source: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.equal(passed, false);
  assert.ok(issues.includes("contains_unsupported_handle"));
});

test("validateCaption: rejects more than 3 hashtags", () => {
  const { passed, issues } = validateCaption("Big news today. Source: ESPN #NFL #Team #Player #Trade", { post_headline: "H", source_name: "ESPN", description: null });
  assert.equal(passed, false);
  assert.ok(issues.some((i) => i.startsWith("excessive_hashtags")));
});

test("validateCaption: rejects markdown code fences and headings", () => {
  const fenced = validateCaption("```\ncode\n```\nSource: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.ok(fenced.issues.includes("contains_code_fence"));
  const heading = validateCaption("# Big News\nSource: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.ok(heading.issues.includes("contains_markdown_heading"));
});

test("validateCaption: rejects meta/refusal commentary", () => {
  const { passed, issues } = validateCaption("As an AI, here is your caption. Source: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.equal(passed, false);
  assert.ok(issues.some((i) => i.startsWith("meta_commentary")));
});

test("validateCaption: rejects a standalone number not present anywhere in the fixture (invented stat)", () => {
  const { passed, issues } = validateCaption("He signed a deal worth 47 million total. Source: ESPN", {
    post_headline: "Player signs extension",
    source_name: "ESPN",
    description: "Player agreed to terms on a new contract.",
  });
  assert.equal(passed, false);
  assert.ok(issues.some((i) => i.startsWith("unsupported_number")));
});

test("validateCaption: allows a number that genuinely appears in the fixture", () => {
  const { passed } = validateCaption("The deal is reportedly worth 20 million. Source: ESPN", {
    post_headline: "Player signs 20 million deal",
    source_name: "ESPN",
    description: null,
  });
  assert.equal(passed, true);
});

test("validateCaption: rejects a quote not present in the supplied description (invented quote)", () => {
  const { passed, issues } = validateCaption('He said "this means everything to me." Source: ESPN', {
    post_headline: "H",
    source_name: "ESPN",
    description: "The team announced the move in a short statement.",
  });
  assert.equal(passed, false);
  assert.ok(issues.some((i) => i.startsWith("unsupported_quote")));
});

test("validateCaption: allows a quote that genuinely appears in the supplied description", () => {
  const { passed } = validateCaption('The team called it "a step forward" for the roster. Source: ESPN', {
    post_headline: "H",
    source_name: "ESPN",
    description: 'In a statement, the team called the move "a step forward" for the roster.',
  });
  assert.equal(passed, true);
});

test("validateCaption: rejects too-short and too-long captions", () => {
  const short = validateCaption("Short. Source: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.ok(short.issues.some((i) => i.startsWith("too_short")));
  const long = validateCaption("X ".repeat(500) + "Source: ESPN", { post_headline: "H", source_name: "ESPN", description: null });
  assert.ok(long.issues.some((i) => i.startsWith("too_long")));
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
