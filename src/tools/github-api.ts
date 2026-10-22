// ─────────────────────────────────────────────────────────────────────────────
// Minimal GitHub REST API client for the public-corpus miner. Not a general SDK —
// only the four endpoints the miner needs (code search, list runs, list artifacts,
// download artifact), using Node's built-in fetch (no Octokit dependency, matching
// this project's "dependency-free" convention — see cli.ts).
// ─────────────────────────────────────────────────────────────────────────────

const API = 'https://api.github.com';

export interface GhSearchCodeItem {
  repository: { full_name: string; html_url: string };
}

export interface GhSearchRepoItem {
  full_name: string;
  stargazers_count: number;
}

export interface GhWorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string;
  html_url: string;
  conclusion: string | null;
}

export interface GhArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  archive_download_url: string;
}

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) {
    throw new Error(
      'GITHUB_TOKEN is not set. Create a classic PAT with the `repo` scope checked — ' +
      'verified empirically: a zero-scope token can search code and list runs/artifacts, ' +
      'but GitHub 403s the actual artifact zip download with "You must have the actions ' +
      'scope to download artifacts" without it. Set it in .env (see .env.example) or ' +
      '`export GITHUB_TOKEN=...` before running this tool.'
    );
  }
  return t;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'verdict-corpus-miner',
  };
}

/** Sleep helper — used only for rate-limit backoff, never for polling. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every network call gets a hard deadline. A run against arbitrary public repos will
// hit the occasional dead/slow connection (expired artifact blob host, a repo's CDN
// hiccup) — without this, one stalled fetch hangs the entire miner indefinitely with
// no error, no log line, nothing to diagnose. Verified live: a 300-run pass stalled
// silently at run 13/300 for 5+ minutes with rate limits nowhere near exhausted.
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Authenticated GET against the GitHub REST API with rate-limit backoff and a hard
 * per-request timeout. On a 403 with `x-ratelimit-remaining: 0`, sleeps until
 * `x-ratelimit-reset` and retries once — GitHub's own documented backoff contract,
 * not a blind retry loop.
 */
async function ghGet(url: string): Promise<Response> {
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0') * 1000;
    const waitMs = Math.max(0, reset - Date.now()) + 1000;
    console.error(`  rate-limited, waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
    await sleep(waitMs);
    return fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  }
  return res;
}

async function ghGetJson<T>(url: string): Promise<T> {
  const res = await ghGet(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Code search — used to find repos whose Playwright config emits a JSON reporter.
 * `page` lets successive miner invocations reach a new slice of results instead of
 * re-covering the same top-ranked repos every time. */
export async function searchCode(query: string, perPage = 30, page = 1): Promise<GhSearchCodeItem[]> {
  const url = `${API}/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
  const data = await ghGetJson<{ items: GhSearchCodeItem[] }>(url);
  return data.items;
}

/** Repo search — used to find well-maintained, actively-run projects by topic,
 * sorted by stars. Popularity correlates with CI hygiene (artifacts actually
 * retained, real recent failures) far better than the content-search queries do:
 * verified on the first pass, where 78/80 content-search-found repos yielded
 * nothing at all, mostly because the matching run's artifact had already expired
 * or was never uploaded in the first place. */
export async function searchRepositories(
  query: string, perPage = 30, page = 1
): Promise<GhSearchRepoItem[]> {
  const url =
    `${API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
  const data = await ghGetJson<{ items: GhSearchRepoItem[] }>(url);
  return data.items;
}

/** Recent completed+failed workflow runs for one repo. */
export async function listFailedRuns(
  owner: string, repo: string, perPage = 20
): Promise<GhWorkflowRun[]> {
  const url =
    `${API}/repos/${owner}/${repo}/actions/runs?status=completed&conclusion=failure&per_page=${perPage}`;
  const data = await ghGetJson<{ workflow_runs: GhWorkflowRun[] }>(url);
  return data.workflow_runs;
}

/** Artifacts attached to one run. */
export async function listArtifacts(owner: string, repo: string, runId: number): Promise<GhArtifact[]> {
  const url = `${API}/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`;
  const data = await ghGetJson<{ artifacts: GhArtifact[] }>(url);
  return data.artifacts;
}

/**
 * Download one artifact's zip content.
 *
 * `archive_download_url` 302-redirects to a signed, time-limited blob-storage URL.
 * We must NOT resend the GitHub Authorization header to that host — it isn't
 * GitHub's API, and forwarding the token to a third-party storage URL would leak
 * it. So the redirect is followed manually: fetch the GitHub URL with auth,
 * capture Location, then fetch Location bare.
 */
export async function downloadArtifactZip(archiveDownloadUrl: string): Promise<Buffer> {
  const first = await fetch(archiveDownloadUrl, {
    headers: authHeaders(), redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const location = first.headers.get('location');
  if (!location) {
    if (first.ok) return Buffer.from(await first.arrayBuffer());
    throw new Error(`Artifact download did not redirect and was not ok: ${first.status}`);
  }
  const blob = await fetch(location, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!blob.ok) throw new Error(`Artifact blob fetch -> ${blob.status}`);
  return Buffer.from(await blob.arrayBuffer());
}
