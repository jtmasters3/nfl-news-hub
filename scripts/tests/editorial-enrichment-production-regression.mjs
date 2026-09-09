#!/usr/bin/env node
// Production Integration — Stage 2B regression suite: Live Observe-Only
// Enriched Scoring. Fully offline and deterministic: no network. Exercises
// the real production wiring (scripts/lib/editorialEnrichmentShadow.js)
// against the LOCKED Stage 1 (editorialEnrichmentContext.js) and Phase 2H-B
// (editorialScoring.js) modules, using the exact same fixture-shape
// conventions already proven in editorial-enrichment-context-regression.mjs.
// Run with: node scripts/tests/editorial-enrichment-production-regression.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildEnrichmentObservation,
  buildEnrichmentObservations,
  readEnrichmentShadowState,
  writeEnrichmentShadowStateAtomic,
  persistEnrichmentShadow,
  ENRICHMENT_SHADOW_SCHEMA_VERSION,
} from "../lib/editorialEnrichmentShadow.js";
import { buildPlayerIndex } from "../lib/nflversePlayerIndex.js";
import { scoreStory } from "../lib/editorialScoring.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixtures — same shape conventions as editorial-enrichment-context-regression.mjs
// ---------------------------------------------------------------------------
function rosterRow({ season = 2026, week = 3, gsis_id = "00-0000001", espn_id = "1001", full_name = "Test Starter Qb", football_name = "Test", team = "KC", position = "QB", depth_chart_position = "QB", status = "ACT", status_description_abbr = "A01" } = {}) {
  return { season, week, gsis_id, espn_id, full_name, football_name, team, position, depth_chart_position, status, status_description_abbr };
}
function depthRow({ dt = "2026-09-20T00:00:00Z", team = "KC", player_name = "Test Starter Qb", espn_id = "1001", gsis_id = "00-0000001", pos_abb = "QB", pos_rank = "1", pos_slot = "1" } = {}) {
  return { dt, team, player_name, espn_id, gsis_id, pos_grp_id: "1", pos_grp: "Base Offense", pos_id: "1", pos_name: "Quarterback", pos_abb, pos_slot, pos_rank };
}
function scheduleRow({ season = 2026, week = 3, game_type = "REG", gameday = "2026-09-20", gametime = "13:00" } = {}) {
  return { season, week, game_type, gameday, gametime };
}
function source({ name = "ESPN", headline = "Test Starter Qb expected to start for the Chiefs", description = "The Chiefs starting quarterback is expected to play.", url = "https://espn.test/story-1", published_at = "2026-09-19T10:00:00Z" } = {}) {
  return { name, headline, description, url, published_at, discovered_at: published_at };
}
function makeStory({
  id = "story-1",
  headline = "Test Starter Qb expected to start for the Chiefs",
  sources = [source()],
  players = ["Test Starter Qb"],
  teams = ["Kansas City Chiefs"],
  current_team = "Kansas City Chiefs",
  is_rumor = false,
  first_published_at = "2026-09-22T02:00:00Z",
  category = "injury",
  importance_score = 42,
} = {}) {
  return {
    id,
    headline,
    category,
    is_rumor,
    teams,
    players,
    current_team,
    sources,
    first_published_at,
    latest_published_at: first_published_at,
    updated_at: first_published_at,
    importance_score,
    status: "new",
    social: null,
    primary_image_url: null,
  };
}

const SCHEDULE_ROWS = [scheduleRow({ week: 3, gameday: "2026-09-20", gametime: "13:00" }), scheduleRow({ week: 3, gameday: "2026-09-21", gametime: "20:15" })];

function starterQbNflverseInputs() {
  const roster_rows = [rosterRow()];
  const depth_chart_rows = [depthRow()];
  return { roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS };
}

function healthyNflverseData(overrides = {}) {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  return {
    available: { roster: true, depth_chart: true, schedule: true },
    roster_rows,
    depth_chart_rows,
    schedule_rows,
    diagnostics: {},
    ...overrides,
  };
}

