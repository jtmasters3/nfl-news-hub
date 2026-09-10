#!/usr/bin/env node
// The Aggregate — Live Automation Acceleration, Stage 3A regression suite:
// Fixed-Window Selection Engine (post pre-lock correction: exact-instant
// activation boundary + legacy-social-workflow exclusion). Fully offline
// and deterministic.
// Run with: node scripts/tests/selection-engine-regression.mjs
import assert from "node:assert/strict";
import {
  easternWallClockToUtcMillis,
  easternOffsetLabel,
  buildFeedSlotsForDate,
  buildStorySlotsForDate,
  rankCandidates,
  findWindowCandidates,
  hasLegacySocialWorkStarted,
  runSelectionEngine,
  FEED_SLOT_TIMES,
  STORY_SLOT_TIMES,
} from "../lib/selectionEngine.js";
import { generateSelection } from "../generate-selection.js";
import { emptyState, ensureRecord, STATES } from "../lib/socialState.js";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function story({ id, importance_score = 10, first_published_at, ready = true }) {
  return {
    id,
    headline: `Story ${id}`,
    importance_score,
    first_published_at,
    latest_published_at: first_published_at,
    category: "league_news",
    social: ready ? { social_status: "ready", post_headline: `Story ${id}`, base_image_url: "https://example.test/img.jpg", source_name: "Test", source_url: `https://example.test/${id}` } : { social_status: "not_ready" },
  };
}

function stateWithSyncedStories(stories, baseState = emptyState()) {
  let state = baseState;
  for (const s of stories) {
    const result = ensureRecord(state, s.id, { status: "new" });
    state = result.state;
  }
  return state;
}

function withStatus(state, storyId, status) {
  return { ...state, stories: { ...state.stories, [storyId]: { ...state.stories[storyId], status } } };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "selection-engine-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function et(dateStr, timeStr) {
  return new Date(easternWallClockToUtcMillis(dateStr, timeStr)).toISOString();
}

// ---------------------------------------------------------------------------
// 1-2. Eastern-time slot generation / DST-safe slot IDs
// ---------------------------------------------------------------------------

test("1. Eastern wall-clock to UTC conversion is correct on both sides of DST", () => {
  assert.equal(easternOffsetLabel(easternWallClockToUtcMillis("2026-03-01", "10:00")), "-05:00");
  assert.equal(easternOffsetLabel(easternWallClockToUtcMillis("2026-03-08", "10:00")), "-04:00");
  assert.equal(easternOffsetLabel(easternWallClockToUtcMillis("2026-10-25", "10:00")), "-04:00");
  assert.equal(easternOffsetLabel(easternWallClockToUtcMillis("2026-11-01", "10:00")), "-05:00");
});

test("2. DST-safe slot IDs: the same local wall-clock time produces a different ID across a DST boundary, correctly encoding the real offset", () => {
  const winterSlots = buildFeedSlotsForDate("2026-03-01");
  const summerSlots = buildFeedSlotsForDate("2026-03-08");
  const winter10 = winterSlots.find((s) => s.slot_id.includes("T10:00"));
  const summer10 = summerSlots.find((s) => s.slot_id.includes("T10:00"));
  assert.ok(winter10.slot_id.endsWith("-05:00"));
  assert.ok(summer10.slot_id.endsWith("-04:00"));
  assert.notEqual(winter10.slot_id, summer10.slot_id);
  const winter10Again = buildFeedSlotsForDate("2026-03-01").find((s) => s.slot_id.includes("T10:00"));
  assert.equal(winter10.slot_id, winter10Again.slot_id);
});

// ---------------------------------------------------------------------------
// 3-6. Window generation
// ---------------------------------------------------------------------------

test("3. Feed 08:00 slot window reaches back to the PREVIOUS day's 22:00 ET", () => {
  const slots = buildFeedSlotsForDate("2026-09-10");
  const slot0800 = slots.find((s) => s.slot_id.includes("T08:00"));
  assert.equal(slot0800.window_start, et("2026-09-09", "22:00"));
  assert.equal(slot0800.window_end, et("2026-09-10", "08:00"));
});

