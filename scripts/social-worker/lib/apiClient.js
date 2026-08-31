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

export async function fetchArtworkQueue() {
  const url = process.env.ARTWORK_QUEUE_URL || "https://jtmasters3.github.io/nfl-news-hub/social-artwork-queue.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch artwork queue: ${res.status}`);
  return res.json();
}