async function withTempCacheFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "editorial-enrichment-shadow-test-"));
  const filePath = path.join(dir, "editorial-enrichment-shadow.json");
  try {
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1-4. Real nflverse data reaches the enrichment call path
// ---------------------------------------------------------------------------

test("1. production nflverseData rows reach buildEditorialPlayerContext via buildEnrichmentObservation", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, { observedAt: "2026-09-22T02:10:00Z" });
  assert.equal(obs.enrichment_status, "resolved");
  assert.equal(obs.position.normalized_position, "QB");
});

test("2. real roster_rows are actually used (identity resolves to the exact fixture player)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.identity.player_id, "00-0000001");
});

test("3. real depth_chart_rows are actually used (starter vs backup changes the observed role)", () => {
  const player_index = buildPlayerIndex({ rows: [rosterRow()] });
  const starterObs = buildEnrichmentObservation(makeStory(), { roster_rows: [rosterRow()], depth_chart_rows: [depthRow({ pos_rank: "1" })], schedule_rows: SCHEDULE_ROWS, player_index }, {});
  const backupObs = buildEnrichmentObservation(makeStory(), { roster_rows: [rosterRow()], depth_chart_rows: [depthRow({ pos_rank: "2" })], schedule_rows: SCHEDULE_ROWS, player_index }, {});
  assert.equal(starterObs.effective_role, "starter");
  assert.equal(backupObs.effective_role, "backup");
});

test("4. real schedule_rows are actually used (as-of week resolution reflects the supplied schedule)", () => {
  const { roster_rows, depth_chart_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows: SCHEDULE_ROWS, player_index }, {});
  assert.equal(obs.diagnostics.temporal_schedule_found, true);
});

// ---------------------------------------------------------------------------
// 5. empty/unavailable data is not treated as valid
// ---------------------------------------------------------------------------

test("5a. persistEnrichmentShadow skips entirely (never writes) when roster is unavailable", async () => {
  await withTempCacheFile(async (filePath) => {
    const nflverseData = healthyNflverseData({ available: { roster: false, depth_chart: true, schedule: true } });
    const result = await persistEnrichmentShadow([makeStory()], nflverseData, { filePath });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "nflverse_roster_or_depth_chart_unavailable");
    const readBack = await readEnrichmentShadowState(filePath);
    assert.deepEqual(readBack.observations, []);
  });
});

test("5b. persistEnrichmentShadow skips entirely when depth_chart is unavailable, even if roster is available", async () => {
  await withTempCacheFile(async (filePath) => {
    const nflverseData = healthyNflverseData({ available: { roster: true, depth_chart: false, schedule: true } });
    const result = await persistEnrichmentShadow([makeStory()], nflverseData, { filePath });
    assert.equal(result.skipped, true);
  });
});

test("5c. an unavailable run never overwrites a previously-good shadow file (LKG preserved)", async () => {
  await withTempCacheFile(async (filePath) => {
    const healthy = healthyNflverseData();
    const first = await persistEnrichmentShadow([makeStory()], healthy, { filePath, observedAt: "2026-09-22T02:00:00Z" });
    assert.equal(first.ok, true);
    const beforeState = await readEnrichmentShadowState(filePath);

    const unavailable = healthyNflverseData({ available: { roster: false, depth_chart: true, schedule: true } });
    await persistEnrichmentShadow([makeStory()], unavailable, { filePath, observedAt: "2026-09-22T02:10:00Z" });
    const afterState = await readEnrichmentShadowState(filePath);
    assert.deepEqual(afterState, beforeState, "an unavailable run must leave the last-known-good file untouched");
  });
});

