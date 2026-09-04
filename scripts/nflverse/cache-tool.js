#!/usr/bin/env node
// Editorial Scoring Brain — Phase 2A/2B manual developer CLI.
//
// Every subcommand is strictly read-only EXCEPT `refresh`, which is the
// one command that performs a real network fetch and writes
// data/nflverse-cache.json. No story scoring, no production processing,
// no social-state access, ever.
//
// Usage:
//   node scripts/nflverse/cache-tool.js refresh [--season 2026]
//   node scripts/nflverse/cache-tool.js inspect
//   node scripts/nflverse/cache-tool.js lookup "<name>"
import { refreshNflverseCache, readNflverseCache, defaultNflSeason } from "../lib/nflverseCache.js";
import { buildPlayerIndex, lookupByName } from "../lib/nflversePlayerIndex.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, season: null, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--season") args.season = Number(rest[++i]);
    else args.positional.push(rest[i]);
  }
  return args;
}

async function cmdRefresh({ season }) {
  const resolvedSeason = season ?? defaultNflSeason();
  console.log(`Refreshing nflverse cache for season ${resolvedSeason}...`);
  const result = await refreshNflverseCache({ season: resolvedSeason });
  console.log("");
  console.log(`Roster:      refreshed=${result.roster.refreshed}${result.roster.error ? ` error="${result.roster.error}"` : ""}`);
  if (result.cache.roster) {
    console.log(`  fetched_at:      ${result.cache.roster.fetched_at}`);
    console.log(`  source_as_of:    ${result.cache.roster.source_as_of}`);
    console.log(`  row_count:       ${result.cache.roster.row_count}`);
    console.log(`  integrity_hash:  ${result.cache.roster.integrity_hash}`);
  }
  console.log(`Depth chart: refreshed=${result.depth_chart.refreshed}${result.depth_chart.error ? ` error="${result.depth_chart.error}"` : ""}`);
  if (result.cache.depth_chart) {
    console.log(`  fetched_at:      ${result.cache.depth_chart.fetched_at}`);
    console.log(`  source_as_of:    ${result.cache.depth_chart.source_as_of}`);
    console.log(`  row_count:       ${result.cache.depth_chart.row_count}`);
    console.log(`  integrity_hash:  ${result.cache.depth_chart.integrity_hash}`);
  }
}

async function cmdInspect() {
  const cache = await readNflverseCache();
  if (!cache) {
    console.log("No valid cache found (missing, corrupt, or schema mismatch). Run `refresh` first.");
    return;
  }
  console.log(JSON.stringify({ schema_version: cache.schema_version, roster: cache.roster && { ...cache.roster, rows: `[${cache.roster.rows.length} rows omitted]` }, depth_chart: cache.depth_chart && { ...cache.depth_chart, rows: `[${cache.depth_chart.rows.length} rows omitted]` } }, null, 2));
}

async function cmdLookup(name) {
  if (!name) throw new Error('Usage: lookup "<name>"');
  const cache = await readNflverseCache();
  if (!cache?.roster) {
    console.log("No cached roster data. Run `refresh` first.");
    return;
  }
  const index = buildPlayerIndex(cache.roster);
  const candidates = lookupByName(index, name);
  console.log(`${candidates.length} candidate(s) for "${name}":\n`);
  for (const c of candidates) {
    console.log(JSON.stringify(c, null, 2));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "refresh") return cmdRefresh(args);
  if (args.command === "inspect") return cmdInspect();
  if (args.command === "lookup") return cmdLookup(args.positional.join(" "));
  console.error('Usage: node scripts/nflverse/cache-tool.js <refresh|inspect|lookup> [args]');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("cache-tool failed:", err);
  process.exitCode = 1;
});
