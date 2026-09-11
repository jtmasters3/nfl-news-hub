// Stage 5B: the real orchestration sequence for executing one approved
// Feed post through Buffer. Stage 5A's version of this file used ad-hoc
// mock-shaped stub dependencies for claimPosting/recordPublishAttempt — a
// mocked ordering test proved only that the SEQUENCING logic was correct,
// never that the real production path could durably write the posting
// claim and publish-attempt checkpoint before a Buffer mutation. This
// version calls through real HTTP-calling adapters (bufferPostingBridge.js)
// and proves each durable checkpoint actually committed (via
// waitForDurableCommit.js, the same SHA-pinned-read pattern already proven
// for approval decisions) before advancing.
//
// NOT scheduled, NOT wired into process-one.js, and NOT invoked against
// production in this stage — every dependency remains explicitly injected,
// and this module itself still never calls fetch directly. A future caller
// constructs `bridge` via createBufferPostingBridge({fetchImpl, ...}) with
// a real fetchImpl, and `fetchState` via githubStateReader.js's
// createFreshStateFetcher() — both of those live entirely outside this file.
//
// Destination-generic sequencing (added alongside Story publishing):
// executeBufferFeedPublish()'s own name and default behavior for every
// existing Feed caller are completely unchanged, but its precondition check
// is now an injectable `validatePreconditions` (default:
// validateBufferFeedPublishPreconditions) and its two internal
// durable-commit predicates read whichever of publishing.instagram.feed/
// .story applies via the shared channelKeyFor() (postingEvents.js) instead
// of a hardcoded `.feed` — so a Story caller (publish-buffer-story.js) can
// reuse this ENTIRE proven sequencing/durability implementation by passing
// validateBufferStoryPublishPreconditions + Story-specific
// resolveJpeg/publishViaWorker, rather than a second reliability system
// existing anywhere in this codebase.
//
// Exact required sequence (Stage 5B spec): 1. Load record 2. Validate
// approved Feed/not posted 3. Acquire exclusive posting claim 4. Snapshot
// deterministic caption 5. Resolve deterministic approved JPEG 6. Durably
// apply posting-claimed (in this architecture, steps 3 and 6 are the SAME
// Worker call — postingClaim.js's handler wins Durable Object ownership and
// fires the posting-claimed dispatch in one request; this function still
// separately CONFIRMS that dispatch committed before treating claim
// ownership as durable) 7. Durably apply posting-publish-attempted 8. Verify
// durable publishAttemptedAt checkpoint exists 9. Call Buffer Worker
// endpoint ONCE 10. Map outcome into the appropriate posting event 11.
// Durably apply that result event AND confirm it actually committed — the
// same "dispatch accepted is not durable persistence" property enforced
// for steps 6 and 7 applies here too. No external Buffer mutation may
// happen before step 8 completes, and step 9 is never retried regardless
// of what happens afterward — including if step 11's persistence or its
// durable-commit confirmation fails. A confirmed-uncommitted result after
// Buffer has already been called is a manual-reconciliation condition, not
// a retry trigger and not license to guess the outcome.
import { assembleInstagramCaption } from "./captionAssembly.js";
import { waitForDurableCommit } from "./waitForDurableCommit.js";
import { channelKeyFor } from "../../lib/postingEvents.js";

/**
 * Pure precondition check — no I/O. Mirrors the exact same checks
 * applyPostingClaimedEvent() itself re-asserts server-side (defense in
 * depth), so a caller can fail fast locally before ever attempting a claim.
 * @param {object} record
 */
export function validateBufferFeedPublishPreconditions(record) {
  if (record?.approval?.status !== "approved") return { ok: false, error: "not_approved" };
  if (record?.selection?.destination !== "feed") return { ok: false, error: "wrong_destination" };
  if (record?.publishing?.status === "posted") return { ok: false, error: "already_posted" };
  if (record?.publishing?.status && record.publishing.status !== "not_posted") return { ok: false, error: `invalid_state:${record.publishing.status}` };
  return { ok: true };
}

/**
 * The Story sibling of validateBufferFeedPublishPreconditions() above —
 * identical checks, requiring destination==="story" instead of "feed". Kept
 * as a SEPARATE exported function (rather than parametrizing the Feed one)
 * so auto-publish-approved-feed.js's own eligibility filter is completely
 * unaffected by Story's existence: it calls the Feed function by name and
 * always did, so its selection set cannot silently grow to include Story
 * records just because this module now also understands Story.
 */
