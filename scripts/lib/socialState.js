// Persistent social-workflow state — the authoritative record of whether a
// story_id has ever entered the social pipeline, and how far it's gotten.
// Deliberately separate from social-feed.json (a derived, fully-regenerated
// view of current story data) and social-artwork-queue.json (a derived,
// fully-regenerated view of THIS file) — this file is the one thing that
// must survive every 10-minute refresh unmodified except by an explicit,
// validated state transition. Never infer social history from headline,
// source URL, social-feed position, or any story count — story_id + this
// file is the only authority.
//
// I/O here mirrors store.js's pattern exactly (atomic temp-file-then-rename
// write, read-with-fallback) but lives in its own module because the
// transition-table validation and canonical-id resolution below are
// specific to this file, not general-purpose story storage.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { SOCIAL_STATE_PATH } from "./store.js";

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const STATES = Object.freeze([
  "preexisting_ignored",
  "new",
  "queued",
  "artwork_requested",
  "artwork_created",
  "validating",
  "awaiting_approval",
  "approved",
  "rejected",
  "caption_ready",
  "posting",
  "posted",
  "failed",
]);

// Adjacency list: from -> allowed to. Enforced by transition() below, so an
// invalid move (e.g. "posted" -> "new") is rejected in code, not just by
// convention. "validating" branches two ways deliberately: approval mode
// always lands on "awaiting_approval"; automatic mode (not implemented in
// this phase) is the only thing that would ever request "caption_ready"
// directly from "validating". "failed" is recoverable exactly once, into
// "awaiting_approval", for exception review — it never bounces back into
// the front of the pipeline.
const TRANSITIONS = Object.freeze({
  preexisting_ignored: ["new"],
  new: ["queued"],
  queued: ["artwork_requested"],
  artwork_requested: ["artwork_created", "failed"],
  artwork_created: ["validating"],
  validating: ["awaiting_approval", "caption_ready", "failed"],
  awaiting_approval: ["approved", "rejected"],
  approved: ["caption_ready"],
  rejected: [],
  caption_ready: ["posting"],
  posting: ["posted", "failed"],
  failed: ["awaiting_approval"],
  posted: [],
});

export function canTransition(fromStatus, toStatus) {
  return Array.isArray(TRANSITIONS[fromStatus]) && TRANSITIONS[fromStatus].includes(toStatus);
}

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

function emptySourceStory() {
  return { post_headline: null, base_image_url: null, source_name: null, source_url: null, category: null };
}

function emptyRecord(storyId, status) {
  const now = new Date().toISOString();
  return {
    story_id: storyId,
    status,
    merged_into: null,
    created_at: now,
    updated_at: now,
    source_story: emptySourceStory(),
    artwork: { status: "not_created", image_url: null, created_at: null, provider: null },
    validation: { status: "not_run", passed: null, issues: [] },
    approval: { status: "pending", approved_at: null, rejected_at: null },
    caption: { status: "not_created", text: null, created_at: null },
    publishing: {
      status: "not_posted",
      instagram: { status: "not_posted", post_id: null, post_url: null },
      facebook: { status: "not_posted", post_id: null, post_url: null },
      posted_at: null,
    },
    // Where/why the most recent failure happened, independent of which
    // platform or stage — stage is expected to eventually be one of
    // "artwork" | "validation" | "caption" | "instagram" | "facebook" |
    // "state_transition", but left as a free string here rather than an
    // enum since new stages (retries, new platforms) shouldn't require a
    // schema change to record.
    last_error: { stage: null, message: null, at: null, retry_count: 0 },
  };
}

export function emptyState() {
  return { schema_version: SCHEMA_VERSION, cutover_at: null, stories: {} };
}

// ---------------------------------------------------------------------------
// Canonical-id resolution (orphan -> canonical reconciliation support)
// ---------------------------------------------------------------------------

/**
 * Follows `merged_into` redirects to find the story a given id ultimately
 * resolves to, detecting cycles rather than looping forever. Every lookup
 * that means "does this story_id already have workflow history" (queued?
 * posted? has artwork?) must go through this first — an orphan reconciled
 * into a canonical id must never let its old id's absence of a record (or
 * a stale one) cause the canonical event to be reprocessed, and a canonical
 * id must never be treated as separate from an orphan that was merged into
 * it.
 *
 * Returns one of:
 *   { ok: true, story_id, record }         — record is null if never seen
 *   { ok: false, error: "redirect_loop", chain }
 *   { ok: false, error: "max_depth_exceeded", chain }
 */
export function resolveCanonicalId(state, storyId, { maxDepth = 10 } = {}) {
  const chain = [];
  let current = storyId;
  while (true) {
    if (chain.includes(current)) return { ok: false, error: "redirect_loop", chain: [...chain, current] };
    chain.push(current);
    if (chain.length > maxDepth) return { ok: false, error: "max_depth_exceeded", chain };
    const record = state.stories[current] ?? null;
    if (!record || !record.merged_into) return { ok: true, story_id: current, record };
    current = record.merged_into;
  }
}

/** Convenience wrapper: the resolved record, or null if none exists/unresolvable. */
export function getRecord(state, storyId) {
  const resolved = resolveCanonicalId(state, storyId);
  return resolved.ok ? resolved.record : null;
}

// ---------------------------------------------------------------------------
// Pure state operations — no file I/O, fully unit-testable. Each returns a
// NEW state object (never mutates the input) so callers can chain/compose
// and tests can assert against both before and after snapshots.
// ---------------------------------------------------------------------------

