// Editorial Scoring Brain — Phase 2G (Part B): explicit, bounded, gsis_id-
// keyed star/notable player lookup. This is NOT fame inference, follower
// counts, search trends, fantasy ADP, Pro Bowl/Madden/salary inference, or
// AI judgment — it is only a deterministic lookup against a small,
// explicitly-reviewed dataset, keyed exclusively by canonical gsis_id.
// Pure, offline, no network, no file reads, no name matching, no numeric
// weight. The production dataset (scripts/data/nfl-star-registry.js) is
// intentionally EMPTY in this phase — see that file's header. This module
// only proves the mechanism: canonical keying, effective-dating, no
// lookahead, and duplicate/overlap rejection.
//
// Interval convention — LOCKED, do not mix with any other convention:
// half-open [effective_from, effective_to). A record applies when
// effective_from <= as_of < effective_to. effective_to === null means
// open-ended (never expires once effective_from is reached). This makes
// two adjacent classifications (e.g. "notable" through end of 2025,
// "elite" starting exactly 2026-01-01T00:00:00Z) meet cleanly at one
// instant with no gap and no overlap.

const VALID_STAR_LEVELS = new Set(["elite", "notable"]);

function parseTimeOrNaN(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/**
 * Deterministically validates a star-registry dataset. Never silently
 * normalizes or repairs a broken record — every problem is reported, none
 * are fixed for you.
 * @param {Array<object>} records
 * @returns {{valid: boolean, errors: Array<{index: number, gsis_id: string|null, reason_codes: string[]}>}}
 */
export function validateStarRegistry(records) {
  if (!Array.isArray(records)) {
    return { valid: false, errors: [{ index: -1, gsis_id: null, reason_codes: ["malformed_registry"] }] };
  }

  const errors = [];
  const byGsis = new Map(); // gsis_id -> [{ index, fromTime, toTime }]

  records.forEach((record, index) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      errors.push({ index, gsis_id: null, reason_codes: ["malformed_record"] });
      return;
    }
    const { gsis_id, star_level, effective_from, effective_to } = record;
    const recordErrors = [];

    if (!gsis_id || typeof gsis_id !== "string") recordErrors.push("missing_gsis_id");
    if (!VALID_STAR_LEVELS.has(star_level)) recordErrors.push("invalid_star_level");

    const fromTime = parseTimeOrNaN(effective_from);
    if (Number.isNaN(fromTime)) recordErrors.push("invalid_effective_from");

    let toTime = Infinity;
    if (effective_to !== null && effective_to !== undefined) {
      toTime = parseTimeOrNaN(effective_to);
      if (Number.isNaN(toTime)) recordErrors.push("invalid_effective_to");
    }

    if (!Number.isNaN(fromTime) && Number.isFinite(toTime) && toTime <= fromTime) recordErrors.push("invalid_interval");

    if (recordErrors.length > 0) {
      errors.push({ index, gsis_id: typeof gsis_id === "string" ? gsis_id : null, reason_codes: recordErrors });
      return; // a structurally invalid record is never checked for overlap
    }

    if (!byGsis.has(gsis_id)) byGsis.set(gsis_id, []);
    byGsis.get(gsis_id).push({ index, fromTime, toTime });
  });

  for (const [gsis_id, intervals] of byGsis.entries()) {
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const a = intervals[i];
        const b = intervals[j];
        const identical = a.fromTime === b.fromTime && a.toTime === b.toTime;
        const overlaps = a.fromTime < b.toTime && b.fromTime < a.toTime;
        if (identical) errors.push({ index: b.index, gsis_id, reason_codes: ["duplicate_interval"] });
        else if (overlaps) errors.push({ index: b.index, gsis_id, reason_codes: ["overlapping_interval"] });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Pure lookup. Assumes `records` has already passed validateStarRegistry —
 * behavior against an un-validated, overlapping dataset is unspecified
 * beyond returning *some* matching record.
 * @param {{gsis_id: string|null, as_of: string|null, records: Array<object>}} input
 * @returns {{star_level: "elite"|"notable"|"none", matched: boolean, gsis_id: string|null, as_of: string|null, effective_from: string|null, effective_to: string|null, reason_codes: string[]}}
 */
export function lookupPlayerStarStatus({ gsis_id = null, as_of = null, records = [] } = {}) {
  const base = { gsis_id: gsis_id ?? null, as_of: as_of ?? null, effective_from: null, effective_to: null };

  if (!gsis_id) return { ...base, star_level: "none", matched: false, reason_codes: ["canonical_gsis_missing"] };
  if (!as_of) return { ...base, star_level: "none", matched: false, reason_codes: ["as_of_missing"] };

  const asOfTime = parseTimeOrNaN(as_of);
  if (Number.isNaN(asOfTime)) return { ...base, star_level: "none", matched: false, reason_codes: ["as_of_invalid"] };

  const list = Array.isArray(records) ? records : [];
  const match = list.find((r) => {
    if (!r || r.gsis_id !== gsis_id) return false;
    const fromTime = parseTimeOrNaN(r.effective_from);
    if (Number.isNaN(fromTime) || fromTime > asOfTime) return false;
    if (r.effective_to === null || r.effective_to === undefined) return true;
    const toTime = parseTimeOrNaN(r.effective_to);
    return !Number.isNaN(toTime) && asOfTime < toTime;
  });

  if (!match) return { ...base, star_level: "none", matched: false, reason_codes: ["star_record_not_found"] };

  return {
    ...base,
    star_level: match.star_level,
    matched: true,
    effective_from: match.effective_from,
    effective_to: match.effective_to ?? null,
    reason_codes: ["star_record_active"],
  };
}
