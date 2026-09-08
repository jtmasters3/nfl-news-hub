#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2F regression suite. Fully offline, fully
// deterministic — no network, no live nflverse dependency. Several cases
// mirror REAL stories found in this repository's own news.json (the
// Deshaun Watson "named QB1" story, and the Keenan Allen/Anthony
// Richardson semicolon-joined headline that motivated the subject-binding
// splitter refinement), even though the fixtures here are synthetic.
// Run with: node scripts/tests/nflverse-fresh-role-resolver-regression.mjs
import assert from "node:assert/strict";
import { resolveFreshRoleEvidence } from "../lib/nflverseFreshRoleResolver.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const DC_AS_OF = "2026-08-15T00:00:00Z";
const FRESH = "2026-09-01T00:00:00Z"; // strictly newer than DC_AS_OF
const STALE = "2026-08-01T00:00:00Z"; // strictly older than DC_AS_OF

function resolve(overrides = {}) {
  return resolveFreshRoleEvidence({
    subject: "Joe Smith",
    baseline_role: "backup",
    depth_chart_as_of: DC_AS_OF,
    sources: [{ name: "NFL Network", headline: "Joe Smith headline", published_at: FRESH }],
    ...overrides,
  });
}

function src(headline, overrides = {}) {
  return { name: "NFL Network", headline, published_at: FRESH, ...overrides };
}

// ---------------------------------------------------------------------------
// STARTER POSITIVES (1-5)
// ---------------------------------------------------------------------------
test("1. subject named the starter -> starter", () => {
  const r = resolve({ sources: [src("Joe Smith named the starter")] });
  assert.equal(r.fresh_role, "starter");
  assert.ok(r.override_applies);
});
test("2. subject named starting QB -> starter", () => {
  const r = resolve({ sources: [src("Joe Smith named the starting quarterback")] });
  assert.equal(r.fresh_role, "starter");
});
test("3. subject will start -> starter", () => {
  const r = resolve({ sources: [src("Joe Smith will start Sunday")] });
  assert.equal(r.fresh_role, "starter");
});
test("4. subject will be the starter -> starter", () => {
  const r = resolve({ sources: [src("Joe Smith will be the starter")] });
  assert.equal(r.fresh_role, "starter");
});
test("5. subject set to start -> starter", () => {
  const r = resolve({ sources: [src("Joe Smith is set to start")] });
  assert.equal(r.fresh_role, "starter");
});

// ---------------------------------------------------------------------------
// STARTER NEGATIVES (6-13)
// ---------------------------------------------------------------------------
test("6. could start -> no override", () => { const r = resolve({ sources: [src("Joe Smith could start")] }); assert.equal(r.override_applies, false); });
test("7. may start -> no override", () => { const r = resolve({ sources: [src("Joe Smith may start")] }); assert.equal(r.override_applies, false); });
test("8. might start -> no override", () => { const r = resolve({ sources: [src("Joe Smith might start")] }); assert.equal(r.override_applies, false); });
test("9. will not start -> no override", () => { const r = resolve({ sources: [src("Joe Smith will not start")] }); assert.equal(r.override_applies, false); });
test("10. not named starter -> no override", () => { const r = resolve({ sources: [src("Joe Smith was not named the starter")] }); assert.equal(r.override_applies, false); });
test("11. candidate to start -> no override", () => { const r = resolve({ sources: [src("Joe Smith is a candidate to start")] }); assert.equal(r.override_applies, false); });
test("12. competing to start -> no override", () => { const r = resolve({ sources: [src("Joe Smith is competing to start")] }); assert.equal(r.override_applies, false); });
test("13. chance to start -> no override", () => { const r = resolve({ sources: [src("Joe Smith has a chance to start")] }); assert.equal(r.override_applies, false); });