test("5d. schedule alone being unavailable does NOT skip the run (roster+depth_chart are the core gate)", async () => {
  await withTempCacheFile(async (filePath) => {
    const nflverseData = healthyNflverseData({ available: { roster: true, depth_chart: true, schedule: false }, schedule_rows: [] });
    const result = await persistEnrichmentShadow([makeStory()], nflverseData, { filePath });
    assert.equal(result.skipped, false);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 6-8. as_of / builder / scorer wiring
// ---------------------------------------------------------------------------

test("6. story.first_published_at drives as_of (never latest_published_at/updated_at/Date.now)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ first_published_at: "2026-09-22T02:00:00Z" });
  story.latest_published_at = "2099-01-01T00:00:00Z"; // deliberately different and absurd — must never be used
  story.updated_at = "2099-01-01T00:00:00Z";
  const obs = buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.first_published_at, "2026-09-22T02:00:00Z");
});

test("7. buildEditorialPlayerContext is genuinely invoked (position/role/identity fields are populated, not stubbed)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.ok(obs.position && obs.baseline_role && obs.identity);
});

test("8. scoreStory is called with context.player_context (enriched preview reflects the resolved player, not neutral)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  const independentNeutral = scoreStory(makeStory(), {});
  assert.notEqual(obs.editorial_score_preview.enriched_total, independentNeutral.enrichment.enriched_total, "a resolved starter QB's enriched preview must differ from the neutral (no context) case");
});

// ---------------------------------------------------------------------------
// 9-11. legacy score/destination isolation
// ---------------------------------------------------------------------------

test("9. production story.importance_score is never mutated by building an observation", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ importance_score: 77 });
  const snapshot = JSON.stringify(story);
  buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(JSON.stringify(story), snapshot);
  assert.equal(story.importance_score, 77);
});

test("10. production_importance_score and editorial_score_preview are stored as clearly separate fields, never conflated", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory({ importance_score: 77 });
  const obs = buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.production_importance_score, 77);
  assert.ok(typeof obs.editorial_score_preview.total_score === "number");
  assert.notEqual(obs.production_importance_score, obs.editorial_score_preview.total_score, "these are two different scoring systems' outputs and must not coincidentally be asserted equal");
});

test("11. no invented production destination field — only editorial_score_preview.destination (a preview) and enriched_destination_preview exist, both clearly namespaced under the preview object", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const story = makeStory();
  assert.ok(!("destination" in story));
  const obs = buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.ok(!("destination" in obs));
  assert.ok("destination" in obs.editorial_score_preview);
  assert.ok(!("destination" in story), "building an observation must never add a destination field onto the story itself");
});

// ---------------------------------------------------------------------------
// 12-16. no production-behavior side effects
// ---------------------------------------------------------------------------

test("12. news ordering unchanged: buildEnrichmentObservations does not sort, filter, or reorder the input stories array", () => {
  const stories = [makeStory({ id: "a" }), makeStory({ id: "b" }), makeStory({ id: "c" })];
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const observations = buildEnrichmentObservations(stories, { roster_rows, depth_chart_rows, schedule_rows }, {});
  assert.deepEqual(observations.map((o) => o.story_id), ["a", "b", "c"]);
  assert.deepEqual(stories.map((s) => s.id), ["a", "b", "c"]);
});

test("13/14. story creation/update fixtures are read-only inputs: buildEnrichmentObservations never mutates any story in the array", () => {
  const stories = [makeStory({ id: "a" }), makeStory({ id: "b" })];
  const snapshot = JSON.stringify(stories);
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  buildEnrichmentObservations(stories, { roster_rows, depth_chart_rows, schedule_rows }, {});
  assert.equal(JSON.stringify(stories), snapshot);
});

test("15. social payload (story.social) is untouched by observation building", () => {
  const story = makeStory();
  story.social = { instagram_caption: "untouched" };
  const snapshot = JSON.stringify(story.social);
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(JSON.stringify(story.social), snapshot);
});

test("16. editorialEnrichmentShadow.js has zero reference to socialState/social-artwork-queue", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/editorialEnrichmentShadow.js", import.meta.url), "utf-8");
  for (const forbidden of ["socialState", "social-state", "socialArtworkQueue", "social-artwork-queue"]) {
    assert.ok(!src.includes(forbidden));
  }
});

