# NFL News Hub

A lightweight NFL news aggregator. It has one job:

```
NFL SOURCES → DISCOVER → DEDUPE/CLUSTER → EXTRACT FACTS → HOMEPAGE + PER-STORY PAGES + JSON → MUNCH AI
```

Static files plus a small Node script. **No AI, no API key, no ongoing cost.**
Everything — discovery, deduplication, clustering, category/importance
scoring, team/player detection — is deterministic (rule-based, regex, and a
32-team dictionary). Munch AI (or any downstream system) is expected to do
the actual writing; this project's job is only to hand it clean, organized,
accurately-sourced material — one URL per story, machine-readable, no login.

## Project layout

```
index.html                    generated homepage feed (do not hand-edit)
styles.css                    plain CSS, no build step
app.js                        vanilla JS: filters, search, copy-for-munch, live timestamps, freshness indicator
news.json                     generated machine-readable feed of every current story
feed.xml                      generated RSS 2.0 feed
stories/
  {slug}.html                 one page per story — headline, source reporting, Munch brief
  {slug}.json                 same story's structured data, standalone
data/
  processed-articles.json     internal ledger of already-seen source URLs (dedupe)
scripts/
  refresh.js                  npm run refresh — the only entry point
  fetch-news.js                stage 1: pull raw articles from all sources
  generate-content.js          stage 2: dedupe/cluster + deterministic extraction -> story objects
  generate-html.js             stage 3a: render news.json -> index.html + feed.xml
  generate-stories.js          stage 3b: render/prune per-story stories/{slug}.html + .json
  serve.js                     zero-dependency static file server for local preview
  lib/
    sources.js, rss.js, sitemap.js, ogDescription.js, xml.js, fetchAll.js   — ingestion
    teams.js, extraction.js, similarity.js                                  — team/category/importance/player/dedupe logic ($0 cost)
    munch.js                                                                 — Munch Content Brief formatter (one canonical format, used everywhere)
    dates.js                                                                 — absolute human-readable timestamps (story pages, Munch briefs)
    urls.js                                                                  — public base URL + story_url/story_json_url builders
    store.js                                                                 — reads/writes news.json, retention, change detection
    text.js, filters.js                                                     — small shared helpers
    ai.js                                                                    — DORMANT. Optional future AI-enrichment hook, not called by default (see below)
.github/workflows/refresh.yml  scheduled refresh via GitHub Actions (no secrets required)
```

