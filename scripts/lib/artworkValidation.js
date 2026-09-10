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
import { ASPECT_RATIO_TARGET as STORY_ASPECT_RATIO_TARGET, ASPECT_RATIO_TOLERANCE as STORY_ASPECT_RATIO_TOLERANCE, ALLOWED_MIME_TYPES as STORY_ALLOWED_MIME_TYPES, MIN_DIMENSION as STORY_MIN_DIMENSION } from "./storyArtworkValidation.js";

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

// ---------------------------------------------------------------------------
// Stage 3B — destination-aware validation for a Stage 3A-SELECTED record's
// PRIMARY asset. Deliberately a NEW function, not a parameterization of
// validateArtwork() above: validateArtwork() stays byte-for-byte unchanged
// (zero risk to any legacy/Feed-selected record's existing behavior, still
// the exact function every current record's Feed asset is validated by).
// This function exists ONLY for the "story" case, where the SAME primary
// artwork_requested -> artwork_created -> validating -> artwork_ready
// lifecycle now needs to validate a 9:16 asset written into
// record.story_artwork instead of a 4:5 asset in record.artwork. Reuses
// the identical top-level guards (validating status, already_posted,
// approval_already_resolved, claim_id match) — those are genuinely
// destination-independent — and Story's own already-locked aspect-ratio/
// dimension constants (see storyArtworkValidation.js), never re-tuned here.
const DESTINATION_RULES = {
  feed: { field: "artwork", ratioTarget: ASPECT_RATIO_TARGET, ratioTolerance: ASPECT_RATIO_TOLERANCE, allowedMimeTypes: ALLOWED_MIME_TYPES, minDimension: MIN_DIMENSION },
  story: { field: "story_artwork", ratioTarget: STORY_ASPECT_RATIO_TARGET, ratioTolerance: STORY_ASPECT_RATIO_TOLERANCE, allowedMimeTypes: STORY_ALLOWED_MIME_TYPES, minDimension: STORY_MIN_DIMENSION },
};

/**
 * @param {object} args
 * @param {object|null} args.record - the resolved (canonical) social-state record, AFTER the asset/claim patch has been applied and status set to "validating".
 * @param {string} args.claimId - claim_id from the /complete payload being validated.
 * @param {boolean} args.reachable - whether image_url was confirmed reachable.
 * @param {"feed"|"story"} args.destination - which asset field/ratio this record's Stage 3A selection requires.
 * @returns {{ passed: boolean, issues: string[] }}
 */
export function validateArtworkForDestination({ record, claimId, reachable, destination }) {
  const issues = [];

  if (!record) {
    return { passed: false, issues: ["record_not_found"] };
  }

  const rules = DESTINATION_RULES[destination];
  if (!rules) {
    return { passed: false, issues: [`unknown_destination:${destination ?? "none"}`] };
  }

  if (record.status !== "validating") {
    issues.push(`unexpected_status:${record.status}`);
  }

  const asset = record[rules.field] || {};

  if (!asset.image_url) issues.push("missing_image_url");
  if (!reachable) issues.push("image_unreachable");
  if (!asset.mime_type || !rules.allowedMimeTypes.has(asset.mime_type)) issues.push(`invalid_mime_type:${asset.mime_type ?? "none"}`);
  if (!asset.size_bytes || asset.size_bytes <= 0) issues.push("empty_image");

  const { width, height } = asset;
  if (!width || !height || width < rules.minDimension || height < rules.minDimension) {
    issues.push(`insane_dimensions:${width ?? "?"}x${height ?? "?"}`);
  }
  if (width && height) {
    const ratio = width / height;
    if (Math.abs(ratio - rules.ratioTarget) > rules.ratioTolerance) {
      issues.push(`aspect_ratio_out_of_range:${ratio.toFixed(3)}`);
    }
  }

  if (asset.status !== "created") issues.push(`unexpected_asset_status:${asset.status ?? "none"}`);
  if (record.publishing?.status === "posted") issues.push("already_posted");
  if (record.approval?.status && record.approval.status !== "pending") issues.push(`approval_already_resolved:${record.approval.status}`);
  if (!record.claim || record.claim.claim_id !== claimId) issues.push("claim_id_mismatch");

  return { passed: issues.length === 0, issues };
}

export { ASPECT_RATIO_TARGET, ASPECT_RATIO_TOLERANCE, ALLOWED_MIME_TYPES, MIN_DIMENSION };
