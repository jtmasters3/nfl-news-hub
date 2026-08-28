// Pure state-transition handlers for the three artwork-bridge events
// (claimed / completed / failed) fired by the Cloudflare Worker via
// repository_dispatch and applied by scripts/social/apply-artwork-event.js.
// Deliberately built entirely on top of scripts/lib/socialState.js's
// existing transition()/setLastError()/resolveCanonicalId() — this is NOT
// a second state machine, just event-shaped call sites into the one that
// already exists. `claim` is new, additive per-record metadata (lease
// bookkeeping: who currently owns the in-flight artwork job and until
// when) — added here via transition()'s patch mechanism, so
// scripts/lib/socialState.js itself never needs to change.
import { resolveCanonicalId, transition, setLastError } from "./socialState.js";
import { validateArtwork } from "./artworkValidation.js";

/**
 * queued -> artwork_requested, recording the new lease.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, processor_id: string, claimed_at: string, claim_expires_at: string, retry_count?: number}} payload
 */
export function applyClaimEvent(state, payload) {
  const { story_id, claim_id, processor_id, claimed_at, claim_expires_at, retry_count = 0 } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  // Two legal starting points: a genuinely fresh claim (record is
  // "queued"), or a lease-recovery claim on a story whose previous claim
  // expired (record is still "artwork_requested" — no transition needed,
  // just an ownership/lease update, since the state table has no "back to
  // queued" edge and this plan doesn't add one).
  if (resolved.record.status === "artwork_requested") {
    const updated = {
      ...resolved.record,
      claim: { claim_id, processor_id, claimed_at, claim_expires_at, retry_count },
      updated_at: new Date().toISOString(),
    };
    const next = { ...state, stories: { ...state.stories, [resolved.story_id]: updated } };
    return { state: next, ok: true, story_id: resolved.story_id, record: updated, recovered: true };
  }

  const result = transition(state, story_id, "artwork_requested", {
    claim: { claim_id, processor_id, claimed_at, claim_expires_at, retry_count },
  });
  if (!result.ok) return result;
  return { ...result, recovered: false };
}

/**
 * artwork_requested -> artwork_created -> validating -> (awaiting_approval | failed).
 * @param {object} state
 * @param {{story_id: string, claim_id: string, image_url: string, storage_key: string, width: number, height: number, mime_type: string, size_bytes: number, provider: string}} payload
 * @param {{reachable: boolean}} opts
 */
export function applyCompleteEvent(state, payload, { reachable }) {
  const { story_id, claim_id, image_url, storage_key, width, height, mime_type, size_bytes, provider } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (resolved.record.status !== "artwork_requested") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }
  if (!resolved.record.claim || resolved.record.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }

  const now = new Date().toISOString();
  let step = transition(state, story_id, "artwork_created", {
    artwork: {
      status: "created",
      image_url,
      storage_key,
      width,
      height,
      mime_type,
      size_bytes,
      provider,
      created_at: now,
    },
  });
  if (!step.ok) return step;

  step = transition(step.state, story_id, "validating");
  if (!step.ok) return step;

  const { passed, issues } = validateArtwork({ record: step.record, claimId: claim_id, reachable });

  if (passed) {
    const final = transition(step.state, story_id, "awaiting_approval");
    return { ...final, validation: { passed, issues } };
  }

  const withError = setLastError(step.state, story_id, {
    stage: "validation",
    message: issues.join("; "),
  });
  const final = transition(withError, story_id, "failed");
  return { ...final, validation: { passed, issues } };
}

/**
 * Records a failure. If the record is still in a state that legally
 * transitions to "failed" (artwork_requested/validating), does so; if it's
 * already "failed" (e.g. a duplicate/late fail event), just appends to
 * last_error/retry_count without attempting a no-op self-transition
 * (transition() has no "failed" -> "failed" edge, and shouldn't).
 * @param {object} state
 * @param {{story_id: string, claim_id?: string, stage: string, message: string}} payload
 */
export function applyFailEvent(state, payload) {
  const { story_id, claim_id, stage, message } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (claim_id && resolved.record.claim && resolved.record.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }

  const withError = setLastError(state, story_id, { stage, message });

  if (resolved.record.status === "failed") {
    return { state: withError, ok: true, story_id: resolved.story_id, record: withError.stories[resolved.story_id], alreadyFailed: true };
  }

  const result = transition(withError, story_id, "failed");
  return result;
}
