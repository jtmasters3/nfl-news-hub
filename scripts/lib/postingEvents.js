// Pure state-transition handlers for the posting-bridge events
// (posting-claimed / posting-container-created / posting-publish-attempted /
// posting-completed / posting-failed / posting-ambiguous), the durable
// state/event foundation for a future Instagram Feed publishing workflow.
// Built entirely on top of scripts/lib/socialState.js's existing
// transition()/setLastError()/resolveCanonicalId() — this is NOT a second
// state machine. "posting" and "posted" are already legal top-level edges
// from "approved" in its TRANSITIONS table (approved -> posting -> posted |
// failed), added when that table was first designed, long before any of
// this file existed.
//
// Stage 4B scope: state architecture ONLY. Nothing in this file makes an
// HTTP request of any kind — every function here applies an
// already-decided, already-authorized event to state, exactly like
// artworkEvents.js/captionEvents.js/approvalEvents.js. The actual Meta/
// Instagram client is a later, separate stage.
//
// Destination scope: this Feed-publishing implementation only ever reads/
// writes publishing.instagram.feed. publishing.instagram.story and
// publishing.facebook are untouched by every function below — Story and
// Facebook publishing are explicitly out of scope here.
import { resolveCanonicalId, transition, setLastError } from "./socialState.js";

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/** Shallow-clones the parts of `publishing` every posting event must preserve unless explicitly patching them. */
function clonePublishing(record) {
  return {
    ...record.publishing,
    instagram: {
      ...record.publishing.instagram,
      feed: { ...record.publishing.instagram.feed },
    },
  };
}

function patchOnly(state, storyId, record, publishingPatch, feedPatch) {
  const updated = {
    ...record,
    publishing: {
      ...clonePublishing(record),
      ...publishingPatch,
      instagram: {
        ...record.publishing.instagram,
        feed: { ...record.publishing.instagram.feed, ...feedPatch },
      },
    },
    updated_at: new Date().toISOString(),
  };
  return { state: { ...state, stories: { ...state.stories, [storyId]: updated } }, ok: true, story_id: storyId, record: updated };
}

/**
 * approved -> posting. The ONLY place a record can ever begin a new
 * publishing attempt. Rejects everything this Feed implementation isn't
 * built for yet (a Story-selected record, a record whose Feed artwork or
 * caption isn't actually ready) rather than silently doing the wrong thing.
 *
 * `caption_used` is a REQUIRED, immutable snapshot taken here, once — every
 * later posting event only ever persists what it's given, never reads
 * record.caption again. `storage_key`/`jpeg_url` are optional at claim time
 * (the JPEG derivative may not exist yet) and are filled in by a later
 * event if omitted here.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, processor_id: string, claimed_at: string, claim_expires_at: string, caption_used: string, storage_key?: string, jpeg_url?: string}} payload
 */
export function applyPostingClaimedEvent(state, payload) {
  const { story_id, claim_id, processor_id, claimed_at, claim_expires_at, caption_used, storage_key, jpeg_url } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (!isNonEmptyString(claim_id) || !isNonEmptyString(processor_id) || !isNonEmptyString(claimed_at) || !isNonEmptyString(claim_expires_at)) {
    return { state, ok: false, error: "invalid_payload" };
  }
  if (!isNonEmptyString(caption_used)) return { state, ok: false, error: "caption_missing" };

  const record = resolved.record;
  if (record.approval?.status !== "approved") return { state, ok: false, error: `invalid_state:${record.status}` };
  if (record.selection?.destination !== "feed") return { state, ok: false, error: "wrong_destination" };
  if (record.artwork?.status !== "created") return { state, ok: false, error: "artwork_not_ready" };
  if (record.caption?.status !== "ready") return { state, ok: false, error: "caption_not_ready" };
  if (record.publishing?.status !== "not_posted") return { state, ok: false, error: `invalid_state:${record.publishing?.status}` };

  const result = transition(state, story_id, "posting", {
    publishing: {
      ...clonePublishing(record),
      status: "posting",
      claim: { claim_id, processor_id, claimed_at, claim_expires_at, retry_count: 0 },
      instagram: {
        ...record.publishing.instagram,
        feed: {
          ...record.publishing.instagram.feed,
          status: "claimed",
          storage_key: storage_key ?? record.publishing.instagram.feed.storage_key,
          jpeg_url: jpeg_url ?? record.publishing.instagram.feed.jpeg_url,
          caption_used,
        },
      },
    },
  });
  return result;
}

