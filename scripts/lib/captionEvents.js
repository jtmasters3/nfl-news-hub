// Pure state-transition handlers for the caption-bridge events
// (caption-claimed / caption-completed / caption-failed) fired by the
// Cloudflare Worker via repository_dispatch and applied by
// scripts/social/apply-artwork-event.js. Built entirely on top of
// scripts/lib/socialState.js's existing transition()/setLastError()/
// resolveCanonicalId() — this is NOT a second state machine.
//
// Deliberately different in shape from artworkEvents.js's applyClaimEvent:
// a caption claim never needs a "fresh vs recovered" distinction at the
// top-level-status layer, because the top-level status never changes
// while a caption is being worked on (it stays "artwork_ready" the whole
// time — see socialState.js's TRANSITIONS comment for why a second
// top-level state isn't needed). Every caption claim event is therefore
// the exact same patch-only operation, whether it's the first attempt or
// a lease-recovery retry after an abandoned claim.
import { resolveCanonicalId, transition, setLastError } from "./socialState.js";
import { validateCaption } from "./captionValidation.js";

const MAX_CAPTION_CLAIM_ATTEMPTS = 3;

/**
 * Records a new caption claim/lease. Legal only from "artwork_ready" —
 * does NOT call transition() (status stays "artwork_ready"); atomicity
 * for "is a caption currently being generated" is enforced entirely by
 * the Durable Object's claim on the caption:{story_id} key, not by this
 * record's status.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, processor_id: string, claimed_at: string, claim_expires_at: string}} payload
 */
export function applyCaptionClaimEvent(state, payload) {
  const { story_id, claim_id, processor_id, claimed_at, claim_expires_at } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };
  if (resolved.record.status !== "artwork_ready") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }

  const updated = {
    ...resolved.record,
    caption: {
      ...resolved.record.caption,
      status: "generating",
      claim: { claim_id, processor_id, claimed_at, claim_expires_at },
    },
    updated_at: new Date().toISOString(),
  };
  const next = { ...state, stories: { ...state.stories, [resolved.story_id]: updated } };
  return { state: next, ok: true, story_id: resolved.story_id, record: updated };
}

/**
 * artwork_ready -> awaiting_approval, ONLY after the shared, authoritative
 * validateCaption() passes here (server-side — the local processor's own
 * validation is a first pass, this is defense in depth, never trust the
 * client alone). This is the ONLY place a new record can ever reach
 * awaiting_approval — socialState.js's TRANSITIONS table has no other
 * edge into it. caption.text is set ONLY in this success branch.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, text: string, hashtags?: string[], attribution_line?: string, source_url?: string, provider: string}} payload
 */
export function applyCaptionCompleteEvent(state, payload) {
  const { story_id, claim_id, text, hashtags, attribution_line, source_url, provider } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (resolved.record.status !== "artwork_ready") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }
  if (!resolved.record.caption?.claim || resolved.record.caption.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }

  const fixture = {
    post_headline: resolved.record.source_story.post_headline,
    source_name: resolved.record.source_story.source_name,
    description: resolved.record.source_story.description,
  };
  const { passed, issues } = validateCaption(text, fixture);

  if (passed) {
    const final = transition(state, story_id, "awaiting_approval", {
      caption: {
        ...resolved.record.caption,
        status: "ready",
        text,
        last_candidate_text: null,
        hashtags: hashtags || [],
        attribution_line: attribution_line || null,
        source_url: source_url || null,
        provider,
        created_at: new Date().toISOString(),
      },
    });
    return { ...final, validation: { passed, issues } };
  }

  // Rejected by the authoritative pass. caption.text must NEVER receive
  // this — route through applyCaptionFailEvent, which only ever writes
  // rejected output to last_candidate_text.
  const failResult = applyCaptionFailEvent(state, {
    story_id,
    claim_id,
    message: `server-side caption validation rejected: ${issues.join("; ")}`,
    last_candidate_text: text,
  });
  return { ...failResult, validation: { passed, issues } };
}

/**
 * Records a caption-claim exhaustion — either the local processor's own
 * bounded local-attempt budget ran out, or (see applyCaptionCompleteEvent
 * above) the authoritative server-side validateCaption() rejected a
 * candidate. Increments caption.claim_attempt_count. Stays at
 * "artwork_ready" (patch-only, no transition — artwork fully preserved,
 * story remains claimable for a future caption attempt) unless this is
 * the THIRD separate exhausted claim run, at which point it escalates to
 * top-level "failed" for human review — still preserving artwork and
 * every caption diagnostic collected.
 *
 * A late/duplicate caption-fail event arriving after the record has
 * already moved on (awaiting_approval via a separate successful
 * completion) is rejected as invalid_state, never corrupting a real
 * success — apply-artwork-event.js already treats that as a skippable
 * no-op, matching the artwork side's existing idempotent-replay handling.
 * @param {object} state
 * @param {{story_id: string, claim_id?: string, message: string, last_candidate_text?: string}} payload
 */
export function applyCaptionFailEvent(state, payload) {
  const { story_id, claim_id, message, last_candidate_text } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (claim_id && resolved.record.caption?.claim?.claim_id && resolved.record.caption.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }

  if (resolved.record.status !== "artwork_ready" && resolved.record.status !== "failed") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }

  const attemptCount = (resolved.record.caption?.claim_attempt_count ?? 0) + 1;
  const withCaptionPatch = {
    ...state,
    stories: {
      ...state.stories,
      [resolved.story_id]: {
        ...resolved.record,
        caption: {
          ...resolved.record.caption,
          status: "failed",
          last_candidate_text: last_candidate_text ?? resolved.record.caption?.last_candidate_text ?? null,
          claim_attempt_count: attemptCount,
        },
        updated_at: new Date().toISOString(),
      },
    },
  };

  const withError = setLastError(withCaptionPatch, story_id, { stage: "caption", message });

  if (resolved.record.status === "failed") {
    // Already escalated by an earlier exhaustion — append diagnostics
    // only, never attempt an illegal failed -> failed self-transition.
    return { state: withError, ok: true, story_id: resolved.story_id, record: withError.stories[resolved.story_id], alreadyFailed: true };
  }

  if (attemptCount < MAX_CAPTION_CLAIM_ATTEMPTS) {
    return { state: withError, ok: true, story_id: resolved.story_id, record: withError.stories[resolved.story_id], escalatedToFailed: false };
  }

  const final = transition(withError, story_id, "failed");
  return { ...final, escalatedToFailed: true };
}

export { MAX_CAPTION_CLAIM_ATTEMPTS };
