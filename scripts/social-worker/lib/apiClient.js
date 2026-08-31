// Thin HTTP client for the Cloudflare Worker bridge. Deliberately the ONLY
// way this local processor ever touches production state — no direct
// reads/writes of data/social-state.json, no local dedup bookkeeping (rule
// A: backend state is authoritative, not local filenames/memory).
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function baseUrl() {
  const url = process.env.ARTWORK_WORKER_BASE_URL;
  if (!url) throw new Error("ARTWORK_WORKER_BASE_URL is not set.");
  return url.replace(/\/+$/, "");
}

function token() {
  const t = process.env.AGGREGATE_ARTWORK_API_TOKEN;
  if (!t) throw new Error("AGGREGATE_ARTWORK_API_TOKEN is not set.");
  return t;
}

export function defaultProcessorId() {
  return process.env.ARTWORK_PROCESSOR_ID || `local-codex-${os.hostname()}`;
}

// A truthful console-instance identifier, NOT a cryptographically verified
// human identity — the approval console authenticates with the same
// shared bearer token as everything else here, so this only ever
// identifies "which authenticated console instance made this decision".
export function defaultApprovalActor() {
  return process.env.APPROVAL_ACTOR_ID || `local-approval-${os.hostname()}`;
}

async function postJson(pathName, body) {
  const res = await fetch(`${baseUrl()}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...parsed };
}

export async function claimStory(storyId, { processorId = defaultProcessorId(), leaseMs } = {}) {
  return postJson("/social/artwork/claim", { story_id: storyId, processor_id: processorId, lease_ms: leaseMs });
}

export async function completeArtwork(storyId, claimId, filePath, { provider = "chatgpt-codex-local" } = {}) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.set("story_id", storyId);
  form.set("claim_id", claimId);
  form.set("provider", provider);
  form.set("image", new Blob([bytes], { type: "image/png" }), path.basename(filePath));

  const res = await fetch(`${baseUrl()}/social/artwork/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
    body: form,
  });
  const parsed = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...parsed };
}

export async function failArtwork(storyId, claimId, stage, message) {
  return postJson("/social/artwork/fail", { story_id: storyId, claim_id: claimId, stage, message });
}

// --- Caption (Phase 2C) — a separate, independent claim lifecycle from
// artwork above, only ever claimable once a story has reached
// "artwork_ready". JSON throughout, not multipart — no binary involved.

export async function claimCaption(storyId, { processorId = defaultProcessorId(), leaseMs } = {}) {
  return postJson("/social/caption/claim", { story_id: storyId, processor_id: processorId, lease_ms: leaseMs });
}

export async function completeCaption(storyId, claimId, { text, hashtags, attributionLine, sourceUrl, provider = "chatgpt-codex-local" }) {
  return postJson("/social/caption/complete", {
    story_id: storyId,
    claim_id: claimId,
    text,
    hashtags: hashtags || [],
    attribution_line: attributionLine || null,
    source_url: sourceUrl || null,
    provider,
  });
}

export async function failCaption(storyId, claimId, message, lastCandidateText) {
  return postJson("/social/caption/fail", { story_id: storyId, claim_id: claimId, message, last_candidate_text: lastCandidateText || null });
}

// --- Approval (Phase Approval) — a decision-aware claim lifecycle, still
// on the SAME Durable Object class, key "approval:{story_id}". See
// cloudflare-worker/src/handlers/approvalDecide.js for the full
// first-decision-wins semantics.

export async function decideApproval(storyId, decision, { requestId, rejectionReason, actor = defaultApprovalActor() } = {}) {
  return postJson("/social/approval/decide", {
    story_id: storyId,
    decision,
    request_id: requestId,
    rejection_reason: rejectionReason || null,
    actor,
  });
}

export async function fetchArtworkQueue() {
  const url = process.env.ARTWORK_QUEUE_URL || "https://jtmasters3.github.io/nfl-news-hub/social-artwork-queue.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch artwork queue: ${res.status}`);
  return res.json();
}

// Public, unauthenticated read of the authoritative state — same raw
// content path the Cloudflare Worker itself reads (see cloudflare-worker's
// github.js). Used by the approval console both to list pending records
// and to poll for the real committed approved/rejected transition.
export async function fetchSocialState() {
  const url = process.env.SOCIAL_STATE_URL || "https://raw.githubusercontent.com/jtmasters3/nfl-news-hub/main/data/social-state.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch data/social-state.json: ${res.status}`);
  return res.json();
}
