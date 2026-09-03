#!/usr/bin/env node
// Regression suite for scripts/lib/socialPayload.js's post_headline
// truncation — specifically the 2026-09 fix for headlines that were being
// cut mid-quote or mid-clause, producing a broken/dangling phrase on the
// actual graphic (real incident: story 08d001da-... "QUINNEN WILLIAMS:
// COWBOYS DEFENSE IS 'NIGHT", and 674e5ee1-... "ERIC DECOSTA: WHEN THE
// LIGHTS HAVE COME ON"). Exercises the real exported buildSocialPayload(),
// not a reimplementation. Run with:
// node scripts/tests/social-payload-regression.mjs
import assert from "node:assert/strict";
import { buildSocialPayload } from "../lib/socialPayload.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function makeStory({ headlines, category = "player_news", teams = [], visualSubject = null, visualSubjectType = null, currentTeam = null } = {}) {
  const sources = headlines.map((headline, i) => ({
    headline,
    url: `https://example.test/story-${i}`,
    name: `Outlet ${i}`,
    description: "A sufficiently long description of the story for source-selection purposes to work correctly in this test.",
    published_at: new Date(Date.now() - i * 1000).toISOString(),
    image_url: i === 0 ? "https://example.test/image.jpg" : null,
  }));
  return {
    sources,
    primary_image_url: "https://example.test/image.jpg",
    primary_image_source: "Example",
    primary_image_credit: null,
    category,
    teams,
    visual_subject: visualSubject,
    visual_subject_type: visualSubjectType,
    current_team: currentTeam,
  };
}

// ---------------------------------------------------------------------------
// The two real incident headlines.
// ---------------------------------------------------------------------------

test("real incident 1 (Quinnen Williams, exact real source headline): the quoted phrase 'night and day' is never split, and the trailing 'under ...' clause is safely dropped instead", () => {
  const story = makeStory({
    // Exact raw headline from news.json for story_id 08d001da-0ad7-4dd8-b9ba-cdd3370bf1f8.
    headlines: ["Quinnen Williams: Cowboys defense is 'night and day' different under new DC Christian Parker"],
    category: "player_news",
    visualSubject: "Quinnen Williams",
    visualSubjectType: "player",
    currentTeam: "Dallas Cowboys",
  });
  const { post_headline } = buildSocialPayload(story);
  assert.equal(post_headline, "QUINNEN WILLIAMS: COWBOYS DEFENSE IS 'NIGHT AND DAY' DIFFERENT");
  // Never the broken, dangling original truncation:
  assert.notEqual(post_headline, "QUINNEN WILLIAMS: COWBOYS DEFENSE IS 'NIGHT");
});

test("real incident 2 (Eric DeCosta, exact real source headline): a dangling 'When...' setup clause is replaced with the complete payoff clause, attribution preserved", () => {
  const story = makeStory({
    // Exact raw headline from news.json for story_id 674e5ee1-46f4-4728-bafe-bad31002dacd.
    headlines: ["Eric DeCosta: When the lights have come on, Trey Hendrickson has brought it"],
    category: "player_news",
    visualSubject: "Eric DeCosta",
    visualSubjectType: "executive",
  });
  const { post_headline } = buildSocialPayload(story);
  assert.equal(post_headline, "ERIC DECOSTA: TREY HENDRICKSON HAS BROUGHT IT");
  // Never the broken, dangling original truncation:
  assert.notEqual(post_headline, "ERIC DECOSTA: WHEN THE LIGHTS HAVE COME ON");
});

// ---------------------------------------------------------------------------
// General regression coverage.
// ---------------------------------------------------------------------------

test("a short headline that already fits is returned unchanged (aside from case)", () => {
  const story = makeStory({ headlines: ["Bills sign QB depth ahead of camp"], category: "roster_move" });
  const { post_headline } = buildSocialPayload(story);
  assert.equal(post_headline, "BILLS SIGN QB DEPTH AHEAD OF CAMP");
});

test("a long headline that DOES need shortening lands on a semantically complete result, never a dangling fragment", () => {
  const story = makeStory({
    headlines: ["Panthers trade veteran linebacker to Broncos in exchange for a 2027 fifth-round pick and a swap of late-round selections"],
    category: "trade",
    teams: ["Carolina Panthers", "Denver Broncos"],
  });
  const { post_headline } = buildSocialPayload(story);
  assert.ok(post_headline.length > 0);
  assert.equal(post_headline, "PANTHERS TRADE VETERAN LINEBACKER TO BRONCOS");
  assert.ok(!/ IN$| TO$| A$| AND$/.test(post_headline), "must not end on a dangling preposition/article/conjunction");
});

test("a quoted phrase elsewhere in a headline that also needs shortening is preserved intact, not split", () => {
  const story = makeStory({
    headlines: ["Coach says roster is 'built to win now' after trading three future draft picks and restructuring several contracts"],
    category: "team_news",
  });
  const { post_headline } = buildSocialPayload(story);
  const quoteCount = (post_headline.match(/'/g) || []).length;
  assert.equal(quoteCount % 2, 0, "quotes must always appear in matched pairs — never split");
  assert.ok(post_headline.includes("'BUILT TO WIN NOW'"), "the quoted phrase itself must survive intact if kept at all");
});

test("no partial final word: the kept fragment never ends mid-word", () => {
  const story = makeStory({
    headlines: ["Quarterback expected to start after clearing concussion protocol and full practice participation"],
    category: "injury",
  });
  const { post_headline } = buildSocialPayload(story);
  // Every word in the result must be a real word from the source headline
  // (case-insensitively) — a mid-word slice would produce a token that
  // doesn't match any whole source word.
  const sourceWords = new Set("Quarterback expected to start after clearing concussion protocol and full practice participation".toUpperCase().split(/\s+/));
  for (const word of post_headline.replace(/[:,]/g, "").split(/\s+/)) {
    assert.ok(sourceWords.has(word), `"${word}" must be a whole word from the source, never a partial slice`);
  }
});

test("no dangling punctuation caused by truncation: result never ends in a colon, comma, or open quote", () => {
  const story = makeStory({
    headlines: ["Team executive: We made the right call, and we'd do it again given everything we know now"],
    category: "league_news",
  });
  const { post_headline } = buildSocialPayload(story);
  assert.ok(!/[,:]$/.test(post_headline), "must never end on a dangling colon or comma");
  const quoteCount = (post_headline.match(/'/g) || []).length;
  assert.equal(quoteCount % 2, 0, "must never end mid-quote");
});

test("a headline whose ONLY candidate is unrecoverably incomplete after every boundary is left as the full original, never forced into a broken shorter form", () => {
  // Every boundary in this headline is immediately followed by another
  // subordinating clause, so neither "before" nor "swapped" is ever
  // complete at any boundary — the function must fall back to the
  // unmodified original rather than return a mangled fragment.
  const story = makeStory({
    headlines: ["Team: While assessing the roster, and before the deadline, after further review"],
    category: "league_news",
  });
  const { post_headline } = buildSocialPayload(story);
  // Either it's returned as the untouched full text (if within HARD_MAX_WORDS)
  // or null (buildSocialPayload's own signal for "not confident") — never a
  // mangled shorter fragment.
  if (post_headline !== null) {
    assert.equal(post_headline, "TEAM: WHILE ASSESSING THE ROSTER, AND BEFORE THE DEADLINE, AFTER FURTHER REVIEW");
  }
});

// ---------------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${c.name} — ${err.message}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed.`);
if (failures > 0) process.exitCode = 1;