test("4. later Feed slots use the preceding 2-hour window on the same date", () => {
  const slots = buildFeedSlotsForDate("2026-09-10");
  assert.equal(slots.find((s) => s.slot_id.includes("T10:00")).window_start, et("2026-09-10", "08:00"));
  assert.equal(slots.find((s) => s.slot_id.includes("T12:00")).window_start, et("2026-09-10", "10:00"));
  assert.equal(slots.find((s) => s.slot_id.includes("T14:00")).window_start, et("2026-09-10", "12:00"));
  assert.equal(slots.length, FEED_SLOT_TIMES.length);
});

test("5. Story 09:00 slot window reaches back to the PREVIOUS day's 20:00 ET", () => {
  const slots = buildStorySlotsForDate("2026-09-10");
  const slot0900 = slots.find((s) => s.slot_id.includes("T09:00"));
  assert.equal(slot0900.window_start, et("2026-09-09", "20:00"));
  assert.equal(slot0900.window_end, et("2026-09-10", "09:00"));
});

test("6. later Story slots use the preceding 1-hour window on the same date", () => {
  const slots = buildStorySlotsForDate("2026-09-10");
  assert.equal(slots.find((s) => s.slot_id.includes("T10:00")).window_start, et("2026-09-10", "09:00"));
  assert.equal(slots.find((s) => s.slot_id.includes("T11:00")).window_start, et("2026-09-10", "10:00"));
  assert.equal(slots.length, STORY_SLOT_TIMES.length);
});

// ---------------------------------------------------------------------------
// 7-10. [start, end) boundary behavior
// ---------------------------------------------------------------------------

test("7/8/9/10. half-open [start,end) window boundary behavior", () => {
  const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "10:00");
  const windowEndMs = easternWallClockToUtcMillis("2026-09-10", "12:00");

  const before = story({ id: "s-before", first_published_at: new Date(windowStartMs - 1).toISOString() });
  const atStart = story({ id: "s-at-start", first_published_at: new Date(windowStartMs).toISOString() });
  const atEnd = story({ id: "s-at-end", first_published_at: new Date(windowEndMs).toISOString() });
  const inside = story({ id: "s-inside", first_published_at: new Date(windowStartMs + 1000).toISOString() });

  const st = stateWithSyncedStories([before, atStart, atEnd, inside]);
  const candidates = findWindowCandidates([before, atStart, atEnd, inside], st.stories, windowStartMs, windowEndMs);
  const ids = candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ["s-at-start", "s-inside"], "before-window and at-end-exactly stories must be rejected; at-start and inside must be accepted");
});

// ---------------------------------------------------------------------------
// 11-13. Deterministic ranking
// ---------------------------------------------------------------------------

test("11. ranking: importance_score descending", () => {
  const a = story({ id: "a", importance_score: 5, first_published_at: "2026-09-10T10:00:00Z" });
  const b = story({ id: "b", importance_score: 50, first_published_at: "2026-09-10T09:00:00Z" });
  assert.equal(rankCandidates([a, b])[0].id, "b");
});

test("12. ranking: equal importance_score -> publication-time descending (more recent wins)", () => {
  const older = story({ id: "older", importance_score: 10, first_published_at: "2026-09-10T09:00:00Z" });
  const newer = story({ id: "newer", importance_score: 10, first_published_at: "2026-09-10T09:30:00Z" });
  assert.equal(rankCandidates([older, newer])[0].id, "newer");
});

test("13. ranking: equal importance_score AND equal publication time -> stable story_id lexical tie-break", () => {
  const b = story({ id: "b-story", importance_score: 10, first_published_at: "2026-09-10T09:00:00Z" });
  const a = story({ id: "a-story", importance_score: 10, first_published_at: "2026-09-10T09:00:00Z" });
  assert.equal(rankCandidates([b, a])[0].id, "a-story");
  assert.equal(rankCandidates([a, b])[0].id, "a-story");
});

