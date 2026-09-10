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
 * selected for any destination, and never already materially engaged in
 * the legacy social pipeline (see hasLegacySocialWorkStarted above).
 */
export function findWindowCandidates(stories, socialStateStories, windowStartMs, windowEndMs) {
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
    if (record.selection) return false; // already selected for a destination — permanently excluded
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
    const candidates = findWindowCandidates(stories, nextStories, windowStartMs, windowEndMs);
    const ranked = rankCandidates(candidates);
    const winner = ranked[0] ?? null;

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
          reason: "importance_score_rank",
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