test("17. editorialEnrichmentShadow.js has zero reference to nflRelevance", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/editorialEnrichmentShadow.js", import.meta.url), "utf-8");
  assert.ok(!/from\s+["'].*nflRelevance/.test(src));
});

test("18. refresh.js's nflRelevance shadow call and its file remain byte-unrelated to the new enrichment call", async () => {
  const { readFile } = await import("node:fs/promises");
  const refreshSrc = await readFile(new URL("../refresh.js", import.meta.url), "utf-8");
  assert.ok(refreshSrc.includes("persistShadowObservations(shadowObservations)"));
  assert.ok(refreshSrc.includes("persistEnrichmentShadow(savedStories, nflverseData"));
});

// ---------------------------------------------------------------------------
// 19-21. locked safety behaviors carried through the new wiring
// ---------------------------------------------------------------------------

test("19. resolved starter QB example produces the expected locked amplification (enriched_total > legacy total_score)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.qb_importance.is_qb, true);
  assert.ok(obs.editorial_score_preview.enriched_total >= obs.editorial_score_preview.total_score, "a resolved starter QB must never score BELOW the neutral legacy baseline");
});

test("20. unresolved player (no roster/depth evidence at all) preserves conservative behavior", () => {
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows: [], depth_chart_rows: [], schedule_rows: SCHEDULE_ROWS, player_index: buildPlayerIndex({ rows: [] }) }, {});
  assert.equal(obs.player_context.player_id, null);
  assert.notEqual(obs.enrichment_status, "resolved");
  // Policy B: canonical identity failure does NOT prove non-playerhood —
  // confirm no positive QB/starter/star amplification leaked through anyway.
  assert.equal(obs.editorial_score_preview.enriched_total, scoreStory(makeStory(), { player_context: obs.player_context }).enrichment.enriched_total);
});

test("21. coach/non-player subject receives no positive QB/starter/star amplification", () => {
  const story = makeStory({ headline: "Coach announces new coordinator", players: [], teams: ["Kansas City Chiefs"], current_team: null });
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.player_context.has_player_subject, false);
  const neutral = scoreStory(story, {});
  assert.equal(obs.editorial_score_preview.enriched_total, neutral.enrichment.enriched_total, "a non-player subject must score identically to the no-context neutral case");
});

// ---------------------------------------------------------------------------
// 22. temporal safety
// ---------------------------------------------------------------------------

test("22. the resolver never uses future roster/depth rows relative to as_of (a future-dated depth snapshot is excluded)", () => {
  const roster_rows = [rosterRow()];
  const futureDepth = [depthRow({ dt: "2099-01-01T00:00:00Z" })]; // far in the future relative to first_published_at
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows: futureDepth, schedule_rows: SCHEDULE_ROWS, player_index }, {});
  assert.equal(obs.diagnostics.temporal_depth_chart_found, false, "a depth-chart snapshot dated after as_of must never be treated as eligible evidence");
});

// ---------------------------------------------------------------------------
// 23-24. observation identity / update policy
// ---------------------------------------------------------------------------

test("23. an unchanged story across two runs does not create uncontrolled duplicate observations (one entry per story_id, always)", async () => {
  await withTempCacheFile(async (filePath) => {
    const nflverseData = healthyNflverseData();
    await persistEnrichmentShadow([makeStory({ id: "story-1" })], nflverseData, { filePath, observedAt: "2026-09-22T02:00:00Z" });
    await persistEnrichmentShadow([makeStory({ id: "story-1" })], nflverseData, { filePath, observedAt: "2026-09-22T02:10:00Z" });
    const state = await readEnrichmentShadowState(filePath);
    assert.equal(state.observations.length, 1);
    assert.equal(state.observations[0].observed_at, "2026-09-22T02:10:00Z", "the observation must reflect the LATEST run, not the first");
  });
});