Plain JavaScript (ES modules, Node's built-in `fetch`) — no TypeScript, no
bundler, no build step, no database.

## Sources (verified working against the live feeds)

| Source | Method |
|---|---|
| ESPN | Official RSS: `https://www.espn.com/espn/rss/nfl/news` |
| NFL.com | No public RSS exists, so we use its **Google News sitemap** (linked from `robots.txt`'s `Sitemap:` directive): `https://www.nfl.com/sitemap-fast-changing.xml`, plus each article's public `og:description` meta tag. |
| FOX Sports | Official public RSS from `foxsports.com/rss-feeds`, **plus** FOX's public news sitemap (`foxsports.com/sitemap.xml?type=news`, filtered to `/stories/nfl/`) — added after finding the RSS feed structurally excludes some short-form articles (confirmed missing even at `size=100`) that only the sitemap lists. |
| Pro Football Talk (NBC Sports) | Official RSS: `https://www.nbcsports.com/profootballtalk.rss` |

Nothing bypasses a paywall, login, robots rule, or anti-bot system, and no
full article bodies are ever fetched or stored — only headlines, short public
descriptions, publish dates, and source URLs.

To add a new source later: add one entry to `scripts/lib/sources.js`.

## How it works ($0, no API key)

`npm run refresh` runs three stages, all deterministic:

1. **Discover** (`fetch-news.js`) — fetches every enabled source in parallel.
2. **Process** (`generate-content.js`) — for each article: skip if its URL is
   already in `data/processed-articles.json` (idempotency). Otherwise detect
   teams, then check it against stories updated in the last 72 hours using
   team overlap + title-similarity. A match folds the article into that
   story (source appended) instead of creating a duplicate.
   - **Category**/**importance**/**rumor status** come from keyword rules
     (with negation guards, e.g. "has *not* agreed to a contract" won't be
     tagged `contract`), recomputed from every source attached to a story.
   - **Players** are extracted only from source *descriptions*, with a
     stoplist for common words, position titles, and known reporters/
     analysts. Deliberately conservative — empty is preferred over wrong.
   - **Headline** is always a verbatim source headline — never
     algorithmically rewritten.
   - **`first_published_at`**/**`latest_published_at`** are the earliest/
     newest *source-claimed* publish times in the cluster — never our own
     processing time. This matters: an outlet can (and does) discover/
     re-report an old event late, which would make a stale story look
     artificially fresh if sorting used our touch time instead.
3. **Publish** (`store.js` + `generate-html.js` + `generate-stories.js`) —
   writes `news.json`, `index.html`, `feed.xml`, and one `stories/{slug}.html`
   + `stories/{slug}.json` per story, **only if something actually
   changed**. Story pages for stories that have aged out get deleted,
   reconciled directly against the filesystem so it's self-healing.

### Sorting and freshness

The homepage and `news.json` sort strictly by `latest_published_at`
descending — **never** by importance. Importance is shown as a badge only;
letting it drive sort order was a real bug caught in production (a 3-day-old
"Breaking"-scored story buried an entire day of fresher news above the
fold).

The header shows a live **"Last checked: N minutes ago"** indicator (and a
**"FEED MAY BE DELAYED"** warning past 30 minutes) by reading GitHub's public
Actions API client-side (CORS-enabled, no auth needed) — this reflects the
true last-successful-run time, including runs that found nothing new,
without requiring a committed timestamp file that would defeat the
no-pointless-commits design below.

Every `npm run refresh` run also self-checks: it compares the newest
source-claimed publish time seen across every discovered article against the
newest story actually saved to `news.json`, and **fails the run** (non-zero
exit, which blocks the workflow's commit step) if a real gap appears. A
green workflow run alone doesn't prove current news was captured — this
does.

### About the optional AI hook

`scripts/lib/ai.js` exists but is **not imported or called by anything** in
the pipeline. Two separate opt-ins are required before it would ever make a
paid API call: `USE_ANTHROPIC=true` **and** `ANTHROPIC_API_KEY` both set.
Neither is set by default. Normal operation never touches this file.

## Copyright approach

Only headlines, short outlet-published descriptions, publish dates, and URLs
are ever collected — never full article text, never rewritten prose.
`news.json`, the per-story pages, and the Munch Content Brief present the
source material as-is, organized and deduplicated, with clear attribution
and links back to every original source. Rumors are always labeled `RUMOR`
and never presented as confirmed.

## news.json

```json
{
  "generated_at": "2026-08-24T21:07:36.000Z",
  "count": 150,
  "stories": [
    {
      "id": "uuid",
      "slug": "panthers-expect-rb-chuba-hubbard-to-be-ready-for-week-1-1whhvr",
      "headline": "Panthers Expect RB Chuba Hubbard To Be Ready For Week 1",
      "category": "injury",
      "importance_score": 4,
      "is_rumor": false,
      "status": "new",
      "update_note": null,
      "teams": ["Carolina Panthers"],
      "players": ["Chuba Hubbard"],
      "sources": [
        {
          "name": "FOX Sports",
          "headline": "Panthers Expect RB Chuba Hubbard To Be Ready For Week 1",
          "description": "Panthers starting running back Chuba Hubbard injured his hamstring earlier in training camp.",
          "url": "https://www.foxsports.com/stories/nfl/carolina-panthers-running-back-chuba-hubbard-injury",
          "published_at": "2026-08-24T19:21:50.000Z",
          "discovered_at": "2026-08-24T19:59:03.021Z"
        }
      ],
      "first_published_at": "2026-08-24T19:21:50.000Z",
      "latest_published_at": "2026-08-24T19:21:50.000Z",
      "updated_at": "2026-08-24T20:07:33.474Z",
      "story_url": "https://jtmasters3.github.io/nfl-news-hub/stories/panthers-expect-rb-chuba-hubbard-to-be-ready-for-week-1-1whhvr.html",
      "story_json_url": "https://jtmasters3.github.io/nfl-news-hub/stories/panthers-expect-rb-chuba-hubbard-to-be-ready-for-week-1-1whhvr.json",
      "munch_content": "NFL STORY\n\nHEADLINE:\n...\n\nCATEGORY:\n...\n\nTEAMS:\n...\n\nPLAYERS:\n...\n\nLATEST REPORT:\n...\n\nSOURCE REPORTING:\n..."
    }
  ]
}
```

`first_published_at`/`latest_published_at` are source-claimed times, always;
`updated_at` is when *we* last touched the record (processing metadata, not
a freshness signal — don't sort by it). Each source entry's `published_at`
is the outlet's own claimed time (`null` if genuinely unavailable) and
`discovered_at` is when we found that specific URL — not the same thing.
Stories older than 7 days (or beyond 300 total) are pruned automatically,
which also deletes their `stories/{slug}.html`/`.json` files; their source
URLs stay in `data/processed-articles.json` for 45 days so they can't
immediately reappear as "new."

## Individual story pages

Every story gets its own page at `stories/{slug}.html`, generated
automatically on every `npm run refresh` — nothing manual. Each page has:
headline, status badges (category/importance/rumor/updated), teams,
players, latest report time (machine `<time datetime>` + human-readable),
full source reporting per outlet (headline, description, published time,
link to the original), and a **Munch Content Brief** with its own **Copy
for Munch** button. A matching `stories/{slug}.json` holds the same
structured data standalone, for anything that wants to fetch one story
without pulling the whole feed. Both are linked from `news.json` via
`story_url`/`story_json_url`, and canonical `<link>`/JSON-LD `NewsArticle`
tags are included for basic SEO/machine-readability — kept intentionally
minimal, no fabricated fields (no image, no author — we don't have real
data for either).

## Munch Content Brief format

Used identically everywhere (homepage cards, story pages, `feed.xml`
description context) — one canonical formatter (`scripts/lib/munch.js`),
regenerated from current story data on every refresh (not just when a story
happens to get touched, so a format change like this one propagates to
every existing story, not only new ones):

```
NFL STORY

HEADLINE:
...

CATEGORY:
...

TEAMS:
...

PLAYERS:
...

LATEST REPORT:
August 24, 2026 at 3:21 PM EDT

SOURCE REPORTING:
FOX Sports
Headline: ...
Description: ...
Published: ...
URL: ...

INSTRUCTIONS FOR CONTENT CREATION:
Create accurate social media content based only on the source reporting above.
Do not invent facts, quotes, statistics, contract figures, injury details, or trade compensation.
If sources disagree, mention the uncertainty rather than choosing one unsupported version.
The output should be engaging but factually grounded.
```

## Running it locally

```bash
npm install
npm run refresh    # fetches sources, writes news.json + index.html + feed.xml + stories/*
npm run serve       # http://localhost:8080
```

`index.html` and every story page are fully self-contained (all content
baked in at generate time, nothing fetched client-side), so double-clicking
any of them to open directly also works — Copy for Munch still works via a
`document.execCommand` fallback since browsers block the modern Clipboard
API on `file://` pages.

## Automatic refresh every ~10 minutes

`.github/workflows/refresh.yml` runs `npm run refresh` on a GitHub Actions
cron schedule and commits the updated files back to the repo — **only when
something actually changed**, and **requires no secrets at all**. Cron is
10 minutes (tightened from an initial 20) to build in real margin against a
30-minute freshness requirement, since GitHub's scheduled cron is
best-effort and can run late under load. Public repos get unlimited free
Actions minutes, and each run takes ~15-20s, so this costs nothing.

## Deploying: GitHub Pages

The simplest pairing for this project, since the refresh workflow already
lives in — and commits back to — a GitHub repo. Enabling Pages is a single
settings toggle in the same repo, no third-party account needed.

## Known limitations of deterministic extraction

No AI means no real language understanding — rare edge cases observed in
testing: a feature article mentioning an injury in passing can get filed
under `injury` even though that's not the story's real topic, and player
extraction occasionally still catches an uncommon byline pattern not
covered by the reporter/analyst blocklist. Both are rare relative to
correctly-extracted data and self-heal via the 7-day retention window. If
this ever matters enough to fix with real language understanding, that's
what the dormant `ai.js` hook is for — opt-in, not required.