// ---------------------------------------------------------------------------
// BACKUP (14-23)
// ---------------------------------------------------------------------------
test("14. named backup -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named the backup")] }); assert.equal(r.fresh_role, "backup"); });
test("15. will serve as backup -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith will serve as the backup")] }); assert.equal(r.fresh_role, "backup"); });
test("16. will be backup -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith will be the backup")] }); assert.equal(r.fresh_role, "backup"); });
test("17. named QB2 -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named QB2")] }); assert.equal(r.fresh_role, "backup"); });
test("18. promoted to QB2 -> backup", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith promoted to QB2")] }); assert.equal(r.fresh_role, "backup"); });
test("19. demoted to backup -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith demoted to backup")] }); assert.equal(r.fresh_role, "backup"); });
test("20. benched + explicit backup destination -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith was benched and will serve as the backup")] }); assert.equal(r.fresh_role, "backup"); });
test("21. benched alone -> no override", () => { const r = resolve({ sources: [src("Joe Smith was benched")] }); assert.equal(r.override_applies, false); });
test("22. demoted alone -> no override", () => { const r = resolve({ sources: [src("Joe Smith was demoted")] }); assert.equal(r.override_applies, false); });
test("23. promoted alone -> no override", () => { const r = resolve({ sources: [src("Joe Smith was promoted")] }); assert.equal(r.override_applies, false); });

