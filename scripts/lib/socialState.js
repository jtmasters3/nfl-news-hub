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
  "artwork_ready",
  "awaiting_approval",
  "approved",
  "rejected",
  "posting",
  "posted",
  "failed",
]);

// Adjacency list: from -> allowed to. Enforced by transition() below, so an
// invalid move (e.g. "posted" -> "new") is rejected in code, not just by
// convention.
//
// Phase 2C (Caption) note: "artwork_ready" is a durable resting state — a
// story lands here once its artwork is generated AND deterministically
// validated, and stays here across any number of caption attempts/claim
// runs. Caption generation is claimed and executed entirely outside this
// state machine (via the caption:{story_id} Durable Object claim
// namespace — see scripts/lib/captionEvents.js) and does NOT need its own
// top-level state: a claimed-but-not-yet-captioned story is fully
// distinguished by the Durable Object's own claim/lease record, exactly
// the same way an abandoned "artwork_requested" claim already is (see
// applyClaimEvent's "recovered" branch) — adding a second top-level state
// here would duplicate an atomicity guarantee the DO already provides.
// "awaiting_approval" is reachable from "artwork_ready" in exactly one
// place (applyCaptionCompleteEvent, after the shared, authoritative
// validateCaption() passes) — this is what makes "awaiting_approval" mean
// a COMPLETE social post (valid artwork + valid caption), never a partial
// one. A caption claim run that exhausts its local attempts does NOT
// transition status at all (see applyCaptionFailEvent) unless it's the
// THIRD separate exhausted claim run, at which point it escalates here to
// "failed" for human review — preserving both the artwork and every
// caption diagnostic collected along the way.
const TRANSITIONS = Object.freeze({
  preexisting_ignored: ["new"],
  new: ["queued"],
  queued: ["artwork_requested"],
  artwork_requested: ["artwork_created", "failed"],
  artwork_created: ["validating"],
  validating: ["artwork_ready", "failed"],
  artwork_ready: ["awaiting_approval", "failed"],
  awaiting_approval: ["approved", "rejected"],
  approved: ["posting"],
  rejected: [],
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
  return {
    post_headline: null,
    base_image_url: null,
    source_name: null,
    source_url: null,
    category: null,
    // Phase 2C additions — additive, so a historical record simply lacks
    // them (defaults below) rather than needing a migration. Carried
    // forward from the SAME already-verified, already-deterministic
    // extraction the news pipeline computes at story-creation time
    // (scripts/generate-content.js), never re-derived or fetched live —
    // this is what lets the caption generator use real team/player names
    // and rumor status without ever looking at mutable live story data.
    teams: [],
    players: [],
    description: null,
    is_rumor: false,
  };
}

/**
 * Feed+Story phase: a fresh, empty "second artwork slot" — same shape as
 * the existing top-level artwork.* fields, but with validation nested
 * inside (rather than a top-level sibling) since this is a brand-new
 * object with no legacy readers to keep compatible. Used both for
 * emptyRecord()'s default and by storyArtworkEvents.js when patching.
 */
function emptyStoryArtwork() {
  return {
    status: "not_created", // "not_created" | "created" | "failed"
    image_url: null,
    storage_key: null,
    width: null,
    height: null,
    mime_type: null,
    size_bytes: null,
    provider: null,
    created_at: null,
    claim: { claim_id: null, processor_id: null, claimed_at: null, claim_expires_at: null },
    validation: { status: "not_run", passed: null, issues: [] },
  };
}

function emptyRecord(storyId, status) {
  const now = new Date().toISOString();
  return {
    story_id: storyId,
    status,
    merged_into: null,
    created_at: now,
    updated_at: now,
    // Feed+Story phase: which content requirements this record is held to.
    // NEVER written onto an existing record — a historical record simply
    // lacks this field, and every version-aware check below treats absence
    // as version 1 (legacy: Feed-only). Only emptyRecord() (i.e. a
    // genuinely brand-new story_id, see ensureRecord()) ever sets 2.
    content_package_version: 2,
    // Per-story override for which destinations to eventually publish to —
    // read only by the (not-yet-built) posting phase; both default true.
    // A legacy record simply lacks this object too.
    publishing_preferences: { instagram_feed: true, instagram_story: true },
    source_story: emptySourceStory(),
    artwork: { status: "not_created", image_url: null, created_at: null, provider: null },
    validation: { status: "not_run", passed: null, issues: [] },
    // Feed+Story phase addition — additive sibling to the existing `artwork`
    // (which continues to mean the 4:5 Feed graphic, completely unchanged).
    // See scripts/lib/storyArtworkEvents.js/storyArtworkValidation.js.
    story_artwork: emptyStoryArtwork(),
    // Approval phase additions — additive, so a historical record simply
    // lacks them (defaults below) rather than needing a migration. `actor`
    // identifies which authenticated console instance made the decision
    // (e.g. "local-approval-<hostname>"), NOT a cryptographically verified
    // human identity — the auth model is a single shared bearer token, not
    // per-person OAuth (see cloudflare-worker's approvalDecide.js).
    approval: {
      status: "pending", // "pending" | "approved" | "rejected"
      decided_at: null,
      approved_at: null,
      rejected_at: null,
      rejection_reason: null,
      actor: null,
      request_id: null,
      decision_source: null, // e.g. "local-approval-console"
    },
    // Phase 2C: caption.text is ONLY ever written by the code path that
    // just confirmed the shared, authoritative validateCaption() passed
    // server-side (see captionEvents.js's applyCaptionCompleteEvent) — a
    // rejected candidate goes in last_candidate_text, never here. The
    // invariant `caption.status === "ready" implies caption.text !== null`
    // holds by construction, not by convention.
    caption: {
      status: "not_created", // "not_created" | "generating" | "ready" | "failed"
      text: null,
      last_candidate_text: null,
      hashtags: [],
      attribution_line: null,
      source_url: null,
      provider: null,
      claim: { claim_id: null, processor_id: null, claimed_at: null, claim_expires_at: null },
      claim_attempt_count: 0, // separate claim RUNS that fully exhausted their local 3-attempt budget — caps at 3, then escalates artwork_ready -> failed
      created_at: null,
    },
    // instagram.feed / instagram.story tracked independently — no posting
    // code exists yet (see the deferred Posting-phase design), so this
    // shape has no legacy readers to preserve; restructured directly
    // rather than added as yet another sibling.
    //
    // Stage 4B: additive only — `claim` (same lease shape as the existing
    // top-level artwork claim / caption.claim / story_artwork.claim) and
    // `instagram.feed`'s extra fields support the future approved ->
    // posting -> posted lifecycle (see scripts/lib/postingEvents.js).
    // `instagram.story` and `facebook` are intentionally untouched — Story
    // and Facebook publishing are out of scope for this stage.
    //
    // Buffer publisher stage: additive only — `provider` ("meta" | "buffer",
    // defaults to "meta" at claim time for full backward compatibility) and
    // the nested `buffer` object record which TRANSPORT is/was handling this
    // Feed post. Provider-neutral fields (media_id, permalink, published_at,
    // publish_attempted_at, last_http_outcome, last_reconciled_at,
    // caption_used, jpeg_url/storage_key) stay shared and are populated the
    // same way regardless of provider — only Meta's own container_id/
    // container_created_at and Buffer's own post_id/channel_id/status/
    // due_at/sent_at are provider-specific, never duplicated into each
    // other. See scripts/lib/postingEvents.js for exactly where `provider`
    // changes which preconditions apply (Buffer has no container step).
    publishing: {
      status: "not_posted",
      claim: { claim_id: null, processor_id: null, claimed_at: null, claim_expires_at: null, retry_count: 0 },
      instagram: {
        feed: {
          status: "not_posted", // "not_posted" | "claimed" | "container_created" | "buffer_post_created" | "publish_attempted" | "posted" | "failed" | "ambiguous"
          provider: null, // "meta" | "buffer" | null (unset/legacy) — which transport is/was handling this Feed post
          storage_key: null,
          jpeg_url: null,
          caption_used: null, // immutable snapshot taken at claim time — never recomputed from record.caption afterward
          container_id: null, // Meta-specific — always null for a Buffer-provider record, which has no container step
          container_created_at: null, // Meta-specific
          publish_attempted_at: null, // durable evidence an irreversible publish call may have occurred — never cleared automatically
          media_id: null, // provider-neutral: Instagram media id (Meta) or Buffer's post id, whichever provider is active
          permalink: null,
          published_at: null,
          last_http_outcome: null, // sanitized outcome category only (e.g. "success" | "5xx" | "timeout") — never a raw response body
          last_reconciled_at: null,
          buffer: { post_id: null, channel_id: null, status: null, due_at: null, sent_at: null }, // Buffer-specific raw fields, additive audit detail only
        },
        // Story-posting stage: additive only, mirroring instagram.feed's own
        // shape field-for-field (same status vocabulary, same provider-
        // neutral vs Buffer-specific split) — no second schema, no second
        // reducer design. Was previously just {status, container_id,
        // media_id, published_at}, sufficient only because nothing ever
        // wrote to it; postingEvents.js's Story-aware functions now do.
        story: {
          status: "not_posted", // "not_posted" | "buffer_post_created" | "publish_attempted" | "posted" | "failed" | "ambiguous"
          provider: null, // "meta" | "buffer" | null (unset/legacy)
          storage_key: null,
          jpeg_url: null,
          caption_used: null,
          container_id: null,
          container_created_at: null,
          publish_attempted_at: null,
          media_id: null,
          permalink: null,
          published_at: null,
          last_http_outcome: null,
          last_reconciled_at: null,
          buffer: { post_id: null, channel_id: null, status: null, due_at: null, sent_at: null },
        },
      },
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
  return { schema_version: SCHEMA_VERSION, cutover_at: null, stories: {}, selection_activated_at: null, selection_slots: {} };
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
    // Phase 2C — same already-verified fields the news pipeline already
    // computed (scripts/generate-content.js), snapshotted here for the
    // same reason everything else above is: caption generation must read
    // this snapshot, never a live story lookup.
    teams: Array.isArray(story.teams) ? story.teams : [],
    players: Array.isArray(story.players) ? story.players : [],
    description: story.sources?.[0]?.description || null,
    is_rumor: story.is_rumor === true,
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
 * Re-snapshots source_story for every record still sitting at "queued"
 * (never a later status) from CURRENT live story data. Safe specifically
 * because "queued" is the one status with zero Content Creation progress
 * attached yet — no claim, no artwork, nothing an upstream fix could
 * clobber — unlike promoteEligible(), which deliberately never re-touches
 * a record once it leaves "new" precisely to avoid overwriting in-progress
 * work. This is the one narrow, safe exception: it lets a corrected
 * upstream computation (e.g. a socialPayload.js fix) reach an
 * ALREADY-queued entry on the very next refresh — no manual state edit,
 * no story_id change, no duplicate record — while never touching a story
 * that has moved past "queued".
 */
export function refreshQueuedSnapshots(state, stories) {
  const storyById = new Map(stories.map((s) => [s.id, s]));
  let next = state;
  let refreshed = 0;
  for (const [storyId, record] of Object.entries(state.stories)) {
    if (record.status !== "queued") continue;
    const story = storyById.get(storyId);
    if (!story || !isEligible(story)) continue;
    const snapshot = snapshotSourceStory(story);
    if (JSON.stringify(snapshot) === JSON.stringify(record.source_story)) continue;
    const updated = { ...record, source_story: snapshot, updated_at: new Date().toISOString() };
    next = { ...next, stories: { ...next.stories, [storyId]: updated } };
    refreshed++;
  }
  return { state: next, refreshed };
}

/**
 * Stage 3B compatibility gate — distinguishes "a legacy pipeline record
 * already materially in flight" from "a new, untouched auto-queued record
 * that must wait for Stage 3A's fixed-window selection engine." Reuses
 * EXISTING fields only (record.created_at, state.selection_activated_at —
 * the latter already persisted by Stage 3A, see selectionEngine.js) rather
 * than introducing any new tracking field or a second state store:
 *
 * - If the selection engine has never activated at all (selection_activated_at
 *   is null), nothing requires a selection yet — every "queued" record
 *   behaves exactly as it always has (pre-Stage-3A behavior, unchanged).
 * - A record CREATED BEFORE activation is "legacy" by construction — it
 *   existed under the old always-queue-everything regime and must keep
 *   working exactly as it always did, selection or no selection.
 * - A record created AT OR AFTER activation is subject to the new regime:
 *   it must have an actual Stage 3A `selection` before it may enter the
 *   artwork queue at all. Being auto-queued by promoteEligible() is no
 *   longer sufficient on its own to begin new artwork work.
 */
function requiresSelectionBeforeQueue(record, selectionActivatedAt) {
  if (!selectionActivatedAt) return false;
  const createdMs = Date.parse(record.created_at);
  if (!Number.isFinite(createdMs)) return false; // malformed timestamp — never gate on unusable data
  return createdMs >= Date.parse(selectionActivatedAt);
}

/** True when a "queued" record is currently eligible to enter the artwork queue at all — see requiresSelectionBeforeQueue's doc comment. */
export function isArtworkQueueEligible(record, selectionActivatedAt) {
  if (!requiresSelectionBeforeQueue(record, selectionActivatedAt)) return true;
  return Boolean(record.selection);
}

/**
 * The artwork-queue payload: every record currently "queued" AND
 * queue-eligible (regardless of which refresh cycle promoted it — a story
 * stays visible here across as many refreshes as it takes until a future
 * processor acknowledges it; generating this list is NOT acknowledgement,
 * see the "queued" state doc). Reads the snapshot taken at promotion time,
 * not live story data, so a story aging out of news.json while still
 * queued doesn't blank out its payload.
 *
 * Stage 3B addition: each entry now carries an explicit `destination`
 * ("feed" | "story") — a legacy record or a Feed-selected record is
 * "feed" (existing behavior, unchanged); a Story-selected record is
 * "story", telling the local processor to build/submit the Story (9:16)
 * asset through the SAME primary claim/complete lifecycle instead of the
 * Feed (4:5) one — see scripts/lib/artworkEvents.js's applyCompleteEvent.
 */
export function buildQueueEntries(state) {
  return Object.values(state.stories)
    .filter((r) => r.status === "queued")
    .filter((r) => isArtworkQueueEligible(r, state.selection_activated_at))
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    .map((r) => ({
      story_id: r.story_id,
      post_headline: r.source_story.post_headline,
      base_image_url: r.source_story.base_image_url,
      source_name: r.source_story.source_name,
      source_url: r.source_story.source_url,
      category: r.source_story.category,
      teams: r.source_story.teams ?? [],
      players: r.source_story.players ?? [],
      description: r.source_story.description ?? null,
      is_rumor: r.source_story.is_rumor ?? false,
      content_package_version: r.content_package_version ?? 1,
      destination: r.selection?.destination ?? "feed",
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
  return {
    schema_version: data.schema_version ?? SCHEMA_VERSION,
    cutover_at: data.cutover_at ?? null,
    stories: data.stories ?? {},
    // Stage 3A (fixed-window selection engine) additive fields — a legacy
    // file simply lacks them, exactly like every other additive field in
    // this module (content_package_version, publishing_preferences,
    // story_artwork, ...). See scripts/lib/selectionEngine.js.
    selection_activated_at: data.selection_activated_at ?? null,
    selection_slots: data.selection_slots ?? {},
  };
}

export async function writeSocialState(state, filePath = SOCIAL_STATE_PATH) {
  await writeJsonAtomic(filePath, state);
}
