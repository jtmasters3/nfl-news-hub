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

## Neutral defaults (legacy score)

These remain true, unconditionally, for the **legacy** `total_score` — see
"Phase 2H-B: dual-score calibration" below for the separate enriched score,
which is the only place these three stop being neutral.

| Multiplier | Legacy value | Why |
|---|---|---|
| `ROLE_MULTIPLIER` | `1.0` (always) | The legacy score never consults position/role data |
| `STAR_BOOST` | `1.0` (always) | The legacy score never consults star/notable data |
| `GAME_PERFORMANCE_MULTIPLIER` | `1.0` (always) | No game/performance data source exists yet, in either score |

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

## Phase 2H-B: dual-score calibration (observe-only)

`scoreStory()` now computes TWO scores side by side, for calibration only:

- **`total_score`** (legacy) — mathematically identical to the score
  Phase 1 has always produced. `ROLE_MULTIPLIER` and `STAR_BOOST` remain
  hardcoded neutral (`1.0`) in this path, exactly as before. Every existing
  caller (the `score-story.js` CLI, this module's own regression suite, and
  any future caller) sees byte-for-byte the same `total_score`,
  `signals`, `modifiers`, and `destination` it always did.
- **`enrichment.enriched_total`** — the SAME formula, but with
  `ROLE_MULTIPLIER` and `STAR_BOOST` replaced by the locked Phase 2H-A
  player-importance multiplier (`scripts/lib/editorialPlayerImportance.js`,
  itself built on Phase 2C-2G's position/role/QB/star resolution). Only
  `EVENT_MAGNITUDE` is multiplied by the enriched player factors — every
  bonus (corroboration, social interest, escalation) and penalty (rumor,
  repetition) is reused verbatim from the legacy calculation, never scaled
  by player importance.

The player-importance inputs arrive via `scoreStory(story, context)`'s
existing **second argument**, at `context.player_context` — deliberately
NOT a field on `story` itself. `story` holds persisted article/event facts;
`context.player_context` is derived, scoring-time-only enrichment (Phase
2C-2G's resolved position/role/QB/star output) the caller supplies fresh on
each call. A `story.player_context` a caller might have persisted is never
read as scoring context — this boundary matters most for Phase 2I, whose
future historical as-of roster/depth/player context must never leak into
the persisted story object by design (see `computePlayerImportanceMultipliers`'s
own doc comment for `player_context`'s shape). A call that doesn't supply
`context.player_context` at all — which is every real story in the current
pipeline today, since nothing upstream of `scoreStory()` yet runs Phase
2C-2G against nflverse data — gets an exactly neutral enrichment
(`enriched_total === total_score`), never a damped one. This is
deliberately different from an *explicitly* supplied unresolved-player
context, which uses Phase 2H-A's own mild 0.855 multiplier instead of full
neutrality — see `enrichment.player_importance_reason_codes`
(`player_context_not_supplied` vs. Phase 2H-A's own `non_player_neutral` /
unresolved-player codes) to tell the two apart.

`enrichment.enriched_destination_preview` runs the identical
`feed_fit`/`story_fit` logic — including the same rumor gate — against the
enriched total, purely for inspecting where a story WOULD land if enriched
scoring ever went live. **`destination` (top-level, legacy) remains the only
field any real or future caller may treat as the actual recommendation.**
No production/pipeline file reads `enrichment` today; only this module's own
regression suite does.

## What Phase 2 already added (2A-2H-A) and what remains

Player identity/position/role/fresh-role/QB-importance/star resolution (nflverse
roster + depth-chart lookup, a bounded gsis_id-keyed star registry — currently
empty pending a separate calibration review) and the player-importance
multiplier math itself are all built and locked (Phase 2A-2H-A). Phase 2H-B
(above) taught `scoreStory()` to CALCULATE an enriched score from that math.
What has **not** happened yet: no real caller supplies
`context.player_context` (nothing upstream resolves and attaches it), and no
production/pipeline caller consumes `enrichment` at all. Phase 2I
(historical/as-of selection) is not implemented.

## What MUST NOT consume this score yet

`promoteEligible()`, `buildQueueEntries()`, `process-one.js`'s target
selection, the Approval Console, regeneration, or any future automatic-
approval policy. Wiring any of these to `scoreStory()`'s output — legacy OR
enriched — is explicitly a later phase (Phase 3 dry-runs, then Phase 6
load-bearing), gated on real dry-run review — not part of this
implementation. The enriched score and its destination preview exist
purely for human calibration review right now.
