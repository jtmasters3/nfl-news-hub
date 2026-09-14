// Deterministically scores each source's extracted image against the
// story's visual subject and picks the best match — or none at all if
// nothing clears the confidence bar. No AI, no paid search API: purely
// substring/keyword matching over metadata already fetched into each
// source record (see imageMeta.js).
//
// ==========================================================================
// 2026-09-14 fix — headline-only "evidence" was sufficient to accept an
// unrelated photo
// ==========================================================================
// Root cause (proven against a real published post, story_id
// 33e7e68f-3076-423d-abb9-ce9844426ee1, "EMMANUEL ACHO COMMENTS SPARK NFL
// INVESTIGATION OF DOM DISANDRO"): the accepted image's own alt text was
// "Philadelphia Eagles v New England Patriots" — a generic wire/game photo
// with ZERO textual connection to Emmanuel Acho or Dom DiSandro. It still
// scored exactly MIN_ACCEPT_SCORE (1 base + 2 for "the CONTAINING
// ARTICLE's headline happens to mention the subject"). That +2 headline
// bonus proves nothing about the SPECIFIC photo — every image on that
// article's page would score it identically, including a stock team photo,
// a reporter's own byline photo, or (as here) an unrelated wire photo — it
// only proves the article as a whole is about the subject, which the
// pipeline already knew before ever looking at any image.
//
// Fix: track whether a candidate has DIRECT evidence — a match against the
// image's OWN metadata (its alt/caption/credit text, scored via
// haystackLower below) or its own URL (slug/word match) — as opposed to
// merely CONTEXTUAL evidence (the containing article's headline mentioning
// the subject, which says nothing about which photo on that page actually
// depicts them). selectStoryImages() below now requires direct evidence,
// not just a numeric score, before ever setting primary_image_url — the
// headline bonus still contributes to the numeric score (kept for ranking
// image_candidates and because a headline match combined with genuine
// direct evidence is still meaningful), but it can never, by itself, cross
// the acceptance bar. A story with no directly-evidenced image gets
// primary_image_url: null, which socialPayload.js's buildSocialStatus()
// already turns into social_status: "needs_media" — already-existing,
// unmodified fail-closed behavior: isEligible() (socialState.js) then
// excludes the story from selection entirely, so it is never queued, never
// generates artwork, and is simply skipped rather than published with an
// unverified photo. No substitute photo is ever invented — this only ever
// narrows acceptance of the one real source photo already fetched.
const REJECT_PATTERNS = [
  /\blogo\b/i, /\bsprite\b/i, /\bavatar\b/i, /\bplaceholder\b/i,
  /\bheadshot\b/i, /\breporter\b/i, /\binsider\b/i, /\bauthor\b/i,
  /\bbyline\b/i, /\bnfl[-_]?shield\b/i,
];

const MIN_ACCEPT_SCORE = 3;

function subjectWords(subject) {
  return subject
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && w !== "iii" && w !== "jr." && w !== "sr.");
}

/**
 * @param {object} source one source record (with image_url/image_alt/image_caption/image_credit fetched)
 * @param {string} matchTarget the text to match against — the player/coach/team name currently being scored for
 * @returns {{score: number, hasDirectEvidence: boolean}|null} null = no usable image on this source at all
 */
export function scoreImageCandidate(source, matchTarget) {
  if (!source.image_url) return null;

  // credit lines occasionally name the subject too (e.g. a captioned wire
  // photo crediting "Emmanuel Acho speaks on ..."), so they count as
  // direct, image-own evidence exactly like alt/caption — never the
  // headline, which describes the article, not this specific photo.
  const haystack = `${source.image_alt || ""} ${source.image_caption || ""} ${source.image_credit || ""}`;
  const urlLower = source.image_url.toLowerCase();
  const headline = source.headline || "";

  if (REJECT_PATTERNS.some((p) => p.test(haystack) || p.test(urlLower))) return { score: -100, hasDirectEvidence: false };

  let score = 1; // base: a real, previously-validated image exists
  let hasDirectEvidence = false;
  if (!matchTarget) return { score, hasDirectEvidence };

  const target = matchTarget.toLowerCase();
  const haystackLower = haystack.toLowerCase();
  const words = subjectWords(matchTarget);

  if (haystackLower.includes(target)) {
    score += 4;
    hasDirectEvidence = true;
  } else if (words.length && words.every((w) => haystackLower.includes(w))) {
    score += 3;
    hasDirectEvidence = true;
  }

  const slug = target.replace(/[^a-z0-9]+/g, "-");
  if (slug && urlLower.includes(slug)) {
    score += 3;
    hasDirectEvidence = true;
  } else if (words.length >= 2 && words.every((w) => urlLower.includes(w))) {
    score += 2;
    hasDirectEvidence = true;
  }

  // Contextual only — the containing article mentions the subject. Never
  // sets hasDirectEvidence: this says nothing about which specific photo on
  // that page depicts them. Still added to the numeric score, which
  // continues to drive image_candidates ranking and is meaningful in
  // combination with genuine direct evidence above.
  if (headline.toLowerCase().includes(target)) score += 2;

  return { score, hasDirectEvidence };
}

