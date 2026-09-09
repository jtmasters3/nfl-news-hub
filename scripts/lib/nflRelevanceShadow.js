// NFL-Only Ingestion Cleanup — Stage 3: Production Shadow Mode persistence.
// DIAGNOSTIC ONLY. Nothing here has any authority over ingestion,
// clustering, scoring, or social/artwork/approval/Meta decisions — it only
// records, verbatim, the output of the LOCKED classifyNflRelevance()
// (scripts/lib/nflRelevance.js, unmodified) for later human review across
// multiple refresh cycles.
//
// Pure record-building (buildShadowObservation, mergeShadowObservations) +
// a small atomic JSON store (readShadowState/writeShadowStateAtomic),
// mirroring the exact established repository convention already used by
// scripts/lib/nflverseCache.js: schema_version check on read (anything else
// — missing file, corrupt JSON, wrong/absent schema_version — is treated
// exactly like "no file yet", never trusted or repaired), temp-file +
// rename on write. Deliberately NOT importing store.js's private
// readJson/writeJsonAtomic — nflverseCache.js already established the
// precedent that each independent subsystem owns its own tiny copy of this
// pattern rather than taking a dependency on the main content pipeline's
// store, and this module follows that same precedent.
//
// ---------------------------------------------------------------------------
// PERSISTENCE ACROSS GITHUB ACTIONS RUNS — inspected, not assumed. The
// refresh workflow (.github/workflows/refresh.yml) commits with `git add
// -A`, not an explicit file allowlist — it stages and commits whatever
// changed anywhere in the working tree after `npm run refresh`. This means
// data/nfl-relevance-shadow.json persists across runs through the EXACT
// SAME mechanism news.json/data/social-state.json/data/processed-
// articles.json already do, with ZERO workflow changes required or made.
//
// ---------------------------------------------------------------------------
// OBSERVATION TIMESTAMP — no new Date.now()/new Date() call was added for
// this. refresh.js's main() already computes `startedAt = Date.now()` for
// its own elapsed-time logging; that SAME value (as an ISO string) is
// threaded through as `refreshRunAt` and reused here as each observation's
// `observed_at` — a genuine "which refresh run produced this" identifier,
// not a fresh per-article wall-clock call. If a caller doesn't supply one
// (e.g. a standalone/test invocation), `observed_at` is simply `null`,
// never fabricated.
// ---------------------------------------------------------------------------
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyNflRelevance } from "./nflRelevance.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SHADOW_PATH = path.join(ROOT, "data", "nfl-relevance-shadow.json");

export const SHADOW_SCHEMA_VERSION = 1;

// Dual-layer bounded retention — mirrors this repo's own established
// numbers exactly (scripts/lib/store.js: MAX_PROCESSED_AGE_DAYS = 45 for
// the processed-articles ledger this observation set is keyed the same way
// as; MAX_STORIES = 300 as the precedent for "cap regardless of age").
// Age-based pruning is primary; the count cap is a deterministic backstop
// for when observed_at is unavailable and age-based pruning can't apply.
export const MAX_SHADOW_OBSERVATION_AGE_DAYS = 45;
export const MAX_SHADOW_OBSERVATIONS = 2000;

function emptyState() {
  return { schema_version: SHADOW_SCHEMA_VERSION, observations: [] };
}

export async function readShadowState(filePath = SHADOW_PATH) {
  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState(); // corrupt file — treated exactly like "no file", never trusted
  }
  if (parsed?.schema_version !== SHADOW_SCHEMA_VERSION || !Array.isArray(parsed.observations)) {
    return emptyState(); // unrecognized shape — never guessed at, never repaired in place
  }
  return parsed;
}

