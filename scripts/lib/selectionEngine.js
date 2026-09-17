// The Aggregate — Live Automation Acceleration, Stage 3A: Fixed-Window
// Selection Engine. SELECTION/SCHEDULING ONLY — this module decides, for
// each due Feed/Story slot, which single current story (if any) wins that
// slot, and durably records the decision. It does NOT publish anything, does
// NOT touch Instagram/Meta, does NOT move a story's existing social-state
// `status` (queued/artwork_requested/.../posted stays exactly what it
// already legitimately is), and does NOT feed into the existing artwork
// claim/queue pipeline — see the "SCOPE BOUNDARY" note below.
//
// AUTHORITATIVE RANKING SIGNAL: story.importance_score (production, from
// scripts/lib/extraction.js's estimateImportance()) — NEVER
// editorial_score_preview/enriched_total from the Stage 2B observe-only
// shadow (scripts/lib/editorialEnrichmentShadow.js), which this module never
// imports or reads.
//
// ---------------------------------------------------------------------------
// SCOPE BOUNDARY — investigated, not assumed. The existing artwork pipeline
// (scripts/lib/socialState.js's promoteEligible()) promotes EVERY eligible
// story unconditionally into "queued", and every queued record carries BOTH
// a Feed asset slot (`artwork`, 4:5) and a Story asset slot (`story_artwork`,
// 9:16) with `publishing_preferences: {instagram_feed: true,
// instagram_story: true}` — i.e. today's live pipeline has no per-destination
// concept at all; it generates both variants for everything. Making the
// existing "queued" -> artwork-claim path respect a SINGLE selected
// destination would require changing buildQueueEntries(), the artwork
// worker's own claim/generation logic, and (per the architecture referenced
// in this repo's own Phase 2B plan) the Cloudflare Worker's claim contract —
// a genuinely substantial, cross-cutting change well beyond "selection."
// Per this stage's own explicit instruction ("if this cannot be implemented
// without substantial artwork changes: implement selection state only and
// STOP/report the exact required Stage 3B interface"), this module
// implements SELECTION STATE ONLY: it durably records `story -> {destination,
// slot_id, ...}` for review and for a future Stage 3B to consume, but never
// touches promoteEligible()/buildQueueEntries()/the artwork claim path. See
// this repo's Stage 3A return report for the exact Stage 3B interface this
// implies.
//
// ---------------------------------------------------------------------------
// PERSISTENCE — additive fields on the SAME data/social-state.json document
// (scripts/lib/socialState.js), not a parallel file:
//   - top-level `selection_activated_at` (ISO string|null): set exactly once,
//     the first time this engine ever runs, to that run's own time. Bounds
//     which slots are ever eligible for processing — see
//     resolveActivationBoundary() below. This is the ONLY place a real
//     wall-clock value is captured; it is operational metadata (an
//     activation boundary), never editorial evidence.
//   - top-level `selection_slots` ({[slot_id]: SlotRecord}): one entry per
//     slot ever PROCESSED (selected or no_candidate) — this map alone is
//     what guarantees a slot is never processed twice (idempotency).
//   - per-story `selection` field on the story's existing social-state
//     record ({destination, slot_id, selected_at, window_start, window_end,
//     score, reason} | undefined): attached via a shallow patch, orthogonal
//     to the record's own `status` (never transitioned) — a story with no
//     `selection` field has simply never been selected. This is the ONLY
//     per-story field this module ever writes, and it is written exactly
//     once per story, ever (see "one story cannot select twice" below).
import { isEligible } from "./socialState.js";

// ---------------------------------------------------------------------------
// Eastern time / DST — a self-contained, standard IANA-offset-lookup
// implementation (not exported by any locked module: nflverseScheduleAsOf.js
// has an equivalent private helper, but it is non-exported and that module
// is locked, so this is a fresh, independent implementation of the same
// well-known technique, not a duplication of any locked business logic).
// ---------------------------------------------------------------------------
const EASTERN_TZ = "America/New_York";

function tzOffsetMillis(utcMillis, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset", hour: "2-digit", hourCycle: "h23" });
  const parts = dtf.formatToParts(new Date(utcMillis));
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(tzPart);
  if (!m) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2] ?? "0");
  const sign = hours < 0 ? -1 : 1;
  return hours * 3600000 + sign * minutes * 60000;
}

