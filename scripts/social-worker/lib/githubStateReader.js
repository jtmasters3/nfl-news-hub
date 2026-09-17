// Reads the authoritative data/social-state.json in a way that CANNOT be
// served stale by raw.githubusercontent.com's edge cache — the actual fix
// for the 2026-09-03 Approval Console false-timeout incident.
//
// Root cause, confirmed empirically (not assumed): repeated requests to
// raw.githubusercontent.com/.../main/data/social-state.json with distinct,
// never-before-seen `?approval_poll=<value>` query strings all returned
// `X-Cache: HIT` against the SAME cached object — Fastly (GitHub's raw
// content CDN) ignores the query string entirely when computing its cache
// key for this asset. A query-string cache-buster on the MUTABLE
// branch-name URL can never work here, no matter how unique the value is.
//
// The fix: never read via the mutable `.../main/...` URL for polling.
// Instead, ask the GitHub REST API (api.github.com — a live API surface,
// not a long-TTL static-asset CDN) for the LATEST COMMIT SHA touching this
// file, then read the file content pinned to that EXACT commit SHA
// (`.../<sha>/data/social-state.json`). A commit SHA is content-addressed
// and immutable — a URL pinned to a brand-new SHA has never been
// requested by anyone before, so it can only ever be a genuine cache MISS
// (fresh origin fetch); a URL pinned to an OLD SHA is safely, permanently
// correct to have cached, since that exact commit's content can never
// change. There is no "stale" state possible for a SHA-pinned URL — this
// was verified directly against production (see the incident's forensic
// report) before implementing this fix.
//
// The GitHub Contents API's inline `content` field was considered and
// rejected: data/social-state.json is ~1.3MB, over the Contents API's 1MB
// inline-content limit — GitHub returns `content: "", encoding: "none"`
// for files that large. The commit-list endpoint used here returns only
// small commit metadata regardless of the target file's size.
const DEFAULT_OWNER = "jtmasters3";
const DEFAULT_REPO = "nfl-news-hub";
const DEFAULT_BRANCH = "main";
const DEFAULT_FILE_PATH = "data/social-state.json";
const ARTWORK_QUEUE_FILE_PATH = "social-artwork-queue.json";

function resolveTarget(opts = {}) {
  return {
    owner: opts.owner ?? process.env.GITHUB_API_OWNER ?? DEFAULT_OWNER,
    repo: opts.repo ?? process.env.GITHUB_API_REPO ?? DEFAULT_REPO,
    branch: opts.branch ?? process.env.GITHUB_API_BRANCH ?? DEFAULT_BRANCH,
    filePath: opts.filePath ?? DEFAULT_FILE_PATH,
    token: opts.token ?? process.env.GITHUB_API_TOKEN ?? null,
  };
}

function githubApiHeaders(token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Small, fast, always-fresh check — the GitHub REST API is not a static
 * CDN and reflects the current ref immediately. This is deliberately
 * called on EVERY poll attempt (cheap) so the large file itself is only
 * ever re-fetched when something has actually changed (see
 * createFreshStateFetcher below).
 * @param {object} [opts] - owner/repo/branch/filePath/token overrides; also accepts fetchImpl for tests
 * @returns {Promise<string>} the latest commit SHA touching filePath on branch
 */
export async function getLatestCommitSha(opts = {}) {
  const { owner, repo, branch, filePath, token } = resolveTarget(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(branch)}&per_page=1`;
  const res = await fetchImpl(url, { headers: githubApiHeaders(token) });

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get?.("x-ratelimit-remaining");
    const err = new Error(`GitHub API rate limited while checking the latest commit for ${filePath} (status ${res.status}, remaining ${remaining ?? "?"})`);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Failed to list commits for ${filePath}: ${res.status}`);

  const commits = await res.json();
  if (!Array.isArray(commits) || !commits[0]?.sha) {
    throw new Error(`Unexpected GitHub commits response shape for ${filePath}`);
  }
  return commits[0].sha;
}

/**
 * Fetches the file's content pinned to an EXACT commit SHA — never the
 * mutable branch-name URL. Validates the response is well-formed JSON
 * with the expected top-level shape before returning it.
 * @param {object} args - commitSha (required) plus owner/repo/filePath overrides; also accepts fetchImpl for tests
 */
