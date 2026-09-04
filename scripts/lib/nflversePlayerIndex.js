// Editorial Scoring Brain — Phase 2B: normalized player index over
// validated roster data. Pure function — no story resolution here (that's
// Phase 2C), no depth-chart/role logic (that's Phase 2E). This module only
// answers "given the cached roster, what players exist and how can they be
// looked up" — deterministically, and without ever silently collapsing two
// different people who share a name into one.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Name normalization — deterministic, no manual alias/nickname list.
// Compares against nflverse's own full_name AND football_name fields (its
// own curated "commonly used name," e.g. "J.J." for Jansen) instead of
// re-deriving nicknames ourselves.
//
// Middle initials are deliberately NOT stripped or fuzzed — conservative by
// design, per the locked architecture: smoothing over "John A. Smith" vs.
// "John B. Smith" risks a false merge, which this index must never do.
// ---------------------------------------------------------------------------
const SUFFIX_WORD_PATTERN = /\b(jr|sr|ii|iii|iv|v)\b/gi;

export function normalizeName(name) {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "") // strip combining diacritical marks left behind by NFKD decomposition
    .replace(/['’.]/g, "") // strip apostrophes (straight/curly) and periods — handles Ja'Marr, C.J.
    .replace(/-/g, " ") // hyphens become spaces — Amon-Ra -> amon ra
    .replace(SUFFIX_WORD_PATTERN, "") // strip Jr/Sr/II/III/IV/V as whole-word tokens
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Status preservation — per the locked architecture correction, Practice
// Squad must never be conflated with Reserve/IR/PUP/NFI. The coarse nflverse
// `status` field reliably separates them (DEV vs. RES), confirmed against
// real fetched data (2946-row current roster, 46849-row full-season file —
// see scripts/nflverse/README.md for the exact observed values). The finer
// `status_description_abbr` field (R01, R02, R04, R05, R40, R48, ...) is
// preserved verbatim but NOT decoded into specific IR/PUP/NFI/Suspended
// sub-types here — no authoritative nflverse documentation of that exact
// numeric-code mapping could be confirmed during Phase 2 research, and
// guessing it would be exactly the kind of unfounded assumption this
// project avoids. "reserve" stays a single, honest, undifferentiated bucket
// unless and until a verified mapping is found.
// ---------------------------------------------------------------------------
const STATUS_BUCKET_MAP = {
  ACT: "active",
  DEV: "practice_squad",
  RES: "reserve", // IR/PUP/NFI/Suspended all fall here, undifferentiated — see note above
  RET: "retired",
  CUT: "cut",
  EXE: "exempt",
  INA: "inactive", // game-day inactive (weekly_rosters only)
  TRD: "transitional",
  TRC: "transitional",
};

export function deriveStatusBucket(rawStatus) {
  return STATUS_BUCKET_MAP[rawStatus] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

function toIndexRecord(row) {
  return {
    gsis_id: row.gsis_id || null,
    espn_id: row.espn_id || null,
    full_name: row.full_name || null,
    football_name: row.football_name || null,
    team: row.team || null,
    position: row.position || null,
    depth_chart_position: row.depth_chart_position || null,
    raw_status: row.status || null,
    raw_status_description_abbr: row.status_description_abbr || null,
    status_bucket: deriveStatusBucket(row.status || null),
    season: row.season || null,
    week: row.week || null,
  };
}

/**
 * @param {{rows: object[]}} rosterCache - the `roster` block of the Phase 2A cache
 * @returns {{
 *   by_gsis_id: Map<string, object>,
 *   by_espn_id: Map<string, object>,
 *   by_normalized_name: Map<string, object[]>
 * }}
 */
export function buildPlayerIndex(rosterCache) {
  const rows = rosterCache?.rows ?? [];
  const by_gsis_id = new Map();
  const by_espn_id = new Map();
  const by_normalized_name = new Map();

  for (const row of rows) {
    const record = toIndexRecord(row);

    if (record.gsis_id) by_gsis_id.set(record.gsis_id, record);
    if (record.espn_id) by_espn_id.set(record.espn_id, record);

    // A normalized name ALWAYS maps to an array, even when only one player
    // currently shares it — this is what guarantees a later name collision
    // (a second player entering the index under the same key) is additive,
    // never a silent overwrite. Both full_name and football_name are
    // indexed, deduplicated per player so one player with matching
    // full_name/football_name doesn't appear twice under the same key.
    const keys = new Set([normalizeName(record.full_name), normalizeName(record.football_name)].filter(Boolean));
    for (const key of keys) {
      if (!by_normalized_name.has(key)) by_normalized_name.set(key, []);
      const bucket = by_normalized_name.get(key);
      if (!bucket.includes(record)) bucket.push(record);
    }
  }

  return { by_gsis_id, by_espn_id, by_normalized_name };
}

/** Lookup helper: candidates for a normalized name, always an array (possibly empty, possibly >1). */
export function lookupByName(index, name) {
  return index.by_normalized_name.get(normalizeName(name)) ?? [];
}

/**
 * A stable fingerprint of the index's content — useful for confirming two
 * indexes built from the same roster data (regardless of input row
 * ordering) are identical, without comparing the full Map structures
 * directly in a test.
 */
export function indexFingerprint(index) {
  const gsisIds = Array.from(index.by_gsis_id.keys()).sort();
  const nameEntries = Array.from(index.by_normalized_name.entries())
    .map(([name, records]) => [name, records.map((r) => r.gsis_id).sort()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ gsisIds, nameEntries }));
  return hash.digest("hex");
}
