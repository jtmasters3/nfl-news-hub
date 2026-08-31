#!/usr/bin/env node
// Local, localhost-ONLY approval console for the Approval phase. This is
// the one place a human decides awaiting_approval -> approved|rejected.
//
// Trust boundary (see the Approval architecture): the browser NEVER talks
// to the Cloudflare Worker directly, and AGGREGATE_ARTWORK_API_TOKEN never
// leaves this Node process — it is read once from process.env, used only
// server-side (via lib/apiClient.js's decideApproval), and is never
// interpolated into any HTML/JS this server sends to the browser. The
// browser's only network calls are same-origin fetches to this server:
// GET / (the page) and POST /api/decide (submit a decision).
//
// This server also does the post-decision confirmation polling itself
// (see lib/waitForApprovalCommit.js) and returns ONE final outcome to the
// browser — the browser never polls anything directly.
//
// Usage:
//   node scripts/social-worker/approval-console.js
// Required env: ARTWORK_WORKER_BASE_URL, AGGREGATE_ARTWORK_API_TOKEN.
// Optional env: APPROVAL_CONSOLE_PORT (default 4321).
import http from "node:http";
import { escapeHtml } from "../lib/text.js";
import { formatHumanDateTime } from "../lib/dates.js";
import { fetchSocialState, decideApproval } from "./lib/apiClient.js";
import { waitForApprovalCommit } from "./lib/waitForApprovalCommit.js";
import { assessApprovalReadiness } from "./lib/approvalReadiness.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.APPROVAL_CONSOLE_PORT) || 4321;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMediaBlock(label, url, alt) {
  const body = url
    ? `<img class="approval-media-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt || "")}" loading="lazy" />`
    : `<p class="approval-empty">Not available</p>`;
  return `<div class="approval-media-block">
          <span class="approval-media-label">${escapeHtml(label)}</span>
          ${body}
        </div>`;
}

function renderCard(record) {
  const s = record.source_story || {};
  const c = record.caption || {};
  const headline = s.post_headline || "(no headline captured)";
  const hashtagLine = Array.isArray(c.hashtags) && c.hashtags.length ? `<p class="approval-caption-hashtags">${escapeHtml(c.hashtags.join(" "))}</p>` : "";
  const readiness = assessApprovalReadiness(record);

  // Legacy/not-ready records (e.g. records that reached awaiting_approval
  // before the Caption phase existed, so they were never captioned) are
  // still shown for visibility, but with no live decision controls — the
  // Worker's own not_ready_for_approval gate would refuse them anyway;
  // this is purely a UI safety net so a human is never offered a button
  // that would either fail or act on incomplete data.
  const decisionSection = readiness.ready
    ? `<div class="approval-decision-row">
          <button type="button" class="approval-btn approval-btn-approve" data-decision="approved">Approve</button>
          <button type="button" class="approval-btn approval-btn-reject" data-decision="rejected">Reject</button>
        </div>
        <label class="approval-reason-label">Rejection reason (optional)
          <input type="text" class="approval-reason-input" placeholder="Optional — only used if you click Reject" />
        </label>
        <p class="approval-status" role="status"></p>`
    : `<div class="approval-decision-row">
          <button type="button" class="approval-btn approval-btn-approve" disabled>Approve</button>
          <button type="button" class="approval-btn approval-btn-reject" disabled>Reject</button>
        </div>
        <p class="approval-not-actionable">Not actionable — ${escapeHtml(readiness.issues.join("; "))}</p>`;

  return `<article class="card approval-item" data-story-id="${escapeHtml(record.story_id)}">
        <div class="card-badges approval-badges">
          <span class="badge badge-category">${escapeHtml(record.status)}</span>
          ${s.category ? `<span class="badge badge-category">${escapeHtml(s.category)}</span>` : ""}
          ${readiness.ready ? "" : `<span class="badge badge-not-ready">not actionable</span>`}
        </div>
        <h2 class="headline approval-headline">${escapeHtml(headline)}</h2>
        <div class="approval-media">
          ${renderMediaBlock("Generated Graphic", record.artwork?.image_url, headline)}
          ${renderMediaBlock("Base Article Image", s.base_image_url, headline)}
        </div>
        <div class="approval-caption-block">
          <span class="approval-media-label">Generated Caption</span>
          <p class="approval-caption-text">${c.text ? escapeHtml(c.text) : `<span class="approval-empty">Caption not generated yet</span>`}</p>
          ${hashtagLine}
        </div>
        <p class="meta"><strong>Source:</strong> ${escapeHtml(s.source_name || "(unknown)")}
          ${s.source_url ? ` &mdash; <a href="${escapeHtml(s.source_url)}" target="_blank" rel="noopener noreferrer">View original</a>` : ""}</p>
        <p class="meta"><strong>Story ID:</strong> <code>${escapeHtml(record.story_id)}</code></p>
        <p class="meta"><strong>Created:</strong> ${escapeHtml(formatHumanDateTime(record.created_at))}</p>
        ${decisionSection}
      </article>`;
}