export function validateBufferStoryPublishPreconditions(record) {
  if (record?.approval?.status !== "approved") return { ok: false, error: "not_approved" };
  if (record?.selection?.destination !== "story") return { ok: false, error: "wrong_destination" };
  if (record?.publishing?.status === "posted") return { ok: false, error: "already_posted" };
  if (record?.publishing?.status && record.publishing.status !== "not_posted") return { ok: false, error: `invalid_state:${record.publishing.status}` };
  return { ok: true };
}

const BUFFER_NONTERMINAL_STATUSES = new Set(["scheduled", "sending", "draft", "needs_approval"]);

/**
 * Pure mapping — given the Worker's /publish/buffer/feed JSON response
 * (`{ok, storyId, outcome, data, error}`), decides EXACTLY which posting
 * event should be applied next. Never guesses in favor of "posted": only
 * Buffer status "sent" (with a real post id) maps to posting-completed;
 * every other recognized nonterminal status maps to posting-buffer-created;
 * a proven definite_failure maps to posting-failed; anything else —
 * ambiguous, a transport-level failure reaching the Worker itself, or an
 * unrecognized/missing Buffer status even on a "successful" call — maps to
 * posting-ambiguous. There is no path back to a retry.
 * @param {{storyId: string, claimId: string, channelId: string, workerResponse: object, now: string}} args
 */
export function mapBufferWorkerOutcomeToEvent({ storyId, claimId, channelId, workerResponse, now }) {
  const outcome = workerResponse?.outcome;
  const data = workerResponse?.data;
  const error = workerResponse?.error;
  // The Worker's safe, sanitized, structured summary of the raw Buffer
  // response (see cloudflare-worker's bufferOutcome.js buildBufferResponseDiagnostic)
  // — threaded through into EVERY mapped event's payload so the exact
  // response characteristics (http_status, data_is_null, has_errors_array,
  // etc.) become durable in social-state.json, not merely visible in a
  // Worker response nobody may still be looking at by the time it matters.
  // Never contains a secret — the Worker itself already stripped those.
  const httpDiagnostic = workerResponse?.diagnostic ?? null;

  if (workerResponse?.ok !== true || !outcome) {
    // The Worker call itself failed to complete normally (network error,
    // non-200, malformed body) — we cannot know whether Buffer's
    // createPost was ever reached. Never guessed either way.
    return { eventType: "posting-ambiguous", payload: { story_id: storyId, claim_id: claimId, http_outcome_category: "worker_call_failed", http_diagnostic: httpDiagnostic } };
  }

  if (outcome === "definite_success") {
    const bufferStatus = data?.status;
    if (bufferStatus === "sent" && data?.id) {
      return {
        eventType: "posting-completed",
        payload: {
          story_id: storyId,
          claim_id: claimId,
          media_id: data.id,
          published_at: data.sentAt || now,
          buffer: { post_id: data.id, channel_id: channelId, status: "sent", sent_at: data.sentAt || now, due_at: data.dueAt ?? null },
          http_diagnostic: httpDiagnostic,
        },
      };
    }
    if (BUFFER_NONTERMINAL_STATUSES.has(bufferStatus) && data?.id) {
      return {
        eventType: "posting-buffer-created",
        payload: { story_id: storyId, claim_id: claimId, post_id: data.id, channel_id: channelId, status: bufferStatus, due_at: data.dueAt ?? null, sent_at: data.sentAt ?? null, http_diagnostic: httpDiagnostic },
      };
    }
    // A "success" with no post id, or an unrecognized status — never guessed.
    return { eventType: "posting-ambiguous", payload: { story_id: storyId, claim_id: claimId, http_outcome_category: `unrecognized_buffer_status:${bufferStatus ?? "missing"}`, http_diagnostic: httpDiagnostic } };
  }

  if (outcome === "definite_failure") {
    return { eventType: "posting-failed", payload: { story_id: storyId, claim_id: claimId, message: error?.message ?? "Buffer reported a definite failure", http_outcome_category: error?.category ?? "unknown", http_diagnostic: httpDiagnostic } };
  }

  // outcome === "ambiguous", or any future/unrecognized outcome label.
  return { eventType: "posting-ambiguous", payload: { story_id: storyId, claim_id: claimId, http_outcome_category: error?.category ?? "ambiguous", http_diagnostic: httpDiagnostic } };
}