// ---------------------------------------------------------------------------
// 14-15. Shared-time priority (exact-instant activation makes this simple —
// activating exactly AT 10:00 means only the 10:00 pair is ever due)
// ---------------------------------------------------------------------------

test("14/15. at a shared time, Feed commits first and Story excludes the same-time Feed winner", () => {
  const onlyCandidate = story({ id: "shared-winner", importance_score: 99, first_published_at: et("2026-09-10", "09:00") });
  const state = stateWithSyncedStories([onlyCandidate]);

  const now = et("2026-09-10", "10:00"); // first-ever activation, exactly at 10:00 -> only the 10:00 pair is due
  const result = runSelectionEngine({ state, stories: [onlyCandidate], now });

  const feedSlot = result.processedSlots.find((s) => s.slot_id.startsWith("feed:") && s.slot_id.includes("T10:00"));
  const storySlot = result.processedSlots.find((s) => s.slot_id.startsWith("story:") && s.slot_id.includes("T10:00"));
  assert.equal(feedSlot.status, "selected");
  assert.equal(feedSlot.story_id, "shared-winner");
  assert.equal(storySlot.status, "no_candidate", "the only candidate was already claimed by Feed — Story must find no one left");
});

// ---------------------------------------------------------------------------
// 16-18. Exclusion of previously selected / legacy-engaged stories
// ---------------------------------------------------------------------------

test("16. a story already selected for Feed (from a prior run) is excluded from a later Story slot's candidates", () => {
  const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "12:00");
  const s = story({ id: "already-feed", importance_score: 50, first_published_at: new Date(windowStartMs + 1000).toISOString() });
  let state = stateWithSyncedStories([s]);
  state = { ...state, stories: { ...state.stories, [s.id]: { ...state.stories[s.id], selection: { destination: "feed", slot_id: "feed:2026-09-10T10:00:00-04:00" } } } };
  const candidates = findWindowCandidates([s], state.stories, windowStartMs, easternWallClockToUtcMillis("2026-09-10", "14:00"));
  assert.equal(candidates.length, 0);
});

test("17. a story already selected for Story is excluded from a later Feed slot's candidates", () => {
  const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "12:00");
  const s = story({ id: "already-story", importance_score: 50, first_published_at: new Date(windowStartMs + 1000).toISOString() });
  let state = stateWithSyncedStories([s]);
  state = { ...state, stories: { ...state.stories, [s.id]: { ...state.stories[s.id], selection: { destination: "story", slot_id: "story:2026-09-10T11:00:00-04:00" } } } };
  const candidates = findWindowCandidates([s], state.stories, windowStartMs, easternWallClockToUtcMillis("2026-09-10", "14:00"));
  assert.equal(candidates.length, 0);
});

test("18. a posted story is excluded from candidacy", () => {
  const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "12:00");
  const s = story({ id: "already-posted", importance_score: 50, first_published_at: new Date(windowStartMs + 1000).toISOString() });
  let state = stateWithSyncedStories([s]);
  state = withStatus(state, s.id, "posted");
  const candidates = findWindowCandidates([s], state.stories, windowStartMs, easternWallClockToUtcMillis("2026-09-10", "14:00"));
  assert.equal(candidates.length, 0);
});

// ---------------------------------------------------------------------------
// LEGACY SOCIAL-WORKFLOW EXCLUSION — hasLegacySocialWorkStarted() predicate,
// investigated against the actual locked socialState.js STATES/TRANSITIONS.
// ---------------------------------------------------------------------------

const LEGACY_ENGAGED_STATES = ["artwork_requested", "artwork_created", "validating", "artwork_ready", "awaiting_approval", "approved", "posting", "posted", "failed", "rejected"];
const NOT_ENGAGED_STATES = ["preexisting_ignored", "new", "queued"];

