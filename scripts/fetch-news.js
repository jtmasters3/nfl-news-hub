#!/usr/bin/env node
// Discovery stage: fetch every enabled source's public feed and return the
// raw articles found. Also runnable standalone for quickly checking that
// each source is reachable and parsing correctly:
//
//   node scripts/fetch-news.js
//
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllSources } from "./lib/fetchAll.js";

export { fetchAllSources };

async function main() {
  const results = await fetchAllSources();
  let ok = 0;

  for (const r of results) {
    if (r.error) {
      console.log(`✗ ${r.source.name}: ERROR — ${r.error}`);
      continue;
    }
    ok++;
    console.log(`✓ ${r.source.name}: ${r.articles.length} articles`);
    for (const a of r.articles.slice(0, 3)) {
      console.log(`   - ${a.headline}`);
    }
  }

  console.log(`\n${ok}/${results.length} sources responded successfully.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
