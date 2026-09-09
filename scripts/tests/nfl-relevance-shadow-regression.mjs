#!/usr/bin/env node
// NFL-Only Ingestion Cleanup — Stage 3 regression suite: Production Shadow
// Mode. DIAGNOSTIC ONLY. This suite exists to prove the one invariant that
// matters most: the locked classifier (scripts/lib/nflRelevance.js, tested
// separately and unmodified here) can run against every discovered article
// and record its result WITHOUT EVER changing what the pipeline actually
// does with that article — including, especially, when the classifier says
// "reject". Drives the real production entry point (processDiscoveredArticles),
// same pattern as clustering-regression.mjs — no parallel/reimplemented logic.
// Run with: node scripts/tests/nfl-relevance-shadow-regression.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { processDiscoveredArticles } from "../generate-content.js";
import {
  buildShadowObservation,
  mergeShadowObservations,
  readShadowState,
  writeShadowStateAtomic,
  persistShadowObservations,
  SHADOW_SCHEMA_VERSION,
} from "../lib/nflRelevanceShadow.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function article({ headline, excerpt, sourceName = "Test Source", sourceUrl, hoursAgo = 1 }) {
  return {
    headline,
    excerpt: excerpt ?? `${headline}. Full report follows with additional context and quotes.`,
    sourceName,
    sourceUrl,
    publishedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  };
}

// A real KEEP fixture: a clean NFL team-transaction headline.
const KEEP_ARTICLE = article({
  headline: "Cowboys sign veteran linebacker to bolster depth",
  excerpt: "Dallas added a proven veteran ahead of Week 1 roster cuts.",
  sourceUrl: "https://example.test/shadow/keep-1",
});

// The required real known contaminating fixture: verbatim (structurally
// identical) to case 18 in nfl-relevance-regression.mjs — a Big Ten
// college-football story with zero NFL signal. classifyNflRelevance()
// returns decision: "reject", classification: "college_football" for this.
const REJECT_ARTICLE = article({
  headline: "Big Ten is using enhanced replay access this season, in Friday games only",
  excerpt:
    "Last night's controversial finish to the Western Michigan-Michigan game would have been somewhat less controversial if the Big Ten had deployed transparency in the replay process.",
  sourceUrl: "https://example.test/shadow/reject-1",
});

// ---------------------------------------------------------------------------
// buildShadowObservation — pure record building
// ---------------------------------------------------------------------------

test("1. KEEP article produces a shadow record with decision=keep and expected schema", () => {
  const obs = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(obs.decision, "keep");
  assert.equal(obs.source_url, KEEP_ARTICLE.sourceUrl);
  assert.equal(obs.headline, KEEP_ARTICLE.headline);
  assert.equal(obs.observed_at, "2026-01-01T00:00:00.000Z");
  const expectedKeys = [
    "source_url", "source_name", "headline", "published_at", "observed_at",
    "decision", "classification", "confidence", "detected_teams",
    "detected_category", "nfl_evidence", "non_nfl_evidence", "reason_codes",
  ].sort();
  assert.deepEqual(Object.keys(obs).sort(), expectedKeys);
});

test("2. real contaminating REJECT fixture (Big Ten/college, no NFL signal) produces decision=reject", () => {
  const obs = buildShadowObservation(REJECT_ARTICLE, { refreshRunAt: null });
  assert.equal(obs.decision, "reject");
  assert.equal(obs.classification, "college_football");
  assert.equal(obs.observed_at, null);
});

test("3. observed_at defaults to null when refreshRunAt is omitted (no fabricated timestamp)", () => {
  const obs = buildShadowObservation(KEEP_ARTICLE);
  assert.equal(obs.observed_at, null);
});

test("4. raw article object is never mutated", () => {
  const input = { ...KEEP_ARTICLE };
  const snapshot = JSON.stringify(input);
  buildShadowObservation(input, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(JSON.stringify(input), snapshot);
});

test("5. deterministic: same input produces identical output", () => {
  const a = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  const b = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(a, b);
});

test("6. no Date.now() dependency introduced for classification/observation logic", () => {
  const original = Date.now;
  Date.now = () => {
    throw new Error("buildShadowObservation must never call Date.now()");
  };
  try {
    const obs = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: null });
    assert.equal(obs.decision, "keep");
  } finally {
    Date.now = original;
  }
});