test("predicate sanity: hasLegacySocialWorkStarted covers exactly the STATES enum with no gaps", () => {
  const covered = new Set([...LEGACY_ENGAGED_STATES, ...NOT_ENGAGED_STATES]);
  assert.deepEqual([...covered].sort(), [...STATES].sort(), "every real state must be classified one way or the other");
});

for (const state_ of LEGACY_ENGAGED_STATES) {
  test(`9-18. hasLegacySocialWorkStarted(status="${state_}") is true, and such a story is excluded from candidacy`, () => {
    assert.equal(hasLegacySocialWorkStarted({ status: state_ }), true);
    const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "12:00");
    const s = story({ id: `legacy-${state_}`, importance_score: 99, first_published_at: new Date(windowStartMs + 1000).toISOString() });
    let socialState = stateWithSyncedStories([s]);
    socialState = withStatus(socialState, s.id, state_);
    const candidates = findWindowCandidates([s], socialState.stories, windowStartMs, easternWallClockToUtcMillis("2026-09-10", "14:00"));
    assert.equal(candidates.length, 0, `a story with status "${state_}" must never be selectable`);
  });
}

test("19. an automatically-queued, otherwise-untouched story REMAINS selectable — excluding all queued stories would make the selector unusable", () => {
  assert.equal(hasLegacySocialWorkStarted({ status: "queued" }), false);
  assert.equal(hasLegacySocialWorkStarted({ status: "new" }), false);
  const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "12:00");
  const s = story({ id: "still-queued", importance_score: 10, first_published_at: new Date(windowStartMs + 1000).toISOString() });
  let socialState = stateWithSyncedStories([s]);
  socialState = withStatus(socialState, s.id, "queued");
  const candidates = findWindowCandidates([s], socialState.stories, windowStartMs, easternWallClockToUtcMillis("2026-09-10", "14:00"));
  assert.equal(candidates.length, 1, "a merely-queued story (zero content-creation progress) must remain selectable");
});

test("20. one story cannot have BOTH an existing legacy workflow AND a new fixed-window selection", () => {
  const windowStartMs = easternWallClockToUtcMillis("2026-09-10", "12:00");
  const s = story({ id: "dual-workflow-guard", importance_score: 99, first_published_at: new Date(windowStartMs + 1000).toISOString() });
  let socialState = stateWithSyncedStories([s]);
  socialState = withStatus(socialState, s.id, "awaiting_approval"); // deep in the legacy pipeline
  const now = et("2026-09-10", "12:00");
  const result = runSelectionEngine({ state: socialState, stories: [s], now });
  assert.equal(result.state.stories[s.id].selection, undefined, "a legacy-engaged story must never also receive a new selection");
  const feedSlot = result.processedSlots.find((p) => p.slot_id.includes("T12:00") && p.slot_id.startsWith("feed:"));
  assert.equal(feedSlot.status, "no_candidate");
});

// ---------------------------------------------------------------------------
// Duplicate-safety / idempotency
// ---------------------------------------------------------------------------

test("one story cannot win two different slots in the same run", () => {
  const s = story({ id: "one-story", importance_score: 99, first_published_at: et("2026-09-10", "07:00") });
  const state = stateWithSyncedStories([s]);
  const now = et("2026-09-10", "08:00"); // first-ever activation exactly at 08:00 -> only Feed08:00 is due
  const result = runSelectionEngine({ state, stories: [s], now });
  const winsFor = result.processedSlots.filter((p) => p.story_id === "one-story");
  assert.equal(winsFor.length, 1, "the same story must win at most one slot, ever");
});

