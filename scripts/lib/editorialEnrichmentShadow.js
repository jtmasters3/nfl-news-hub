// Production Integration — Stage 2B: Live Observe-Only Enriched Scoring.
// DIAGNOSTIC ONLY. Composes three already-LOCKED modules — Stage 1's
// buildEditorialPlayerContext() (editorialEnrichmentContext.js), Phase
// 2H-B's scoreStory() (editorialScoring.js), and Stage A's real nflverse
// production data (nflverseProductionData.js) — into one per-refresh
// observation pass. Nothing here has any authority over production:
// story.importance_score, story.category, story.status, Feed/Story
// selection, social eligibility, artwork/caption/approval/posting, and NFL
// relevance filtering are all completely untouched by this module. Every
// field this module ever reads off a story is read-only; it never mutates
// a story object.
//
// ---------------------------------------------------------------------------
// WHOLESALE-REPLACE PERSISTENCE MODEL — deliberately different from
// scripts/lib/nflRelevanceShadow.js's incremental first-seen-wins dedup, for
// a reasoned reason: NFL-relevance classification is a one-time, immutable
// fact about a given article URL (classified once, forever). Editorial
// enrichment is the OPPOSITE — it is the CURRENT state of a STORY that can
// keep evolving for its entire lifetime (more sources arrive, identity
// resolves later, depth-chart role changes) via updateStory(). Since this
// module is called from the SAME existing per-refresh recompute pass that
// already recomputes players/visual-media/social/munch_content for every
// CURRENT story (not just ones touched this run — see generate-content.js's
// own comment on that loop), recomputing this diagnostic for every current
// story on every successful run and replacing the shadow file's observation
// set wholesale is simpler and more correct than incremental merging: it
// always reflects the CURRENT computed view of the CURRENT story set, it
// naturally excludes any story_id that has aged out of news.json (no
// separate retention/pruning logic needed), and "one observation per
// story_id, always updated in place" falls out for free.
//
// The one case where a wholesale replace would be wrong is when this run
// could not safely recompute at all (nflverse roster/depth-chart
// unavailable) — see buildEnrichmentObservations()'s own header comment for
// why that case SKIPS the shadow file entirely (preserving whatever was
// last successfully computed) rather than replacing it with garbage.
// ---------------------------------------------------------------------------
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEditorialPlayerContext } from "./editorialEnrichmentContext.js";
import { scoreStory } from "./editorialScoring.js";
import { buildPlayerIndex } from "./nflversePlayerIndex.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENRICHMENT_SHADOW_PATH = path.join(ROOT, "data", "editorial-enrichment-shadow.json");

export const ENRICHMENT_SHADOW_SCHEMA_VERSION = 1;

// Purely defensive backstop — a wholesale replace is already implicitly
// bounded by however many stories news.json currently retains (its own
// MAX_STORIES cap in store.js), so this should never actually trigger; it
// exists only to guarantee this file can never grow unbounded even if that
// upstream assumption is ever violated.
export const MAX_ENRICHMENT_OBSERVATIONS = 300;

function emptyState() {
  return { schema_version: ENRICHMENT_SHADOW_SCHEMA_VERSION, observations: [] };
}

export async function readEnrichmentShadowState(filePath = ENRICHMENT_SHADOW_PATH) {
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
    return emptyState(); // corrupt file — treated exactly like "no file yet", never trusted
  }
  if (parsed?.schema_version !== ENRICHMENT_SHADOW_SCHEMA_VERSION || !Array.isArray(parsed.observations)) {
    return emptyState(); // unrecognized shape — never guessed at, never repaired in place
  }
  return parsed;
}

