// The Aggregate — Live Automation Acceleration, Stage 3A. Thin file-I/O
// shell around scripts/lib/selectionEngine.js's pure runSelectionEngine(),
// mirroring scripts/generate-artwork-queue.js's own shell pattern exactly.
// Read-modify-write against the SAME data/social-state.json document
// generateArtworkQueue() already syncs every current story into — this
// step runs strictly after that one (see scripts/refresh.js), so every
// story in `stories` is guaranteed to already have a social-state record.
//
// NEVER THROWS — selection/state-persistence failure must never block
// normal news ingestion (news.json/HTML/RSS/NFL relevance shadow/Stage 2B
// enrichment shadow), per this stage's own explicit failure-isolation
// requirement. Any failure here is caught, logged as a clear warning, and
// swallowed; the caller receives {ok: false} rather than a rejected promise.
import { readSocialState, writeSocialState } from "./lib/socialState.js";
import { runSelectionEngine } from "./lib/selectionEngine.js";

/**
 * @param {Array} stories - current news.json stories (post-prune, i.e. what writeNews() returned)
 * @param {{now?: string, filePath?: string}} [options] - `now` is the refresh's own run time, used ONLY for slot-schedule evaluation and activation bookkeeping (never for story eligibility, which always uses each story's own first_published_at). Defaults to the real current time when omitted. `filePath` overrides the real data/social-state.json path — tests must always supply a temp path here, exactly like persistShadowObservations()/persistEnrichmentShadow() already require elsewhere in this codebase.
 */
export async function generateSelection(stories, { now = new Date().toISOString(), filePath } = {}) {
  try {
    const state = await readSocialState(filePath);
    const result = runSelectionEngine({ state, stories, now });
    await writeSocialState(result.state, filePath);
    return {
      ok: true,
      activated: result.activated,
      processedSlots: result.processedSlots,
      selectedCount: result.processedSlots.filter((s) => s.status === "selected").length,
      noCandidateCount: result.processedSlots.filter((s) => s.status === "no_candidate").length,
    };
  } catch (err) {
    console.warn(
      `[selection] failed to run the fixed-window selection engine — production ingestion is unaffected: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