test("one slot cannot select twice across repeated runs", async () => {
  const s1 = story({ id: "first", importance_score: 10, first_published_at: et("2026-09-10", "07:00") });
  const s2 = story({ id: "second", importance_score: 99, first_published_at: et("2026-09-10", "07:15") });
  const now1 = et("2026-09-10", "08:00");
  const run1 = runSelectionEngine({ state: stateWithSyncedStories([s1]), stories: [s1], now: now1 });
  const feedSlotId = run1.processedSlots[0].slot_id;
  assert.equal(run1.processedSlots.find((p) => p.slot_id === feedSlotId).story_id, "first");

  const now2 = et("2026-09-10", "08:05");
  const run2 = runSelectionEngine({ state: stateWithSyncedStories([s2], run1.state), stories: [s1, s2], now: now2 });
  assert.equal(run2.processedSlots.filter((p) => p.slot_id === feedSlotId).length, 0, "an already-processed slot must never appear in processedSlots again");
  assert.equal(run2.state.selection_slots[feedSlotId].story_id, "first", "the original winner must never be replaced");
});

test("repeated runs with no new due slots are fully idempotent (no state churn)", () => {
  const s = story({ id: "idempotent-story", importance_score: 10, first_published_at: et("2026-09-10", "07:00") });
  const state = stateWithSyncedStories([s]);
  const now = et("2026-09-10", "08:00");
  const run1 = runSelectionEngine({ state, stories: [s], now });
  const run2 = runSelectionEngine({ state: run1.state, stories: [s], now });
  assert.deepEqual(run2.state, run1.state);
  assert.deepEqual(run2.processedSlots, []);
});

test("a slot with no eligible candidate is recorded deterministically as no_candidate, never fabricated", () => {
  const now = et("2026-09-10", "08:00");
  const result = runSelectionEngine({ state: emptyState(), stories: [], now });
  assert.equal(result.processedSlots[0].status, "no_candidate");
  assert.equal(result.processedSlots[0].story_id, null);
  assert.equal(result.state.selection_slots[result.processedSlots[0].slot_id].status, "no_candidate");
});

// ---------------------------------------------------------------------------
// ACTIVATION BOUNDARY — corrected semantics: persist the EXACT activation
// instant; slots strictly before it are permanently ignored (never even
// recorded as no_candidate); the first eligible slot is the first one
// whose slot_time >= activation_time, picked up whenever a later refresh
// first reaches or passes it.
// ---------------------------------------------------------------------------

test("A1. first activation at 13:37 ET does not backfill any earlier same-day slot", () => {
  const now = et("2026-09-10", "13:37");
  const result = runSelectionEngine({ state: emptyState(), stories: [], now });
  assert.equal(result.activated, true);
  assert.equal(result.state.selection_activated_at, now, "the persisted boundary must be the EXACT activation instant, not start-of-day or any other derived value");
  // Nothing is due yet at the exact activation instant (13:37 matches no slot boundary) — the activation run itself selects nothing.
  assert.deepEqual(result.processedSlots, []);
  // Critically: none of the earlier slots (08:00 Feed, 09:00/10:00/11:00/12:00/13:00 Story, 10:00/12:00 Feed) were ever recorded at all — not even as no_candidate.
  assert.deepEqual(result.state.selection_slots, {}, "pre-activation slots must be permanently ignored, never written as no_candidate");
});

test("A2. the first eligible slot after a 13:37 activation is processed on the NEXT refresh that reaches it (14:00)", () => {
  const activateNow = et("2026-09-10", "13:37");
  const activated = runSelectionEngine({ state: emptyState(), stories: [], now: activateNow });

  const s = story({ id: "after-activation", importance_score: 10, first_published_at: et("2026-09-10", "13:45") });
  const laterNow = et("2026-09-10", "14:05"); // next refresh, ~28 minutes later, past the 14:00 boundary
  const result = runSelectionEngine({ state: stateWithSyncedStories([s], activated.state), stories: [s], now: laterNow });

  const slotIds = result.processedSlots.map((p) => p.slot_id);
  assert.ok(slotIds.some((id) => id.startsWith("feed:") && id.includes("T14:00")), "the first eligible Feed slot (14:00) must be processed");
  assert.ok(slotIds.some((id) => id.startsWith("story:") && id.includes("T14:00")), "the first eligible Story slot (14:00) must be processed");
  // Nothing earlier than the 13:37 activation instant is ever present.
  assert.ok(!slotIds.some((id) => id.includes("T13:00") || id.includes("T12:00") || id.includes("T11:00") || id.includes("T10:00") || id.includes("T09:00") || id.includes("T08:00")));
  const feedWin = result.processedSlots.find((p) => p.slot_id.startsWith("feed:") && p.slot_id.includes("T14:00"));
  assert.equal(feedWin.story_id, "after-activation");
});

