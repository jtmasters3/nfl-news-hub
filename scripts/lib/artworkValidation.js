// Deterministic (no AI) validation for a single artwork submission, run
// server-side (scripts/social/apply-artwork-event.js, inside the
// artwork-completed GitHub Action) right before artwork_created ->
// validating -> awaiting_approval. Pure function: every input the checks
// need is passed in explicitly, nothing is fetched here, so this is fully
// unit-testable without network or file I/O. The Cloudflare Worker runs
// its own (separate) checks before ever writing bytes to R2 — this is a
// second, independent pass over the committed record, per the spec's
// "defense in depth" requirement, not a shared code path across the
// Worker/Action runtime boundary.
const ASPECT_RATIO_TARGET = 4 / 5;
const ASPECT_RATIO_TOLERANCE = 0.06; // ~6%, matches "approximately 4:5"
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg"]);
const MIN_DIMENSION = 200; // sanity floor — well below any real social graphic

/**
 * @param {object} args
 * @param {object|null} args.record - the resolved (canonical) social-state record, AFTER the artwork/claim patch has been applied and status set to "validating".
 * @param {string} args.claimId - claim_id from the /complete payload being validated.
 * @param {boolean} args.reachable - whether image_url was confirmed reachable (HTTP fetch done by the caller).
 * @returns {{ passed: boolean, issues: string[] }}
 */
export function validateArtwork({ record, claimId, reachable }) {
  const issues = [];

  // 1. story_id exists / 2. canonical, not a dangling merge — both implied
  // by the caller having successfully resolved a record via resolveCanonicalId
  // before calling this function; a null record fails everything else too.
  if (!record) {
    return { passed: false, issues: ["record_not_found"] };
  }

  // 3. current state is (about to leave) artwork_created, i.e. we got here
  // via the artwork_created -> validating transition the caller already made.
  if (record.status !== "validating") {
    issues.push(`unexpected_status:${record.status}`);
  }

  const artwork = record.artwork || {};

  // 4. image_url exists
  if (!artwork.image_url) {
    issues.push("missing_image_url");
  }

  // 5. image is reachable
  if (!reachable) {
    issues.push("image_unreachable");
  }

  // 6. MIME type
  if (!artwork.mime_type || !ALLOWED_MIME_TYPES.has(artwork.mime_type)) {
    issues.push(`invalid_mime_type:${artwork.mime_type ?? "none"}`);
  }

  // 7. nonzero size
  if (!artwork.size_bytes || artwork.size_bytes <= 0) {
    issues.push("empty_image");
  }

  // 8. dimensions are sane
  const { width, height } = artwork;
  if (!width || !height || width < MIN_DIMENSION || height < MIN_DIMENSION) {
    issues.push(`insane_dimensions:${width ?? "?"}x${height ?? "?"}`);
  }

  // 9. aspect ratio approximately 4:5
  if (width && height) {
    const ratio = width / height;
    if (Math.abs(ratio - ASPECT_RATIO_TARGET) > ASPECT_RATIO_TOLERANCE) {
      issues.push(`aspect_ratio_out_of_range:${ratio.toFixed(3)}`);
    }
  }

  // 10. no prior successful artwork exists for this story_id — by the time
  // we're validating, artwork.status must be exactly "created" (set by the
  // artwork_requested -> artwork_created transition this same event chain
  // just performed), never anything indicating an earlier, separate success.
  if (artwork.status !== "created") {
    issues.push(`unexpected_artwork_status:${artwork.status ?? "none"}`);
  }

  // 11. publishing.status is not posted
  if (record.publishing?.status === "posted") {
    issues.push("already_posted");
  }

  // 12. approval has not already been completed/rejected
  if (record.approval?.status && record.approval.status !== "pending") {
    issues.push(`approval_already_resolved:${record.approval.status}`);
  }

  // 13. claim_id matches the active claim
  if (!record.claim || record.claim.claim_id !== claimId) {
    issues.push("claim_id_mismatch");
  }

  return { passed: issues.length === 0, issues };
}

export { ASPECT_RATIO_TARGET, ASPECT_RATIO_TOLERANCE, ALLOWED_MIME_TYPES, MIN_DIMENSION };
