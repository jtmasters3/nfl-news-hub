# NFL News Hub

A lightweight NFL news aggregator. It has one job:

```
NFL NEWS SOURCES → DISCOVER → DEDUPE/CLUSTER → EXTRACT FACTS → HTML + JSON → MUNCH AI
```

Static files plus a small Node script. **No AI, no API key, no ongoing cost.**
Everything — discovery, deduplication, clustering, category/importance
scoring, team/player detection — is deterministic (rule-based, regex, and a
32-team dictionary). Munch AI (or any downstream system) is expected to do
the actual writing; this project's job is only to hand it clean, organized,
accurately-sourced material.

## Project layout

```
index.html                    generated static homepage (do not hand-edit)
styles.css                    plain CSS, no build step
app.js                        vanilla JS: filters, search, copy-for-munch, live timestamps
news.json                     generated machine-readable feed — the primary output
feed.xml                      generated RSS 2.0 feed (secondary/optional)
data/
  processed-articles.json     internal ledger of already-seen source URLs (dedupe)
scripts/
  refresh.js                  npm run refresh — the only entry point
  fetch-news.js                stage 1: pull raw articles from all sources
  generate-content.js          stage 2: dedupe/cluster + deterministic extraction -> story objects
  generate-html.js             stage 3: render news.json -> index.html + feed.xml
  serve.js                     zero-dependency static file server for local preview
  lib/
    sources.js, rss.js, sitemap.js, ogDescription.js, xml.js, fetchAll.js   — ingestion
    teams.js, extraction.js, similarity.js                                  — team/category/importance/player/dedupe logic ($0 cost)
    munch.js                                                                 — Munch content formatter
    store.js                                                                 — reads/writes the JSON files, retention, change detection
    text.js, filters.js                                                     — small shared helpers
    ai.js                                                                    — DORMANT. Optional future AI-enrichment hook, not called by default (see "About the optional AI hook" below)
.github/workflows/refresh.yml  scheduled refresh via GitHub Actions (no secrets required)
```