test("A3. activation exactly AT a slot boundary (14:00:00.000) allows that slot", () => {
  const now = et("2026-09-10", "14:00");
  const result = runSelectionEngine({ state: emptyState(), stories: [], now });
  const slotIds = result.processedSlots.map((p) => p.slot_id);
  assert.ok(slotIds.some((id) => id.includes("T14:00")), "a slot whose time exactly equals the activation instant must be included (inclusive lower bound)");
});

test("A4. activation one second AFTER a slot boundary (14:00:01) excludes that slot", () => {
  const now = new Date(easternWallClockToUtcMillis("2026-09-10", "14:00") + 1000).toISOString();
  const result = runSelectionEngine({ state: emptyState(), stories: [], now });
  const slotIds = result.processedSlots.map((p) => p.slot_id);
  assert.ok(!slotIds.some((id) => id.includes("T14:00")), "a slot one second before activation must be permanently excluded, never processed");
  assert.equal(result.state.selection_activated_at, now);
});

test("A5. activation after the final daily slot (22:00 Feed / 20:00 Story) produces no same-day selection", () => {
  const now = et("2026-09-10", "23:00");
  const result = runSelectionEngine({ state: emptyState(), stories: [], now });
  assert.deepEqual(result.processedSlots, []);
  assert.deepEqual(result.state.selection_slots, {});
});

test("A6. the next day's first slot (Feed 08:00) works normally after a late activation the previous night", () => {
  const activateNow = et("2026-09-10", "23:00");
  const activated = runSelectionEngine({ state: emptyState(), stories: [], now: activateNow });

  const s = story({ id: "next-day-story", importance_score: 10, first_published_at: et("2026-09-11", "07:30") });
  const laterNow = et("2026-09-11", "08:10");
  const result = runSelectionEngine({ state: stateWithSyncedStories([s], activated.state), stories: [s], now: laterNow });

  const feedSlot = result.processedSlots.find((p) => p.slot_id.startsWith("feed:") && p.slot_id.includes("2026-09-11T08:00"));
  assert.ok(feedSlot, "the next day's 08:00 Feed slot must be processed normally");
  assert.equal(feedSlot.story_id, "next-day-story");
});

test("A7. persisted activation survives a fresh 'restart' (a brand-new engine invocation reading the same state)", () => {
  const activateNow = et("2026-09-10", "13:37");
  const activated = runSelectionEngine({ state: emptyState(), stories: [], now: activateNow });
  // Simulate a process restart: a completely separate call, fed only the persisted state.
  const restartedNow = et("2026-09-10", "14:05");
  const afterRestart = runSelectionEngine({ state: activated.state, stories: [], now: restartedNow });
  assert.equal(afterRestart.state.selection_activated_at, activateNow, "activation must never be re-derived or reset across restarts");
  assert.equal(afterRestart.activated, false);
});

test("A8. activation before the first daily slot still only catches slots at/after the exact activation instant", () => {
  const now = et("2026-09-10", "06:00"); // before Feed 08:00 and Story 09:00
  const result = runSelectionEngine({ state: emptyState(), stories: [], now });
  assert.deepEqual(result.processedSlots, [], "no slot is due yet at 06:00");
  assert.equal(result.state.selection_activated_at, now);
});