/**
 * The full sequencing orchestrator, using real production adapters
 * (`bridge`, built by createBufferPostingBridge) and a real durable-commit
 * fetcher (`fetchState`, built by githubStateReader.js's
 * createFreshStateFetcher()) — both explicitly injected, so this module
 * still makes no network call of any kind itself.
 *
 * `bridge.publishViaWorker` is invoked AT MOST ONCE per call to this
 * function, no matter what it returns and no matter what happens
 * afterward — there is no retry loop anywhere in this file.
 * @param {object} args
 * @param {string} args.storyId
 * @param {string} args.channelId - the configured Buffer Instagram channel id
 * @param {() => Promise<object>} args.fetchState - returns the current, authoritative social state (SHA-pinned read)
 * @param {(args: {storyId: string, captionUsed: string, storageKey?: string, jpegUrl?: string, provider: string}) => Promise<{ok: true, claim_id: string, processor_id: string, claimed_at: string, claim_expires_at: string}|{ok: false, error: string}>} args.claimPosting
 * @param {(record: object) => Promise<{ok: true, jpegUrl: string, storageKey: string}|{ok: false, error: string}>} args.resolveJpeg
 * @param {(args: {storyId: string, claimId: string, publishAttemptedAt: string}) => Promise<{ok: boolean, error?: string}>} args.recordPublishAttempt
 * @param {(args: {storyId: string, channelId: string, caption: string, imageUrl: string, publishAttemptCheckpoint: {publishAttemptedAt: string}}) => Promise<object>} args.publishViaWorker
 * @param {(args: {storyId: string, claimId: string, eventType: string, payload: object}) => Promise<{ok: boolean, error?: string}>} args.recordPostingResult
 * @param {() => string} [args.now]
 * @param {object} [args.pollOptions] - forwarded to waitForDurableCommit (attempts/intervalMs/sleep/onWaiting) — tests override these for speed
 */