// ---------------------------------------------------------------------------
// RANK LABEL MAPPING (24-34)
// ---------------------------------------------------------------------------
test("24. QB1 -> starter", () => { const r = resolve({ sources: [src("Joe Smith named QB1")] }); assert.equal(r.fresh_role, "starter"); });
test("25. QB2 -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named QB2")] }); assert.equal(r.fresh_role, "backup"); });
test("26. QB3 -> fringe", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named QB3")] }); assert.equal(r.fresh_role, "fringe"); });
test("27. WR2 -> starter", () => { const r = resolve({ sources: [src("Joe Smith named WR2")] }); assert.equal(r.fresh_role, "starter"); });
test("28. WR3 -> significant_rotation", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named WR3")] }); assert.equal(r.fresh_role, "significant_rotation"); });
test("29. WR4 -> backup", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named WR4")] }); assert.equal(r.fresh_role, "backup"); });
test("30. WR5 -> fringe", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named WR5")] }); assert.equal(r.fresh_role, "fringe"); });
test("31. CB3 -> significant_rotation", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named CB3")] }); assert.equal(r.fresh_role, "significant_rotation"); });
test("32. EDGE2 -> significant_rotation", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named EDGE2")] }); assert.equal(r.fresh_role, "significant_rotation"); });
test("33. S2 -> significant_rotation", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named FS2")] }); assert.equal(r.fresh_role, "significant_rotation"); });
test("34. K2 -> fringe", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named K2")] }); assert.equal(r.fresh_role, "fringe"); });

// ---------------------------------------------------------------------------
// PRACTICE SQUAD (35-38)
// ---------------------------------------------------------------------------
test("35. signed to practice squad -> practice_squad", () => { const r = resolve({ sources: [src("Joe Smith signed to the practice squad")] }); assert.equal(r.fresh_role, "practice_squad"); });
test("36. joins practice squad -> practice_squad", () => { const r = resolve({ sources: [src("Joe Smith joins the practice squad")] }); assert.equal(r.fresh_role, "practice_squad"); });
test("37. elevated from practice squad alone -> no role override", () => { const r = resolve({ sources: [src("Joe Smith elevated from the practice squad")] }); assert.equal(r.override_applies, false); });
test("38. elevated from practice squad + named starter -> starter", () => { const r = resolve({ sources: [src("Joe Smith elevated from the practice squad and named the starter")] }); assert.equal(r.fresh_role, "starter"); });

// ---------------------------------------------------------------------------
// SUBJECT BINDING (39-44)
// ---------------------------------------------------------------------------
test("39. Player A subject, Player A will start -> applies", () => {
  const r = resolveFreshRoleEvidence({ subject: "Player A", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [{ name: "NFL Network", headline: "Player A will start Sunday", published_at: FRESH }] });
  assert.equal(r.override_applies, true);
});
test("40. Player A subject, Player B will start -> does not apply", () => {
  const r = resolveFreshRoleEvidence({ subject: "Player A", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [{ name: "NFL Network", headline: "Player B will start Sunday. Player A remains on the roster.", published_at: FRESH }] });
  assert.equal(r.override_applies, false);
});
test("41. multi-player sentence ambiguous attachment -> reject (subject named alongside a known other player in the same unit)", () => {
  const r = resolveFreshRoleEvidence({
    subject: "Player A",
    baseline_role: "backup",
    depth_chart_as_of: DC_AS_OF,
    other_players: ["Player B"],
    sources: [{ name: "NFL Network", headline: "Player A and Player B both want to start, but only one will start", published_at: FRESH }],
  });
  assert.equal(r.override_applies, false, "a unit naming both the subject and another known player must never be resolved by word-order/proximity guessing");
  assert.ok(r.rejected_evidence.some((e) => e.reason_codes.includes("ambiguous_multi_player_sentence")));
});
test("42. role statement in a different sentence than the subject -> reject (mirrors real Keenan Allen/Anthony Richardson semicolon-joined headline)", () => {
  const r = resolveFreshRoleEvidence({ subject: "Keenan Allen", baseline_role: "starter", depth_chart_as_of: DC_AS_OF, sources: [{ name: "NFL.com", headline: "Keenan Allen stays mum on arrest; Anthony Richardson named the backup", published_at: FRESH }] });
  assert.equal(r.override_applies, false, "the backup phrase belongs to a different semicolon-delimited clause about a different player");
});
test("43. headline subject binding works", () => {
  const r = resolveFreshRoleEvidence({ subject: "Joe Smith", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [{ name: "NFL Network", headline: "Joe Smith named the starter", description: "", published_at: FRESH }] });
  assert.equal(r.override_applies, true);
});
test("44. description subject binding works", () => {
  const r = resolveFreshRoleEvidence({ subject: "Joe Smith", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [{ name: "NFL Network", headline: "Team notes for the week", description: "Joe Smith named the starter.", published_at: FRESH }] });
  assert.equal(r.override_applies, true);
});

// ---------------------------------------------------------------------------
// TIMESTAMP (45-51)
// ---------------------------------------------------------------------------
test("45. report newer than depth_chart_as_of -> eligible", () => { const r = resolve({ sources: [src("Joe Smith named the starter", { published_at: FRESH })] }); assert.equal(r.override_applies, true); });
test("46. report equal to depth_chart_as_of -> stale/not eligible", () => { const r = resolve({ sources: [src("Joe Smith named the starter", { published_at: DC_AS_OF })] }); assert.equal(r.override_applies, false); });
test("47. report older -> stale/not eligible", () => { const r = resolve({ sources: [src("Joe Smith named the starter", { published_at: STALE })] }); assert.equal(r.override_applies, false); });
test("48. missing depth_chart_as_of -> no override", () => { const r = resolve({ depth_chart_as_of: null, sources: [src("Joe Smith named the starter")] }); assert.equal(r.override_applies, false); });
test("49. missing published_at -> no override", () => { const r = resolve({ sources: [src("Joe Smith named the starter", { published_at: null })] }); assert.equal(r.override_applies, false); });
test("50. invalid published_at -> no override", () => { const r = resolve({ sources: [src("Joe Smith named the starter", { published_at: "not-a-date" })] }); assert.equal(r.override_applies, false); });
test("51. source latest_seen_at newer but published_at older -> no override (latest_seen_at is never consulted)", () => {
  const r = resolve({ sources: [src("Joe Smith named the starter", { published_at: STALE, latest_seen_at: FRESH })] });
  assert.equal(r.override_applies, false);
});

// ---------------------------------------------------------------------------
// SOURCE TIERS (52-60)
// ---------------------------------------------------------------------------
test("52. Tier A material shift one source -> applies", () => {
  const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named the starter", { name: "ESPN" })] });
  assert.equal(r.override_applies, true);
  assert.equal(r.confidence, "high");
});
test("53. Tier A minor shift one source -> applies", () => {
  const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named QB2", { name: "ESPN" })] }); // fringe->backup is minor
  assert.equal(r.override_applies, true);
});
test("54. Tier B minor shift one source -> applies", () => {
  const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named QB2", { name: "CBS Sports" })] }); // Tier B, fringe->backup minor
  assert.equal(r.override_applies, true);
  assert.equal(r.confidence, "medium");
});
test("55. Tier B material shift one source -> insufficient", () => {
  const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named the starter", { name: "CBS Sports" })] }); // fringe->starter is material
  assert.equal(r.override_applies, false);
});
test("56. Tier B material shift two independent sources -> applies", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named the starter", { name: "CBS Sports" }), src("Joe Smith named the starter", { name: "FOX Sports", published_at: "2026-09-02T00:00:00Z" })],
  });
  assert.equal(r.override_applies, true);
  assert.equal(r.confidence, "high");
});
test("57. Tier B same publisher duplicated twice -> insufficient", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named the starter", { name: "CBS Sports" }), src("Joe Smith named the starter", { name: "CBS Sports", published_at: "2026-09-02T00:00:00Z" })],
  });
  assert.equal(r.override_applies, false);
});
test("58. Tier B duplicate URL twice -> insufficient", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named the starter", { name: "CBS Sports", url: "https://example.com/a" }), src("Joe Smith named the starter", { name: "CBS Sports", url: "https://example.com/a", published_at: "2026-09-02T00:00:00Z" })],
  });
  assert.equal(r.override_applies, false);
});
test("59. unknown-tier source alone -> no override", () => {
  const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named QB2", { name: "Random Blog" })] });
  assert.equal(r.override_applies, false);
});
test("60. unknown + one Tier B material -> still insufficient", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named the starter", { name: "CBS Sports" }), src("Joe Smith named the starter", { name: "Random Blog", published_at: "2026-09-02T00:00:00Z" })],
  });
  assert.equal(r.override_applies, false);
});