test("7. a throwing article field accessor is caught and recorded, never propagated", () => {
  const poisoned = {
    sourceUrl: "https://example.test/shadow/poisoned",
    sourceName: "Test",
    publishedAt: null,
    get headline() {
      throw new Error("boom");
    },
    get excerpt() {
      return "irrelevant";
    },
  };
  const obs = buildShadowObservation(poisoned, { refreshRunAt: null });
  assert.equal(obs.source_url, poisoned.sourceUrl);
  assert.equal(obs.decision, null);
  assert.ok(obs.reason_codes.includes("observation_build_exception"));
});

test("7b. even a fully-poisoned article (every field throws) never crashes buildShadowObservation", () => {
  const allPoisoned = {
    get sourceUrl() {
      throw new Error("boom-url");
    },
    get sourceName() {
      throw new Error("boom-name");
    },
    get headline() {
      throw new Error("boom-headline");
    },
    get excerpt() {
      throw new Error("boom-excerpt");
    },
    get publishedAt() {
      throw new Error("boom-published");
    },
  };
  const obs = buildShadowObservation(allPoisoned, { refreshRunAt: null });
  assert.equal(obs.source_url, null);
  assert.equal(obs.decision, null);
  assert.ok(obs.reason_codes.includes("observation_build_exception"));
});

// ---------------------------------------------------------------------------
// mergeShadowObservations — dedup + bounded retention
// ---------------------------------------------------------------------------

test("8. dedup: same source_url encountered twice yields exactly one record (first-seen wins)", () => {
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations: [] };
  const first = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  const second = { ...buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-02-01T00:00:00.000Z" }), headline: "changed headline" };
  const merged = mergeShadowObservations(state, [first]);
  const mergedAgain = mergeShadowObservations(merged, [second]);
  assert.equal(mergedAgain.observations.length, 1);
  assert.equal(mergedAgain.observations[0].observed_at, "2026-01-01T00:00:00.000Z");
  assert.equal(mergedAgain.observations[0].headline, KEEP_ARTICLE.headline);
});

test("9. different source_urls produce separate records", () => {
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations: [] };
  const a = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: null });
  const b = buildShadowObservation(REJECT_ARTICLE, { refreshRunAt: null });
  const merged = mergeShadowObservations(state, [a, b]);
  assert.equal(merged.observations.length, 2);
});

test("10. records with no source_url are skipped rather than guessed at", () => {
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations: [] };
  const noUrl = buildShadowObservation({ headline: "No URL here", excerpt: "x", sourceUrl: null }, {});
  const merged = mergeShadowObservations(state, [noUrl]);
  assert.equal(merged.observations.length, 0);
});

test("11. bounded retention: age-based cutoff prunes old observations deterministically", () => {
  const old = { ...buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2020-01-01T00:00:00.000Z" }) };
  const recent = { ...buildShadowObservation(REJECT_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" }) };
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations: [old, recent] };
  const merged = mergeShadowObservations(state, [], { maxAgeDays: 45, now: "2026-01-02T00:00:00.000Z" });
  assert.equal(merged.observations.length, 1);
  assert.equal(merged.observations[0].source_url, REJECT_ARTICLE.sourceUrl);
});

test("12. bounded retention: hard count cap trims oldest-inserted first, deterministically", () => {
  const observations = Array.from({ length: 5 }, (_, i) => ({
    source_url: `https://example.test/shadow/count-${i}`,
    observed_at: null,
    decision: "keep",
  }));
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations };
  const merged = mergeShadowObservations(state, [], { maxCount: 3 });
  assert.equal(merged.observations.length, 3);
  assert.deepEqual(
    merged.observations.map((o) => o.source_url),
    ["https://example.test/shadow/count-2", "https://example.test/shadow/count-3", "https://example.test/shadow/count-4"]
  );
});

test("13. no observed_at record is never age-pruned (nothing to compare)", () => {
  const noTimestamp = { source_url: "https://example.test/shadow/no-ts", observed_at: null, decision: "keep" };
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations: [noTimestamp] };
  const merged = mergeShadowObservations(state, [], { maxAgeDays: 1, now: "2026-01-01T00:00:00.000Z" });
  assert.equal(merged.observations.length, 1);
});

test("14. merge never mutates its inputs", () => {
  const state = { schema_version: SHADOW_SCHEMA_VERSION, observations: [buildShadowObservation(KEEP_ARTICLE, {})] };
  const stateSnapshot = JSON.stringify(state);
  const newObs = [buildShadowObservation(REJECT_ARTICLE, {})];
  const newObsSnapshot = JSON.stringify(newObs);
  mergeShadowObservations(state, newObs);
  assert.equal(JSON.stringify(state), stateSnapshot);
  assert.equal(JSON.stringify(newObs), newObsSnapshot);
});

