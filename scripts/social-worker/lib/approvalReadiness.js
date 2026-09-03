// Pure UI-side readiness check for an awaiting_approval record — mirrors
// cloudflare-worker's approvalDecide.js's storyReadyForApproval() exactly
// (a small intentional duplicate across the two separate deploy targets,
// same pattern as imageValidation.js/artworkValidation.js). This does NOT
// replace or weaken the Worker's own server-side not_ready_for_approval
// gate — that remains the sole authority a decision is ever actually
// accepted against. This is purely a UI safety net so the console never
// exposes live Approve/Reject controls for a record the Worker would
// reject anyway (e.g. a legacy pre-Caption-phase record that reached
// "awaiting_approval" before captioning existed and so has no caption).
export function assessApprovalReadiness(record) {
  const issues = [];
  if (record.merged_into) issues.push("story has been merged into another canonical story");
  if (record.artwork?.status !== "created") issues.push("artwork not created");
  if (record.validation?.passed !== true) issues.push("artwork validation not passed");

  // Feed+Story phase: a content_package_version 2 record ALSO requires a
  // valid Story asset before it's actionable. A legacy record (no field,
  // or explicitly 1) is held to exactly the same bar as before this
  // phase existed — never newly blocked by a requirement it predates.
  if (record.content_package_version === 2) {
    if (record.story_artwork?.status !== "created") issues.push("Story artwork not created");
    if (record.story_artwork?.validation?.passed !== true) issues.push("Story artwork validation not passed");
  }

  if (record.caption?.status !== "ready") issues.push("caption not ready");
  if (!record.caption?.text || !record.caption.text.trim()) issues.push("caption text missing");
  return { ready: issues.length === 0, issues };
}