export async function writeEnrichmentShadowStateAtomic(state, filePath = ENRICHMENT_SHADOW_PATH) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Builds one diagnostic observation for a single story. NEVER throws — any
 * exception anywhere in this chain (buildEditorialPlayerContext() already
 * fails open internally, but scoreStory() and the field-access below are
 * guarded here too, for the same defense-in-depth reasoning already applied
 * in nflRelevanceShadow.js's buildShadowObservation()) is caught and
 * recorded as its own diagnostic entry rather than propagating.
 *
 * Uses ONLY real, already-locked field names from buildEditorialPlayerContext()'s
 * and scoreStory()'s documented return shapes — never invented fields.
 *
 * @param {object} story
 * @param {{roster_rows: Array<object>, depth_chart_rows: Array<object>, schedule_rows: Array<object>, player_index: object}} nflverseInputs
 * @param {{observedAt?: string|null}} options
 */
export function buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, { observedAt = null } = {}) {
  try {
    // as_of is deliberately NOT passed — buildEditorialPlayerContext()'s own
    // locked default (story.first_published_at) is used untouched, per
    // Stage 1's locked as_of policy.
    const enrichment = buildEditorialPlayerContext({
      story,
      roster_rows,
      depth_chart_rows,
      schedule_rows,
      player_index,
    });

    let scorePreview = null;
    let scoreError = null;
    try {
      const scoreResult = scoreStory(story, { player_context: enrichment.player_context });
      scorePreview = {
        // editorialScoring.js's OWN internal legacy/baseline total — a
        // DIFFERENT scoring system from story.importance_score. Never
        // conflated with it; see this module's persistEnrichmentShadow()
        // caller (generate-content.js) for production_importance_score,
        // which is story.importance_score verbatim.
        total_score: scoreResult.total_score,
        destination: scoreResult.destination,
        enriched_total: scoreResult.enrichment.enriched_total,
        score_delta: scoreResult.enrichment.score_delta,
        score_delta_percent: scoreResult.enrichment.score_delta_percent,
        enriched_destination_preview: scoreResult.enrichment.enriched_destination_preview,
      };
    } catch (err) {
      scoreError = err instanceof Error ? err.message : String(err);
    }

    return {
      story_id: story?.id ?? null,
      headline: story?.headline ?? null,
      first_published_at: story?.first_published_at ?? null,
      observed_at: observedAt,
      production_importance_score: story?.importance_score ?? null,
      enrichment_status: enrichment.status,
      subject: enrichment.subject,
      identity: enrichment.identity
        ? { player_id: enrichment.identity.player_id, display_name: enrichment.identity.display_name, confidence: enrichment.identity.confidence, matched_by: enrichment.identity.matched_by }
        : null,
      position: enrichment.position ? { normalized_position: enrichment.position.normalized_position, confidence: enrichment.position.confidence } : null,
      baseline_role: enrichment.baseline_role ? { role: enrichment.baseline_role.role, confidence: enrichment.baseline_role.confidence } : null,
      fresh_role: enrichment.fresh_role ? { fresh_role: enrichment.fresh_role.fresh_role, confidence: enrichment.fresh_role.confidence, override_applies: enrichment.fresh_role.override_applies } : null,
      effective_role: enrichment.effective_role,
      qb_importance: enrichment.qb_importance,
      star: enrichment.star,
      player_context: enrichment.player_context,
      editorial_score_preview: scorePreview,
      diagnostics: enrichment.diagnostics,
      reason_codes: scoreError ? [...enrichment.reason_codes, "score_preview_exception"] : enrichment.reason_codes,
      error_message: scoreError,
    };
  } catch (err) {
    // Even reading fields off `story` for this fallback record could itself
    // throw (e.g. a poisoned getter) — guarded the same way
    // nflRelevanceShadow.js's buildShadowObservation() guards its own
    // catch-all fallback, so this function can truly never throw.
    let story_id = null;
    let headline = null;
    let first_published_at = null;
    let production_importance_score = null;
    try {
      story_id = story?.id ?? null;
      headline = story?.headline ?? null;
      first_published_at = story?.first_published_at ?? null;
      production_importance_score = story?.importance_score ?? null;
    } catch {
      // leave all four as null — nothing safely readable off this story
    }
    return {
      story_id,
      headline,
      first_published_at,
      observed_at: observedAt,
      production_importance_score,
      enrichment_status: "error",
      subject: null,
      identity: null,
      position: null,
      baseline_role: null,
      fresh_role: null,
      effective_role: null,
      qb_importance: null,
      star: null,
      player_context: null,
      editorial_score_preview: null,
      diagnostics: null,
      reason_codes: ["observation_build_exception"],
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Builds one observation per CURRENT story — the "wholesale replace" input
 * set. Never throws: each story's observation is independently guarded (see
 * buildEnrichmentObservation), so one story's failure can never affect any
 * other story's observation, or the overall array being returned.
 */
export function buildEnrichmentObservations(stories, { roster_rows, depth_chart_rows, schedule_rows }, { observedAt = null } = {}) {
  const player_index = buildPlayerIndex({ rows: Array.isArray(roster_rows) ? roster_rows : [] });
  const list = Array.isArray(stories) ? stories : [];
  return list
    .slice(0, MAX_ENRICHMENT_OBSERVATIONS)
    .map((story) => buildEnrichmentObservation(story, { roster_rows, depth_chart_rows, schedule_rows, player_index }, { observedAt }));
}

/**
 * End-to-end persist step for refresh.js. NEVER throws — any failure (read,
 * build, write) is caught, logged as a clear warning, and swallowed.
 *
 * `nflverseAvailable` must be true only when BOTH roster and depth-chart
 * data are genuinely available this run (schedule is a secondary,
 * optionally-absent signal per Stage 1's own locked "manual mode" —
 * schedule_rows defaults to null there). When core data is unavailable,
 * this run's shadow update is SKIPPED ENTIRELY — the existing file (last
 * computed with genuine evidence) is left untouched rather than being
 * replaced with a run that had nothing real to evaluate. This is the
 * "skip enriched scoring observation" option from the task spec, chosen
 * over "record a clearly unavailable diagnostic state" because it keeps
 * every persisted record honestly backed by real evidence, and because an
 * unavailable run is already visible via refresh.js's own [nflverse]
 * diagnostic log line — a second, redundant "unavailable" marker inside
 * this file would not add information.
 */
export async function persistEnrichmentShadow(stories, nflverseData, { observedAt = null, filePath = ENRICHMENT_SHADOW_PATH } = {}) {
  const nflverseAvailable = Boolean(nflverseData?.available?.roster && nflverseData?.available?.depth_chart);
  if (!nflverseAvailable) {
    return { ok: true, skipped: true, reason: "nflverse_roster_or_depth_chart_unavailable", count: 0 };
  }

  try {
    const observations = buildEnrichmentObservations(
      stories,
      {
        roster_rows: nflverseData.roster_rows,
        depth_chart_rows: nflverseData.depth_chart_rows,
        schedule_rows: nflverseData.schedule_rows,
      },
      { observedAt }
    );
    const state = { schema_version: ENRICHMENT_SHADOW_SCHEMA_VERSION, observations };
    await writeEnrichmentShadowStateAtomic(state, filePath);
    return { ok: true, skipped: false, count: observations.length };
  } catch (err) {
    console.warn(
      `[editorial-enrichment-shadow] failed to persist enrichment observations — production ingestion is unaffected: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