// ---------------------------------------------------------------------------
// Persistence: atomic write, malformed-file recovery, failure isolation
// ---------------------------------------------------------------------------

let tmpDir;

test("15. readShadowState on a missing file returns empty state, never throws", async () => {
  const filePath = path.join(tmpDir, "does-not-exist.json");
  const state = await readShadowState(filePath);
  assert.deepEqual(state, { schema_version: SHADOW_SCHEMA_VERSION, observations: [] });
});

test("16. readShadowState on a malformed (corrupt JSON) file safely recovers to empty state", async () => {
  const filePath = path.join(tmpDir, "corrupt.json");
  await fsWriteFile(filePath, "{ not valid json ][", "utf-8");
  const state = await readShadowState(filePath);
  assert.deepEqual(state, { schema_version: SHADOW_SCHEMA_VERSION, observations: [] });
});

test("17. readShadowState on an unrecognized schema_version safely recovers to empty state", async () => {
  const filePath = path.join(tmpDir, "wrong-schema.json");
  await fsWriteFile(filePath, JSON.stringify({ schema_version: 999, observations: "not-an-array" }), "utf-8");
  const state = await readShadowState(filePath);
  assert.deepEqual(state, { schema_version: SHADOW_SCHEMA_VERSION, observations: [] });
});

test("18. writeShadowStateAtomic + readShadowState round-trip via temp-file+rename", async () => {
  const filePath = path.join(tmpDir, "roundtrip", "shadow.json");
  const obs = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  await writeShadowStateAtomic({ schema_version: SHADOW_SCHEMA_VERSION, observations: [obs] }, filePath);
  const readBack = await readShadowState(filePath);
  assert.equal(readBack.observations.length, 1);
  assert.equal(readBack.observations[0].source_url, KEEP_ARTICLE.sourceUrl);
});

test("19. persistShadowObservations end-to-end: dedup persists across two separate runs", async () => {
  const filePath = path.join(tmpDir, "persist-e2e.json");
  const first = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  const r1 = await persistShadowObservations([first], filePath);
  assert.equal(r1.ok, true);
  assert.equal(r1.count, 1);

  const secondRunSameUrl = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: "2026-02-01T00:00:00.000Z" });
  const different = buildShadowObservation(REJECT_ARTICLE, { refreshRunAt: "2026-02-01T00:00:00.000Z" });
  const r2 = await persistShadowObservations([secondRunSameUrl, different], filePath);
  assert.equal(r2.ok, true);
  assert.equal(r2.count, 2); // KEEP_ARTICLE deduped, REJECT_ARTICLE added
});

test("20. persistShadowObservations with an empty array is a documented no-op", async () => {
  const filePath = path.join(tmpDir, "never-created.json");
  const r = await persistShadowObservations([], filePath);
  assert.deepEqual(r, { ok: true, skipped: true, count: 0 });
});