export async function writeShadowStateAtomic(state, filePath = SHADOW_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Builds one diagnostic shadow record for a raw discovered article. Pure —
 * never mutates `article`. NEVER throws: a classifyNflRelevance() failure
 * (locked module, not expected to throw on ordinary input, but guarded
 * anyway per this stage's explicit failure-isolation requirement) is caught
 * and recorded as its own diagnostic entry rather than propagating.
 *
 * @param {{sourceId?: string, sourceName?: string, sourceUrl?: string, headline?: string, excerpt?: string, publishedAt?: string|null}} article
 * @param {{refreshRunAt?: string|null}} options
 */
export function buildShadowObservation(article, { refreshRunAt = null } = {}) {
  // The ENTIRE body is guarded, not just the classifier call — even reading
  // a field off `article` could theoretically throw (e.g. a getter), and
  // this function must never be the thing that breaks ingestion. A
  // catch-all fallback record is still identifiable by source_url when
  // that field itself is readable; if not even that is readable, the
  // record still carries a clear diagnostic reason code rather than
  // propagating.
  try {
    const base = {
      source_url: article?.sourceUrl ?? null,
      source_name: article?.sourceName ?? null,
      headline: article?.headline ?? null,
      published_at: article?.publishedAt ?? null,
      observed_at: refreshRunAt ?? null,
    };

    let classification;
    try {
      classification = classifyNflRelevance({
        sourceId: article?.sourceId ?? null,
        sourceName: article?.sourceName ?? null,
        sourceUrl: article?.sourceUrl ?? null,
        headline: article?.headline ?? null,
        excerpt: article?.excerpt ?? null,
      });
    } catch (err) {
      return {
        ...base,
        decision: null,
        classification: null,
        confidence: null,
        detected_teams: [],
        detected_category: null,
        nfl_evidence: [],
        non_nfl_evidence: [],
        reason_codes: ["classifier_exception"],
        error_message: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      ...base,
      decision: classification.decision,
      classification: classification.classification,
      confidence: classification.confidence,
      detected_teams: classification.detected_teams,
      detected_category: classification.detected_category,
      nfl_evidence: classification.nfl_evidence,
      non_nfl_evidence: classification.non_nfl_evidence,
      reason_codes: classification.reason_codes,
    };
  } catch (err) {
    let source_url = null;
    try {
      source_url = article?.sourceUrl ?? null;
    } catch {
      source_url = null;
    }
    return {
      source_url,
      source_name: null,
      headline: null,
      published_at: null,
      observed_at: refreshRunAt ?? null,
      decision: null,
      classification: null,
      confidence: null,
      detected_teams: [],
      detected_category: null,
      nfl_evidence: [],
      non_nfl_evidence: [],
      reason_codes: ["observation_build_exception"],
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pure merge: appends new observations onto existing state, deduplicated by
 * source_url (one URL -> one record; an already-recorded URL is never
 * duplicated or overwritten — first-seen wins), then applies bounded
 * retention. Never mutates `state` or `newObservations`.
 *
 * @param {{schema_version: number, observations: Array<object>}} state
 * @param {Array<object>} newObservations
 * @param {{maxAgeDays?: number, maxCount?: number, now?: string|null}} options - `now`, if supplied, must be an explicit ISO timestamp (never computed internally via Date.now()) used only to evaluate the age cutoff.
 */
export function mergeShadowObservations(state, newObservations, { maxAgeDays = MAX_SHADOW_OBSERVATION_AGE_DAYS, maxCount = MAX_SHADOW_OBSERVATIONS, now = null } = {}) {
  const existing = Array.isArray(state?.observations) ? state.observations : [];
  const seenUrls = new Set(existing.map((o) => o.source_url).filter(Boolean));

  const merged = existing.slice();
  for (const obs of Array.isArray(newObservations) ? newObservations : []) {
    if (!obs?.source_url) continue; // no identity to dedupe on — skip rather than guess
    if (seenUrls.has(obs.source_url)) continue; // one URL -> one record, first-seen wins
    seenUrls.add(obs.source_url);
    merged.push(obs);
  }

  // Age-based pruning only runs when an explicit `now` is supplied — never
  // Date.now() internally. A record with no observed_at of its own is never
  // age-pruned (nothing to compare against); the count cap below is the
  // backstop for that case.
  let pruned = merged;
  if (now) {
    const cutoff = Date.parse(now) - maxAgeDays * 86_400_000;
    pruned = merged.filter((o) => !o.observed_at || Date.parse(o.observed_at) >= cutoff);
  }

  if (pruned.length > maxCount) {
    pruned = pruned.slice(pruned.length - maxCount); // keep the newest maxCount; oldest-inserted trimmed first
  }

  return { schema_version: SHADOW_SCHEMA_VERSION, observations: pruned };
}

/**
 * End-to-end persist step for refresh.js: read -> merge -> atomic write.
 * NEVER throws — any failure (read, merge, write) is caught, logged as a
 * clear warning (never silently hidden), and swallowed, so a shadow-mode
 * problem can never block the real production refresh. This is the only
 * function in this module that performs its own top-level disk I/O
 * sequence end-to-end; generate-content.js itself never touches disk (see
 * its own "Pure data in / data out" header comment) — it only returns the
 * observations for refresh.js to pass here, exactly like it already does
 * for `stories`/`processedUrls`.
 */
export async function persistShadowObservations(newObservations, filePath = SHADOW_PATH) {
  if (!newObservations || newObservations.length === 0) return { ok: true, skipped: true, count: 0 };
  try {
    const state = await readShadowState(filePath);
    const latestObservedAt = newObservations[newObservations.length - 1]?.observed_at ?? null;
    const merged = mergeShadowObservations(state, newObservations, { now: latestObservedAt });
    await writeShadowStateAtomic(merged, filePath);
    return { ok: true, count: merged.observations.length };
  } catch (err) {
    console.warn(
      `[nfl-relevance-shadow] failed to persist shadow observations — production ingestion is unaffected: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