/**
 * Ensures a record exists for storyId, creating one with `status` if
 * missing. A no-op (created: false) if a record already exists — this is
 * what makes repeated 10-minute refreshes safe: syncing the same story_id
 * a hundred times creates exactly one record, ever.
 */
export function ensureRecord(state, storyId, { status = "new" } = {}) {
  if (state.stories[storyId]) return { state, created: false };
  const next = { ...state, stories: { ...state.stories, [storyId]: emptyRecord(storyId, status) } };
  return { state: next, created: true };
}

/**
 * For every story currently known, ensure a state record exists (status
 * "new" by default — cutover-seed.js is the only caller that passes
 * "preexisting_ignored" instead, and only at the one-time cutover moment).
 * Never touches an existing record.
 */
export function syncStories(state, stories, { defaultStatus = "new" } = {}) {
  let next = state;
  let created = 0;
  for (const story of stories) {
    const result = ensureRecord(next, story.id, { status: defaultStatus });
    next = result.state;
    if (result.created) created++;
  }
  return { state: next, created };
}

/** A story is ready for the artwork queue exactly when socialPayload.js's own "ready" check already says so — never re-derived. */
export function isEligible(story) {
  return story?.social?.social_status === "ready";
}

function snapshotSourceStory(story) {
  const social = story.social || {};
  return {
    post_headline: social.post_headline ?? null,
    base_image_url: social.base_image_url ?? null,
    source_name: social.source_name ?? null,
    source_url: social.source_url ?? null,
    category: story.category ?? null,
  };
}

/**
 * Attempts a validated transition for storyId (resolved through
 * merged_into first). `patch` is shallow-merged onto the record AFTER the
 * status change, for caller-supplied fields (e.g. artwork.*, source_story).
 * Rejects (ok: false) rather than applying anything if the transition
 * isn't in TRANSITIONS, or if storyId can't be resolved at all.
 */
export function transition(state, storyId, toStatus, patch = {}) {
  const resolved = resolveCanonicalId(state, storyId);
  if (!resolved.ok) return { state, ok: false, error: resolved.error };
  if (!resolved.record) return { state, ok: false, error: "not_found" };
  if (!canTransition(resolved.record.status, toStatus)) {
    return { state, ok: false, error: `invalid_transition:${resolved.record.status}->${toStatus}` };
  }
  const updated = { ...resolved.record, ...patch, status: toStatus, updated_at: new Date().toISOString() };
  const next = { ...state, stories: { ...state.stories, [resolved.story_id]: updated } };
  return { state: next, ok: true, story_id: resolved.story_id, record: updated };
}

/**
 * Promotes every "new" record whose current story data is eligible
 * (per isEligible) into "queued", snapshotting post_headline/
 * base_image_url/source_name/source_url/category onto the record at that
 * moment — this is what lets the artwork queue still emit a stable payload
 * even after the story itself ages out of news.json later (see
 * buildQueueEntries, which reads the snapshot, never the live story).
 * A "new" record whose story isn't eligible yet (e.g. no image found so
 * far) is left as "new" and re-checked on every future call — this is how
 * a story that only becomes eligible later (image backfilled) still gets
 * queued without ever being double-counted.
 */
export function promoteEligible(state, stories) {
  const storyById = new Map(stories.map((s) => [s.id, s]));
  let next = state;
  let promoted = 0;
  for (const [storyId, record] of Object.entries(state.stories)) {
    if (record.status !== "new") continue;
    const story = storyById.get(storyId);
    if (!story || !isEligible(story)) continue;
    const result = transition(next, storyId, "queued", { source_story: snapshotSourceStory(story) });
    if (result.ok) {
      next = result.state;
      promoted++;
    }
  }
  return { state: next, promoted };
}

/**
 * The artwork-queue payload: every record currently "queued" (regardless
 * of which refresh cycle promoted it — a story stays visible here across
 * as many refreshes as it takes until a future processor acknowledges it;
 * generating this list is NOT acknowledgement, see the "queued" state
 * doc). Reads the snapshot taken at promotion time, not live story data,
 * so a story aging out of news.json while still queued doesn't blank out
 * its payload.
 */
export function buildQueueEntries(state) {
  return Object.values(state.stories)
    .filter((r) => r.status === "queued")
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    .map((r) => ({
      story_id: r.story_id,
      post_headline: r.source_story.post_headline,
      base_image_url: r.source_story.base_image_url,
      source_name: r.source_story.source_name,
      source_url: r.source_story.source_url,
      category: r.source_story.category,
    }));
}

/** Records a failure without changing status — call transition() separately if the failure should also move the record to "failed". */
export function setLastError(state, storyId, { stage, message }) {
  const resolved = resolveCanonicalId(state, storyId);
  if (!resolved.ok || !resolved.record) return state;
  const updated = {
    ...resolved.record,
    last_error: {
      stage,
      message,
      at: new Date().toISOString(),
      retry_count: (resolved.record.last_error?.retry_count ?? 0) + 1,
    },
    updated_at: new Date().toISOString(),
  };
  return { ...state, stories: { ...state.stories, [resolved.story_id]: updated } };
}

// ---------------------------------------------------------------------------
// File I/O — atomic write (temp file + rename), same pattern as store.js.
// ---------------------------------------------------------------------------

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

export async function readSocialState(filePath = SOCIAL_STATE_PATH) {
  const data = await readJson(filePath, null);
  if (!data) return emptyState();
  return { schema_version: data.schema_version ?? SCHEMA_VERSION, cutover_at: data.cutover_at ?? null, stories: data.stories ?? {} };
}

export async function writeSocialState(state, filePath = SOCIAL_STATE_PATH) {
  await writeJsonAtomic(filePath, state);
}