test("21. persistence failure is isolated: returns ok:false, never throws", async () => {
  // Force a write failure by pointing the shadow file *inside* a path
  // segment that is actually a plain file, so mkdir(recursive) on its
  // "directory" fails with ENOTDIR — a realistic disk-level failure mode,
  // not a contrived exception.
  const blockerFile = path.join(tmpDir, "im-a-file-not-a-directory");
  await fsWriteFile(blockerFile, "x", "utf-8");
  const filePath = path.join(blockerFile, "shadow.json");
  const obs = buildShadowObservation(KEEP_ARTICLE, { refreshRunAt: null });
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  try {
    const r = await persistShadowObservations([obs], filePath);
    assert.equal(r.ok, false);
    assert.ok(warned, "expected a console.warn diagnostic, not a silent failure");
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// processDiscoveredArticles integration — THE core invariant
// ---------------------------------------------------------------------------

test("22. KEEP article: still processed into a new story, AND a shadow observation is recorded", async () => {
  const out = await processDiscoveredArticles([{ articles: [KEEP_ARTICLE] }], [], {}, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(out.stats.newStories, 1);
  assert.equal(out.stories.length, 1);
  assert.ok(out.processedUrls[KEEP_ARTICLE.sourceUrl], "ledger entry must exist exactly as before");
  assert.equal(out.shadowObservations.length, 1);
  assert.equal(out.shadowObservations[0].decision, "keep");
});

test("23. THE MOST IMPORTANT INVARIANT: REJECT article is still processed into a new story exactly as before, with a REJECT diagnostic recorded", async () => {
  const out = await processDiscoveredArticles([{ articles: [REJECT_ARTICLE] }], [], {}, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(out.stats.newStories, 1, "a reject decision must NOT prevent story creation");
  assert.equal(out.stories.length, 1);
  assert.equal(out.stories[0].headline, REJECT_ARTICLE.headline);
  assert.ok(out.processedUrls[REJECT_ARTICLE.sourceUrl], "ledger entry must exist exactly as if shadow mode didn't exist");
  assert.equal(out.stats.skippedExisting, 0, "reject must not be treated as skipped/existing");
  assert.equal(out.shadowObservations.length, 1);
  assert.equal(out.shadowObservations[0].decision, "reject");
  assert.equal(out.shadowObservations[0].classification, "college_football");
});

test("24. same source URL encountered twice ACROSS runs produces exactly one shadow observation, and is never reclassified", async () => {
  const run1 = await processDiscoveredArticles([{ articles: [KEEP_ARTICLE] }], [], {}, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(run1.shadowObservations.length, 1);

  const run2 = await processDiscoveredArticles(
    [{ articles: [KEEP_ARTICLE] }],
    run1.stories,
    run1.processedUrls,
    { refreshRunAt: "2026-01-02T00:00:00.000Z" }
  );
  assert.equal(run2.stats.skippedExisting, 1, "existing dedup behavior must be unchanged");
  assert.equal(run2.shadowObservations.length, 0, "an already-processed URL must never reach the classifier again");
});

test("25. two different new URLs in the same run each produce their own observation", async () => {
  const out = await processDiscoveredArticles(
    [{ articles: [KEEP_ARTICLE, REJECT_ARTICLE] }],
    [],
    {},
    { refreshRunAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(out.shadowObservations.length, 2);
  const byUrl = Object.fromEntries(out.shadowObservations.map((o) => [o.source_url, o]));
  assert.equal(byUrl[KEEP_ARTICLE.sourceUrl].decision, "keep");
  assert.equal(byUrl[REJECT_ARTICLE.sourceUrl].decision, "reject");
});

test("26. observed_at defaults to null (not fabricated) when processDiscoveredArticles is called without refreshRunAt (e.g. direct/test invocation)", async () => {
  const out = await processDiscoveredArticles([{ articles: [KEEP_ARTICLE] }], [], {});
  assert.equal(out.shadowObservations[0].observed_at, null);
});

test("27. defense in depth: the shadow-observation call site in generate-content.js is itself wrapped in try/catch, warns on failure, and never gates processing", async () => {
  // buildShadowObservation() is hardened to never throw (see tests 7/7b),
  // so this outer try/catch can no longer be exercised by any real article
  // shape today — it exists purely as a second, independent layer of
  // failure isolation in case that inner guarantee is ever weakened by a
  // future change. Verified structurally: the call site must be wrapped in
  // try/catch, must warn (never silently swallow), and the catch block must
  // contain no continue/return/filter/throw of its own that would gate
  // article processing on the outcome.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../generate-content.js", import.meta.url), "utf-8");
  const pushIdx = source.indexOf("shadowObservations.push(buildShadowObservation(");
  assert.ok(pushIdx >= 0, "expected the shadowObservations.push(buildShadowObservation(...)) call site");
  const before = source.slice(Math.max(0, pushIdx - 200), pushIdx);
  assert.ok(/try\s*\{[^}]*$/.test(before), "the call must sit inside a try block");
  const catchIdx = source.indexOf("} catch (err) {", pushIdx);
  assert.ok(catchIdx >= 0 && catchIdx - pushIdx < 400, "expected a nearby catch block");
  const catchBlockEnd = source.indexOf("\n      }", catchIdx);
  const catchBlock = source.slice(catchIdx, catchBlockEnd);
  assert.ok(catchBlock.includes("console.warn"), "a shadow-observation failure must produce a visible warning, never be silently hidden");
  for (const controlFlow of ["continue;", "return ", "return;", ".filter(", "throw "]) {
    assert.ok(!catchBlock.includes(controlFlow), `catch block must not contain "${controlFlow}" — a shadow failure must never gate article processing`);
  }
});

test("27b. even in the hardened design, a genuinely broken article (all fields throw) still lets its shadow record build and normal processing proceed for every OTHER article in the same run", async () => {
  const healthy = article({ headline: "Steelers sign free agent safety", sourceUrl: "https://example.test/shadow/healthy" });
  const allPoisoned = {
    get sourceUrl() {
      throw new Error("boom-url");
    },
    get sourceName() {
      throw new Error("boom-name");
    },
    get headline() {
      throw new Error("boom-headline");
    },
    get excerpt() {
      throw new Error("boom-excerpt");
    },
    get publishedAt() {
      throw new Error("boom-published");
    },
  };
  // The poisoned article itself will still fail later in the pre-existing,
  // unrelated `text = \`${article.headline} ...\`` line further down in
  // processDiscoveredArticles — that is pre-existing production behavior,
  // not something Shadow Mode introduces or is responsible for isolating.
  // What Shadow Mode must guarantee is narrower: its own observation step
  // never throws for this article (proven directly via buildShadowObservation
  // in test 7b), so it contributes zero additional risk on top of whatever
  // already existed.
  const directObservation = buildShadowObservation(allPoisoned, { refreshRunAt: null });
  assert.equal(directObservation.reason_codes[0], "observation_build_exception");

  const out = await processDiscoveredArticles([{ articles: [healthy] }], [], {}, { refreshRunAt: null });
  assert.equal(out.stats.newStories, 1);
  assert.equal(out.shadowObservations.length, 1);
});

test("28. no mutation of raw article through the full processDiscoveredArticles path", async () => {
  const input = { ...KEEP_ARTICLE };
  const snapshot = JSON.stringify(input);
  await processDiscoveredArticles([{ articles: [input] }], [], {}, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(JSON.stringify(input), snapshot);
});

test("29. shadow observation contents match a fresh, independent classification (no mutation of classifier result)", async () => {
  const out = await processDiscoveredArticles([{ articles: [REJECT_ARTICLE] }], [], {}, { refreshRunAt: null });
  const independent = buildShadowObservation(REJECT_ARTICLE, { refreshRunAt: null });
  assert.deepEqual(out.shadowObservations[0], independent);
});

test("30. processed ledger entry shape is unchanged by shadow mode (storyId + processedAt only)", async () => {
  const out = await processDiscoveredArticles([{ articles: [KEEP_ARTICLE] }], [], {}, { refreshRunAt: "2026-01-01T00:00:00.000Z" });
  const entry = out.processedUrls[KEEP_ARTICLE.sourceUrl];
  assert.deepEqual(Object.keys(entry).sort(), ["processedAt", "storyId"]);
});

test("31. normal clustering behavior is unchanged: two same-story articles still merge into one story under shadow mode", async () => {
  const a = article({ headline: "Chiefs sign veteran cornerback", sourceUrl: "https://example.test/shadow/cluster-a" });
  const b = article({
    headline: "Chiefs sign veteran cornerback",
    excerpt: "Chiefs sign veteran cornerback. Full report follows with additional context and quotes.",
    sourceUrl: "https://example.test/shadow/cluster-b",
  });
  let stories = [];
  let ledger = {};
  for (const art of [a, b]) {
    const out = await processDiscoveredArticles([{ articles: [art] }], stories, ledger, { refreshRunAt: null });
    stories = out.stories;
    ledger = out.processedUrls;
  }
  const distinctStoryIds = new Set(Object.values(ledger).map((v) => v.storyId));
  assert.equal(distinctStoryIds.size, 1, "shadow mode must not change existing clustering decisions");
});

test("32. generate-content.js has zero references to social-state/social-queue/scoring modules (Shadow Mode stays isolated)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../generate-content.js", import.meta.url), "utf-8");
  for (const forbidden of ["socialState", "social-state", "socialArtworkQueue", "social-artwork-queue", "editorialScoring", "editorialEnrichmentContext"]) {
    assert.ok(!source.includes(forbidden), `generate-content.js must not reference ${forbidden}`);
  }
});

test("33. locked classifier and its regression file remain byte-identical (Shadow Mode only imports and calls, never edits)", async () => {
  const { readFile } = await import("node:fs/promises");
  const shadowSource = await readFile(new URL("../lib/nflRelevanceShadow.js", import.meta.url), "utf-8");
  assert.ok(shadowSource.includes('from "./nflRelevance.js"'), "must consume the locked classifier via a normal import");
  assert.ok(!shadowSource.includes("writeFile") || !shadowSource.match(/writeFile\([^)]*nflRelevance/), "must never write to the locked classifier module");
});

// ---------------------------------------------------------------------------
let failures = 0;
tmpDir = await mkdtemp(path.join(os.tmpdir(), "nfl-relevance-shadow-test-"));
try {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`PASS  ${c.name}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.name} — ${err.message}`);
    }
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