function renderPage(records) {
  const items = records.length ? records.map(renderCard).join("\n") : `<p class="empty-state">No posts are currently awaiting approval.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approval Console (local)</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #111; background: #fafafa; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; background: #fff; }
  .headline { font-size: 1.1rem; margin: 0.5rem 0; }
  .approval-media { display: flex; gap: 1rem; flex-wrap: wrap; }
  .approval-media-block { flex: 1 1 260px; }
  .approval-media-image { max-width: 100%; border-radius: 4px; }
  .approval-media-label { display: block; font-size: 0.75rem; text-transform: uppercase; color: #666; margin-bottom: 0.25rem; }
  .approval-caption-block { margin: 1rem 0; padding: 0.75rem; background: #f4f4f4; border-radius: 4px; }
  .approval-caption-text { white-space: pre-wrap; margin: 0 0 0.5rem; }
  .approval-caption-hashtags { color: #06c; margin: 0; }
  .meta { font-size: 0.85rem; color: #555; margin: 0.25rem 0; }
  .badge { display: inline-block; font-size: 0.7rem; text-transform: uppercase; background: #eee; border-radius: 3px; padding: 0.15rem 0.4rem; margin-right: 0.25rem; }
  .approval-decision-row { display: flex; gap: 0.5rem; margin-top: 1rem; }
  .approval-btn { flex: 1; padding: 0.6rem; font-size: 1rem; border-radius: 6px; border: none; cursor: pointer; }
  .approval-btn-approve { background: #1a7f37; color: #fff; }
  .approval-btn-reject { background: #b0261e; color: #fff; }
  .approval-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .approval-reason-label { display: block; font-size: 0.8rem; color: #555; margin-top: 0.5rem; }
  .approval-reason-input { display: block; width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.4rem; }
  .approval-status { font-size: 0.9rem; margin-top: 0.5rem; min-height: 1.2em; }
  .approval-not-actionable { font-size: 0.9rem; margin-top: 0.5rem; color: #92400e; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 4px; padding: 0.5rem; }
  .badge-not-ready { background: #fde68a; color: #78350f; }
  .approval-empty { color: #888; font-style: italic; }
  .empty-state { color: #666; }
</style>
</head>
<body>
  <h1>Approval Console <small style="font-weight:normal;color:#888;">(local — localhost only)</small></h1>
  <p class="meta">This page talks only to this local server. Reload to refresh the list.</p>
  <div id="approval-list">
    ${items}
  </div>
  <script>
    const OUTCOME_TEXT = {
      approved: () => "Approved ✓",
      rejected: () => "Rejected ✓",
      already_approved: () => "Already approved ✓",
      already_rejected: () => "Already rejected ✓",
      conflict_already_approved: () => "This post was already approved — it cannot be rejected.",
      conflict_already_rejected: () => "This post was already rejected — it cannot be approved.",
      invalid_state: (d) => "This post is no longer in a decidable state (" + (d.status || "unknown") + ").",
      not_ready_for_approval: (d) => "Not ready for approval: " + ((d.issues || []).join("; ") || "server-side checks failed."),
      blocked_opposite_decision: (d) => (d.decision === "approved" ? "Reject" : "Approve") + " already owns this decision and is still being confirmed by GitHub. " + (d.decision === "approved" ? "Approve" : "Reject") + " isn't available until that resolves.",
      in_flight: () => "A decision submission for this post is already in progress — wait a moment and check again.",
      recoverable_error: (d) => "GitHub didn't confirm the dispatch — safe to retry " + d.decision + " now.",
      timeout: (d) => "Still waiting on GitHub to confirm your " + (d.decision === "approved" ? "Approve" : "Reject") + " decision. This may still be processing. You can check again or safely retry " + (d.decision === "approved" ? "Approve" : "Reject") + ".",
      error: (d) => "Something went wrong: " + (d.message || "unknown error"),
    };

    function cardFor(button) {
      return button.closest(".approval-item");
    }

    async function submitDecision(card, decision) {
      const storyId = card.dataset.storyId;
      const statusEl = card.querySelector(".approval-status");
      const approveBtn = card.querySelector(".approval-btn-approve");
      const rejectBtn = card.querySelector(".approval-btn-reject");
      const reasonInput = card.querySelector(".approval-reason-input");
      const requestId = crypto.randomUUID(); // one id per logical click — reused only by this click's own automatic retries below

      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      statusEl.textContent = decision === "approved" ? "Submitting Approve…" : "Submitting Reject…";

      const body = JSON.stringify({
        story_id: storyId,
        decision,
        request_id: requestId,
        rejection_reason: decision === "rejected" ? reasonInput.value.trim() || null : null,
      });

      let response = null;
      let lastError = null;
      // Bounded local retry ONLY for an uncertain network outcome talking
      // to our own localhost server (e.g. the request never completed) —
      // reuses the SAME request_id, since it's still the same logical click.
      for (let attempt = 1; attempt <= 3 && !response; attempt++) {
        try {
          const res = await fetch("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body });
          response = await res.json();
        } catch (err) {
          lastError = err;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }

      if (!response) {
        statusEl.textContent = "Local request failed: " + (lastError ? lastError.message : "unknown error") + ". Safe to try again.";
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        return;
      }

      const outcome = response.outcome || "error";
      const textFn = OUTCOME_TEXT[outcome] || OUTCOME_TEXT.error;
      statusEl.textContent = textFn({ ...response, decision });

      const terminal = outcome === "approved" || outcome === "rejected" || outcome === "already_approved" || outcome === "already_rejected";
      if (terminal) {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        return;
      }

      if (outcome === "conflict_already_approved" || outcome === "conflict_already_rejected" || outcome === "invalid_state" || outcome === "not_ready_for_approval") {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        return;
      }

      if (outcome === "blocked_opposite_decision") {
        // The OTHER decision owns this story's lifecycle — never imply the
        // one that was just blocked is safe to retry; the owning decision
        // stays available since retrying it is always safe.
        if (decision === "approved") { approveBtn.disabled = true; rejectBtn.disabled = true; }
        else { rejectBtn.disabled = true; approveBtn.disabled = true; }
        return;
      }

      if (outcome === "in_flight") {
        approveBtn.disabled = decision !== "approved";
        rejectBtn.disabled = decision !== "rejected";
        return;
      }

      // recoverable_error / timeout: only the SAME decision is safe to retry.
      approveBtn.disabled = decision !== "approved";
      rejectBtn.disabled = decision !== "rejected";
    }

    document.querySelectorAll(".approval-btn").forEach((btn) => {
      btn.addEventListener("click", () => submitDecision(cardFor(btn), btn.dataset.decision));
    });
  </script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function classifyDecideResult(decideResult) {
  const result = decideResult.result;
  if (result === "pending") return { outcome: "pending", needsPoll: true };
  if (["already_approved", "already_rejected", "conflict_already_approved", "conflict_already_rejected", "invalid_state", "not_ready_for_approval", "blocked_opposite_decision", "in_flight", "recoverable_error"].includes(result)) {
    return { outcome: result, needsPoll: false };
  }
  return { outcome: "error", needsPoll: false };
}

async function handleDecide(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: "error", message: "invalid_json" }));
    return;
  }

  const storyId = body.story_id;
  const decision = body.decision;
  const requestId = body.request_id;
  const rejectionReason = body.rejection_reason;

  if (!storyId || (decision !== "approved" && decision !== "rejected") || !requestId) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: "error", message: "invalid_request" }));
    return;
  }

  let decideResult;
  try {
    decideResult = await decideApproval(storyId, decision, { requestId, rejectionReason });
  } catch (err) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: "error", message: err.message }));
    return;
  }

  const classified = classifyDecideResult(decideResult);

  if (!classified.needsPoll) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: classified.outcome, ...decideResult }));
    return;
  }

  // "pending": dispatch was accepted by GitHub (or an earlier attempt's
  // dispatch was) but not yet committed. Poll the authoritative state
  // server-side and return ONE final outcome — the browser never polls
  // anything itself.
  const pollResult = await waitForApprovalCommit(fetchSocialState, storyId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(pollResult.committed ? { outcome: pollResult.status } : { outcome: "timeout" }));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      const state = await fetchSocialState();
      const records = Object.values(state.stories || {})
        .filter((r) => r.status === "awaiting_approval")
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage(records));
      return;
    }
    if (req.method === "POST" && req.url === "/api/decide") {
      await handleDecide(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error", message: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Approval console running at http://${HOST}:${PORT}/ (localhost only — do not expose this port)`);
});