// ---------------------------------------------------------------------------
// MATERIALITY (61-70)
// ---------------------------------------------------------------------------
test("61. backup->starter material", () => { const r = resolve({ baseline_role: "backup", sources: [src("Joe Smith named the starter", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "material"); });
test("62. fringe->starter material", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named the starter", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "material"); });
test("63. unknown->starter material", () => { const r = resolve({ baseline_role: "unknown", sources: [src("Joe Smith named the starter", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "material"); });
test("64. starter->backup material", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named QB2", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "material"); });
test("65. fringe->significant_rotation material", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named WR3", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "material"); });
test("66. backup->fringe minor (final documented classification)", () => { const r = resolve({ baseline_role: "backup", sources: [src("Joe Smith named QB3", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "minor"); });
test("67. fringe->backup minor", () => { const r = resolve({ baseline_role: "fringe", sources: [src("Joe Smith named QB2", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "minor"); });
test("68. unknown->backup minor", () => { const r = resolve({ baseline_role: "unknown", sources: [src("Joe Smith named QB2", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "minor"); });
test("69. backup->significant_rotation minor per locked table", () => { const r = resolve({ baseline_role: "backup", sources: [src("Joe Smith named WR3", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "minor"); });
test("70. same role -> none / no meaningful override", () => { const r = resolve({ baseline_role: "starter", sources: [src("Joe Smith named the starter", { name: "ESPN" })] }); assert.equal(r.shift_materiality, "none"); assert.equal(r.override_applies, false); });

// ---------------------------------------------------------------------------
// RUMOR / SPECULATION (71-74)
// ---------------------------------------------------------------------------
test("71. story/source marked rumor -> no override", () => { const r = resolve({ is_rumor: true, sources: [src("Joe Smith named the starter", { name: "ESPN" })] }); assert.equal(r.override_applies, false); });
test("72. \"expected to be named starter\" -> no override", () => { const r = resolve({ sources: [src("Joe Smith is expected to be named the starter")] }); assert.equal(r.override_applies, false); });
test("73. \"reportedly could start\" -> no override", () => { const r = resolve({ sources: [src("Joe Smith reportedly could start")] }); assert.equal(r.override_applies, false); });
test("74. factual \"was named starter\" -> eligible", () => { const r = resolve({ sources: [src("Joe Smith was named the starter", { name: "ESPN" })] }); assert.equal(r.override_applies, true); });

// ---------------------------------------------------------------------------
// MULTIPLE EVIDENCE (75-79)
// ---------------------------------------------------------------------------
test("75. multiple qualifying Tier A sources same role -> deterministic", () => {
  const r = resolve({ sources: [src("Joe Smith named the starter", { name: "ESPN" }), src("Joe Smith will start", { name: "NFL Network", published_at: "2026-09-02T00:00:00Z" })] });
  assert.equal(r.fresh_role, "starter");
  assert.equal(r.qualifying_evidence.length, 2);
});
test("76. qualifying sources disagree on role -> do not arbitrarily choose (equal timestamps)", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named the starter", { name: "ESPN", published_at: FRESH }), src("Joe Smith named QB2", { name: "NFL Network", published_at: FRESH })],
  });
  assert.equal(r.override_applies, false);
  assert.ok(r.reason_codes.includes("conflicting_fresh_reports"));
});
test("77. newer qualifying source conflicts with older qualifying source -> newer supersedes", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named QB2", { name: "ESPN", published_at: FRESH }), src("Joe Smith named the starter", { name: "NFL Network", published_at: "2026-09-05T00:00:00Z" })],
  });
  assert.equal(r.fresh_role, "starter");
  assert.ok(r.reason_codes.includes("newer_report_superseded_conflicting_older_report"));
});
test("78. evidence input ordering does not change the result", () => {
  const sourcesA = [src("Joe Smith named the starter", { name: "ESPN" }), src("Joe Smith named QB2", { name: "NFL Network", published_at: "2026-09-05T00:00:00Z" })];
  const sourcesB = [sourcesA[1], sourcesA[0]];
  const a = resolve({ baseline_role: "fringe", sources: sourcesA });
  const b = resolve({ baseline_role: "fringe", sources: sourcesB });
  assert.equal(a.fresh_role, b.fresh_role);
  assert.equal(a.override_applies, b.override_applies);
});
test("79. duplicate evidence does not inflate corroboration", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [src("Joe Smith named the starter", { name: "CBS Sports" }), src("Joe Smith named the starter", { name: "CBS Sports", published_at: "2026-09-02T00:00:00Z" }), src("Joe Smith named the starter", { name: "CBS Sports", published_at: "2026-09-03T00:00:00Z" })],
  });
  assert.equal(r.override_applies, false, "three copies from the SAME publisher must never satisfy the two-independent-source requirement");
});

// ---------------------------------------------------------------------------
// BOUNDARIES (80-89)
// ---------------------------------------------------------------------------
test("80. no network calls", async () => {
  const src2 = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseFreshRoleResolver.js", import.meta.url), "utf-8"));
  assert.equal(/\bfetch\s*\(/.test(src2), false);
});
test("81. no filesystem/cache reads", async () => {
  const src2 = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseFreshRoleResolver.js", import.meta.url), "utf-8"));
  assert.equal(/readFileSync|require\(['"]fs/.test(src2), false);
});
test("82. no scoring fields returned", () => {
  const r = resolve({ sources: [src("Joe Smith named the starter")] });
  for (const forbidden of ["role_weight", "position_weight", "role_multiplier", "star_boost", "total_score", "score"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(r, forbidden), false, `must never contain: ${forbidden}`);
  }
});
test("83. no Phase 2E mutation (resolvePlayerRole's own module is never written to; this module only reads its exported function)", async () => {
  const src2 = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseFreshRoleResolver.js", import.meta.url), "utf-8"));
  assert.ok(src2.includes('from "./nflverseRoleResolver.js"'), "must reuse the locked Phase 2E export");
  assert.equal(/writeFile|export function resolvePlayerRole/.test(src2), false, "must never redefine or write to the locked Phase 2E module");
});
test("84. no input mutation", () => {
  const sourcesArr = Object.freeze([Object.freeze(src("Joe Smith named the starter"))]);
  assert.doesNotThrow(() => resolveFreshRoleEvidence({ subject: "Joe Smith", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: sourcesArr }));
});
test("85. player fame/name other than subject binding does not change role mapping", () => {
  const a = resolveFreshRoleEvidence({ subject: "Random Player", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [src("Random Player named the starter")] });
  const b = resolveFreshRoleEvidence({ subject: "Famous Player", baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [src("Famous Player named the starter")] });
  assert.equal(a.fresh_role, b.fresh_role);
  assert.equal(a.override_applies, b.override_applies);
});
test("86. team does not change role mapping", () => {
  const r = resolve({ sources: [src("Joe Smith named the starter", { team: "KC" })] });
  assert.equal(r.fresh_role, "starter");
});
test("87. the fresh-role parser does not resolve identity (accepts a literal subject string only, never a candidate list)", async () => {
  const src2 = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseFreshRoleResolver.js", import.meta.url), "utf-8"));
  assert.equal(/lookupByName|nflverseIdentityResolver/.test(src2), false);
});
test("88. the fresh-role parser does not normalize position beyond explicit locked rank-label interpretation", async () => {
  const src2 = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/nflverseFreshRoleResolver.js", import.meta.url), "utf-8"));
  const importCount = (src2.match(/from "\.\/nflversePositionNormalizer\.js"/g) || []).length;
  assert.equal(importCount, 1, "normalizePlayerPosition must be imported exactly once, used only as the rank-label mechanical vehicle");
});
test("89. H/KR/PR are never usable as fresh football-role destinations", () => {
  const r = resolve({ sources: [src("Joe Smith named KR1")] });
  assert.equal(r.override_applies, false, "KR is not one of the locked positioned rank-label prefixes and must never match");
});

// ---------------------------------------------------------------------------
// Additional coverage required by real observed source-tier/story shape
// ---------------------------------------------------------------------------

test("Additional: real Deshaun Watson 'being named QB1' headline (Tier B, backup->starter material) -> insufficient corroboration", () => {
  const r = resolveFreshRoleEvidence({
    subject: "Deshaun Watson",
    baseline_role: "backup",
    depth_chart_as_of: "2026-08-01T00:00:00Z",
    sources: [{ name: "Pro Football Talk", headline: 'Todd Monken "absolutely not" bothered by fan backlash to Deshaun Watson being named QB1', description: "When Browns quarterback Deshaun Watson played in a preseason game in Cleveland last month, he was heartily booed.", published_at: "2026-09-01T19:53:12.000Z" }],
  });
  assert.equal(r.override_applies, false);
  assert.equal(r.qualifying_evidence.length, 0);
  assert.ok(r.rejected_evidence.some((e) => e.reason_codes.includes("insufficient_corroboration")));
});

test("Additional: the same real headline from a Tier A source instead -> applies", () => {
  const r = resolveFreshRoleEvidence({
    subject: "Deshaun Watson",
    baseline_role: "backup",
    depth_chart_as_of: "2026-08-01T00:00:00Z",
    sources: [{ name: "ESPN", headline: "Deshaun Watson being named QB1", published_at: "2026-09-01T19:53:12.000Z" }],
  });
  assert.equal(r.override_applies, true);
  assert.equal(r.fresh_role, "starter");
});

test("Additional: real source object shape (name/url/published_at/discovered_at, no source_name/source_url) is accepted directly", () => {
  const r = resolveFreshRoleEvidence({
    subject: "Joe Smith",
    baseline_role: "backup",
    depth_chart_as_of: DC_AS_OF,
    sources: [{ name: "ESPN", headline: "Joe Smith named the starter", description: "", url: "https://example.com/a", published_at: FRESH, discovered_at: "2026-09-02T00:00:00Z" }],
  });
  assert.equal(r.override_applies, true);
  assert.equal(r.qualifying_evidence[0].source_name, "ESPN");
});

test("Additional: no player context (subject null) -> no override", () => {
  const r = resolveFreshRoleEvidence({ subject: null, baseline_role: "backup", depth_chart_as_of: DC_AS_OF, sources: [src("Joe Smith named the starter")] });
  assert.equal(r.override_applies, false);
});

test("Additional: role_as_of reflects the qualifying evidence's own published_at, never Date.now()", () => {
  const r = resolve({ sources: [src("Joe Smith named the starter", { name: "ESPN", published_at: "2026-09-02T12:00:00.000Z" })] });
  assert.equal(r.role_as_of, "2026-09-02T12:00:00.000Z");
});

test("Additional: only the 6 locked role enum values are ever returned as fresh_role across a broad sample", () => {
  const LOCKED = new Set(["starter", "significant_rotation", "backup", "fringe", "practice_squad", "unknown"]);
  const samples = [
    resolve({ sources: [src("Joe Smith named the starter", { name: "ESPN" })] }),
    resolve({ sources: [] }),
    resolve({ sources: [src("Joe Smith could start")] }),
    resolve({ baseline_role: "fringe", sources: [src("Joe Smith named WR3", { name: "ESPN" })] }),
    resolve({ sources: [src("Joe Smith signed to the practice squad", { name: "ESPN" })] }),
  ];
  for (const s of samples) assert.ok(LOCKED.has(s.fresh_role), `unexpected value: ${s.fresh_role}`);
});

// ---------------------------------------------------------------------------
// HARDENING PASS: per-group qualification before conflict resolution (H1-H5,
// mirroring the locked spec's Examples A/B/D/E), and publisher-identity
// canonicalization (H6-H15).
// ---------------------------------------------------------------------------

function evAt(headline, name, publishedAt) {
  return { name, headline, published_at: publishedAt };
}

test("H1. two Tier B starter reports + newer no-shift backup report -> starter remains (Example A)", () => {
  const r = resolve({
    baseline_role: "backup",
    sources: [
      evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z"),
      evAt("Joe Smith named the starter", "FOX Sports", "2026-09-01T01:05:00Z"),
      evAt("Joe Smith named the backup", "Yahoo Sports", "2026-09-01T01:10:00Z"),
    ],
  });
  assert.equal(r.fresh_role, "starter");
  assert.equal(r.override_applies, true);
});

test("H2. two Tier B starter reports + newer independently-qualified minor fringe report -> fringe supersedes (Example B)", () => {
  const r = resolve({
    baseline_role: "backup",
    sources: [
      evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z"),
      evAt("Joe Smith named the starter", "FOX Sports", "2026-09-01T01:05:00Z"),
      evAt("Joe Smith named QB3", "Yahoo Sports", "2026-09-01T01:10:00Z"), // fringe (backup->fringe is minor)
    ],
  });
  assert.equal(r.fresh_role, "fringe");
  assert.ok(r.reason_codes.includes("newer_report_superseded_conflicting_older_report"));
});

test("H3. one uncorroborated Tier B material starter report + one qualifying Tier B minor report -> the qualifying minor role wins, no conflict (Example D)", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [
      evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z"), // fringe->starter material, only 1 source
      evAt("Joe Smith named QB2", "FOX Sports", "2026-09-01T01:05:00Z"), // fringe->backup minor, qualifies alone
    ],
  });
  assert.equal(r.fresh_role, "backup");
  assert.ok(!r.reason_codes.includes("conflicting_fresh_reports"), "an uncorroborated group must never even reach conflict resolution");
  assert.ok(r.rejected_evidence.some((e) => e.mapped_role === "starter" && e.reason_codes.includes("insufficient_corroboration")));
});

test("H4. two independently-qualified different roles with equal latest timestamps -> conflict / no override", () => {
  const r = resolve({
    baseline_role: "backup",
    sources: [evAt("Joe Smith named the starter", "ESPN", "2026-09-01T01:00:00Z"), evAt("Joe Smith named QB3", "NFL Network", "2026-09-01T01:00:00Z")],
  });
  assert.equal(r.override_applies, false);
  assert.ok(r.reason_codes.includes("conflicting_fresh_reports"));
});

test("H5. input ordering does not change the H1/H2 results", () => {
  const sourcesA = [
    evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z"),
    evAt("Joe Smith named the starter", "FOX Sports", "2026-09-01T01:05:00Z"),
    evAt("Joe Smith named QB3", "Yahoo Sports", "2026-09-01T01:10:00Z"),
  ];
  const sourcesB = [sourcesA[2], sourcesA[0], sourcesA[1]];
  const a = resolve({ baseline_role: "backup", sources: sourcesA });
  const b = resolve({ baseline_role: "backup", sources: sourcesB });
  assert.equal(a.fresh_role, b.fresh_role);
  assert.equal(a.override_applies, b.override_applies);
  assert.deepEqual(a.reason_codes, b.reason_codes);
});

test("H6. PFT + Pro Football Talk material reports count as ONE independent publisher (insufficient)", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [evAt("Joe Smith named the starter", "PFT", "2026-09-01T01:00:00Z"), evAt("Joe Smith named the starter", "Pro Football Talk", "2026-09-01T01:05:00Z")],
  });
  assert.equal(r.override_applies, false, "PFT and Pro Football Talk are the same real outlet and must not satisfy the two-independent-source requirement");
});

test("H7. FOX Sports + Fox Sports material reports count as ONE independent publisher (insufficient)", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [evAt("Joe Smith named the starter", "FOX Sports", "2026-09-01T01:00:00Z"), evAt("Joe Smith named the starter", "Fox Sports", "2026-09-01T01:05:00Z")],
  });
  assert.equal(r.override_applies, false);
});

test("H8. same hostname under different URLs -> one independent publisher, even under two different Tier B names/bylines", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [
      { name: "CBS Sports", headline: "Joe Smith named the starter", url: "https://www.example.com/article-a", published_at: "2026-09-01T01:00:00Z" },
      { name: "The Athletic", headline: "Joe Smith named the starter", url: "https://example.com/article-b", published_at: "2026-09-01T01:05:00Z" },
    ],
  });
  assert.equal(r.override_applies, false, "the same hostname (www.-stripped) must count as one publisher even under two different Tier B names/URLs");
});

test("H9. the same exact URL repeated -> one independent publisher", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [
      { name: "CBS Sports", headline: "Joe Smith named the starter", url: "https://example.com/a", published_at: "2026-09-01T01:00:00Z" },
      { name: "CBS Sports", headline: "Joe Smith named the starter", url: "https://example.com/a", published_at: "2026-09-01T01:05:00Z" },
    ],
  });
  assert.equal(r.override_applies, false);
});

test("H10. genuinely different Tier B publishers -> two independent publishers (applies)", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z"), evAt("Joe Smith named the starter", "The Athletic", "2026-09-01T01:05:00Z")],
  });
  assert.equal(r.override_applies, true);
  assert.equal(r.confidence, "high");
});

