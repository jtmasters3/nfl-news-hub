// Pure state-transition handlers for the story-artwork-bridge events
// (story-artwork-claimed / story-artwork-completed / story-artwork-failed)
// fired by the Cloudflare Worker via repository_dispatch and applied by
// scripts/social/apply-artwork-event.js. Built on the SAME pattern as
// captionEvents.js: a fully independent claim/lease lifecycle (DO key
// "story-artwork:{story_id}") that patches only `story_artwork.*` and
// NEVER transitions top-level `status` — top-level status stays
// "artwork_ready" throughout Story generation, exactly like caption
// generation already does, and for the same reason: the Durable Object's
// own claim atomicity is what makes "is Story artwork currently being
// worked on" atomic, not a second top-level state.
import { resolveCanonicalId, setLastError } from "./socialState.js";
import { validateStoryArtwork } from "./storyArtworkValidation.js";

/**
 * Records a new Story-artwork claim/lease. Legal only from "artwork_ready"
 * (i.e. Feed already succeeded) — patch-only, no transition().
 * @param {object} state
 * @param {{story_id: string, claim_id: string, processor_id: string, claimed_at: string, claim_expires_at: string}} payload
 */
export function applyStoryArtworkClaimEvent(state, payload) {
  const { story_id, claim_id, processor_id, claimed_at, claim_expires_at } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };
  if (resolved.record.status !== "artwork_ready") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }

  const updated = {
    ...resolved.record,
    story_artwork: {
      ...resolved.record.story_artwork,
      status: "generating",
      claim: { claim_id, processor_id, claimed_at, claim_expires_at },
    },
    updated_at: new Date().toISOString(),
  };
  const next = { ...state, stories: { ...state.stories, [resolved.story_id]: updated } };
  return { state: next, ok: true, story_id: resolved.story_id, record: updated };
}

/**
 * Records a Story-artwork submission and runs the shared, authoritative
 * validateStoryArtwork(). On pass, story_artwork.status becomes "created"
 * — still no top-level transition; the story only becomes caption-eligible
 * once BOTH Feed and Story are valid, which captionClaim.js's Worker guard
 * checks directly against these fields, not against a top-level state.
 * @param {object} state
 * @param {{story_id: string, claim_id: string, image_url: string, storage_key: string, width: number, height: number, mime_type: string, size_bytes: number, provider: string}} payload
 * @param {{reachable: boolean}} opts
 */
export function applyStoryArtworkCompleteEvent(state, payload, { reachable }) {
  const { story_id, claim_id, image_url, storage_key, width, height, mime_type, size_bytes, provider } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (resolved.record.status !== "artwork_ready") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }
  if (!resolved.record.story_artwork?.claim || resolved.record.story_artwork.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }

  const now = new Date().toISOString();
  const withSubmission = {
    ...state,
    stories: {
      ...state.stories,
      [resolved.story_id]: {
        ...resolved.record,
        story_artwork: {
          ...resolved.record.story_artwork,
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
        updated_at: now,
      },
    },
  };

  const { passed, issues } = validateStoryArtwork({ record: withSubmission.stories[resolved.story_id], claimId: claim_id, reachable });

  if (passed) {
    const final = {
      ...withSubmission,
      stories: {
        ...withSubmission.stories,
        [resolved.story_id]: {
          ...withSubmission.stories[resolved.story_id],
          story_artwork: {
            ...withSubmission.stories[resolved.story_id].story_artwork,
            validation: { status: "passed", passed: true, issues },
          },
        },
      },
    };
    return { state: final, ok: true, story_id: resolved.story_id, record: final.stories[resolved.story_id], validation: { passed, issues } };
  }

  const withError = setLastError(withSubmission, story_id, { stage: "story_artwork_validation", message: issues.join("; ") });
  const final = {
    ...withError,
    stories: {
      ...withError.stories,
      [resolved.story_id]: {
        ...withError.stories[resolved.story_id],
        story_artwork: {
          ...withError.stories[resolved.story_id].story_artwork,
          status: "failed",
          validation: { status: "failed", passed: false, issues },
        },
      },
    },
  };
  return { state: final, ok: true, story_id: resolved.story_id, record: final.stories[resolved.story_id], validation: { passed, issues } };
}

/**
 * Records a Story-artwork generation/upload failure. Patch-only, same
 * self-healing shape as captionEvents.js's applyCaptionFailEvent — never
 * touches top-level status, never touches Feed's own artwork/claim.
 * @param {object} state
 * @param {{story_id: string, claim_id?: string, stage: string, message: string}} payload
 */
export function applyStoryArtworkFailEvent(state, payload) {
  const { story_id, claim_id, stage, message } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };

  if (claim_id && resolved.record.story_artwork?.claim?.claim_id && resolved.record.story_artwork.claim.claim_id !== claim_id) {
    return { state, ok: false, error: "claim_mismatch" };
  }

  const withError = setLastError(state, story_id, { stage: stage || "story_artwork", message });
  const record = withError.stories[resolved.story_id];
  const final = {
    ...withError,
    stories: {
      ...withError.stories,
      [resolved.story_id]: {
        ...record,
        story_artwork: { ...record.story_artwork, status: "failed" },
      },
    },
  };
  return { state: final, ok: true, story_id: resolved.story_id, record: final.stories[resolved.story_id] };
}