export async function executeBufferFeedPublish({
  storyId,
  channelId,
  fetchState,
  claimPosting,
  resolveJpeg,
  recordPublishAttempt,
  publishViaWorker,
  recordPostingResult,
  now = () => new Date().toISOString(),
  pollOptions = {},
  // Injected precondition check — defaults to the exact Feed-only gate this
  // function has always used, so every existing Feed caller (which never
  // passes this) is completely unaffected. A Story caller (see
  // auto-publish-approved-story.js / publish-buffer-story.js) passes
  // validateBufferStoryPublishPreconditions instead, reusing this entire
  // sequencing/durability implementation rather than forking a second one.
  validatePreconditions = validateBufferFeedPublishPreconditions,
}) {
  // 1. Load record — always fresh, never a caller-supplied snapshot.
  const state = await fetchState();
  const record = state?.stories?.[storyId];
  if (!record) return { ok: false, step: "load_record", error: "not_found" };

  // 2. Validate approved / not posted for the caller's own destination.
  const precondition = validatePreconditions(record);
  if (!precondition.ok) return { ok: false, step: "precondition", error: precondition.error };

  // 4. Snapshot deterministic caption.
  const captionResult = assembleInstagramCaption(record);
  if (!captionResult.ok) return { ok: false, step: "caption", error: captionResult.error };

  // 5. Resolve deterministic approved JPEG.
  const jpegResult = await resolveJpeg(record);
  if (!jpegResult.ok) return { ok: false, step: "jpeg", error: jpegResult.error };

  // 3 + 6. Acquire exclusive posting claim — in this architecture the same
  // Worker call also durably applies posting-claimed (see file header).
  const claim = await claimPosting({
    storyId,
    captionUsed: captionResult.caption,
    storageKey: jpegResult.storageKey,
    jpegUrl: jpegResult.jpegUrl,
    provider: "buffer",
  });
  if (!claim.ok) return { ok: false, step: "claim", error: claim.error };

  // Prove the posting-claimed event actually committed — dispatch
  // acceptance alone is not durability. No external mutation may happen
  // before this resolves true.
  const claimCommit = await waitForDurableCommit(
    fetchState,
    storyId,
    (r) => r?.publishing?.claim?.claim_id === claim.claim_id,
    pollOptions
  );
  if (!claimCommit.committed) return { ok: false, step: "claim_commit_confirmation", error: claimCommit.status, claim };

  // 7. Durably apply posting-publish-attempted BEFORE any Buffer call.
  const publishAttemptedAt = now();
  const attemptResult = await recordPublishAttempt({ storyId, claimId: claim.claim_id, publishAttemptedAt });
  if (!attemptResult.ok) return { ok: false, step: "publish_attempted", error: attemptResult.error ?? "checkpoint_not_recorded", claim };

  // 8. Verify the durable publishAttemptedAt checkpoint actually landed —
  // the load-bearing safety property of this whole sequence.
  const attemptCommit = await waitForDurableCommit(
    fetchState,
    storyId,
    (r) => r?.publishing?.instagram?.[channelKeyFor(r)]?.publish_attempted_at === publishAttemptedAt,
    pollOptions
  );
  if (!attemptCommit.committed) return { ok: false, step: "publish_attempt_commit_confirmation", error: attemptCommit.status, claim, publishAttemptedAt };

  // 9. Call Buffer Worker endpoint EXACTLY ONCE. Nothing below this line
  // may ever trigger a second call to publishViaWorker.
  const workerResponse = await publishViaWorker({
    storyId,
    channelId,
    caption: captionResult.caption,
    imageUrl: jpegResult.jpegUrl,
    publishAttemptCheckpoint: { publishAttemptedAt },
  });

  // 10. Map outcome into the appropriate posting event.
  const mapped = mapBufferWorkerOutcomeToEvent({ storyId, claimId: claim.claim_id, channelId, workerResponse, now: now() });

  // 11. Durably apply that result event. If persistence itself fails AFTER
  // the Buffer call, this is a manual-reconciliation condition — the
  // external mutation may already have succeeded, so Buffer is never called
  // again in response to this failure.
  const resultPersist = await recordPostingResult({ storyId, claimId: claim.claim_id, eventType: mapped.eventType, payload: mapped.payload });
  if (!resultPersist.ok) {
    return {
      ok: false,
      step: "result_persistence",
      error: resultPersist.error ?? "result_not_recorded",
      manualReconciliationRequired: true,
      claim,
      publishAttemptedAt,
      workerResponse,
      resultEvent: mapped,
    };
  }

  // Dispatch acceptance is NOT durable persistence — exactly the same gap
  // already closed for posting-claimed and posting-publish-attempted above.
  // Once Buffer has been called, the only safe response to "we cannot prove
  // our own result state actually committed" is manual reconciliation:
  // never call Buffer again, never guess the outcome either way.
  const resultCommit = await waitForDurableCommit(
    fetchState,
    storyId,
    buildResultCommitPredicate(mapped.eventType, mapped.payload),
    pollOptions
  );
  if (!resultCommit.committed) {
    return {
      ok: false,
      step: "result_persistence",
      error: resultCommit.status,
      manualReconciliationRequired: true,
      claim,
      publishAttemptedAt,
      workerResponse,
      resultEvent: mapped,
    };
  }

  return { ok: true, claim, publishAttemptedAt, workerResponse, resultEvent: mapped, record: resultCommit.record };
}

/**
 * Builds the predicate waitForDurableCommit uses to prove the result event
 * actually landed in committed state — never merely that GitHub accepted
 * the dispatch. Uses the existing reducer/state contract (postingEvents.js)
 * directly: no parallel status vocabulary is introduced here.
 * @param {string} eventType
 * @param {object} payload - the exact payload mapBufferWorkerOutcomeToEvent produced
 */
function buildResultCommitPredicate(eventType, payload) {
  switch (eventType) {
    case "posting-completed":
      return (record) => {
        if (record?.status !== "posted") return false;
        const feed = record?.publishing?.instagram?.[channelKeyFor(record)];
        if (feed?.status !== "posted") return false;
        if (feed?.media_id !== payload.media_id) return false;
        if (payload.buffer?.post_id && feed?.buffer?.post_id !== payload.buffer.post_id) return false;
        return true;
      };
    case "posting-buffer-created":
      return (record) => {
        if (record?.status !== "posting") return false;
        const feed = record?.publishing?.instagram?.[channelKeyFor(record)];
        if (feed?.status !== "buffer_post_created") return false;
        if (feed?.buffer?.post_id !== payload.post_id) return false;
        if (feed?.buffer?.status !== payload.status) return false;
        return true;
      };
    case "posting-failed":
      return (record) => record?.status === "failed" && record?.publishing?.instagram?.[channelKeyFor(record)]?.status === "failed";
    case "posting-ambiguous":
      return (record) => record?.status === "posting" && record?.publishing?.instagram?.[channelKeyFor(record)]?.status === "ambiguous";
    default:
      return () => false;
  }
}
