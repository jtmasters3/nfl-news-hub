// Real HTTP-calling adapters for the Buffer posting bridge (Stage 5B).
// Replaces Stage 5A's ad-hoc mock-shaped stub dependencies
// (bufferFeedOrchestrator.js used to receive already-decided
// claimPosting/recordPublishAttempt functions with no real request-building
// or response-parsing behind them) with functions that actually call the
// cloudflare-worker's real endpoints — /social/posting/claim,
// /social/posting/publish-attempted, /social/posting/result,
// /publish/buffer/feed, /social/posting/reconcile, /social/artwork/jpeg —
// added this stage.
//
// Every function here takes an explicitly injected `fetchImpl`; construction
// fails closed with no live-network fallback if one isn't supplied, matching
// the exact pattern already used by createMetaClient/createBufferClient/
// createBufferPublisherClient. Each adapter makes AT MOST ONE HTTP request
// per call — no retry loop exists anywhere in this file. The Worker's own
// bearer-token authentication is the same shared gate every other route
// uses; this module never sees or needs a Buffer/Meta credential — those
// live only in the Worker's own secret storage.
function assertFetchImpl(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createBufferPostingBridge requires an explicit fetchImpl function — no live-network fallback exists.");
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`createBufferPostingBridge requires a non-empty ${name}`);
  }
}

/**
 * @param {{fetchImpl: Function, workerBaseUrl: string, workerApiToken: string}} args
 */