/**
 * Records a created Instagram media container. Patch-only — top-level
 * status stays "posting" (there is no "posting" -> "posting" edge in
 * TRANSITIONS, nor should there be; this is ownership/progress metadata,
 * not a state change, exactly like captionClaimEvent never moving off
 * "artwork_ready"). No Meta call happens here — this only records that one
 * already happened elsewhere.
 *
 * Idempotent on an identical replay (same container_id): a true no-op,
 * returned without touching `updated_at`, so a duplicate delivery never
 * even looks like new activity. A DIFFERENT container_id than the one
 * already on record is rejected — a story may only ever have one container
 * per posting attempt.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, container_id: string, container_created_at: string}} payload
 */
export function applyPostingContainerCreatedEvent(state, payload) {
  const { story_id, claim_id, container_id, container_created_at } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  const record = resolved.record;
  if (record.status !== "posting") return { state, ok: false, error: `invalid_state:${record.status}` };
  if (!record.publishing.claim || record.publishing.claim.claim_id !== claim_id) return { state, ok: false, error: "claim_mismatch" };
  if (!isNonEmptyString(container_id) || !isNonEmptyString(container_created_at)) return { state, ok: false, error: "invalid_payload" };

  const existing = record.publishing.instagram.feed.container_id;
  if (existing === container_id) {
    return { state, ok: true, story_id: resolved.story_id, record, idempotentReplay: true };
  }
  if (existing) {
    return { state, ok: false, error: "container_id_conflict" };
  }

  return patchOnly(state, resolved.story_id, record, {}, { status: "container_created", container_id, container_created_at });
}

/**
 * Records that media_publish is ABOUT TO BE called (or was just called) —
 * this must be persisted BEFORE the actual irreversible Meta call in every
 * future caller, since this field is the durable evidence an ambiguous
 * outcome needs to reconcile against. Patch-only, same reasoning as
 * container-created.
 *
 * Once publish_attempted_at exists for a container, it is permanent: an
 * identical replay (same container_id AND same publish_attempted_at) is a
 * safe no-op; anything else — a different timestamp, a different container
 * — is rejected. This is deliberately stricter than container-created's
 * idempotency, because this field is the one thing standing between the
 * system and a duplicate Instagram post.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, container_id: string, publish_attempted_at: string}} payload
 */
export function applyPostingPublishAttemptedEvent(state, payload) {
  const { story_id, claim_id, container_id, publish_attempted_at } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  const record = resolved.record;
  if (record.status !== "posting") return { state, ok: false, error: `invalid_state:${record.status}` };
  if (!record.publishing.claim || record.publishing.claim.claim_id !== claim_id) return { state, ok: false, error: "claim_mismatch" };
  if (!isNonEmptyString(container_id) || !isNonEmptyString(publish_attempted_at)) return { state, ok: false, error: "invalid_payload" };

  const feed = record.publishing.instagram.feed;
  if (feed.container_id !== container_id) return { state, ok: false, error: "container_mismatch" };
  if (!isNonEmptyString(feed.caption_used)) return { state, ok: false, error: "caption_missing" };
  if (!isNonEmptyString(feed.jpeg_url) && !isNonEmptyString(feed.storage_key)) return { state, ok: false, error: "asset_missing" };

  if (feed.publish_attempted_at) {
    if (feed.publish_attempted_at === publish_attempted_at) {
      return { state, ok: true, story_id: resolved.story_id, record, idempotentReplay: true };
    }
    return { state, ok: false, error: "publish_attempt_conflict" };
  }

  return patchOnly(state, resolved.story_id, record, {}, { status: "publish_attempted", publish_attempted_at });
}

/**
 * posting -> posted. Requires a durable publish_attempted_at to already
 * exist on the SAME container (structurally enforcing "persist before the
 * irreversible call" — this function refuses to invent a completion out of
 * nothing). Every historical field (container_id, caption_used, jpeg_url,
 * publish_attempted_at, claim metadata) is preserved, never cleared — audit
 * evidence, not scratch state.
 *
 * A record already at "posted" with the SAME media_id is an idempotent
 * no-op (a duplicate dispatch delivery, not a new post). The SAME status
 * with a DIFFERENT media_id is rejected — posted is immutable.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, container_id: string, media_id: string, permalink?: string, published_at: string}} payload
 */
