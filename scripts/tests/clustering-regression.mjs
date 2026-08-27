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
// For scenarios with more than 2 articles where the expected grouping isn't
// simply "all one" or "all separate" — e.g. 3 articles that should merge
// into 1 story, plus a 4th that should NOT join them (expected: 2).
function expectDistinct(name, articles, expected) {
  cases.push({ name, articles, expected });
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

// Real historical duplicate (3 story_ids before reconciliation) fixed by
// the excerpt-corroboration mechanism, not by lowering the headline
// threshold: H1 ("carted off") scores only 0.167/0.273 against H2/H3 on
// headline text alone — the action-only headline and the diagnosis-only
// headlines just don't share much vocabulary. What DOES link them is that
// all three excerpts independently describe the same practice incident
// (carted off, Wednesday, joint practice, Panthers). Real headlines/
// excerpts, real timestamps (H1 14:55 UTC, H2 +4h13m, H3 +58min after H2).
const BRADEN_H1 = "OT Braden Smith, DL Ali Gaye carted off for Texans";
const BRADEN_D1 = "The Texans had to make multiple calls for carts to help transport injured players during Wednesday's joint practice with the Panthers.";
const BRADEN_H2 = "Source: Texans believe RT Smith has foot injury";
const BRADEN_D2 = "Texans right tackle Braden Smith and reserve defensive end Ali Gaye were carted off the field together Wednesday early in a joint practice with the Panthers.";
const BRADEN_H3 = "Report: Texans OT Braden Smith injured his foot in Wednesday's practice";
const BRADEN_D3 = "Texans offensive tackle Braden Smith had to be carted off the field during Wednesday's joint practice with the Panthers and head coach DeMeco Ryans did not have an update on his condition when he spoke to reporters after the workout.";

mustMerge("Braden Smith initial injury — H1/H2/H3 same practice incident (real historical duplicate, fixed by excerpt corroboration)", [
  article({ headline: BRADEN_H1, excerpt: BRADEN_D1, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-braden-1", hoursAgo: 5.2 }),
  article({ headline: BRADEN_H2, excerpt: BRADEN_D2, sourceName: "ESPN", sourceUrl: "https://espn.example/regress-braden-2", hoursAgo: 0.97 }),
  article({ headline: BRADEN_H3, excerpt: BRADEN_D3, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-braden-3", hoursAgo: 0 }),
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

mustNotMerge("Trade agreement -> rescinded trade", [
  article({ headline: "Chiefs agree to trade for Kenneth Walker III", sourceName: "ESPN", sourceUrl: "https://espn.example/regress-nomerge-13", hoursAgo: 6 }),
  article({ headline: "Chiefs-Seahawks Kenneth Walker trade rescinded after failed physical", sourceName: "NFL.com", sourceUrl: "https://nfl.example/regress-nomerge-14", hoursAgo: 0 }),
]);

// Braden Smith initial injury (H1/H2/H3, merged above) -> the REAL later
// specific diagnosis story that must stay separate — this is the exact
// pairing the historical reconciliation must NOT touch.
expectDistinct("Braden Smith initial injury (H1/H2/H3) -> later plantar-fascia diagnosis stays separate", [
  article({ headline: BRADEN_H1, excerpt: BRADEN_D1, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-braden-diag-1", hoursAgo: 21.9 }),
  article({ headline: BRADEN_H2, excerpt: BRADEN_D2, sourceName: "ESPN", sourceUrl: "https://espn.example/regress-braden-diag-2", hoursAgo: 17.7 }),
  article({ headline: BRADEN_H3, excerpt: BRADEN_D3, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-braden-diag-3", hoursAgo: 16.7 }),
  article({
    headline: "Texans OT Braden Smith to miss time with plantar fascia injury",
    excerpt: "The good news is that Texans offensive tackle Braden Smith avoided a season-ending foot injury when he needed to be carted off the field during Wednesday's practice.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-braden-diag-4",
    hoursAgo: 0,
  }),
], 2);

// Same initial injury cluster -> a genuinely unrelated later Braden Smith
// development (different event family entirely) must not ride in on shared
// subject/team/background alone.
expectDistinct("Braden Smith initial injury (H1/H2/H3) -> unrelated later Braden Smith development stays separate", [
  article({ headline: BRADEN_H1, excerpt: BRADEN_D1, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-braden-unrelated-1", hoursAgo: 50 }),
  article({ headline: BRADEN_H2, excerpt: BRADEN_D2, sourceName: "ESPN", sourceUrl: "https://espn.example/regress-braden-unrelated-2", hoursAgo: 45 }),
  article({ headline: BRADEN_H3, excerpt: BRADEN_D3, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-braden-unrelated-3", hoursAgo: 44 }),
  article({
    headline: "Texans suspend OT Braden Smith for violating team conduct policy",
    excerpt: "The Texans announced Braden Smith has been suspended without pay for one week for violating the team's conduct policy, an unrelated matter to his earlier foot injury.",
    sourceName: "NFL.com",
    sourceUrl: "https://nfl.example/regress-braden-unrelated-4",
    hoursAgo: 0,
  }),
], 2);

// Ali Gaye is only a one-off co-mention in H1 — once Smith-specific
// reporting (H2/H3) has established the story's confident subject as
// Smith, a separate Gaye-only development must not merge in just because
// the original article mentioned both players and the excerpt repeats the
// same practice/day/opponent background.
expectDistinct("Ali Gaye-only later development does not merge into the Braden Smith story", [
  article({ headline: BRADEN_H1, excerpt: BRADEN_D1, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-gaye-1", hoursAgo: 5.2 }),
  article({ headline: BRADEN_H2, excerpt: BRADEN_D2, sourceName: "ESPN", sourceUrl: "https://espn.example/regress-gaye-2", hoursAgo: 0.97 }),
  article({ headline: BRADEN_H3, excerpt: BRADEN_D3, sourceName: "Pro Football Talk", sourceUrl: "https://pft.example/regress-gaye-3", hoursAgo: 0 }),
  article({
    headline: "Texans DL Ali Gaye diagnosed with knee sprain",
    excerpt: "Texans defensive lineman Ali Gaye, who was also carted off during Wednesday's joint practice with the Panthers, has been diagnosed with a knee sprain.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-gaye-4",
    hoursAgo: 0,
  }),
], 2);

// ---------------------------------------------------------------------------
// SYNTHETIC ADVERSARIAL — excerpts share heavy boilerplate/background
// language, but the actual subject or event differs. Proof that excerpt
// corroboration cannot override the identity/event-state gates it depends on.
// ---------------------------------------------------------------------------

mustNotMerge("Adversarial: same team/day boilerplate, genuinely different player and no headline overlap", [
  article({
    headline: "OT Braden Smith, DL Ali Gaye carted off for Texans",
    excerpt: "The Texans had to make multiple calls for carts to help transport injured players during Wednesday's joint practice with the Panthers.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-1",
    hoursAgo: 3,
  }),
  article({
    headline: "Texans WR Nico Collins leaves practice early with cramp",
    excerpt: "Texans wide receiver Nico Collins left Wednesday's joint practice with the Panthers early with what the team called a minor cramp.",
    sourceName: "ESPN",
    sourceUrl: "https://espn.example/regress-adv-2",
    hoursAgo: 0,
  }),
]);

mustNotMerge("Adversarial: same specific player, same team, but genuinely unrelated topics (real false-merge found via data replay)", [
  article({
    headline: "Jayden Daniels 'to learn from' joint practice after Commanders' offense struggles vs. Ravens",
    excerpt: "The Washington Commanders offense had a rough day on Wednesday in a joint practice with the Ravens. QB Jayden Daniels told reporters the team will 'learn' from the day.",
    sourceName: "NFL.com",
    sourceUrl: "https://nfl.example/regress-adv-5",
    hoursAgo: 6,
  }),
  article({
    headline: "Jayden Daniels: I've said everything I needed to say about my LSU jersey number",
    excerpt: "Commanders quarterback Jayden Daniels does not want to talk about his battle with LSU about the school not retiring his jersey number.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-6",
    hoursAgo: 0,
  }),
]);

mustNotMerge("Adversarial: same team, generic scheduling-word overlap only (different players entirely)", [
  article({
    headline: "Chiefs To Sit Patrick Mahomes In Preseason Finale vs. Seahawks Friday",
    excerpt: "Chiefs quarterback Patrick Mahomes is not playing in Kansas City's preseason finale against the Seahawks on Friday night.",
    sourceName: "FOX Sports",
    sourceUrl: "https://fox.example/regress-adv-7",
    hoursAgo: 3,
  }),
  article({
    headline: "Cam Ward's preseason struggles continue with 'missed opportunities' vs. Seahawks",
    excerpt: "Tennessee Titans quarterback Cam Ward completed 8 of 12 passes for 69 yards in three drives against the Seattle Seahawks on Sunday night.",
    sourceName: "ESPN",
    sourceUrl: "https://espn.example/regress-adv-8",
    hoursAgo: 0,
  }),
]);

mustNotMerge("Adversarial: same team, generic severity-idiom overlap only (different players, different injuries)", [
  article({
    headline: "Saints lose cornerback and special teamer Rejzohn Wright to season-ending hip injury",
    excerpt: "Saints cornerback and special teams contributor Rejzohn Wright will miss the entire 2026 season.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-9",
    hoursAgo: 3,
  }),
  article({
    headline: "Kellen Moore confirms RB Ty Chandler has season-ending knee injury",
    excerpt: "Saints running back Ty Chandler will miss the entire season with a knee injury, coach Kellen Moore confirmed Tuesday.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-10",
    hoursAgo: 0,
  }),
]);

mustNotMerge("Practice-return status change does not absorb an unrelated later contract story (escalation-only story is not a blank slate)", [
  article({
    headline: "Christian Gonzalez returns to Patriots practice",
    excerpt: "Cornerback Christian Gonzalez has not agreed to a contract extension with the Patriots, but he has returned to the practice field.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-11",
    hoursAgo: 6,
  }),
  article({
    headline: "Christian Gonzalez: Contract talks are \"frustrating\"",
    excerpt: "As the regular season approaches, the Patriots and cornerback Christian Gonzalez still don't have a new contract in place.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-12",
    hoursAgo: 0,
  }),
]);

mustNotMerge("Adversarial: same player mentioned in passing, unrelated meeting/ownership stories", [
  article({
    headline: "Jed York was not spotted at Wednesday's meeting of NFL owners",
    excerpt: "NFL owners got together in Atlanta on Wednesday, primarily to vote on the sale of the Seahawks.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-13",
    hoursAgo: 3,
  }),
  article({
    headline: "Owners approve sale of Seahawks to Vinod Khosla and family",
    excerpt: "Unanimous vote clears path for $9.612 billion purchase.",
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-14",
    hoursAgo: 0,
  }),
]);

mustNotMerge("Adversarial: same player/team, heavy background overlap, but excerpt introduces a new diagnosis", [
  article({
    headline: BRADEN_H1,
    excerpt: BRADEN_D1,
    sourceName: "Pro Football Talk",
    sourceUrl: "https://pft.example/regress-adv-3",
    hoursAgo: 6,
  }),
  article({
    headline: "Texans confirm Braden Smith injury",
    excerpt: "Texans offensive tackle Braden Smith, who was carted off the field during Wednesday's joint practice with the Panthers, has been diagnosed with a torn ACL and will miss the remainder of the season.",
    sourceName: "NFL.com",
    sourceUrl: "https://nfl.example/regress-adv-4",
    hoursAgo: 0,
  }),
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