// ==========================================================================
// 2026-09-14 tightening — named-person image relevance must be person-
// specific
// ==========================================================================
// The direct-evidence rule above (does the image's OWN metadata corroborate
// SOME target) is necessary but not sufficient for a headline centered on
// one or more named people: it would still accept a photo whose only
// direct evidence is a matching TEAM name, which proves the photo is from
// the right team's coverage, never that it depicts the specific named
// person the headline is actually about. "EMMANUEL ACHO COMMENTS SPARK NFL
// INVESTIGATION OF DOM DISANDRO" has no team at all as its subject — a
// generic "Philadelphia Eagles v New England Patriots" photo must fail
// regardless of any team-fallback logic.
//
// headline_named_people (see generate-content.js's applyVisualMedia) is
// the FULL list of named people extractLikelyPlayerNames() finds in the
// ORIGINAL mixed-case headline — deliberately not limited to the single
// visual_subject value, since a headline can genuinely name more than one
// person (Acho AND DiSandro) and evidence for EITHER is sufficient. When
// this list is non-empty, selectStoryImages() below scores every source
// against EVERY named person (never just visual_subject) and accepts a
// candidate only if it has direct evidence for AT LEAST ONE of them —
// the current_team fallback is skipped entirely in this branch, since a
// team match is explicitly not sufficient evidence for a person-centric
// headline. When the list is empty (team/event-centered headlines, or a
// headline whose person the extractor couldn't isolate), behavior is
// completely unchanged from the prior 2026-09-14 fix: score against
// visual_subject, falling back to current_team.
//
// Still no face recognition, no invented image identity, no web scraping,
// no paid API — this only ever changes which of the ALREADY-FETCHED
// source photos' own textual metadata is checked against, using the same
// substring/word matching scoreImageCandidate already does.

/**
 * Builds the ranked image_candidates list and picks primary_image_* for a
 * story. For a person-centric headline (headline_named_people non-empty),
 * requires direct evidence tying the image to at least one of those named
 * people specifically — never a generic team/event match. Otherwise, tries
 * to match the visual subject first; if nothing clears the confidence bar
 * and the subject is a person, falls back to matching the current team (a
 * relevant team photo beats an unrelated/no image). Never picks a rejected
 * candidate (logo/reporter headshot/etc) even as a fallback — those score
 * -100 and are filtered out entirely.
 *
 * @param {{sources: object[], visual_subject: string|null, visual_subject_type: string|null, current_team: string|null, headline_named_people?: string[]}} story
 */
export function selectStoryImages({ sources, visual_subject, visual_subject_type, current_team, headline_named_people = [] }) {
  const isPerson = visual_subject_type === "player" || visual_subject_type === "coach" || visual_subject_type === "executive";

  function scoreAgainst(target) {
    return sources
      .map((s) => ({ source: s, result: scoreImageCandidate(s, target) }))
      .filter((c) => c.result !== null && c.result.score > -100);
  }

  // Accepted (a possible primary) requires BOTH the numeric bar AND direct,
  // image-own evidence — see this file's own 2026-09-14 header for exactly
  // why the numeric score alone is not enough.
  function isAccepted(c) {
    return c.result.score >= MIN_ACCEPT_SCORE && c.result.hasDirectEvidence;
  }

  // The same source photo can be scored multiple times (once per named
  // person) when a headline names more than one — keep only each source's
  // single best-scoring result so the ranked candidates list never lists
  // the same photo twice.
  function bestPerSource(entries) {
    const bestByUrl = new Map();
    for (const c of entries) {
      const key = c.source.image_url;
      const existing = bestByUrl.get(key);
      if (!existing || c.result.score > existing.result.score) bestByUrl.set(key, c);
    }
    return [...bestByUrl.values()];
  }

  let scored;
  let usedTarget;

  if (headline_named_people.length > 0) {
    const allPersonScored = headline_named_people.flatMap((person) => scoreAgainst(person).map((c) => ({ ...c, person })));
    scored = bestPerSource(allPersonScored);
    const topAccepted = scored.filter(isAccepted).sort((a, b) => b.result.score - a.result.score)[0];
    // Purely for the returned candidates' `subject` label — never affects
    // acceptance, which is already fully decided above.
    usedTarget = topAccepted?.person ?? visual_subject ?? headline_named_people[0];
  } else {
    scored = visual_subject ? scoreAgainst(visual_subject) : scoreAgainst(null);
    usedTarget = visual_subject;
    const anyConfidentMatch = scored.some(isAccepted);

    if (!anyConfidentMatch && isPerson && current_team) {
      const teamScored = scoreAgainst(current_team);
      if (teamScored.some(isAccepted)) {
        scored = teamScored;
        usedTarget = current_team;
      }
    }
  }

  const candidates = scored
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, 5)
    .map(({ source, result }) => ({
      url: source.image_url,
      source: source.name,
      subject: usedTarget,
      match_score: result.score,
      has_direct_evidence: result.hasDirectEvidence,
      alt: source.image_alt,
      caption: source.image_caption,
      credit: source.image_credit,
    }));

  const primary = candidates.find((c) => c.match_score >= MIN_ACCEPT_SCORE && c.has_direct_evidence) ?? null;

  return {
    image_candidates: candidates,
    primary_image_url: primary?.url ?? null,
    primary_image_source: primary?.source ?? null,
    primary_image_credit: primary?.credit ?? null,
    primary_image_alt: primary?.alt ?? null,
  };
}