export function applyPostingCompletedEvent(state, payload) {
  const { story_id, claim_id, container_id, media_id, permalink, published_at } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  const record = resolved.record;

  if (record.status === "posted") {
    if (record.publishing.instagram.feed.media_id === media_id) {
      return { state, ok: true, story_id: resolved.story_id, record, idempotentReplay: true };
    }
    return { state, ok: false, error: "media_id_conflict" };
  }

  if (record.status !== "posting") return { state, ok: false, error: `invalid_state:${record.status}` };
  if (!record.publishing.claim || record.publishing.claim.claim_id !== claim_id) return { state, ok: false, error: "claim_mismatch" };
  if (!isNonEmptyString(media_id) || !isNonEmptyString(published_at)) return { state, ok: false, error: "invalid_payload" };
  if (!Number.isFinite(Date.parse(published_at))) return { state, ok: false, error: "invalid_payload" };

  const feed = record.publishing.instagram.feed;
  if (feed.container_id !== container_id) return { state, ok: false, error: "container_mismatch" };
  if (feed.status !== "publish_attempted") return { state, ok: false, error: `invalid_state:${feed.status}` };

  return transition(state, story_id, "posted", {
    publishing: {
      ...clonePublishing(record),
      status: "posted",
      posted_at: published_at,
      instagram: {
        ...record.publishing.instagram,
        feed: { ...feed, status: "posted", media_id, permalink: permalink ?? null, published_at },
      },
    },
  });
}

/**
 * posting -> failed. Represents an outcome PROVEN not to have published —
 * never used for an ambiguous result (see applyPostingAmbiguousEvent for
 * that). Sanitized fields only: `message`/`http_outcome_category` are the
 * sole allowed detail carriers, matching the codebase's existing
 * last_error convention — there is no parameter here for a token, header,
 * or raw response body, so one can never be persisted by this function
 * regardless of what a misbehaving caller's payload contains.
 *
 * A late/duplicate fail event arriving after the record already escalated
 * to "failed" appends diagnostics only, mirroring artworkEvents.js's
 * applyFailEvent — never a "failed" -> "failed" self-transition.
 * @param {object} state
 * @param {{story_id: string, claim_id?: string, message: string, http_outcome_category?: string}} payload
 */
export function applyPostingFailedEvent(state, payload) {
  const { story_id, claim_id, message, http_outcome_category } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  const record = resolved.record;
  if (claim_id && record.publishing?.claim?.claim_id && record.publishing.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }
  if (record.status !== "posting" && record.status !== "failed") {
    return { state, ok: false, error: `invalid_state:${record.status}` };
  }

  const withPublishingPatch = {
    ...state,
    stories: {
      ...state.stories,
      [resolved.story_id]: {
        ...record,
        publishing: {
          ...clonePublishing(record),
          instagram: {
            ...record.publishing.instagram,
            feed: { ...record.publishing.instagram.feed, status: "failed", last_http_outcome: http_outcome_category ?? record.publishing.instagram.feed.last_http_outcome },
          },
        },
        updated_at: new Date().toISOString(),
      },
    },
  };

  const withError = setLastError(withPublishingPatch, story_id, { stage: "instagram", message });

  if (record.status === "failed") {
    return { state: withError, ok: true, story_id: resolved.story_id, record: withError.stories[resolved.story_id], alreadyFailed: true };
  }

  return transition(withError, story_id, "failed");
}

/**
 * Records an AMBIGUOUS outcome — a timeout, connection reset, 5xx, or
 * unparseable response where a media_publish call may or may not have
 * succeeded. Deliberately does NOT transition top-level status at all
 * (stays "posting") and does NOT touch publish_attempted_at, container_id,
 * caption_used, or claim metadata — every piece of evidence needed for a
 * later reconciliation pass (Stage 4C/4D, not built here) survives
 * untouched. There is no code path in this function that can move status
 * back to "approved"/"not_posted"/"claimed" — it only ever patches the
 * nested feed.status to "ambiguous" and records when/what was last
 * observed, safe to call repeatedly as reconciliation attempts happen over
 * time.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, http_outcome_category?: string, reconciled_at?: string}} payload
 */
export function applyPostingAmbiguousEvent(state, payload) {
  const { story_id, claim_id, http_outcome_category, reconciled_at } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  const record = resolved.record;
  if (record.status !== "posting") return { state, ok: false, error: `invalid_state:${record.status}` };
  if (!record.publishing.claim || record.publishing.claim.claim_id !== claim_id) return { state, ok: false, error: "claim_mismatch" };

  const feed = record.publishing.instagram.feed;
  if (feed.status !== "publish_attempted" && feed.status !== "ambiguous") {
    return { state, ok: false, error: `invalid_state:${feed.status}` };
  }

  return patchOnly(
    state,
    resolved.story_id,
    record,
    {},
    {
      status: "ambiguous",
      last_http_outcome: http_outcome_category ?? feed.last_http_outcome,
      last_reconciled_at: reconciled_at ?? feed.last_reconciled_at,
    }
  );
}
