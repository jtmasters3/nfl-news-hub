// Automatic reconciliation of EXISTING Buffer posts stuck at
// feed.status="buffer_post_created" — the async-completion gap identified
// after the Myles Garrett live test: Buffer's createPost response can be a
// proven, definite success (a real post_id) while Buffer's own object
// status is still "sending", not yet "sent". This module NEVER creates a
// Buffer post — it only reads an ALREADY-EXISTING post's current status
// (via the existing read-only /social/posting/reconcile endpoint) and, once
// Buffer itself reports a genuine terminal outcome, persists the matching
// existing result event (posting-completed or posting-failed) through the
// existing /social/posting/result endpoint. No new persistence mechanism,
// no second reconciliation implementation — both endpoints are reused
// exactly as-is.
//
// IMPORTANT distinction from postingReconcile.js's own `outcome` field:
// that field's CONFIRMED_POSTED means only "this post_id exists in Buffer's
// listing" (see bufferReconcile.js's reconcileBufferPublishOutcome — a
// matched post_id short-circuits to CONFIRMED_POSTED regardless of the
// post's own status). It does NOT mean "reached Buffer's terminal 'sent'
// status" — a post can be CONFIRMED_POSTED while still "sending". This
// module therefore looks at `matchedPost.status`/`matchedPost.sentAt`
// directly, never inferring anything from the coarser `outcome` label.
//
// Pure, no I/O — every dependency (the reconcile call, the result call) is
// injected by the caller (scripts/social/reconcile-buffer-completions.js),
// so this file can be fully tested without a network call ever being
// possible, and contains no reference to Buffer's createPost mutation or
// to Meta at all.
//
// Destination-generic (added alongside Story publishing): reads whichever
// of publishing.instagram.feed/.story applies via the shared
// channelKeyFor() (postingEvents.js) instead of a hardcoded `.feed`, so
// this SAME reconciler handles both Feed and Story records with zero
// second implementation — exactly the "generalize, don't duplicate"
// pattern already applied throughout the posting-bridge stack. Existing
// Feed reconciliation behavior is completely unchanged (channelKeyFor
// returns "feed" for every existing Feed record).
import { channelKeyFor } from "../../lib/postingEvents.js";

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

const TERMINAL_SENT_STATUS = "sent";
const TERMINAL_ERROR_STATUS = "error";

/**
 * The ONLY records this module may ever act on: an existing, already-created
 * Buffer post whose own terminal status (sent vs. still-processing vs.
 * error) has not yet been reconciled into the durable record. Deliberately
 * excludes every other status — not_posted, approved, claimed,
 * publish_attempted, ambiguous, failed, posted — by construction, not by a
 * caller remembering to filter correctly.
 * @param {object} record - a data/social-state.json story record
 */
export function isEligibleForCompletionReconciliation(record) {
  const feed = record?.publishing?.instagram?.[channelKeyFor(record)];
  return (
    record?.publishing?.status === "posting" &&
    feed?.status === "buffer_post_created" &&
    feed?.provider === "buffer" &&
    isNonEmptyString(feed?.buffer?.post_id)
  );
}

/**
 * Pure decision function: given the eligible record and the raw
 * `matchedPost` a reconcile-lookup returned (or null/undefined if the
 * stored post_id wasn't found in Buffer's current listing), decide the
 * exactly-one action to take. Never mutates anything itself — the caller
 * applies the decision via the existing /social/posting/result endpoint.
 * @param {object} record
 * @param {{id: string, text?: string, channelId?: string, status?: string, sentAt?: string}|null} matchedPost
 * @returns {{action: "complete", media_id: string, published_at: string, buffer: object}
 *         | {action: "fail", message: string, http_outcome_category: string}
 *         | {action: "none", reason: string}}
 */
