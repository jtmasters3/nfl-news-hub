// Deterministic (no AI) validation for a single Story artwork submission —
// same role as artworkValidation.js (Feed), run server-side inside the
// story-artwork-completed GitHub Action right before story_artwork.status
// becomes "created". A separate module, not a parameterized reuse of
// artworkValidation.js, because the two checklists differ meaningfully
// (target ratio, no "already_posted"/"approval_already_resolved" guards —
// those are top-level-status concerns that don't apply to a sibling object
// that never drives top-level status) and because keeping them independent
// means a future change to one can never silently affect the other.
const ASPECT_RATIO_TARGET = 9 / 16;
const ASPECT_RATIO_TOLERANCE = 0.06; // ~6%, matches Feed's "approximately" tolerance
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg"]);
const MIN_DIMENSION = 400; // reasonable floor for a phone-vertical social graphic — well below 1080x1920, well above a thumbnail

/**
 * @param {object} args
 * @param {object|null} args.record - the resolved (canonical) social-state record.
 * @param {string} args.claimId - claim_id from the story-artwork /complete payload being validated.
 * @param {boolean} args.reachable - whether image_url was confirmed reachable.
 * @returns {{ passed: boolean, issues: string[] }}
 */
export function validateStoryArtwork({ record, claimId, reachable }) {
  const issues = [];

  if (!record) {
    return { passed: false, issues: ["record_not_found"] };
  }

  // Story artwork is only ever legal once Feed itself is durable —
  // top-level status must already be "artwork_ready" (the same guard
  // story-artwork-claim already enforced when the claim was granted).
  if (record.status !== "artwork_ready") {
    issues.push(`unexpected_status:${record.status}`);
  }

  const story = record.story_artwork || {};

  if (!story.image_url) issues.push("missing_image_url");
  if (!reachable) issues.push("image_unreachable");
  if (!story.mime_type || !ALLOWED_MIME_TYPES.has(story.mime_type)) issues.push(`invalid_mime_type:${story.mime_type ?? "none"}`);
  if (!story.size_bytes || story.size_bytes <= 0) issues.push("empty_image");

  const { width, height } = story;
  if (!width || !height || width < MIN_DIMENSION || height < MIN_DIMENSION) {
    issues.push(`insane_dimensions:${width ?? "?"}x${height ?? "?"}`);
  }

  // Ratio-based, not exact-dimension — a generator returning e.g. 1080x1908
  // or 1024x1820 must pass just as cleanly as an exact 1080x1920.
  if (width && height) {
    const ratio = width / height;
    if (Math.abs(ratio - ASPECT_RATIO_TARGET) > ASPECT_RATIO_TOLERANCE) {
      issues.push(`aspect_ratio_out_of_range:${ratio.toFixed(3)}`);
    }
  }

  if (story.status !== "created") issues.push(`unexpected_story_artwork_status:${story.status ?? "none"}`);
  if (!story.claim || story.claim.claim_id !== claimId) issues.push("claim_id_mismatch");

  return { passed: issues.length === 0, issues };
}

export { ASPECT_RATIO_TARGET, ASPECT_RATIO_TOLERANCE, ALLOWED_MIME_TYPES, MIN_DIMENSION };
