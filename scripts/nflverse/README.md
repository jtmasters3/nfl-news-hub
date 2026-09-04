# nflverse cache — Phase 2A / 2B (observe-only)

Implements Phase 2A (cache fetch + validation) and Phase 2B (normalized
player index) of the locked Editorial Scoring Brain Phase 2 architecture.
**2C onward (identity resolution, position/role logic, scoring
integration) are not built yet.**

## Data source and attribution

Roster and depth-chart data comes from
[nflverse-data](https://github.com/nflverse/nflverse-data), a community
project. Code is MIT-licensed; the data itself is **CC-BY 4.0** (commercial
use permitted, attribution required — this file, plus the cache metadata's
own `source_url` field, satisfies that). The underlying NFL data remains
subject to the NFL's own terms. No paid API, no authentication, no
scraping, no R/Python dependency — plain HTTPS CSV fetches only.

## What's implemented

- [`scripts/lib/nflverseCache.js`](../lib/nflverseCache.js) — fetch, parse,
  validate, and atomically cache the current-season roster and depth-chart
  datasets. Roster and depth-chart freshness are tracked completely
  independently (`fetched_at` vs. `source_as_of` per block) — a successful
  fetch never implies upstream data actually changed.
- [`scripts/lib/nflversePlayerIndex.js`](../lib/nflversePlayerIndex.js) —
  a pure, deterministic index over the cached roster: lookup by `gsis_id`,
  `espn_id`, or normalized name. **Never resolves a story to a player** —
  that's Phase 2C.
- [`cache-tool.js`](./cache-tool.js) — a manual, read-only-except-`refresh`
  developer CLI.

## Cache schema

```json
{
  "schema_version": 1,
  "roster": {
    "fetched_at": "when we pulled it",
    "source_as_of": "the newest season-week actually present in the data",
    "source_url": "...",
    "row_count": 0,
    "integrity_hash": "sha256 of the parsed rows",
    "rows": []
  },
  "depth_chart": {
    "fetched_at": "when we pulled it",
    "source_as_of": "the newest `dt` snapshot timestamp actually present",
    "source_url": "...",
    "row_count": 0,
    "integrity_hash": "...",
    "rows": []
  }
}
```

Written to `data/nflverse-cache.json`, atomically (temp file + rename —
the same pattern already used by `socialState.js`/`store.js`). Each block
refreshes and fails **independently**: a roster fetch failure never blocks
a depth-chart update, and malformed new data for either block never
replaces that block's last known-good data — it's simply skipped, carried
forward unchanged.

## Required columns (validated before anything replaces the cache)

**Roster:** `season, week, team, position, status, full_name,
football_name, gsis_id`. Optional supplementary ID columns (`sportradar_id,
yahoo_id, rotowire_id, pff_id, pfr_id, fantasy_data_id, sleeper_id,
esb_id, ...`) are **never** required — real fetched data shows these are
frequently sparse even for well-known, actively-rostered players.

**Depth chart:** `dt, team, player_name, gsis_id, pos_abb, pos_rank`.

## Current vs. historical

Both fetch functions accept an explicit `season` parameter (defaulting to
the current season via `defaultNflSeason()`) rather than hardcoding "this
year" — this is deliberate: it's the same hook a later historical resolver
(Phase 2I) will need to fetch a *different* season's file, without any
structural change to this module. Historical week-level roster data
(`weekly_rosters`) and the depth-chart dataset's own per-snapshot `dt`
field both support point-in-time resolution — not wired up yet, but never
architecturally foreclosed.

## Status preservation — the locked architecture correction

Practice Squad must never be conflated with Reserve/IR/PUP/NFI. Real
observed data (2,946-row current roster + 46,849-row full 2025 season)
confirms the coarse `status` field already separates them cleanly:

| `status` | Meaning | `status_bucket` |
|---|---|---|
| `ACT` | Active | `active` |
| `DEV` | Practice squad | `practice_squad` |
| `RES` | Reserve (**IR/PUP/NFI/Suspended all fall here, undifferentiated**) | `reserve` |
| `RET` | Retired | `retired` |
| `CUT` | Released/cut | `cut` |
| `EXE` | Exempt list | `exempt` |
| `INA` | Game-day inactive (weekly data only) | `inactive` |
| `TRD` / `TRC` | Trade-transitional | `transitional` |

The finer `status_description_abbr` field (real observed values include
`A01, P01, P02, P03, P04, P06, P07, R01, R02, R03, R04, R05, R06, R09,
R23, R27, R36, R40, R48, R49, E02, W03, W04, I01, I02, F01`) is preserved
**verbatim** on every indexed record but deliberately **not** decoded into
specific IR-vs-PUP-vs-NFI-vs-Suspended sub-types — no authoritative
nflverse documentation of that exact numeric-code mapping could be
confirmed during Phase 2 research (the dictionary page renders its table
client-side and isn't available as static text). Guessing that mapping
would be exactly the kind of unfounded assumption this project avoids.
`reserve` stays one honest, undifferentiated bucket unless a verified
mapping is found later.

**`role` is not computed anywhere in 2A/2B.** A starting QB placed on
Reserve is indexed with `status_bucket: "reserve"` and nothing else —
never `practice_squad`, never `fringe`. Converting a roster status into an
actual editorial `role` (which also needs depth-chart context) is Phase
2E's job.

## How to use the CLI

```bash
# The one command that performs a real fetch and writes the cache
node scripts/nflverse/cache-tool.js refresh

# Read-only: print cache metadata (row counts, hashes, freshness)
node scripts/nflverse/cache-tool.js inspect

# Read-only: look up a name in the player index
node scripts/nflverse/cache-tool.js lookup "Patrick Mahomes"
```

## What's NOT built yet

Identity resolution (2C), position normalization (2D), role/depth-chart
resolution (2E), the fresh-role-signal detector (2F), QB handling and the
star-boost lookup (2G), scoring integration (2H), and historical dry-run
support (2I). No position weights, no role weights, no star list. Nothing
here is imported by any production workflow code.