test("A9. repeated refresh at the same `now` remains idempotent even right after activation", () => {
  const now = et("2026-09-10", "13:37");
  const run1 = runSelectionEngine({ state: emptyState(), stories: [], now });
  const run2 = runSelectionEngine({ state: run1.state, stories: [], now });
  assert.deepEqual(run2.state, run1.state);
  assert.deepEqual(run2.processedSlots, []);
});

// ---------------------------------------------------------------------------
// Destination isolation / legacy compatibility
// ---------------------------------------------------------------------------

test("27. a Feed slot selection records destination: 'feed' only", () => {
  const s = story({ id: "feed-only", importance_score: 10, first_published_at: et("2026-09-10", "07:30") });
  const now = et("2026-09-10", "08:00");
  const result = runSelectionEngine({ state: stateWithSyncedStories([s]), stories: [s], now });
  assert.equal(result.state.stories["feed-only"].selection.destination, "feed");
});

test("28. a Story slot selection records destination: 'story' only", () => {
  const s = story({ id: "story-only", importance_score: 10, first_published_at: et("2026-09-10", "08:30") });
  const now = et("2026-09-10", "09:00");
  const result = runSelectionEngine({ state: stateWithSyncedStories([s]), stories: [s], now });
  assert.equal(result.state.stories["story-only"].selection.destination, "story");
});

test("29. a newly selected story never receives both a Feed AND a Story selection", () => {
  const s = story({ id: "single-dest", importance_score: 99, first_published_at: et("2026-09-10", "09:00") });
  const now = et("2026-09-10", "10:00"); // both Feed and Story due simultaneously on first activation
  const result = runSelectionEngine({ state: stateWithSyncedStories([s]), stories: [s], now });
  const wins = result.processedSlots.filter((p) => p.story_id === "single-dest");
  assert.equal(wins.length, 1);
});

test("30. existing legacy paired social-state records (both artwork and story_artwork present, no `selection` field) remain fully readable and untouched", () => {
  const s = story({ id: "legacy-paired", importance_score: 10, first_published_at: "2020-01-01T00:00:00Z" });
  const state = stateWithSyncedStories([s]);
  const legacyRecord = state.stories["legacy-paired"];
  assert.ok("artwork" in legacyRecord && "story_artwork" in legacyRecord);
  assert.ok(!("selection" in legacyRecord));
  const now = et("2026-09-10", "08:00");
  const result = runSelectionEngine({ state, stories: [s], now });
  assert.deepEqual(result.state.stories["legacy-paired"], legacyRecord);
});

// ---------------------------------------------------------------------------
// Human approval / no publishing / no Meta
// ---------------------------------------------------------------------------

test("31/32. selection never sets approval.status to anything but its existing default, and never transitions story status toward awaiting_approval", () => {
  const s = story({ id: "approval-check", importance_score: 10, first_published_at: et("2026-09-10", "07:30") });
  const now = et("2026-09-10", "08:00");
  const result = runSelectionEngine({ state: stateWithSyncedStories([s]), stories: [s], now });
  const record = result.state.stories["approval-check"];
  assert.equal(record.approval.status, "pending");
  assert.equal(record.status, "new", "selection must never change the record's own state-machine status");
});

