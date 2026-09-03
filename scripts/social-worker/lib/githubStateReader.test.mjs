#!/usr/bin/env node
// Tests the SHA-pinned authoritative state reader that replaced the
// disproven query-string CDN cache-busting approach (see the doc comment
// on waitForApprovalCommit.js for the full incident writeup). All network
// access is injected via `fetchImpl` — no real GitHub calls, no real
// story. Run with:
// node scripts/social-worker/lib/githubStateReader.test.mjs
import assert from "node:assert/strict";
import { getLatestCommitSha, fetchStateAtCommit, createFreshStateFetcher } from "./githubStateReader.js";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// getLatestCommitSha
// ---------------------------------------------------------------------------

test("getLatestCommitSha calls the GitHub commits API (api.github.com), never raw.githubusercontent.com", async () => {
  const calledUrls = [];
  const sha = await getLatestCommitSha({
    fetchImpl: async (url) => {
      calledUrls.push(url);
      return jsonResponse([{ sha: "abc123" }]);
    },
  });
  assert.equal(sha, "abc123");
  assert.equal(calledUrls.length, 1);
  assert.ok(calledUrls[0].startsWith("https://api.github.com/repos/"), "must call the GitHub REST API, not raw.githubusercontent.com");
  assert.ok(!calledUrls[0].includes("raw.githubusercontent.com"));
});

test("getLatestCommitSha's request URL is not the mutable branch-name raw content URL used by the old, disproven cache-busting fix", async () => {
  const calledUrls = [];
  await getLatestCommitSha({
    fetchImpl: async (url) => {
      calledUrls.push(url);
      return jsonResponse([{ sha: "def456" }]);
    },
  });
  assert.ok(!calledUrls[0].includes("?approval_poll="), "query-string cache-busting must not appear anywhere in the new architecture");
});

test("getLatestCommitSha flags a 403 as rate-limited (err.rateLimited === true) rather than a generic failure", async () => {
  await assert.rejects(
    () =>
      getLatestCommitSha({
        fetchImpl: async () => jsonResponse(null, { ok: false, status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      }),
    (err) => {
      assert.equal(err.rateLimited, true);
      return true;
    }
  );
});

test("getLatestCommitSha flags a 429 as rate-limited too", async () => {
  await assert.rejects(
    () => getLatestCommitSha({ fetchImpl: async () => jsonResponse(null, { ok: false, status: 429 }) }),
    (err) => {
      assert.equal(err.rateLimited, true);
      return true;
    }
  );
});

test("getLatestCommitSha throws a plain (non-rate-limited) error on other failures, e.g. 500", async () => {
  await assert.rejects(
    () => getLatestCommitSha({ fetchImpl: async () => jsonResponse(null, { ok: false, status: 500 }) }),
    (err) => {
      assert.notEqual(err.rateLimited, true);
      return true;
    }
  );
});

test("getLatestCommitSha validates the response shape — an empty array is rejected, not silently treated as a valid SHA", async () => {
  await assert.rejects(() => getLatestCommitSha({ fetchImpl: async () => jsonResponse([]) }));
});

test("getLatestCommitSha validates the response shape — a non-array body is rejected", async () => {
  await assert.rejects(() => getLatestCommitSha({ fetchImpl: async () => jsonResponse({ not: "an array" }) }));
});

test("getLatestCommitSha sends an Authorization header only when a token is supplied", async () => {
  let headersSeenNoToken;
  await getLatestCommitSha({
    fetchImpl: async (_url, init) => {
      headersSeenNoToken = init.headers;
      return jsonResponse([{ sha: "s1" }]);
    },
  });
  assert.equal(headersSeenNoToken.Authorization, undefined);

  let headersSeenWithToken;
  await getLatestCommitSha({
    token: "test-token-value",
    fetchImpl: async (_url, init) => {
      headersSeenWithToken = init.headers;
      return jsonResponse([{ sha: "s1" }]);
    },
  });
  assert.equal(headersSeenWithToken.Authorization, "Bearer test-token-value");
});

// ---------------------------------------------------------------------------
// fetchStateAtCommit
// ---------------------------------------------------------------------------

test("fetchStateAtCommit reads via the IMMUTABLE commit-SHA-pinned raw URL, not the mutable branch-name URL", async () => {
  const calledUrls = [];
  const state = await fetchStateAtCommit({
    commitSha: "35756ac8f95dbf3d608f861f009d734a5057e88c",
    fetchImpl: async (url) => {
      calledUrls.push(url);
      return jsonResponse({ stories: { S1: { status: "approved" } } });
    },
  });
  assert.equal(calledUrls.length, 1);
  assert.ok(calledUrls[0].includes("/35756ac8f95dbf3d608f861f009d734a5057e88c/"), "must be pinned to the exact commit SHA");
  assert.ok(!calledUrls[0].includes("/main/"), "must never read via the mutable branch name for polling purposes");
  assert.equal(state.stories.S1.status, "approved");
});

test("fetchStateAtCommit requires a commitSha argument", async () => {
  await assert.rejects(() => fetchStateAtCommit({ fetchImpl: async () => jsonResponse({ stories: {} }) }));
});

test("fetchStateAtCommit validates the response shape — missing/invalid `.stories` is rejected rather than silently returned", async () => {
  await assert.rejects(() => fetchStateAtCommit({ commitSha: "sha1", fetchImpl: async () => jsonResponse({ not: "the right shape" }) }));
  await assert.rejects(() => fetchStateAtCommit({ commitSha: "sha1", fetchImpl: async () => jsonResponse(null) }));
});

test("fetchStateAtCommit throws a clear error on a non-ok HTTP response", async () => {
  await assert.rejects(() => fetchStateAtCommit({ commitSha: "sha1", fetchImpl: async () => jsonResponse(null, { ok: false, status: 404 }) }));
});

test("fetchStateAtCommit throws a clear error when the body is not valid JSON", async () => {
  await assert.rejects(() =>
    fetchStateAtCommit({
      commitSha: "sha1",
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("Unexpected token"); } }),
    })
  );
});