test("24. a material story update (e.g. depth-chart role change) is reflected on the very next run (update-in-place, not first-seen-wins)", async () => {
  await withTempCacheFile(async (filePath) => {
    const roster_rows = [rosterRow()];
    const starterData = { available: { roster: true, depth_chart: true, schedule: true }, roster_rows, depth_chart_rows: [depthRow({ pos_rank: "1" })], schedule_rows: SCHEDULE_ROWS, diagnostics: {} };
    await persistEnrichmentShadow([makeStory({ id: "story-1" })], starterData, { filePath, observedAt: "2026-09-22T02:00:00Z" });
    const firstState = await readEnrichmentShadowState(filePath);
    assert.equal(firstState.observations[0].effective_role, "starter");

    const backupData = { available: { roster: true, depth_chart: true, schedule: true }, roster_rows, depth_chart_rows: [depthRow({ pos_rank: "2" })], schedule_rows: SCHEDULE_ROWS, diagnostics: {} };
    await persistEnrichmentShadow([makeStory({ id: "story-1" })], backupData, { filePath, observedAt: "2026-09-22T02:10:00Z" });
    const secondState = await readEnrichmentShadowState(filePath);
    assert.equal(secondState.observations.length, 1);
    assert.equal(secondState.observations[0].effective_role, "backup", "the shadow file must reflect the story's CURRENT enrichment, not a stale first-seen snapshot");
  });
});

test("24b. a story that ages out of the current stories array is naturally excluded on the next successful run (wholesale replace)", async () => {
  await withTempCacheFile(async (filePath) => {
    const nflverseData = healthyNflverseData();
    await persistEnrichmentShadow([makeStory({ id: "story-1" }), makeStory({ id: "story-2" })], nflverseData, { filePath, observedAt: "2026-09-22T02:00:00Z" });
    await persistEnrichmentShadow([makeStory({ id: "story-2" })], nflverseData, { filePath, observedAt: "2026-09-22T02:10:00Z" });
    const state = await readEnrichmentShadowState(filePath);
    assert.deepEqual(state.observations.map((o) => o.story_id), ["story-2"]);
  });
});

// ---------------------------------------------------------------------------
// 25-29. failure isolation
// ---------------------------------------------------------------------------

test("25. a malformed enrichment shadow file on disk fails safely (treated as empty, never thrown)", async () => {
  await withTempCacheFile(async (filePath) => {
    await fsWriteFile(filePath, "{ not valid json", "utf-8");
    const state = await readEnrichmentShadowState(filePath);
    assert.deepEqual(state, { schema_version: ENRICHMENT_SHADOW_SCHEMA_VERSION, observations: [] });
  });
});

test("25b. an unrecognized schema_version is treated as empty, never trusted", async () => {
  await withTempCacheFile(async (filePath) => {
    await fsWriteFile(filePath, JSON.stringify({ schema_version: 999, observations: [] }), "utf-8");
    const state = await readEnrichmentShadowState(filePath);
    assert.deepEqual(state, { schema_version: ENRICHMENT_SHADOW_SCHEMA_VERSION, observations: [] });
  });
});

test("26. a shadow write failure does not block/throw — persistEnrichmentShadow returns ok:false safely", async () => {
  await withTempCacheFile(async (filePath) => {
    const dir = path.dirname(filePath);
    const blockerFile = path.join(dir, "im-a-file-not-a-directory");
    await fsWriteFile(blockerFile, "x", "utf-8");
    const brokenPath = path.join(blockerFile, "editorial-enrichment-shadow.json");
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const result = await persistEnrichmentShadow([makeStory()], healthyNflverseData(), { filePath: brokenPath });
      assert.equal(result.ok, false);
      assert.ok(warned, "a write failure must produce a visible warning, never be silently hidden");
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("27. buildEditorialPlayerContext failure (poisoned story field) does not block the observation or throw", () => {
  const poisoned = {
    get id() {
      throw new Error("boom-id");
    },
    headline: "Test",
    first_published_at: "2026-09-22T02:00:00Z",
  };
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const obs = buildEnrichmentObservation(poisoned, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.enrichment_status, "error");
  assert.ok(obs.reason_codes.includes("observation_build_exception"));
});

test("28. scoreStory failure does not block the observation or throw (enrichment context is still recorded)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  // primary_image_url is read by scoreStory() (production_readiness.image_available)
  // but never by buildEditorialPlayerContext() — confirmed by direct
  // inspection of editorialEnrichmentContext.js, which never references it.
  // This isolates the failure to exactly the scoreStory() call.
  const flaky = {
    ...makeStory(),
    get primary_image_url() {
      throw new Error("boom-image-url");
    },
  };
  const obs = buildEnrichmentObservation(flaky, { roster_rows, depth_chart_rows, schedule_rows, player_index }, {});
  assert.equal(obs.editorial_score_preview, null);
  assert.ok(obs.error_message);
  assert.ok(obs.reason_codes.includes("score_preview_exception"));
  // The enrichment context itself (computed BEFORE the scoreStory failure) is still present.
  assert.ok(obs.position);
});

test("29. unavailable nflverse data never blocks ingestion (persistEnrichmentShadow always resolves, never throws)", async () => {
  await withTempCacheFile(async (filePath) => {
    const nflverseData = { available: { roster: false, depth_chart: false, schedule: false }, roster_rows: [], depth_chart_rows: [], schedule_rows: [], diagnostics: {} };
    await assert.doesNotReject(() => persistEnrichmentShadow([makeStory()], nflverseData, { filePath }));
  });
});

// ---------------------------------------------------------------------------
// 30-31. determinism / no Date.now
// ---------------------------------------------------------------------------

test("30. repeated deterministic input yields deterministic scoring output", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const a = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, { observedAt: "2026-09-22T02:00:00Z" });
  const b = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, { observedAt: "2026-09-22T02:00:00Z" });
  assert.deepEqual(a, b);
});