export async function fetchStateAtCommit(args = {}) {
  const { owner, repo, filePath } = resolveTarget(args);
  const { commitSha } = args;
  if (!commitSha) throw new Error("fetchStateAtCommit requires a commitSha");
  const fetchImpl = args.fetchImpl ?? fetch;

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filePath}`;
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${filePath} at commit ${commitSha}: ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${filePath} at commit ${commitSha} was not valid JSON`);
  }
  if (!data || typeof data !== "object" || !data.stories || typeof data.stories !== "object") {
    throw new Error(`Unexpected data/social-state.json shape at commit ${commitSha}`);
  }
  return data;
}

/**
 * Returns a `fetchState()`-shaped function — matching
 * waitForApprovalCommit.js's contract exactly — that internally performs
 * the cheap commit-check-then-conditional-fetch described above. Each
 * returned function has its OWN independent "last seen SHA" memory (a
 * fresh closure per call), so a new confirmation poll always starts from
 * a clean slate.
 */
export function createFreshStateFetcher(opts = {}) {
  let lastSha = null;
  let lastState = null;
  return async function fetchFreshState() {
    const sha = await getLatestCommitSha(opts);
    if (sha !== lastSha || !lastState) {
      lastState = await fetchStateAtCommit({ ...opts, commitSha: sha });
      lastSha = sha;
    }
    return lastState;
  };
}

/**
 * Fetches social-artwork-queue.json content pinned to an EXACT commit SHA
 * — same immutability guarantee as fetchStateAtCommit above, just with an
 * array-shaped payload instead of the {stories: {...}} document shape.
 * @param {object} args - commitSha (required) plus owner/repo overrides; also accepts fetchImpl for tests
 */
export async function fetchArtworkQueueAtCommit(args = {}) {
  const { owner, repo } = resolveTarget(args);
  const { commitSha } = args;
  if (!commitSha) throw new Error("fetchArtworkQueueAtCommit requires a commitSha");
  const fetchImpl = args.fetchImpl ?? fetch;

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${ARTWORK_QUEUE_FILE_PATH}`;
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${ARTWORK_QUEUE_FILE_PATH} at commit ${commitSha}: ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${ARTWORK_QUEUE_FILE_PATH} at commit ${commitSha} was not valid JSON`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected ${ARTWORK_QUEUE_FILE_PATH} shape at commit ${commitSha} (expected an array)`);
  }
  return data;
}

/**
 * social-artwork-queue.json's own equivalent of createFreshStateFetcher()
 * above — same SHA-pinning guarantee, applied to the queue file instead of
 * data/social-state.json. Added 2026-09-17 after the exact staleness class
 * this file's own header describes was confirmed live for the queue too:
 * process-one.js's target selection previously read the queue via
 * apiClient.js's fetchArtworkQueue(), which fetches from the GitHub Pages
 * mirror (jtmasters3.github.io) — a build+deploy+CDN path with no
 * same-cycle freshness guarantee at all. A Stage 3A selection that just
 * (re)assigned a record's destination (e.g. a Tier-2/Tier-3 fallback pick,
 * which by construction always just happened) could be read back with its
 * PRIOR destination still in the queue entry, routing process-one.js's
 * artwork generation to the wrong template/aspect-ratio for that
 * destination — confirmed in production against story f77944a0 (a
 * Story-selected record that was generated Feed-shaped, 1122x1402/0.8,
 * and correctly rejected by validation for the wrong aspect ratio). This
 * function is immune to that by construction, exactly like
 * createFreshStateFetcher() already is for data/social-state.json.
 */
export function createFreshArtworkQueueFetcher(opts = {}) {
  let lastSha = null;
  let lastQueue = null;
  return async function fetchFreshArtworkQueue() {
    const sha = await getLatestCommitSha({ ...opts, filePath: ARTWORK_QUEUE_FILE_PATH });
    if (sha !== lastSha || !lastQueue) {
      lastQueue = await fetchArtworkQueueAtCommit({ ...opts, commitSha: sha });
      lastSha = sha;
    }
    return lastQueue;
  };
}