// ---------------------------------------------------------------------------
// createFreshStateFetcher — the actual fetchState() passed into
// waitForApprovalCommit
// ---------------------------------------------------------------------------

test("createFreshStateFetcher's returned function takes no arguments — matches waitForApprovalCommit's fetchState() contract exactly", async () => {
  const fetchState = createFreshStateFetcher({
    fetchImpl: async (url) => (url.includes("api.github.com") ? jsonResponse([{ sha: "sha-a" }]) : jsonResponse({ stories: { S1: { status: "approved" } } })),
  });
  const state = await fetchState();
  assert.equal(state.stories.S1.status, "approved");
});

test("a fresh, never-before-seen commit SHA always triggers a real fetch of the full file — this is what guarantees freshness", async () => {
  let commitCheckCalls = 0;
  let contentFetchCalls = 0;
  const fetchState = createFreshStateFetcher({
    fetchImpl: async (url) => {
      if (url.includes("api.github.com")) {
        commitCheckCalls++;
        return jsonResponse([{ sha: `sha-${commitCheckCalls}` }]);
      }
      contentFetchCalls++;
      return jsonResponse({ stories: { S1: { status: contentFetchCalls === 1 ? "awaiting_approval" : "approved" } } });
    },
  });

  const first = await fetchState();
  assert.equal(first.stories.S1.status, "awaiting_approval");
  const second = await fetchState();
  assert.equal(second.stories.S1.status, "approved");
  assert.equal(commitCheckCalls, 2, "the cheap commit check runs on every poll attempt");
  assert.equal(contentFetchCalls, 2, "a genuinely new SHA each time means the big file is re-fetched each time too");
});

test("an UNCHANGED commit SHA between polls skips the expensive full-file re-fetch, reusing the last-read state", async () => {
  let commitCheckCalls = 0;
  let contentFetchCalls = 0;
  const fetchState = createFreshStateFetcher({
    fetchImpl: async (url) => {
      if (url.includes("api.github.com")) {
        commitCheckCalls++;
        return jsonResponse([{ sha: "same-sha-every-time" }]);
      }
      contentFetchCalls++;
      return jsonResponse({ stories: { S1: { status: "awaiting_approval" } } });
    },
  });

  await fetchState();
  await fetchState();
  await fetchState();
  assert.equal(commitCheckCalls, 3, "still checks the SHA on every call — it's cheap and must always be fresh");
  assert.equal(contentFetchCalls, 1, "the 1.3MB file is only fetched once, since the SHA never changed");
});

test("a rate-limited commit-check error propagates out of the fetcher with rateLimited still set, so waitForApprovalCommit can detect it", async () => {
  const fetchState = createFreshStateFetcher({
    fetchImpl: async () => jsonResponse(null, { ok: false, status: 403 }),
  });
  await assert.rejects(() => fetchState(), (err) => {
    assert.equal(err.rateLimited, true);
    return true;
  });
});

test("two independently-created fetchers do not share state — each starts with its own clean 'last seen SHA'", async () => {
  let contentFetchCallsA = 0;
  const fetcherA = createFreshStateFetcher({
    fetchImpl: async (url) => (url.includes("api.github.com") ? jsonResponse([{ sha: "sha-x" }]) : (contentFetchCallsA++, jsonResponse({ stories: {} }))),
  });
  let contentFetchCallsB = 0;
  const fetcherB = createFreshStateFetcher({
    fetchImpl: async (url) => (url.includes("api.github.com") ? jsonResponse([{ sha: "sha-x" }]) : (contentFetchCallsB++, jsonResponse({ stories: {} }))),
  });
  await fetcherA();
  await fetcherB();
  assert.equal(contentFetchCallsA, 1);
  assert.equal(contentFetchCallsB, 1, "fetcherB must not treat fetcherA's already-seen SHA as already-known");
});

// ---------------------------------------------------------------------------
// Credential safety — no token in this module ever gets written anywhere
// browser-facing; these tests just assert its handling stays purely
// server-side data passed through fetch headers, never returned/logged.
// ---------------------------------------------------------------------------

test("a supplied token never appears anywhere in a fetchStateAtCommit or getLatestCommitSha return value", async () => {
  const sha = await getLatestCommitSha({
    token: "super-secret-token-xyz",
    fetchImpl: async () => jsonResponse([{ sha: "sha1" }]),
  });
  assert.equal(JSON.stringify(sha).includes("super-secret-token-xyz"), false);

  const state = await fetchStateAtCommit({
    commitSha: "sha1",
    token: "super-secret-token-xyz",
    fetchImpl: async () => jsonResponse({ stories: {} }),
  });
  assert.equal(JSON.stringify(state).includes("super-secret-token-xyz"), false);
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