test("H11. a Tier A role group independently qualifies with one source", () => {
  const r = resolve({ baseline_role: "fringe", sources: [evAt("Joe Smith named the starter", "ESPN", "2026-09-01T01:00:00Z")] });
  assert.equal(r.override_applies, true);
  assert.equal(r.confidence, "high");
});

test("H12. an unqualified role group cannot supersede a qualified role group merely by having a newer timestamp", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [
      evAt("Joe Smith named QB2", "CBS Sports", "2026-09-01T01:00:00Z"), // fringe->backup is minor; 1 Tier B source qualifies
      evAt("Joe Smith named the starter", "FOX Sports", "2026-09-01T01:05:00Z"), // fringe->starter is material; only 1 source, newer — must NOT win
    ],
  });
  assert.equal(r.fresh_role, "backup", "the newer but uncorroborated material 'starter' group must not supersede the already-qualified 'backup' group");
  assert.ok(r.rejected_evidence.some((e) => e.mapped_role === "starter" && e.reason_codes.includes("insufficient_corroboration")));
});

test("H13. a rejected/unqualified group remains auditable in rejected_evidence with its asserted role and tier", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z")],
  });
  assert.equal(r.override_applies, false);
  const entry = r.rejected_evidence.find((e) => e.mapped_role === "starter");
  assert.ok(entry, "the rejected group must still be present in rejected_evidence");
  assert.equal(entry.source_tier, "B");
  assert.ok(entry.reason_codes.includes("insufficient_corroboration"));
});

test("H14. publisher canonicalization is deterministic", () => {
  const sources = [evAt("Joe Smith named the starter", "PFT", "2026-09-01T01:00:00Z"), evAt("Joe Smith named the starter", "Pro Football Talk", "2026-09-01T01:05:00Z")];
  const a = resolve({ baseline_role: "fringe", sources });
  const b = resolve({ baseline_role: "fringe", sources });
  assert.deepEqual(a, b);
});

test("H15. publisher canonicalization does not use fuzzy matching (a merely similar but distinct outlet name is NOT merged)", () => {
  const r = resolve({
    baseline_role: "fringe",
    sources: [evAt("Joe Smith named the starter", "CBS Sports", "2026-09-01T01:00:00Z"), evAt("Joe Smith named the starter", "CBS News", "2026-09-01T01:05:00Z")],
  });
  // "CBS News" is not a known Tier B alias of "CBS Sports" and shares only a generic corporate prefix —
  // it must be treated as unknown-tier (sourceTier authority is unaffected by canonicalization), not silently merged or upgraded.
  assert.equal(r.override_applies, false, "CBS News is an unknown-tier source and must not corroborate a Tier B CBS Sports report");
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
