// Deterministically scores each source's extracted image against the
// story's visual subject and picks the best match — or none at all if
// nothing clears the confidence bar. No AI, no paid search API: purely
// substring/keyword matching over metadata already fetched into each
// source record (see imageMeta.js).

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
 * @param {object} source one source record (with image_url/image_alt/image_caption fetched)
 * @param {string} matchTarget the text to match against — the player/coach/team name currently being scored for
 * @returns {number|null} null = no usable image on this source at all; otherwise a score (may be <= 0)
 */
export function scoreImageCandidate(source, matchTarget) {
  if (!source.image_url) return null;

  const haystack = `${source.image_alt || ""} ${source.image_caption || ""}`;
  const urlLower = source.image_url.toLowerCase();
  const headline = source.headline || "";

  if (REJECT_PATTERNS.some((p) => p.test(haystack) || p.test(urlLower))) return -100;

  let score = 1; // base: a real, previously-validated image exists
  if (!matchTarget) return score;

  const target = matchTarget.toLowerCase();
  const haystackLower = haystack.toLowerCase();
  const words = subjectWords(matchTarget);

  if (haystackLower.includes(target)) score += 4;
  else if (words.length && words.every((w) => haystackLower.includes(w))) score += 3;

  const slug = target.replace(/[^a-z0-9]+/g, "-");
  if (slug && urlLower.includes(slug)) score += 3;
  else if (words.length >= 2 && words.every((w) => urlLower.includes(w))) score += 2;

  if (headline.toLowerCase().includes(target)) score += 2;

  return score;
}

/**
 * Builds the ranked image_candidates list and picks primary_image_* for a
 * story. Tries to match the visual subject first; if nothing clears the
 * confidence bar and the subject is a person, falls back to matching the
 * current team (a relevant team photo beats an unrelated/no image). Never
 * picks a rejected candidate (logo/reporter headshot/etc) even as a
 * fallback — those score -100 and are filtered out entirely.
 *
 * @param {{sources: object[], visual_subject: string|null, visual_subject_type: string|null, current_team: string|null}} story
 */
export function selectStoryImages({ sources, visual_subject, visual_subject_type, current_team }) {
  const isPerson = visual_subject_type === "player" || visual_subject_type === "coach" || visual_subject_type === "executive";

  function scoreAll(target) {
    return sources
      .map((s) => ({ source: s, score: scoreImageCandidate(s, target) }))
      .filter((c) => c.score !== null && c.score > -100);
  }

  let scored = visual_subject ? scoreAll(visual_subject) : scoreAll(null);
  let usedTarget = visual_subject;
  const anyConfidentMatch = scored.some((c) => c.score >= MIN_ACCEPT_SCORE);

  if (!anyConfidentMatch && isPerson && current_team) {
    const teamScored = scoreAll(current_team);
    if (teamScored.some((c) => c.score >= MIN_ACCEPT_SCORE)) {
      scored = teamScored;
      usedTarget = current_team;
    }
  }

  const candidates = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ source, score }) => ({
      url: source.image_url,
      source: source.name,
      subject: usedTarget,
      match_score: score,
      alt: source.image_alt,
      caption: source.image_caption,
      credit: source.image_credit,
    }));

  const primary = candidates.find((c) => c.match_score >= MIN_ACCEPT_SCORE) ?? null;

  return {
    image_candidates: candidates,
    primary_image_url: primary?.url ?? null,
    primary_image_source: primary?.source ?? null,
    primary_image_credit: primary?.credit ?? null,
    primary_image_alt: primary?.alt ?? null,
  };
}
