// Pure state-transition handlers for the package-regeneration events
// (feed-regenerate-completed / feed-regenerate-failed /
// story-regenerate-completed / story-regenerate-failed), fired by the
// Cloudflare Worker via repository_dispatch and applied by
// scripts/social/apply-artwork-event.js. This is the operator-only
// "regenerate Feed/Story on an already-awaiting_approval package" recovery
// path (2026-09 branding-defect fix) — legal ONLY from "awaiting_approval"
// and NEVER transitions top-level status, on success OR failure:
//
//   - success: patches artwork.*/validation.* (or story_artwork.*)
//     with the new, correctly-branded image. The record simply stays
//     "awaiting_approval" — the readiness check
//     (approvalReadiness.js/approvalDecide.js's storyReadyForApproval)
//     naturally re-evaluates true once both assets are valid again, no
//     new top-level state needed.
//   - failure: patches validation.* to reflect the failure and records
//     last_error, but leaves status at "awaiting_approval" too — the
//     SAME readiness check naturally makes the package NOT actionable
//     until it's fixed. No separate "regeneration failed" state exists;
//     reusing the existing readiness gate is the whole mechanism.
//
// Deliberately does NOT reuse artworkValidation.js/storyArtworkValidation.js's
// validateArtwork()/validateStoryArtwork() directly — those check
// record.status === "validating" and record.claim.claim_id, neither of
// which applies here (status stays "awaiting_approval", and regeneration
// uses its own separate DO claim namespace, never patched into the
// top-level `claim`/`story_artwork.claim` fields). The image-property
// checks that DO apply (mime type, size, dimensions, aspect ratio,
// reachability) are re-run here using the SAME exported constants as the
// original validators, so the actual numeric thresholds can never drift
// between the two.
import { resolveCanonicalId, setLastError } from "./socialState.js";
import { ASPECT_RATIO_TARGET as FEED_RATIO_TARGET, ASPECT_RATIO_TOLERANCE as FEED_RATIO_TOLERANCE, ALLOWED_MIME_TYPES, MIN_DIMENSION as FEED_MIN_DIMENSION } from "./artworkValidation.js";
import { ASPECT_RATIO_TARGET as STORY_RATIO_TARGET, ASPECT_RATIO_TOLERANCE as STORY_RATIO_TOLERANCE, MIN_DIMENSION as STORY_MIN_DIMENSION } from "./storyArtworkValidation.js";

function validateRegeneratedImage({ imageUrl, mimeType, sizeBytes, width, height, reachable, ratioTarget, ratioTolerance, minDimension }) {
  const issues = [];
  if (!imageUrl) issues.push("missing_image_url");
  if (!reachable) issues.push("image_unreachable");
  if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) issues.push(`invalid_mime_type:${mimeType ?? "none"}`);
  if (!sizeBytes || sizeBytes <= 0) issues.push("empty_image");
  if (!width || !height || width < minDimension || height < minDimension) issues.push(`insane_dimensions:${width ?? "?"}x${height ?? "?"}`);
  if (width && height) {
    const ratio = width / height;
    if (Math.abs(ratio - ratioTarget) > ratioTolerance) issues.push(`aspect_ratio_out_of_range:${ratio.toFixed(3)}`);
  }
  return { passed: issues.length === 0, issues };
}

function applyRegenerateCompleteEvent(state, payload, { reachable }, { field, ratioTarget, ratioTolerance, minDimension, stage }) {
  const { story_id, image_url, storage_key, width, height, mime_type, size_bytes, provider } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };
  if (resolved.record.status !== "awaiting_approval") {
    return { state, ok: false, error: `invalid_state:${resolved.record.status}` };
  }

  const { passed, issues } = validateRegeneratedImage({ imageUrl: image_url, mimeType: mime_type, sizeBytes: size_bytes, width, height, reachable, ratioTarget, ratioTolerance, minDimension });

  const now = new Date().toISOString();
  const newAsset = { status: "created", image_url, storage_key, width, height, mime_type, size_bytes, provider, created_at: now };
  const newValidation = passed ? { status: "passed", passed: true, issues: [] } : { status: "failed", passed: false, issues };

  const existingSlot = resolved.record[field] || {};
  let next = {
    ...state,
    stories: {
      ...state.stories,
      [resolved.story_id]: {
        ...resolved.record,
        [field]: field === "artwork" ? newAsset : { ...existingSlot, ...newAsset, validation: newValidation },
        ...(field === "artwork" ? { validation: newValidation } : {}),
        updated_at: now,
      },
    },
  };
  if (!passed) {
    next = setLastError(next, story_id, { stage, message: issues.join("; ") });
  }
  return { state: next, ok: true, story_id: resolved.story_id, record: next.stories[resolved.story_id], validation: { passed, issues } };
}

export function applyFeedRegenerateCompleteEvent(state, payload, opts) {
  return applyRegenerateCompleteEvent(state, payload, opts, { field: "artwork", ratioTarget: FEED_RATIO_TARGET, ratioTolerance: FEED_RATIO_TOLERANCE, minDimension: FEED_MIN_DIMENSION, stage: "feed_regeneration" });
}

export function applyStoryRegenerateCompleteEvent(state, payload, opts) {
  return applyRegenerateCompleteEvent(state, payload, opts, { field: "story_artwork", ratioTarget: STORY_RATIO_TARGET, ratioTolerance: STORY_RATIO_TOLERANCE, minDimension: STORY_MIN_DIMENSION, stage: "story_regeneration" });
}

/**
 * Patch-only diagnostic for a regeneration attempt that never reached
 * /complete (e.g. Codex generation or compositing failed) — never touches
 * artwork.* / story_artwork.* or top-level status. The prior valid asset
 * (and its R2 object) is completely untouched by an attempt failure.
 */
function applyRegenerateFailEvent(state, payload, stage) {
  const { story_id, message } = payload;
  const resolved = resolveCanonicalId(state, story_id);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };
  const next = setLastError(state, story_id, { stage, message });
  return { state: next, ok: true, story_id: resolved.story_id, record: next.stories[resolved.story_id] };
}

export function applyFeedRegenerateFailEvent(state, payload) {
  return applyRegenerateFailEvent(state, payload, "feed_regeneration");
}

export function applyStoryRegenerateFailEvent(state, payload) {
  return applyRegenerateFailEvent(state, payload, "story_regeneration");
}
