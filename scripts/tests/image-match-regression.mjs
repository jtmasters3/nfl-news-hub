#!/usr/bin/env node
// Regression suite for the 2026-09-14 subject-relevance fix in
// scripts/lib/imageMatch.js — proven against a real published post, story_id
// 33e7e68f-3076-423d-abb9-ce9844426ee1 ("EMMANUEL ACHO COMMENTS SPARK NFL
// INVESTIGATION OF DOM DISANDRO"): a generic wire photo (alt text
// "Philadelphia Eagles v New England Patriots") was accepted as the primary
// image purely because the CONTAINING ARTICLE's headline mentioned the
// subject — its own alt/caption/credit text and URL never corroborated the
// subject at all. Fixed by requiring DIRECT evidence (the image's own
// metadata or URL) before accepting a candidate as primary_image_url, never
// the headline-mention bonus alone.
// Run with: node scripts/tests/image-match-regression.mjs
import assert from "node:assert/strict";
import { scoreImageCandidate, selectStoryImages } from "../lib/imageMatch.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function source(overrides = {}) {
  return {
    name: "Test Source",
    headline: "Headline",
    image_url: "https://example.test/photo.jpg",
    image_alt: null,
    image_caption: null,
    image_credit: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreImageCandidate — direct vs. contextual evidence
// ---------------------------------------------------------------------------

test("1. THE EXACT PRODUCTION CASE — an image whose own alt text is an unrelated wire-photo caption, matched only via the containing article's headline, scores MIN_ACCEPT_SCORE but has NO direct evidence", () => {
  const s = source({ headline: "Report: Emmanuel Acho comments spark NFL investigation of Dom DiSandro", image_alt: "Philadelphia Eagles v New England Patriots" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.score, 3, "1 base + 2 headline-mention bonus = 3, exactly the old accept threshold");
  assert.equal(result.hasDirectEvidence, false, "the photo's own alt text never mentions Emmanuel Acho — nothing about it is actually evidenced");
});

test("2. an image whose OWN alt text names the subject has direct evidence", () => {
  const s = source({ headline: "Some other headline", image_alt: "Emmanuel Acho speaks at a press conference" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.hasDirectEvidence, true);
  assert.ok(result.score >= 3);
});

test("3. an image whose OWN caption names the subject has direct evidence", () => {
  const s = source({ image_caption: "Emmanuel Acho on the set of Speak" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.hasDirectEvidence, true);
});

test("4. an image whose OWN credit line names the subject has direct evidence", () => {
  const s = source({ image_credit: "Photo of Emmanuel Acho by Getty Images" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.hasDirectEvidence, true);
});

test("5. a URL slug match counts as direct evidence", () => {
  const s = source({ image_url: "https://example.test/photos/emmanuel-acho-2026.jpg" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.hasDirectEvidence, true);
});

test("6. partial subject-word match in alt/caption still counts as direct evidence (all words present)", () => {
  const s = source({ image_alt: "Acho, Emmanuel at NFL Honors" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.hasDirectEvidence, true);
});

test("7. the headline-mention bonus is still added to the numeric score (for ranking) even though it never sets hasDirectEvidence", () => {
  const withHeadlineOnly = scoreImageCandidate(source({ headline: "Emmanuel Acho story" }), "Emmanuel Acho");
  const withNothing = scoreImageCandidate(source({ headline: "Unrelated headline" }), "Emmanuel Acho");
  assert.equal(withHeadlineOnly.score, withNothing.score + 2);
  assert.equal(withHeadlineOnly.hasDirectEvidence, false);
  assert.equal(withNothing.hasDirectEvidence, false);
});

test("8. a rejected pattern (e.g. logo) still scores -100 regardless of evidence, in the new object shape", () => {
  const s = source({ image_alt: "Team logo" });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.score, -100);
  assert.equal(result.hasDirectEvidence, false);
});

test("9. no image at all still returns null", () => {
  assert.equal(scoreImageCandidate(source({ image_url: null }), "Emmanuel Acho"), null);
});

test("10. no matchTarget returns base score 1 with no direct evidence", () => {
  const result = scoreImageCandidate(source(), null);
  assert.equal(result.score, 1);
  assert.equal(result.hasDirectEvidence, false);
});

// ---------------------------------------------------------------------------
// selectStoryImages — the end-to-end acceptance decision
// ---------------------------------------------------------------------------

test("11. THE EXACT PRODUCTION SCENARIO — a single source whose only image is an unrelated wire photo matched solely via the article headline must NOT become primary_image_url; the story must fail closed instead of publishing bad artwork", () => {
  const sources = [
    source({
      headline: "Report: Emmanuel Acho comments spark NFL investigation of Dom DiSandro",
      image_url: "https://nbcsports.example/2291720662.jpg",
      image_alt: "Philadelphia Eagles v New England Patriots",
    }),
  ];
  const result = selectStoryImages({ sources, visual_subject: "Emmanuel Acho", visual_subject_type: "player", current_team: null });
  assert.equal(result.primary_image_url, null, "no image can be safely verified as relevant — this must fail closed, never publish the unrelated wire photo");
  assert.equal(result.image_candidates.length, 1, "the candidate is still listed (for visibility/debugging) — it is simply never chosen as primary");
  assert.equal(result.image_candidates[0].has_direct_evidence, false);
});

test("12. the SAME story with a genuinely corroborated image (alt text naming the subject) DOES get a primary_image_url — this fix must not block legitimately relevant photos", () => {
  const sources = [
    source({
      headline: "Report: Emmanuel Acho comments spark NFL investigation of Dom DiSandro",
      image_url: "https://nbcsports.example/acho-portrait.jpg",
      image_alt: "Emmanuel Acho attends the NFL Honors ceremony",
    }),
  ];
  const result = selectStoryImages({ sources, visual_subject: "Emmanuel Acho", visual_subject_type: "player", current_team: null });
  assert.equal(result.primary_image_url, sources[0].image_url);
});

test("13. multiple sources: an unrelated-but-headline-matching photo is never chosen over a genuinely corroborated one, and ranking still favors the higher-scoring corroborated candidate", () => {
  const unrelated = source({ headline: "Emmanuel Acho story", image_url: "https://a.test/unrelated.jpg", image_alt: "Philadelphia Eagles v New England Patriots" });
  const corroborated = source({ headline: "Different outlet, same subject", image_url: "https://b.test/acho.jpg", image_alt: "Emmanuel Acho on set" });
  const result = selectStoryImages({ sources: [unrelated, corroborated], visual_subject: "Emmanuel Acho", visual_subject_type: "player", current_team: null });
  assert.equal(result.primary_image_url, corroborated.image_url);
});

test("14. when NO source has any directly-evidenced image, primary_image_url is null even with a team fallback available — team fallback must ALSO require direct evidence, not just a team-name headline mention", () => {
  const sources = [source({ headline: "Emmanuel Acho and the Philadelphia Eagles", image_alt: "generic sideline photo", image_caption: null })];
  const result = selectStoryImages({ sources, visual_subject: "Emmanuel Acho", visual_subject_type: "player", current_team: "Philadelphia Eagles" });
  assert.equal(result.primary_image_url, null);
});

test("15. a team-fallback image whose OWN alt text names the team is accepted (direct evidence via the team fallback path)", () => {
  const sources = [source({ headline: "Team news", image_alt: "Philadelphia Eagles helmet on the sideline" })];
  const result = selectStoryImages({ sources, visual_subject: "Some Unmatched Person", visual_subject_type: "player", current_team: "Philadelphia Eagles" });
  assert.equal(result.primary_image_url, sources[0].image_url);
});

test("16. og:image status alone is never sufficient — this is the single image the ingestion pipeline fetches (see imageMeta.js), and this test proves being that one fetched image is not itself evidence", () => {
  // toSourceEntry() always attaches exactly one fetched image (the og:image)
  // per source — there is no 'is this the og:image' flag to check separately;
  // this test documents that scoreImageCandidate never grants any evidence
  // credit merely for image_url being present (the null-matchTarget case,
  // test 10 above) nor for matching only the headline (test 1/7 above).
  const s = source({ headline: "Emmanuel Acho story", image_alt: null, image_caption: null, image_credit: null });
  const result = scoreImageCandidate(s, "Emmanuel Acho");
  assert.equal(result.hasDirectEvidence, false);
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