export function createBufferPostingBridge({ fetchImpl, workerBaseUrl, workerApiToken }) {
  assertFetchImpl(fetchImpl);
  assertNonEmptyString(workerBaseUrl, "workerBaseUrl");
  assertNonEmptyString(workerApiToken, "workerApiToken");

  async function postJson(path, body) {
    let res;
    try {
      res = await fetchImpl(`${workerBaseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${workerApiToken}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { __transportError: true, error: "network_error", message: err?.message ?? "network error" };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { __transportError: true, error: "invalid_response", httpStatus: res.status };
    }
    return { httpStatus: res.status, ...json };
  }

  return {
    /**
     * Acquires exclusive posting:{story_id} ownership AND durably applies
     * posting-claimed as a single call — this mirrors the Worker's real
     * postingClaim.js handler, which fires the posting-claimed
     * repository_dispatch as part of the very same request that wins the
     * Durable Object claim. There is no separate "acquire claim" call in
     * this architecture; the caller must still confirm the resulting commit
     * landed (see waitForDurableCommit.js) before treating it as durable.
     * @param {{storyId: string, captionUsed: string, storageKey?: string, jpegUrl?: string, provider?: string}} args
     */
    async claimPosting({ storyId, captionUsed, storageKey, jpegUrl, provider = "buffer" }) {
      const result = await postJson("/social/posting/claim", {
        story_id: storyId,
        caption_used: captionUsed,
        storage_key: storageKey,
        jpeg_url: jpegUrl,
        provider,
      });
      if (result.__transportError) return { ok: false, error: result.error, message: result.message, httpStatus: result.httpStatus };
      if (!result.claimed) return { ok: false, error: result.reason ?? "claim_failed", httpStatus: result.httpStatus };
      return {
        ok: true,
        claim_id: result.claim_id,
        processor_id: result.processor_id,
        claimed_at: result.claimed_at,
        claim_expires_at: result.claim_expires_at,
      };
    },

    /**
     * Durably records the publish-attempt checkpoint via the Worker's real
     * claim-ownership-verified endpoint. Must be confirmed committed (via
     * waitForDurableCommit.js) before the caller may proceed to Buffer.
     * @param {{storyId: string, claimId: string, publishAttemptedAt: string}} args
     */
    async recordPublishAttempt({ storyId, claimId, publishAttemptedAt }) {
      const result = await postJson("/social/posting/publish-attempted", {
        story_id: storyId,
        claim_id: claimId,
        publish_attempted_at: publishAttemptedAt,
      });
      if (result.__transportError) return { ok: false, error: result.error, message: result.message, httpStatus: result.httpStatus };
      if (!result.ok) return { ok: false, error: result.reason ?? "publish_attempt_failed", httpStatus: result.httpStatus };
      return { ok: true };
    },

    /**
     * Durably applies exactly one of the four terminal/near-terminal result
     * events. Called AFTER the single Buffer mutation attempt — a failure
     * here must never be interpreted by the caller as license to call
     * Buffer again (see bufferFeedOrchestrator.js's manual-reconciliation
     * outcome).
     * @param {{storyId: string, claimId: string, eventType: string, payload: object}} args
     */
    async recordPostingResult({ storyId, claimId, eventType, payload }) {
      const result = await postJson("/social/posting/result", {
        story_id: storyId,
        claim_id: claimId,
        event_type: eventType,
        payload,
      });
      if (result.__transportError) return { ok: false, error: result.error, message: result.message, httpStatus: result.httpStatus };
      if (!result.ok) return { ok: false, error: result.reason ?? "result_persist_failed", httpStatus: result.httpStatus };
      return { ok: true };
    },

    /**
     * Invokes the Worker's real Buffer-publishing endpoint exactly once.
     * Returns the Worker's response shape unchanged
     * ({ok, storyId, outcome, data, error}) for mapBufferWorkerOutcomeToEvent
     * to interpret — this function itself never guesses at the outcome.
     * @param {{storyId: string, channelId: string, caption: string, imageUrl: string, publishAttemptCheckpoint: {publishAttemptedAt: string}}} args
     */
    async publishViaWorker({ storyId, channelId, caption, imageUrl, publishAttemptCheckpoint }) {
      const result = await postJson("/publish/buffer/feed", { storyId, channelId, caption, imageUrl, publishAttemptCheckpoint });
      if (result.__transportError) return { ok: false, error: { category: result.error, message: result.message } };
      return result;
    },

    /**
     * The Story sibling of publishViaWorker() above — identical shape and
     * behavior, hitting the Worker's separate /publish/buffer/story route
     * (which calls publishStoryPost()/createStoryPost() server-side, never
     * publishFeedPost()/createPost()). Kept as its own method rather than a
     * parameter on publishViaWorker so a caller can never accidentally
     * target the wrong route by passing the wrong flag.
     * @param {{storyId: string, channelId: string, caption: string, imageUrl: string, publishAttemptCheckpoint: {publishAttemptedAt: string}}} args
     */
    async publishViaWorkerStory({ storyId, channelId, caption, imageUrl, publishAttemptCheckpoint }) {
      const result = await postJson("/publish/buffer/story", { storyId, channelId, caption, imageUrl, publishAttemptCheckpoint });
      if (result.__transportError) return { ok: false, error: { category: result.error, message: result.message } };
      return result;
    },

    /**
     * Read-only reconciliation lookup. Fires no dispatch itself — the
     * caller is responsible for persisting whatever outcome this reports
     * via recordPostingResult, keeping "decide" and "persist" separate.
     * Not scheduled/wired into any automation by this stage.
     * @param {{storyId: string}} args
     */
    async reconcile({ storyId }) {
      const result = await postJson("/social/posting/reconcile", { story_id: storyId });
      if (result.__transportError) return { ok: false, error: result.error, message: result.message };
      return result;
    },

    /**
     * Uploads a JPEG derivative buffer to the Worker's deterministic
     * storage endpoint. Not claim-gated (see postingJpegUpload.js's header
     * on the Worker side) — this runs before the posting claim is ever
     * acquired, matching the real orchestrator step order (caption/JPEG
     * resolution happens before claimPosting()). Makes exactly one HTTP
     * request; never retries.
     * @param {{storyId: string, jpegBuffer: Buffer}} args
     */
    async uploadJpeg({ storyId, jpegBuffer }) {
      const form = new FormData();
      form.set("story_id", storyId);
      form.set("jpeg", new Blob([jpegBuffer], { type: "image/jpeg" }), `${storyId}.jpg`);

      let res;
      try {
        res = await fetchImpl(`${workerBaseUrl}/social/artwork/jpeg`, {
          method: "POST",
          headers: { authorization: `Bearer ${workerApiToken}` },
          body: form,
        });
      } catch (err) {
        return { ok: false, error: "network_error", message: err?.message ?? "network error" };
      }
      let result;
      try {
        result = await res.json();
      } catch {
        return { ok: false, error: "invalid_response", httpStatus: res.status };
      }
      if (!result.uploaded) return { ok: false, error: result.reason ?? "upload_failed", httpStatus: res.status };
      return { ok: true, publicUrl: result.publicUrl, storageKey: result.storageKey, reused: !!result.reused };
    },

    /**
     * The Story sibling of uploadJpeg() above — identical shape, uploads to
     * the Worker's separate /social/artwork/jpeg-story route (9:16
     * ratio/floor validation server-side, a separate storage key prefix
     * from Feed's). Not claim-gated, same as uploadJpeg — runs before the
     * posting claim is acquired.
     * @param {{storyId: string, jpegBuffer: Buffer}} args
     */
    async uploadStoryJpeg({ storyId, jpegBuffer }) {
      const form = new FormData();
      form.set("story_id", storyId);
      form.set("jpeg", new Blob([jpegBuffer], { type: "image/jpeg" }), `${storyId}.jpg`);

      let res;
      try {
        res = await fetchImpl(`${workerBaseUrl}/social/artwork/jpeg-story`, {
          method: "POST",
          headers: { authorization: `Bearer ${workerApiToken}` },
          body: form,
        });
      } catch (err) {
        return { ok: false, error: "network_error", message: err?.message ?? "network error" };
      }
      let result;
      try {
        result = await res.json();
      } catch {
        return { ok: false, error: "invalid_response", httpStatus: res.status };
      }
      if (!result.uploaded) return { ok: false, error: result.reason ?? "upload_failed", httpStatus: res.status };
      return { ok: true, publicUrl: result.publicUrl, storageKey: result.storageKey, reused: !!result.reused };
    },
  };
}
