# Editorial Scoring Brain — Phase 1 (observe-only)

Implements the deterministic scoring foundation locked across the three
"Editorial Scoring Brain" architecture memos, using **only signals that
already exist in the repository today**. This is the first *implementation*
phase of that design — everything else in the locked architecture (fixed
editorial windows, Feed/Story destination selection, automatic approval)
comes later and is **not** built yet.

## What Phase 1 is

- A pure function, [`scoreStory(story, context)`](../lib/editorialScoring.js),
  that takes a story-shaped object and returns a deterministic, explainable,
  JSON-serializable score.
- Supporting pure modules: [`editorialEventMagnitude.js`](../lib/editorialEventMagnitude.js)
  (the event/injury/transaction magnitude ladder) and
  [`editorialSourceConfidence.js`](../lib/editorialSourceConfidence.js)
  (source tiering + bounded corroboration).
- A read-only CLI, [`score-story.js`](./score-story.js), for manually
  inspecting a score against a fixture or a real (already-published) story.
- A regression suite: `npm run test:editorial-scoring`.

## What Phase 1 is deliberately NOT

- **Not load-bearing.** Nothing in the production pipeline imports or calls
  `scoreStory()`. `promoteEligible()`, `buildQueueEntries()`,
  `process-one.js`, the Approval Console, and every other production path
  are completely unmodified and unaware this module exists.
- **Not connected to any new data source.** No nflverse, no roster/depth-chart
  cache, no star-exception list, no game/performance data. `ROLE_MULTIPLIER`,
  `STAR_BOOST`, and `GAME_PERFORMANCE_MULTIPLIER` are all hardcoded neutral
  (`1.0`) in Phase 1 — there is no data source yet to compute anything else
  from. See Phase 2+ below.
- **Not the fixed-window selector.** No window state, no Feed-first/Story-
  exclusion orchestration, no owed-publishing model. Those were designed and
  locked separately and are a later phase.
- **Not write access to anything.** The CLI reads `news.json` read-only (via
  the existing `readNews()`); it never touches `data/social-state.json`,
  never claims a lease, never calls the Cloudflare Worker, never generates
  artwork or captions, never calls Meta.

## Available signals (Phase 1)

`category`, event types (via `eventType.js`, reused unmodified), `teams`,
`players[]`, `visual_subject`/`visual_subject_type`/`current_team`, source
names/timestamps/count, `is_rumor`, headline, description.

## Unavailable signals (Phase 1)

Player role/position/depth-chart tier, star/fame tier, game/schedule
context, performance stats, records/milestones cross-referencing, betting
data. All deferred — see `OBSERVE_ONLY_CALIBRATION_DEFAULTS` in
`editorialScoring.js` for exactly which multipliers stay neutral because of
this.

## Neutral defaults

| Multiplier | Phase 1 value | Why |
|---|---|---|
| `ROLE_MULTIPLIER` | `1.0` (always) | No position/depth-chart data source exists yet |
| `STAR_BOOST` | `1.0` (always) | No star-exception list exists yet |
| `GAME_PERFORMANCE_MULTIPLIER` | `1.0` (always) | No game/performance data source exists yet |

Every constant lives in one place — `OBSERVE_ONLY_CALIBRATION_DEFAULTS` — and
is named that deliberately. **None of these numbers are final editorial
weights.** They exist so the formula's *shape* (bounded floors/ceilings, a
multiplicative core, capped additive modifiers) can be exercised and tested
before any of the actual numbers are calibrated against real dry-run data —
see Decision 6 of the locked architecture.

## Why observe-only

The architecture memos were explicit: scoring must be observed against real
data and reviewed by a human before it ever gates a real editorial decision.
Phase 1 exists specifically to make that observation possible — a score, a
full breakdown, and destination-fit metadata for any story, computed and
printed, with zero side effects.

## How to inspect a score

```bash
# Against a test fixture
node scripts/editorial/score-story.js --fixture scripts/editorial/fixtures/head-coach-fired.json

# Against any real, already-published story (read-only — reads news.json only)
node scripts/editorial/score-story.js --story-id <uuid>

# Raw JSON (either form)
node scripts/editorial/score-story.js --fixture <path> --json
```

## What Phase 2 will add

Player identity/role/tier resolution — a cached nflverse roster + depth-chart
lookup, and the small, seasonal, audited star-exception list — per the
locked architecture's Decisions 1 and 2. This is the point at which
`ROLE_MULTIPLIER` and `STAR_BOOST` stop being hardcoded neutral values.

## What MUST NOT consume this score yet

`promoteEligible()`, `buildQueueEntries()`, `process-one.js`'s target
selection, the Approval Console, regeneration, or any future automatic-
approval policy. Wiring any of these to `scoreStory()`'s output is
explicitly a later phase (Phase 3 dry-runs, then Phase 6 load-bearing),
gated on real dry-run review — not part of this implementation.