test("33/34. selectionEngine.js and generate-selection.js contain no publishing/Meta/Instagram API calls or imports", async () => {
  const { readFile } = await import("node:fs/promises");
  const engineSrc = await readFile(new URL("../lib/selectionEngine.js", import.meta.url), "utf-8");
  const shellSrc = await readFile(new URL("../generate-selection.js", import.meta.url), "utf-8");
  for (const src of [engineSrc, shellSrc]) {
    assert.ok(!/from\s+["'].*(instagram|facebook|meta|graph)/i.test(src));
    assert.ok(!/fetch\s*\(/.test(src));
    assert.ok(!/access_token/i.test(src));
  }
});

// ---------------------------------------------------------------------------
// Authority isolation
// ---------------------------------------------------------------------------

test("35. selection ranking is driven by story.importance_score", async () => {
  const { readFile } = await import("node:fs/promises");
  const engineSrc = await readFile(new URL("../lib/selectionEngine.js", import.meta.url), "utf-8");
  assert.ok(engineSrc.includes("importance_score"));
});

test("36. editorial_score_preview/enriched_total/Stage 2B shadow modules are never IMPORTED by the selection engine", async () => {
  const { readFile } = await import("node:fs/promises");
  const engineSrc = await readFile(new URL("../lib/selectionEngine.js", import.meta.url), "utf-8");
  const shellSrc = await readFile(new URL("../generate-selection.js", import.meta.url), "utf-8");
  for (const src of [engineSrc, shellSrc]) {
    assert.ok(!/from\s+["'].*editorialEnrichmentShadow/.test(src));
    assert.ok(!/from\s+["'].*editorialScoring/.test(src));
    assert.ok(!/from\s+["'].*editorialEnrichmentContext/.test(src));
  }
  assert.ok(!engineSrc.includes("story.editorial_score_preview") && !engineSrc.includes(".enriched_total"));
});

test("37. no reference to nflRelevance anywhere in the new selection code", async () => {
  const { readFile } = await import("node:fs/promises");
  const engineSrc = await readFile(new URL("../lib/selectionEngine.js", import.meta.url), "utf-8");
  const shellSrc = await readFile(new URL("../generate-selection.js", import.meta.url), "utf-8");
  assert.ok(!/nflRelevance/.test(engineSrc));
  assert.ok(!/nflRelevance/.test(shellSrc));
});

// ---------------------------------------------------------------------------
// Failure isolation / persistence — every persistence-touching test uses an
// explicit temp filePath; the REAL data/social-state.json is never opened.
// ---------------------------------------------------------------------------

test("38. generateSelection() never throws, even under a real write failure — and NEVER touches the real production social-state.json", async () => {
  await withTempDir(async (dir) => {
    const healthyPath = path.join(dir, "social-state.json");
    const ok = await generateSelection([story({ id: "x", first_published_at: new Date().toISOString() })], { now: new Date().toISOString(), filePath: healthyPath });
    assert.equal(ok.ok, true);

    const blockerFile = path.join(dir, "im-a-file-not-a-directory");
    await fsWriteFile(blockerFile, "x", "utf-8");
    const brokenPath = path.join(blockerFile, "social-state.json");
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const result = await generateSelection([story({ id: "y", first_published_at: new Date().toISOString() })], { now: new Date().toISOString(), filePath: brokenPath });
      assert.equal(result.ok, false);
      assert.ok(warned, "a selection failure must produce a visible warning, never be silently hidden");
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("39. selection state is written atomically (temp-file + rename) via the existing socialState.js writer — verified via a real round-trip", async () => {
  const { writeSocialState, readSocialState } = await import("../lib/socialState.js");
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "social-state.json");
    const s = story({ id: "atomic-check", importance_score: 10, first_published_at: et("2026-09-10", "07:30") });
    const now = et("2026-09-10", "08:00");
    const result = runSelectionEngine({ state: stateWithSyncedStories([s]), stories: [s], now });
    await writeSocialState(result.state, filePath);
    const readBack = await readSocialState(filePath);
    assert.equal(readBack.stories["atomic-check"].selection.destination, "feed");
    assert.ok(readBack.selection_activated_at);
  });
});

test("40. a malformed existing social-state file fails safely when read through readSocialState() (pre-existing behavior, untouched by Stage 3A)", async () => {
  const { readSocialState } = await import("../lib/socialState.js");
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "social-state.json");
    await fsWriteFile(filePath, "{ not valid json", "utf-8");
    await assert.rejects(() => readSocialState(filePath));
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