/** Converts an Eastern wall-clock (dateStr "YYYY-MM-DD", timeStr "HH:MM") to a UTC millisecond instant, DST-correct via the real IANA rules. */
export function easternWallClockToUtcMillis(dateStr, timeStr) {
  const naiveUtc = Date.parse(`${dateStr}T${timeStr}:00Z`);
  const offset1 = tzOffsetMillis(naiveUtc, EASTERN_TZ);
  const pass1 = naiveUtc - offset1;
  const offset2 = tzOffsetMillis(pass1, EASTERN_TZ);
  return naiveUtc - offset2;
}

/** The Eastern-time UTC offset label ("-04:00"/"-05:00") in effect at a given UTC instant — used for building human-readable, DST-disambiguating slot IDs. */
export function easternOffsetLabel(utcMillis) {
  const offsetMs = tzOffsetMillis(utcMillis, EASTERN_TZ);
  const totalMinutes = offsetMs / 60000;
  const sign = totalMinutes <= 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** The Eastern calendar date ("YYYY-MM-DD") a given UTC instant falls on. */
export function utcMillisToEasternDateString(utcMillis) {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return dtf.format(new Date(utcMillis)); // en-CA formats as YYYY-MM-DD
}

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Local wall-clock ISO representation for a slot ID, e.g. "2026-09-10T10:00:00-04:00" — the same real-world instant always produces the same string, and DST is disambiguated by construction (the offset itself is part of the ID). */
function localIsoForSlotId(dateStr, timeStr, utcMillis) {
  return `${dateStr}T${timeStr}:00${easternOffsetLabel(utcMillis)}`;
}

// ---------------------------------------------------------------------------
// Locked slot schedule
// ---------------------------------------------------------------------------
export const FEED_SLOT_TIMES = Object.freeze(["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"]);
export const STORY_SLOT_TIMES = Object.freeze(["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"]);

// ---------------------------------------------------------------------------
// 2026-09-14 durability fix — stale-selection leak into autonomous posting
// ---------------------------------------------------------------------------
// Root cause (proven against a real production post, story_id
// 33e7e68f-3076-423d-abb9-ce9844426ee1, "EMMANUEL ACHO COMMENTS SPARK NFL
// INVESTIGATION OF DOM DISANDRO"): this engine's own findWindowCandidates()
// correctly selected this story ONCE, on 2026-09-10, for that day's 12:00 PM
// ET Feed slot — its first_published_at (2026-09-10T14:00:04.000Z UTC =
// 10:00:04 AM ET) genuinely falls inside that slot's [10:00,12:00) ET
// window, and "no backlog catch-up" was never violated here: a
// zero-candidate slot is recorded "no_candidate" and a once-selected story
// (`if (record.selection) return false`, above) can never be re-selected
// for a later slot. The leak happened entirely DOWNSTREAM of selection: the
// story sat at status "queued" for four days (unrelated legacy-pipeline
// stalling), until the autonomous runner's own eligibility/approval gates —
// which had no concept of a selection going stale — let it be generated and
// posted on 2026-09-14 as if it were current news.
//
// isSelectionExpired() is the shared staleness predicate BOTH
// staticAutonomousEligibility.js (the pre-generation FIFO/awaiting_approval
// filter) and autoApprovalGate.js (the final gate immediately before every
// auto-approval decision, for every mode: generate, recover-artwork,
// recover-caption, approve-only) now consult — a single choke point,
// defined here (not in either gate file) specifically to avoid a circular
// import between them (autoApprovalGate.js already re-exports building
// blocks staticAutonomousEligibility.js imports).
//
// 2026-09-14 tightening — a full extra slot interval (2h Feed / 1h Story)
// was too loose for the intended editorial rule: it let a selection remain
// autonomously actionable all the way through the NEXT Feed/Story
// interval, which is itself indistinguishable from the backlog-catch-up
// behavior this whole fix exists to forbid. The grace period exists ONLY
// to cover the operational pipeline's own real timing, not to grant a
// second full window of eligibility.
//
// The autonomous runner is cron-triggered roughly every 10 minutes (see
// auto-prepare-social.js's own header), and a real end-to-end
// claim->artwork->caption->approval->post run has been observed taking
// ~25 minutes (story_id 33e7e68f-3076-423d-abb9-ce9844426ee1) — but that
// run started well AFTER its own window_end, from cold, on a backlog item;
// a run that starts promptly, at or shortly after window_end (the
// intended, non-backlog case this grace period is actually for), needs
// only enough slack for one more 10-minute cron tick plus normal
// generation/approval/publishing time. 20 minutes was chosen as that
// bound for BOTH destinations: two cron ticks of margin, deliberately far
// short of the next slot's own window_end (2h Feed / 1h Story away) so a
// missed slot can never silently ride into the next one's eligibility
// window. An expired record is never mutated or deleted — it simply stops
// being autonomously actionable (generated, recovered, approved, or
// posted), exactly like every other eligibility exclusion in this system,
// remaining fully available to a human/manual workflow.
const SELECTION_EXPIRY_GRACE_MS = {
  feed: 20 * 60 * 1000,
  story: 20 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// 2026-09-16 fallback selection — a slot's own window (2h Feed / 1h Story) is
// narrow by design (see buildFeedSlotsForDate/buildStorySlotsForDate above),
// and this engine never re-evaluates a slot once processed, so a slot with
// zero eligible stories inside its own narrow window previously always
// recorded "no_candidate" — even on days where a perfectly acceptable, only
// slightly older story existed just outside that window. This engine never
// enforced an importance THRESHOLD (rankCandidates has no cutoff — the top
// of the ranking always wins regardless of score), so the actual gap was
// never "no story cleared a bar," it was "no story fell in a narrow enough
// window at all." FALLBACK_LOOKBACK_HOURS widens the search only when the
// slot's own window is empty, reusing the SAME eligibility rules
// (findWindowCandidates) and the SAME ranking rules (rankCandidates) — this
// never lowers the bar for what counts as a valid candidate, it only widens
// how far back the engine looks for one. 6 hours mirrors the editorial
// judgment already encoded in refresh.js's own STALE_SOURCE_HOURS=6 ("lenient
// on purpose: quiet windows are normal, not a bug") — reused here rather
// than inventing a new number, and nowhere near the multi-day staleness this
// change is explicitly not meant to permit.
const FALLBACK_LOOKBACK_MS = 6 * 60 * 60 * 1000;

// 2026-09-17 bounded final fallback — one full day, deliberately small and
// sensible (see runSelectionEngine's own Tier-3 comment for the full
// reasoning), reached ONLY when both the slot's own window and the 6-hour
// Tier-2 pool are empty. Never the multi-day/legacy staleness this engine
// has always refused to resurface.
const FINAL_FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{destination?: string, window_end?: string}|null|undefined} selection
 * @param {number} nowMs
 * @returns {boolean} true once this selection is too old to autonomously act on
 */
export function isSelectionExpired(selection, nowMs) {
  if (!selection) return false;
  const windowEndMs = Date.parse(selection.window_end);
  if (!Number.isFinite(windowEndMs)) return false;
  const grace = SELECTION_EXPIRY_GRACE_MS[selection.destination] ?? SELECTION_EXPIRY_GRACE_MS.feed;
  return nowMs >= windowEndMs + grace;
}

/**
 * 2026-09-17: the auto-approval-eligibility variant of the check above.
 * Confirmed live (story 68026926, "SAMMY'S SPORTSBOOK WHISPERS"): a fully
 * valid, freshly-generated Feed post (real Codex artwork, real validated
 * caption, both completed within minutes of selection) can still legitimately
 * finish its caption a little past the normal 20-minute grace when a lost
 * caption-completed dispatch needs the autonomous recovery mechanism to
 * step in first — the record itself is not stale, only the clock
 * comparison is unfairly strict about it. isSelectionExpired() above stays
 * exactly as-is (still used, unchanged, for selectionEngine.js's own
 * destination-reuse eligibility in findWindowCandidates — a completely
 * different, intentionally strict concern). This variant is ONLY for
 * auto-approval eligibility (staticAutonomousEligibility.js,
 * autoApprovalGate.js): it measures the same grace window from the LATER
 * of the selection's own window_end or the record's own most recent real
 * content-completion timestamp (caption/artwork/story_artwork created_at).
 * A record whose content was ALSO never refreshed since a stale selection
 * (the original 2026-09-14 Emmanuel Acho incident this whole check exists
 * for — sat four days untouched) remains correctly expired here too,
 * since none of ITS OWN timestamps are recent either — this never widens
 * eligibility for genuinely neglected content, only for content that just
 * finished being prepared.
 * @param {object} record - a data/social-state.json story record
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isSelectionExpiredForApproval(record, nowMs) {
  const selection = record?.selection;
  if (!selection) return false;
  const windowEndMs = Date.parse(selection.window_end);
  if (!Number.isFinite(windowEndMs)) return false;
  const grace = SELECTION_EXPIRY_GRACE_MS[selection.destination] ?? SELECTION_EXPIRY_GRACE_MS.feed;
  const contentTimestamps = [record?.caption?.created_at, record?.artwork?.created_at, record?.story_artwork?.created_at]
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  const anchorMs = contentTimestamps.length ? Math.max(windowEndMs, ...contentTimestamps) : windowEndMs;
  return nowMs >= anchorMs + grace;
}

/**
 * Builds every Feed slot definition for one Eastern calendar date. The
 * 08:00 slot's window reaches back to the PREVIOUS day's 22:00 ET (its
 * predecessor slot, which does not exist on this same date) — every other
 * slot's window is the preceding 2 hours on the SAME date. Half-open
 * [start, end).
 */
export function buildFeedSlotsForDate(dateStr) {
  const prevDate = addDaysToDateString(dateStr, -1);
  return FEED_SLOT_TIMES.map((time, i) => {
    const slotUtc = easternWallClockToUtcMillis(dateStr, time);
    const windowStartUtc = i === 0 ? easternWallClockToUtcMillis(prevDate, "22:00") : easternWallClockToUtcMillis(dateStr, FEED_SLOT_TIMES[i - 1]);
    return {
      destination: "feed",
      slot_id: `feed:${localIsoForSlotId(dateStr, time, slotUtc)}`,
      slot_time: new Date(slotUtc).toISOString(),
      slot_time_ms: slotUtc,
      window_start: new Date(windowStartUtc).toISOString(),
      window_end: new Date(slotUtc).toISOString(),
    };
  });
}

/**
 * Builds every Story slot definition for one Eastern calendar date. The
 * 09:00 slot's window reaches back to the PREVIOUS day's 20:00 ET — every
 * other slot's window is the preceding 1 hour on the SAME date. Half-open
 * [start, end).
 */
export function buildStorySlotsForDate(dateStr) {
  const prevDate = addDaysToDateString(dateStr, -1);
  return STORY_SLOT_TIMES.map((time, i) => {
    const slotUtc = easternWallClockToUtcMillis(dateStr, time);
    const windowStartUtc = i === 0 ? easternWallClockToUtcMillis(prevDate, "20:00") : easternWallClockToUtcMillis(dateStr, STORY_SLOT_TIMES[i - 1]);
    return {
      destination: "story",
      slot_id: `story:${localIsoForSlotId(dateStr, time, slotUtc)}`,
      slot_time: new Date(slotUtc).toISOString(),
      slot_time_ms: slotUtc,
      window_start: new Date(windowStartUtc).toISOString(),
      window_end: new Date(slotUtc).toISOString(),
    };
  });
}

/**
 * All slot definitions (Feed + Story) whose slot_time falls within
 * [fromUtcMillis, toUtcMillis] inclusive, across however many Eastern
 * calendar dates that range spans. Sorted chronologically by slot_time,
 * with "feed" ordered before "story" at an exact tie — this is what makes
 * shared-time priority (10/12/14/16/18/20 ET) deterministic even when both
 * slots are processed within the same refresh.
 */
export function generateSlotsInRange(fromUtcMillis, toUtcMillis) {
  if (toUtcMillis < fromUtcMillis) return [];
  const startDate = utcMillisToEasternDateString(fromUtcMillis);
  const endDate = utcMillisToEasternDateString(toUtcMillis);
  const slots = [];
  let cursor = startDate;
  // A slot's window can reach into the previous day, but slot_time itself
  // is always on its own nominal date — one extra trailing day of margin
  // keeps this simple without needing a precise iteration-count formula.
  for (let i = 0; i < 400; i++) {
    slots.push(...buildFeedSlotsForDate(cursor), ...buildStorySlotsForDate(cursor));
    if (cursor === endDate) break;
    cursor = addDaysToDateString(cursor, 1);
  }
  return slots
    .filter((s) => s.slot_time_ms >= fromUtcMillis && s.slot_time_ms <= toUtcMillis)
    .sort((a, b) => a.slot_time_ms - b.slot_time_ms || (a.destination === "feed" ? -1 : 1) - (b.destination === "feed" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Candidate ranking — deterministic, per the locked rule: importance_score
// DESC, first_published_at DESC, story_id lexical ASC as the final tie-break.
// ---------------------------------------------------------------------------
export function rankCandidates(stories) {
  return stories.slice().sort((a, b) => {
    if (b.importance_score !== a.importance_score) return b.importance_score - a.importance_score;
    const byDate = Date.parse(b.first_published_at) - Date.parse(a.first_published_at);
    if (byDate !== 0) return byDate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Launch-safety predicate: has this story's EXISTING legacy social-state
 * record materially engaged the legacy paired Feed+Story pipeline, beyond
 * merely existing in social-state? Investigated against the actual locked
 * state machine (scripts/lib/socialState.js's TRANSITIONS/STATES) rather
 * than guessed:
 *
 * - "new" and "queued" are NOT material engagement. syncStories() assigns
 *   "new" to literally every current story unconditionally, and
 *   promoteEligible()'s own doc comment is explicit that "queued" means
 *   zero Content Creation progress has happened yet (no claim, no artwork,
 *   nothing) — it is purely "automatically present in social state," not
 *   "legacy work started." Excluding these would make the selector
 *   unusable: in real production data, the overwhelming majority of
 *   eligible stories currently sit in exactly this state.
 * - "preexisting_ignored" is a one-time historical cutover marker (see
 *   cutover-seed.js) — it never entered ANY workflow, old or new, so it is
 *   also not material engagement (though in practice such a story's
 *   first_published_at predates the entire social feature, so it will
 *   essentially never match a live window anyway).
 * - EVERY other state means real legacy work happened:
 *   artwork_requested/artwork_created/validating/artwork_ready (artwork
 *   pipeline claimed and progressing), awaiting_approval/approved/posting/
 *   posted (reached or passed human review), "failed" (TRANSITIONS shows
 *   it is reachable ONLY from artwork_requested/validating/artwork_ready/
 *   posting — i.e. real work was attempted and failed — and its own only
 *   outgoing transition, "failed" -> "awaiting_approval", means it remains
 *   recoverable WITHIN the legacy pipeline), and "rejected" (TRANSITIONS
 *   shows it is a terminal dead-end reachable only from awaiting_approval —
 *   i.e. the story reached full human review and was explicitly decided on).
 *   Letting the new engine independently claim any of these for a
 *   (possibly different) destination while the legacy record still shows
 *   real in-flight or decided work is exactly the dual-workflow collision
 *   this predicate exists to prevent.
 */
export function hasLegacySocialWorkStarted(record) {
  return !["preexisting_ignored", "new", "queued"].includes(record?.status);
}

/**
 * Stories eligible for ONE slot: socialPayload-ready (isEligible, reused
 * from socialState.js, never re-derived), first_published_at within the
 * slot's own half-open [window_start, window_end) window, never already
 * materially engaged in the legacy social pipeline (see
 * hasLegacySocialWorkStarted above), and destination-aware duplicate
 * protection (2026-09-17 fix — see its own header below).
 *
 * @param {Array} stories
 * @param {object} socialStateStories
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @param {"feed"|"story"} destination - the slot currently being filled
 * @param {number} nowMs - for the same-destination-vs-expired check below
 */
export function findWindowCandidates(stories, socialStateStories, windowStartMs, windowEndMs, destination, nowMs) {
  return stories.filter((story) => {
    if (!isEligible(story)) return false;
    const publishedMs = Date.parse(story.first_published_at);
    if (!Number.isFinite(publishedMs)) return false;
    if (!(publishedMs >= windowStartMs && publishedMs < windowEndMs)) return false;
    const record = socialStateStories[story.id];
    // No existing social-state record at all -> not yet synced this refresh
    // (see scripts/generate-selection.js's ordering, which always runs
    // after generateArtworkQueue()'s syncStories() call) -> never a
    // candidate. Prevents ever writing a `selection`-only "shell" record
    // that would be missing status/artwork/etc. and confuse a later
    // ensureRecord()/promoteEligible() call.
    if (!record) return false;
    // 2026-09-17 destination-aware duplicate fix — proven necessary by the
    // real 2026-09-17 2:00 PM Story incident: every otherwise-usable recent
    // "ready" story in the fallback pool was excluded purely because it had
    // ALREADY been selected for FEED, even though Feed and Story are
    // separate scheduled posts with their own separate artwork/caption/
    // approval/publishing sub-state — a story used once on Feed does not
    // inherently duplicate a Story post of the SAME story. The rule:
    //   - a story already selected for THIS SAME destination is always
    //     excluded (no duplicate Feed-of-Feed or Story-of-Story, ever);
    //   - a story already selected for the OTHER destination is excluded
    //     ONLY while that other selection is still live (not yet past its
    //     own grace window) — reusing it while Feed's own opportunity to
    //     generate real artwork from it is still open would silently
    //     starve Feed's own slot to feed Story's. Once that other
    //     destination's window has genuinely, permanently expired (a
    //     record that will NEVER receive artwork for it now — the exact
    //     hasLegacySocialWorkStarted()===false, isSelectionExpired()===true
    //     case), reusing it for the currently-unfilled destination costs
    //     the other destination nothing real, since its own fulfillment was
    //     already lost regardless of what happens here.
    // hasLegacySocialWorkStarted() below remains an unconditional exclusion
    // regardless of destination or expiry — once real artwork/caption work
    // has actually started for a record, its selection can never be
    // reassigned out from under that in-flight or completed work.
    if (record.selection) {
      const sameDestination = record.selection.destination === destination;
      const otherDestinationStillLive = !sameDestination && !isSelectionExpired(record.selection, nowMs);
      if (sameDestination || otherDestinationStillLive) return false;
    }
    if (hasLegacySocialWorkStarted(record)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Activation boundary — set exactly once, the first time this engine ever
// runs, to that run's own time. Never backdated, never re-derived from
// Date.now() internally (the caller supplies `now`). This is what prevents
// "suddenly process every theoretical slot since the repository began": no
// slot with slot_time before activation is EVER eligible for processing.
// ---------------------------------------------------------------------------
/**
 * On first activation, the boundary is persisted as EXACTLY that run's own
 * `now` — not the start of the day, not any other derived value. Slots
 * with slot_time < activation_time are permanently ignored: they are never
 * enumerated as due at all (see generateSlotsInRange's inclusive lower
 * bound below), so they are never even recorded as "no_candidate" — they
 * simply fall outside the scheduler's active lifetime by design, exactly
 * as specified. Because `now` essentially never lands exactly on a slot
 * boundary, the activation run itself typically selects nothing; the first
 * slot whose slot_time >= activation_time is picked up on whichever later
 * refresh first reaches or passes it (production refreshes run roughly
 * every 10 minutes) — this is the intended, explicitly-specified behavior,
 * not a gap. No date is ever hardcoded: this is the caller-supplied `now`
 * itself, captured once and persisted forever.
 */
export function resolveActivationBoundary(state, nowIso) {
  if (state.selection_activated_at) return { activatedAt: state.selection_activated_at, justActivated: false };
  return { activatedAt: nowIso, justActivated: true };
}

/**
 * Runs the fixed-window selection engine for one refresh. Pure — never
 * mutates `state`/`stories`, never performs file I/O, never calls
 * Date.now()/new Date() itself (the caller supplies `now`).
 *
 * @param {{state: object, stories: Array<object>, now: string}} input -
 *   `now` is an explicit ISO timestamp (the refresh's own run time — the
 *   SLOT SCHEDULE is legitimately evaluated against real wall-clock time,
 *   per this stage's own design; story ELIGIBILITY still only ever uses
 *   each story's own first_published_at, never `now`).
 * @returns {{state: object, processedSlots: Array<object>, activated: boolean}}
 */
export function runSelectionEngine({ state, stories, now }) {
  const nowMs = Date.parse(now);
  const { activatedAt, justActivated } = resolveActivationBoundary(state, now);
  const activatedMs = Date.parse(activatedAt);

  const dueSlots = generateSlotsInRange(activatedMs, nowMs).filter((s) => !state.selection_slots[s.slot_id]);

  let nextStories = { ...state.stories };
  const nextSlots = { ...state.selection_slots };
  const processedSlots = [];

  for (const slot of dueSlots) {
    const windowStartMs = Date.parse(slot.window_start);
    const windowEndMs = Date.parse(slot.window_end);
    const candidates = findWindowCandidates(stories, nextStories, windowStartMs, windowEndMs, slot.destination, nowMs);
    const ranked = rankCandidates(candidates);
    let winner = ranked[0] ?? null;
    let reason = "importance_score_rank";

    // Tier 1 (the slot's own window) found nothing — widen to the fallback
    // lookback pool rather than immediately recording no_candidate. Only
    // runs when Tier 1 is empty, so an existing high-importance winner is
    // never displaced, and never searches earlier than the slot's own
    // window already did (skipped entirely once the fallback start would be
    // >= the window it's meant to widen), so this can only ever ADD
    // candidates a bare no_candidate slot didn't already have.
    if (!winner) {
      const fallbackStartMs = Math.max(activatedMs, windowEndMs - FALLBACK_LOOKBACK_MS);
      if (fallbackStartMs < windowStartMs) {
        const fallbackCandidates = findWindowCandidates(stories, nextStories, fallbackStartMs, windowEndMs, slot.destination, nowMs);
        const fallbackRanked = rankCandidates(fallbackCandidates);
        const fallbackWinner = fallbackRanked[0] ?? null;
        if (fallbackWinner) {
          winner = fallbackWinner;
          reason = "fallback_recent_pool_importance_score_rank";
        }
      }
    }

    // Tier 3 (2026-09-17) — a bounded FINAL fallback, only reached when
    // BOTH the slot's own window and the 6-hour Tier-2 pool are empty.
    // Widens to 24 hours — a deliberately small, sensible bound (one full
    // news cycle, never the multi-day/legacy staleness this engine has
    // always refused to resurface) — using the exact SAME eligibility
    // (findWindowCandidates) and ranking (rankCandidates) rules as every
    // other tier, so it can never select an invalid/merged/unsafe/no-media
    // record, never weakens same-destination duplicate protection, and
    // still strongly prefers the freshest, highest-importance story within
    // its own wider pool. Tagged with its own distinct reason so production
    // can audit exactly how often true slot-fulfillment-of-last-resort is
    // actually needed. If even THIS pool is empty, no_candidate remains the
    // honest, correct outcome — this engine still never fabricates a
    // candidate that doesn't meet every existing rule.
    if (!winner) {
      const finalFallbackStartMs = Math.max(activatedMs, windowEndMs - FINAL_FALLBACK_LOOKBACK_MS);
      if (finalFallbackStartMs < windowEndMs - FALLBACK_LOOKBACK_MS) {
        const finalCandidates = findWindowCandidates(stories, nextStories, finalFallbackStartMs, windowEndMs, slot.destination, nowMs);
        const finalRanked = rankCandidates(finalCandidates);
        const finalWinner = finalRanked[0] ?? null;
        if (finalWinner) {
          winner = finalWinner;
          reason = "final_fallback_recent_pool_importance_score_rank";
        }
      }
    }

    if (!winner) {
      nextSlots[slot.slot_id] = {
        destination: slot.destination,
        slot_time: slot.slot_time,
        window_start: slot.window_start,
        window_end: slot.window_end,
        status: "no_candidate",
        story_id: null,
        processed_at: now,
      };
      processedSlots.push({ slot_id: slot.slot_id, status: "no_candidate", story_id: null });
      continue;
    }

    const existingRecord = nextStories[winner.id];
    nextStories = {
      ...nextStories,
      [winner.id]: {
        ...existingRecord,
        selection: {
          destination: slot.destination,
          slot_id: slot.slot_id,
          selected_at: now,
          window_start: slot.window_start,
          window_end: slot.window_end,
          score: winner.importance_score,
          reason,
        },
        updated_at: now,
      },
    };
    nextSlots[slot.slot_id] = {
      destination: slot.destination,
      slot_time: slot.slot_time,
      window_start: slot.window_start,
      window_end: slot.window_end,
      status: "selected",
      story_id: winner.id,
      processed_at: now,
    };
    processedSlots.push({ slot_id: slot.slot_id, status: "selected", story_id: winner.id });
  }

  const nextState = {
    ...state,
    selection_activated_at: activatedAt,
    selection_slots: nextSlots,
    stories: nextStories,
  };

  return { state: nextState, processedSlots, activated: justActivated };
}