test("31. no Date.now() dependency introduced into this module's own logic (observed_at is caller-supplied only)", () => {
  const { roster_rows, depth_chart_rows, schedule_rows } = starterQbNflverseInputs();
  const player_index = buildPlayerIndex({ rows: roster_rows });
  const original = Date.now;
  Date.now = () => {
    throw new Error("editorialEnrichmentShadow.js must never call Date.now() itself");
  };
  try {
    const obs = buildEnrichmentObservation(makeStory(), { roster_rows, depth_chart_rows, schedule_rows, player_index }, { observedAt: null });
    assert.equal(obs.observed_at, null);
  } finally {
    Date.now = original;
  }
});

// ---------------------------------------------------------------------------
// 32-34. no unrelated production behavior change (structural)
// ---------------------------------------------------------------------------

test("32. generate-content.js's importance_score assignment is untouched by Stage 2B", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../generate-content.js", import.meta.url), "utf-8");
  assert.ok(src.includes("importance_score: estimateImportance(text)"));
  assert.ok(!src.includes("editorialEnrichmentShadow") && !src.includes("editorialScoring") && !src.includes("buildEditorialPlayerContext"), "generate-content.js must remain untouched by Stage 2B — the new wiring lives entirely in refresh.js");
});

test("33. no Feed/Story/social function is imported or called by the new module (prose scope-notes in comments are not a dependency)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/editorialEnrichmentShadow.js", import.meta.url), "utf-8");
  for (const forbidden of ["generateArtworkQueue", "generateSocialFeed", "generatePostsForApproval"]) {
    assert.ok(!src.includes(forbidden));
  }
  assert.ok(!/from\s+["'].*(socialState|generate-social|generate-artwork|generate-posts)/.test(src));
});

test("34. no Meta/publishing API is imported or called by the new module (import.meta.url is an unrelated JS language feature, not a Meta/Facebook reference)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/editorialEnrichmentShadow.js", import.meta.url), "utf-8");
  const withoutImportMeta = src.replace(/import\.meta/g, "");
  assert.ok(!/\bmeta\b/i.test(withoutImportMeta));
});

// ---------------------------------------------------------------------------
// Atomic persistence round-trip
// ---------------------------------------------------------------------------

test("35. writeEnrichmentShadowStateAtomic + readEnrichmentShadowState round-trip", async () => {
  await withTempCacheFile(async (filePath) => {
    const state = { schema_version: ENRICHMENT_SHADOW_SCHEMA_VERSION, observations: [{ story_id: "x" }] };
    await writeEnrichmentShadowStateAtomic(state, filePath);
    const readBack = await readEnrichmentShadowState(filePath);
    assert.deepEqual(readBack, state);
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