Plain JavaScript (ES modules, Node's built-in `fetch`) — no TypeScript, no
bundler, no build step, no database.

## Sources (verified working against the live feeds)

| Source | Method |
|---|---|
| ESPN | Official RSS: `https://www.espn.com/espn/rss/nfl/news` |
| NFL.com | No public RSS exists, so we use its **Google News sitemap** (linked from `robots.txt`'s `Sitemap:` directive — a standard crawler-facing file, not scraping): `https://www.nfl.com/sitemap-fast-changing.xml`, plus each article's public `og:description` meta tag (the same short snippet a link preview shows — never the article body). |
| FOX Sports | Official public RSS from `foxsports.com/rss-feeds` (free for non-commercial use with attribution) |
| Pro Football Talk (NBC Sports) | Official RSS: `https://www.nbcsports.com/profootballtalk.rss` |

Nothing bypasses a paywall, login, robots rule, or anti-bot system, and no
full article bodies are ever fetched or stored — only headlines, short public
descriptions, publish dates, and source URLs.

To add a new source later: add one entry to `scripts/lib/sources.js`.

## How it works ($0, no API key)

`npm run refresh` runs three stages, all deterministic:

1. **Discover** (`fetch-news.js`) — fetches all four sources in parallel.
2. **Process** (`generate-content.js`) — for each article: skip if its URL is
   already in `data/processed-articles.json` (idempotency, so a re-run never
   reprocesses the same article twice). Otherwise detect teams (32-team
   dictionary match), then check it against stories updated in the last 72
   hours using team overlap + title-similarity (Jaccard on tokens). A match
   means the same event is already covered by another outlet, so the article
   is folded into that story (its source is appended) instead of creating a
   duplicate — conservative by design: a shared team lowers the similarity
   bar, but with no shared team the bar is high, so unrelated stories don't
   get merged.
   - **Category** and **importance score** come from keyword rules (with a
     few negation guards, e.g. "has *not* agreed to a contract" won't be
     tagged `contract`) and are recomputed from the combined text of every
     source attached to a story as more reporting comes in.
   - **Rumor status** is keyword-detected ("reportedly", "per a source",
     "expected to"...) per source; a story stops being flagged `RUMOR` the
     moment any attached source states it plainly.
   - **Players** are extracted only from source *descriptions* (never
     headlines, which are often Title Case and defeat the heuristic), with a
     stoplist for common words, position titles, and well-known reporters/
     analysts (so "NFL Network Insider Ian Rapoport" doesn't get mistaken
     for a player). Deliberately conservative — **empty is preferred over
     wrong**. See "Known limitations" below for what still occasionally slips
     through.
   - **Headline** is always a verbatim source headline (whichever source
     broke the story) — never algorithmically rewritten. Every outlet's
     original headline is preserved in `sources[].headline`.
3. **Publish** (`store.js` + `generate-html.js`) — writes `news.json` and
   `data/processed-articles.json`, **only if the story content actually
   changed**, then regenerates `index.html` and `feed.xml` from scratch (also
   skipped on a no-op run). This is what keeps the scheduled GitHub Action
   from creating a commit every 20 minutes when nothing new happened.

### About the optional AI hook

`scripts/lib/ai.js` exists but is **not imported or called by anything** in
the pipeline. It's kept only as a building block if you ever want to bolt on
an AI-enrichment pass later. Two separate opt-ins are required before it
would ever make a paid API call: `USE_ANTHROPIC=true` **and**
`ANTHROPIC_API_KEY` both set. Neither is set by default, nothing in
`refresh.js` references them, and `.env.example` documents them as commented-
out/optional. Normal operation never touches this file.

### Known limitations of deterministic extraction

No AI means no real language understanding — a few edge cases in the ~90
stories tested:
- A feature article that mentions an injury in passing ("...focused this
  offseason on regaining strength lost due to 2025 injury...") can get
  filed under `injury` even though the story itself is a different topic.
- Player extraction occasionally still catches an uncommon byline pattern
  not covered by the reporter/analyst blocklist (observed once in testing:
  "Brothers Matt" from "Brothers Matt LaFleur and Mike LaFleur..."). These
  are rare relative to the ~50 correctly-extracted names in the same test
  run and get pruned from `news.json` after 7 days regardless.

If this ever matters enough to fix with real language understanding, that's
exactly what the dormant `ai.js` hook is for — opt-in, not required.

## Copyright approach

Only headlines, short outlet-published descriptions (or `og:description`
snippets), publish dates, and URLs are ever collected — never full article
text, never rewritten prose. `news.json` and the Munch content block present
the source material as-is, organized and deduplicated, with clear
attribution and links back to every original source. Rumors are always
labeled `RUMOR` and never presented as confirmed.

## news.json

The machine-readable feed Munch AI (or anything else) should read:

```json
{
  "generated_at": "2026-08-24T18:22:24.521Z",
  "count": 88,
  "stories": [
    {
      "id": "uuid",
      "slug": "browns-name-deshaun-watson-starting-qb-...",
      "headline": "Browns name Deshaun Watson starting QB for Week 1 of 2026 season",
      "category": "league_news",
      "importance_score": 8,
      "is_rumor": false,
      "status": "updated",
      "update_note": "Additional reporting from Pro Football Talk.",
      "teams": ["Cleveland Browns"],
      "players": ["Deshaun Watson", "Todd Monken"],
      "sources": [
        {
          "name": "NFL.com",
          "headline": "Browns name Deshaun Watson starting QB for Week 1 of 2026 season",
          "description": "Two days after he was lustily booed by hometown fans, Deshaun Watson has been handed the reins to the Browns starting quarterback job for Week 1 of the 2026 season.",
          "url": "https://www.nfl.com/news/browns-deshaun-watson-starting-qb-week-1-2026-season",
          "published_at": "2026-08-24T02:01:34.000Z"
        }
      ],
      "published_at": "2026-08-22T10:06:17.000Z",
      "updated_at": "2026-08-24T18:22:24.503Z",
      "munch_content": "NFL STORY\n\nHEADLINE:\n...\n\nCATEGORY:\n...\n\nTEAMS:\n...\n\nPLAYERS:\n...\n\nSOURCE REPORTING:\n..."
    }
  ]
}
```

Categories: `breaking`, `trade`, `rumor`, `injury`, `contract`,
`free_agency`, `draft`, `fantasy`, `team_news`, `player_news`,
`league_news`, `roster_move`, `suspension`, `coaching`, `retirement`,
`other`. `teams`/`players` are plain, human-readable strings (full team
names, e.g. `"Dallas Cowboys"`) — no codes to decode. Stories older than 7
days (or beyond 300 total) are pruned automatically; their source URLs stay
in `data/processed-articles.json` for 45 days so they can't immediately
reappear as "new" once they leave the public feed.

## Running it locally

```bash
npm install
npm run refresh    # fetches sources, writes news.json + index.html + feed.xml
npm run serve       # http://localhost:8080
```

`index.html` is fully self-contained (all story content is baked in at
generate time, nothing fetched client-side), so you can also just
double-click `index.html` to open it directly — the Copy-for-Munch button
still works there via a fallback (`document.execCommand`) since browsers
block the modern Clipboard API on `file://` pages.

## Automatic refresh every ~20 minutes

`.github/workflows/refresh.yml` runs `npm run refresh` on a GitHub Actions
cron schedule and commits the updated `news.json`/`index.html`/`feed.xml`/
ledger back to the repo — **only when something actually changed**, and
**requires no secrets at all**. This works no matter which static host you
use, since the host just serves whatever's currently in the repo.

## Deploying: GitHub Pages

The simplest pairing for this specific project, since the refresh workflow
already lives in — and commits back to — a GitHub repo. No third-party
account, no separate service to connect, no API tokens: enabling Pages is a
single settings toggle in the same repo.

## Testing performed (this pass, no API key present)

```
AI enrichment: off (deterministic, $0 cost)
[refresh] ESPN: 23 articles found
[refresh] NFL.com: 25 articles found
[refresh] FOX Sports: 26 articles found
[refresh] Pro Football Talk: 30 articles found
Done — 104 articles checked, 88 new stories, 16 updated, 0 already known. 88 stories live.
```

- All four sources confirmed working live.
- 104 articles clustered down to 88 stories — e.g. one story combining 4
  separate NFL.com/PFT articles about the Browns' evolving Watson-vs-Sanders
  QB1 decision into a single record with all 4 sources attached.
- `news.json` parses as valid JSON; `feed.xml` parses as valid XML.
- Re-running `npm run refresh` against the same feed snapshot: 0 new, 0
  updated, 104 "already known", and — confirmed — `index.html`/`feed.xml`
  were **not** rewritten ("No story content changed" logged).
- Inspected the full player list across all 88 stories by hand: found and
  fixed three real bugs mid-session — reporter names ("Adam Schefter", "Ian
  Rapoport") leaking in as players, a Title-Case-headline artifact
  ("Cornerback Christian Gonzalez" instead of "Christian Gonzalez"), and a
  category miss caused by negated language ("has *not* agreed to a
  contract" was tagged `contract`). All three verified fixed against the
  live data; see "Known limitations" above for what's left.
- Verified in-browser: filter chips, team dropdown, and search all
  correctly show/hide cards; clicked **Copy for Munch** for real (not
  simulated) and confirmed the exact `NFL STORY / HEADLINE: / CATEGORY: /
  TEAMS: / PLAYERS: / SOURCE REPORTING: / ...` block lands on the clipboard;
  no horizontal overflow at 375px mobile width; no console errors.
