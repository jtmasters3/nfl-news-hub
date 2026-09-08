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

## Phase 2I: historical/as-of evidence selection (observe-only)

[`scripts/lib/nflverseAsOfResolver.js`](../lib/nflverseAsOfResolver.js)
answers one narrow question: given an explicit `as_of` timestamp, WHICH
already-fetched roster/depth-chart rows were actually available at or
before that instant? It is a pure, offline selector — it never fetches or
caches data itself (that stays Phase 2A's job) and never resolves identity,
position, role, or star status (Phase 2C-2G, untouched). Its hard invariant:
**no future information may ever be selected.** Missing evidence is always
preferred over future evidence — there is no "best effort" fallback to a
later snapshot, a later week, or the current/latest data.

`as_of` is required and explicit. `Date.now()`, a no-argument `new Date()`,
or any other "current time" substitute is never used anywhere in this
module — a missing, non-string, or unparseable `as_of` returns a
deterministic neutral result (never a thrown error) with reason code
`as_of_missing` or `as_of_invalid`.

### Depth-chart selection

Selects the largest eligible `dt` <= `as_of` and returns every row sharing
that exact `dt`. Real data, fetched and inspected directly during this
phase (`depth_charts_2025.csv` and `depth_charts_2026.csv` from
nflverse-data), shows `dt` is **always** a full UTC timestamp
(`2026-09-08T11:56:57Z`), never a bare date — so the date-only convention
below is a defensive fallback, not the common case:

> A bare `YYYY-MM-DD` `dt` is treated as eligible only from the **start of
> the following UTC day**, never "known all day." An `as_of` occurring
> anywhere during that same calendar day can never consume it. This is
> deliberately more conservative than assuming midnight means the snapshot
> was already known at the start of its own day.

`selected_depth_chart_age_days` is derived only from `as_of` minus the
selected snapshot's own `dt` — never from current time. No selection ->
`null`.

### Roster selection — two modes, resolved via a follow-up schedule investigation

Both `rosters/roster_<season>.csv` (current-season) and
`weekly_rosters/roster_weekly_<season>.csv` (true historical, confirmed via
a completed season's file to carry real per-week rows across weeks 1-22 and
every `game_type`) were fetched live and inspected. **Both carry only
`season`, `week`, and `game_type` — no calendar date or timestamp column
exists anywhere in this dataset.** A follow-up investigation (same phase)
fetched and inspected the genuinely different nflverse `schedules` dataset
(`games.csv`, 7,548 games, 1999-2026) and found it CAN supply that missing
anchor — see
[`scripts/lib/nflverseScheduleAsOf.js`](../lib/nflverseScheduleAsOf.js)'s
own header comment for the full investigation. Two roster-targeting modes
now exist, never mixed within one call:

- **schedule-derived mode** (normal operation) — supply `schedule_rows`.
  `resolveNflWeekAsOf({ as_of, schedule_rows })` finds the greatest
  `(season, week)` whose **final scheduled kickoff** (Eastern time, per
  nflverse's own documented convention, converted to UTC via the real IANA
  `America/New_York` rules — never a hand-coded DST rule) has been reached
  at or before `as_of`, and that becomes the roster target automatically.
- **manual mode** (no `schedule_rows` supplied) — the original Phase 2I
  behavior: the caller supplies `target_season`/`target_week` directly.
  Useful for deterministic tests/manual inspection, but **never anti-lookahead
  verified** by this module — see `manual_roster_target_not_temporally_verified`
  below.

Either way, once a target is established, roster selection does the part
that IS safely resolvable: exact-or-nearest-**preceding** week, never a
later one. If `schedule_rows` is supplied, any manually-supplied
target_season/target_week is ignored — never silently: recorded via the
`manual_target_ignored_schedule_present` reason code — to avoid ambiguous
precedence between the two modes.

**Precise terminology — read this before touching the schedule rule.** The
schedule boundary is:

    schedule_anchor_timestamp(W) = MAX scheduled KICKOFF timestamp
                                    among all valid scheduled games in week W
    week W is schedule-eligible  <=>  schedule_anchor_timestamp(W) <= as_of

A kickoff timestamp marks when a game **starts**, not when it ends — this
dataset has no game-end timestamp at all. **Never describe this boundary as
"week concluded," "week completed," or "all games finished"** anywhere in
this codebase; the correct, exact description is `selection_basis:
"final_scheduled_kickoff_reached"` (exposed verbatim on the schedule
result, alongside `anchor_type: "final_scheduled_kickoff"`, so the meaning
can never be misread downstream).

**Why "final scheduled kickoff reached" is still safe, and what it does NOT
prove.** The official nflverse/nflreadr dictionary documents a roster row's
`week` as "the most recent week... that a player appeared on the roster" —
a trailing marker, not a snapshot proven fixed at a specific instant. No
per-row publish timestamp exists anywhere in this dataset, and no game-end
timestamp exists in `schedules` either. So lining up season/week numbers
between `schedules` and `weekly_rosters` is not, by itself, proof of
temporal safety. The rule actually implemented — a week is eligible only
once **every** one of its scheduled games has at least started — is the
most conservative one directly justified by real data: while even one game
in week W hasn't started, week W is unambiguously still in the future or in
progress, so it can never be a legitimate historical target. Once every game
has started, W is no longer a future week by any reasonable definition —
that alone is enough to close the concrete failure mode this investigation
was asked to prevent (selecting an in-progress or future week). It does
**not** prove nflverse's weekly-roster file was actually published by that
instant, nor that the games had actually **finished** by then — there is no
publish timestamp and no game-end timestamp to check either against. A
direct, honestly-reported cost: a story breaking **mid-week** about that
same week's roster move can only safely use the **prior** schedule-eligible
week's roster — never its own in-progress week's.

**Temporal provenance — mechanically distinguishing indirect roster evidence
from depth chart's real timestamp.** Depth-chart evidence always carries a
real source timestamp (`dt`). Roster evidence never does. The composed
`roster` result always carries:

| `temporal_basis` | `temporal_confidence` | Meaning |
|---|---|---|
| `"schedule_final_kickoff"` | `"indirect"` | Schedule-derived mode succeeded. Anti-lookahead safe per the rule above, but the roster snapshot itself still has no real timestamp — hence "indirect," never a verified/high-medium-low style confidence (which would risk confusion with Phase 2C-2G's own identity/position/role/star confidence fields). |
| `"manual_target"` | `"unverified"` | Caller supplied `target_season`/`target_week` directly, no schedule cross-check at all. |
| `"unresolved"` | `null` | No target could be established by either mode. |

`roster_as_of` is **always** `null` — nflverse roster data carries no source
timestamp finer than `(season, week)`, and this module never fabricates
one. It is never set equal to `schedule_anchor_timestamp` (exposed
separately on the `roster` object, only in schedule-derived mode) — those
are two different, unrelated timestamps: one is a real (absent) snapshot
time, the other is an eligibility boundary.

### Reason codes

`as_of_missing`, `as_of_invalid`, `roster_selected_exact`,
`roster_selected_preceding`, `roster_not_available`,
`roster_week_target_not_supplied`, `roster_temporal_field_invalid`,
`future_roster_rejected`, `depth_chart_selected`, `depth_chart_not_available`,
`depth_chart_dt_invalid`, `future_depth_chart_rejected`,
`manual_target_ignored_schedule_present`, `schedule_week_selected`,
`schedule_final_kickoff_anchor`, `schedule_not_available`,
`schedule_temporal_field_invalid`, `no_eligible_schedule_week`,
`future_schedule_week_rejected`, `roster_schedule_anchored`,
`roster_manual_target`, `manual_roster_target_not_temporally_verified`.

### What Phase 2I deliberately does NOT do

No historical fetch/cache path is implemented yet — Phase 2A's own
`fetchDepthChartSeasonHistory`/`weeklyRosterUrl` hooks exist but nothing
calls them from either resolver module; callers must supply
`roster_rows`/`depth_chart_rows`/`schedule_rows` themselves (the `schedules`
dataset has no cache/fetch module of its own yet either). No wiring into
`editorialScoring.js`, `generate-content.js`, or any live selector — these
modules have zero importers outside their own regression suites today.