export function decideReconciliationAction(record, matchedPost) {
  const feed = record.publishing.instagram[channelKeyFor(record)];
  const storedPostId = feed.buffer.post_id;
  const storedChannelId = feed.buffer.channel_id;
  const storedCaption = feed.caption_used;

  if (!matchedPost || !matchedPost.id) {
    // Buffer's own read-only listing not (yet) showing a post we already
    // KNOW was created — per bufferReconcile.js's own documented stance,
    // absence from a listing proves nothing (pagination/propagation delay).
    // Never treated as failure; left for a later reconciliation pass.
    return { action: "none", reason: "not_found_in_listing" };
  }

  // Defense-in-depth: the reconcile endpoint's own search already matches
  // by exact stored post_id, but this module never trusts that blindly.
  if (matchedPost.id !== storedPostId) {
    return { action: "none", reason: "post_id_mismatch" };
  }
  if (isNonEmptyString(storedChannelId) && matchedPost.channelId !== storedChannelId) {
    return { action: "none", reason: "channel_mismatch" };
  }
  if (isNonEmptyString(storedCaption) && matchedPost.text !== storedCaption) {
    return { action: "none", reason: "caption_mismatch" };
  }

  if (matchedPost.status === TERMINAL_SENT_STATUS) {
    if (!isNonEmptyString(matchedPost.sentAt) || !Number.isFinite(Date.parse(matchedPost.sentAt))) {
      return { action: "none", reason: "invalid_sent_at" };
    }
    return {
      action: "complete",
      media_id: matchedPost.id,
      published_at: matchedPost.sentAt,
      buffer: { post_id: matchedPost.id, channel_id: matchedPost.channelId ?? storedChannelId ?? null, status: "sent", sent_at: matchedPost.sentAt },
    };
  }

  if (matchedPost.status === TERMINAL_ERROR_STATUS) {
    return {
      action: "fail",
      message: "Buffer reports this post's status as 'error' during automatic completion reconciliation.",
      http_outcome_category: "buffer_post_error",
    };
  }

  // draft | needs_approval | scheduled | sending | any unrecognized value —
  // still in progress or not yet understood; never guessed in either
  // direction.
  return { action: "none", reason: "still_processing" };
}

/**
 * Runs the full reconciliation pass across every eligible record in
 * `state`, independently — a per-record read/apply failure never aborts
 * the batch, matching this codebase's existing "never let one story's
 * trouble block every other story" convention (see generate-selection.js).
 * @param {object} state - the current data/social-state.json document
 * @param {{reconcileStory: (storyId: string) => Promise<{ok: boolean, matchedPost?: object, error?: string}>,
 *          applyResult: (args: {story_id: string, claim_id: string, event_type: string, payload: object}) => Promise<{ok: boolean, error?: string}>}} deps
 * @returns {Promise<Array<{story_id: string, eligible: true, action: string, detail?: string, applied?: boolean, applyError?: string}>>}
 */
export async function runBufferCompletionReconciliation(state, { reconcileStory, applyResult }) {
  const results = [];
  const stories = state?.stories ?? {};

  for (const [storyId, record] of Object.entries(stories)) {
    if (!isEligibleForCompletionReconciliation(record)) continue;

    let reconcileResult;
    try {
      reconcileResult = await reconcileStory(storyId);
    } catch (err) {
      results.push({ story_id: storyId, eligible: true, action: "none", detail: `reconcile_read_error: ${err.message}` });
      continue;
    }

    if (!reconcileResult?.ok) {
      results.push({ story_id: storyId, eligible: true, action: "none", detail: `reconcile_read_error: ${reconcileResult?.error ?? reconcileResult?.reason ?? "unknown"}` });
      continue;
    }

    const decision = decideReconciliationAction(record, reconcileResult.matchedPost ?? null);

    if (decision.action === "none") {
      results.push({ story_id: storyId, eligible: true, action: "none", detail: decision.reason });
      continue;
    }

    const claimId = record.publishing.claim?.claim_id;
    if (!isNonEmptyString(claimId)) {
      results.push({ story_id: storyId, eligible: true, action: decision.action, detail: "missing_claim_id", applied: false });
      continue;
    }

    const eventType = decision.action === "complete" ? "posting-completed" : "posting-failed";
    const payload =
      decision.action === "complete"
        ? { media_id: decision.media_id, published_at: decision.published_at, buffer: decision.buffer }
        : { message: decision.message, http_outcome_category: decision.http_outcome_category };

    try {
      const applied = await applyResult({ story_id: storyId, claim_id: claimId, event_type: eventType, payload });
      results.push({ story_id: storyId, eligible: true, action: decision.action, applied: !!applied?.ok, applyError: applied?.ok ? undefined : (applied?.error ?? applied?.reason ?? "unknown") });
    } catch (err) {
      results.push({ story_id: storyId, eligible: true, action: decision.action, applied: false, applyError: err.message });
    }
  }

  return results;
}
