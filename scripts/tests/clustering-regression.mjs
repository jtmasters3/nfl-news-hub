#!/usr/bin/env node
// Permanent regression suite for story clustering (see scripts/lib/similarity.js
// and scripts/lib/eventType.js). Drives the REAL production entry point
// (processDiscoveredArticles) with real-world headline pairs — no
// parallel/reimplemented matcher. Each case is either a MUST-MERGE pair
// (same real-world event, different outlet/wording) or a MUST-NOT-MERGE
// pair (a materially different development, even when superficially
// similar). Run with: node scripts/tests/clustering-regression.mjs
//
// Several MUST-MERGE cases below are real historical duplicates found in
// production (see git history for the corresponding one-time data
// reconciliations) — they exist here specifically so a future change to
// similarity.js/eventType.js can't silently reintroduce the same failure.
import assert from "node:assert/strict";
import { processDiscoveredArticles } from "../generate-content.js";

function article({ headline, excerpt, sourceName, sourceUrl, hoursAgo }) {
  return {
    headline,
    excerpt: excerpt || `${headline}. Full report follows with additional context and quotes from team sources.`,
    sourceName,
    sourceUrl,
    publishedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  };
}

async function distinctStoryIds(articles) {
  let stories = [];
  let ledger = {};
  for (const a of articles) {
    const out = await processDiscoveredArticles([{ articles: [a] }], stories, ledger);
    stories = out.stories;
    ledger = out.processedUrls;
  }
  return new Set(Object.values(ledger).map((v) => v.storyId)).size;
}

const cases = [];
function mustMerge(name, articles) {
  cases.push({ name, articles, expected: 1 });
}
function mustNotMerge(name, articles) {
  cases.push({ name, articles, expected: articles.length });
}

// ---------------------------------------------------------------------------
// MUST MERGE — same real-world event, different outlet/wording
// ---------------------------------------------------------------------------

mustMerge("Leonard Williams extension — cross-outlet reports (real historical duplicate, fixed by outlet-prefix stripping)", [
  article({ headline: "NFL Network: Seahawks, DT Leonard Williams agree to three-year, $90M extension", sourceName: "NFL.com", sourceUrl: "https://nfl.example/regress-lw-1", hoursAgo: 5 }),
  article({ headline: "Seahawks, Leonard Williams agree to three-year, $90 million extension", sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-lw-2", hoursAgo: 3 }),
  article({ headline: "Seahawks Reportedly Extend Star DL Leonard Williams On 3-Year Deal", sourceName: "FOX Sports", sourceUrl: "https://fox.example/regress-lw-3", hoursAgo: 0 }),
]);

mustMerge("Cedric Tillman release — cross-outlet reports (real historical duplicate, fixed by verb-tense stemming)", [
  article({ headline: "Report: Browns to release WR Cedric Tillman", sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-tillman-1", hoursAgo: 2 }),
  article({ headline: "Browns Reportedly Releasing Former 3rd-Round Pick Cedric Tillman", sourceName: "FOX Sports", sourceUrl: "https://fox.example/regress-tillman-2", hoursAgo: 0 }),
]);

mustMerge("Cody Ford release — cross-outlet reports (real historical duplicate, fixed by verb-tense stemming)", [
  article({ headline: "Bengals release O-lineman Ford after 3 seasons", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-ford-1", hoursAgo: 2 }),
  article({ headline: "Bengals releasing OL Cody Ford", sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-ford-2", hoursAgo: 0 }),
]);

mustMerge("D.J. Humphries signing — cross-outlet reports (real historical duplicate, fixed by verb-tense stemming)", [
  article({ headline: "Commanders announce D.J. Humphries signing", sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-humphries-1", hoursAgo: 15 }),
  article({ headline: "Commanders sign OT D.J. Humphries to a one-year deal", sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-humphries-2", hoursAgo: 0 }),
]);

mustMerge("Chiefs/Kenneth Walker trade — city vs. nickname, \"acquire\" vs. \"trades\", dropped suffix", [
  article({ headline: "Chiefs acquire Kenneth Walker III", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-walker-1", hoursAgo: 3 }),
  article({ headline: "Kansas City trades for RB Kenneth Walker", sourceName: "FOX Sports", sourceUrl: "https://fox.example/regress-walker-2", hoursAgo: 0 }),
]);

mustMerge("Patriots/Texans trade — two teams, city vs. nickname on both sides", [
  article({ headline: "Patriots trade WR Kayshon Boutte to Texans", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-boutte-1", hoursAgo: 3 }),
  article({ headline: "Houston acquires Kayshon Boutte from New England", sourceName: "FOX Sports", sourceUrl: "https://fox.example/regress-boutte-2", hoursAgo: 0 }),
]);

// ---------------------------------------------------------------------------
// MUST NOT MERGE — a materially different development, not a duplicate
// ---------------------------------------------------------------------------

mustNotMerge("Trade -> fails physical", [
  article({ headline: "Chiefs trade for Kenneth Walker III", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-1", hoursAgo: 6 }),
  article({ headline: "Kenneth Walker III fails physical after trade", sourceName: "FOX Sports", sourceUrl: "https://fox.example/regress-nomerge-2", hoursAgo: 0 }),
]);

mustNotMerge("Injury -> confirmed torn ACL", [
  article({ headline: "Player suffers knee injury", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-3", hoursAgo: 5 }),
  article({ headline: "MRI confirms torn ACL, out for season for Player", sourceName: "NFL.com", sourceUrl: "https://nfl.example/regress-nomerge-4", hoursAgo: 0 }),
]);

mustNotMerge("Questionable -> placed on injured reserve", [
  article({ headline: "Player questionable for Sunday", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-5", hoursAgo: 5 }),
  article({ headline: "Player placed on injured reserve", sourceName: "NFL.com", sourceUrl: "https://nfl.example/regress-nomerge-6", hoursAgo: 0 }),
]);

mustNotMerge("Same team, different player, similar transaction language", [
  article({ headline: "Chiefs trade for Kenneth Walker III", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-7", hoursAgo: 1 }),
  article({ headline: "Chiefs trade for Isiah Pacheco", sourceName: "FOX Sports", sourceUrl: "https://fox.example/regress-nomerge-8", hoursAgo: 0 }),
]);

mustNotMerge("Signing -> later release (same player, opposite transaction)", [
  article({ headline: "Titans sign S Amani Hooker", sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-nomerge-9", hoursAgo: 60 }),
  article({ headline: "Titans release S Amani Hooker three days later", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-10", hoursAgo: 0 }),
]);

mustNotMerge("Injury -> later season-ending diagnosis", [
  article({ headline: "Player suffers knee injury in practice", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-11", hoursAgo: 5 }),
  article({ headline: "Player diagnosed with torn ACL, ruled out for season", sourceName: "NFL.com", sourceUrl: "https://nfl.example/regress-nomerge-12", hoursAgo: 0 }),
]);

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  let actual, error;
  try {
    actual = await distinctStoryIds(c.articles);
  } catch (err) {
    error = err;
  }
  try {
    if (error) throw error;
    assert.equal(actual, c.expected);
    console.log(`PASS  ${c.name}`);
  } catch {
    failures++;
    console.log(`FAIL  ${c.name} — expected ${c.expected} distinct story_id(s), got ${actual}${error ? ` (error: ${error.message})` : ""}`);
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
