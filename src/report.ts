// ─────────────────────────────────────────────────────────────────────────────
// Verdict report rendering — terminal table + machine-readable JSON.
// Table style ported from livguard-ecomm/scripts/ci-triage.js renderTable.
// ─────────────────────────────────────────────────────────────────────────────

import type { Verdict, FailureCategory } from './core/types.js';
import { parseBrokenTarget } from './target.js';

// Plain-English, one-line explanation of each verdict — written for someone who has
// never seen this codebase. The category label ("REAL_REGRESSION") says WHAT; this
// says what it MEANS and who should act. Kept literal on purpose: no jargon a first-
// week engineer would have to look up.
const EXPLAIN: Record<FailureCategory, string> = {
  FLAKY: 'Failed once then passed on retry — a timing flake, not a real break. Safe to ignore.',
  INFRA: 'The site or server errored (network / 5xx / nav timeout) — an environment problem, not app code.',
  ENVIRONMENT: 'Test setup did not run (missing secret, auth state, or env var) — a CI config problem, not a bug.',
  AUTH: 'The API rejected authentication (401/403) — check the token/credentials, not the app code.',
  MISSING_ROUTE: 'Endpoints returned not-found across several tests — one cause (wrong base URL / prefix / bad deploy).',
  SECURITY_FINDING: 'The security suite caught a real vulnerability signature (BOLA, missing cookie flag, leaked secret, 5xx on a hostile payload...) — confirm with a security/dev owner, not a locator or infra issue.',
  REAL_REGRESSION: 'A genuine break — this test failed for real. Needs a developer to look at the app, NOT a locator fix.',
  SELECTOR_BROKEN: 'The element the test looks for was not found — the page changed / locator drifted. Fix the selector.',
  THRESHOLD_DRIFT: 'The screenshot differs beyond tolerance — a visual change. Approve a new baseline or fix the UI.',
  UNKNOWN: 'Verdict could not classify this automatically — read the error below and triage by hand.',
};

// The EXACT locator the test tried to reach — the raw expression Playwright echoes in
// the error ("getByRole('heading', { name: /search results for/i })"). This is the #1
// fact for someone checking why a run failed: it names the element that did not match,
// verbatim, not a paraphrase. Null when there's no locator in the error (e.g. an API
// assertion) — parseBrokenTarget also recovers a filter-chain anchor when present.
function failedLocator(errorMessage: string | null): string | null {
  return parseBrokenTarget(errorMessage).raw || null;
}

// The assertion/matcher that failed and its outcome, from the first error line
// ("expect(locator).toBeVisible() failed", "Timeout 30000ms exceeded", …). Says what
// Playwright *did* — the counterpart to failedLocator's *what it looked for*.
function assertionOutcome(errorMessage: string | null): string | null {
  const first = (errorMessage ?? '').split('\n').map(l => l.trim()).find(Boolean);
  return first ?? null;
}

// The logical pieces of the Detail cell, fact-first for triage: the exact broken
// locator, then what the assertion did, then the on-page reason — and last, the
// plain-English meaning. renderTable wraps each segment on its own line; the job
// summary joins them with a separator.
function detailSegments(v: Verdict): string[] {
  const segs: string[] = [];

  const loc = failedLocator(v.failure.errorMessage);
  if (loc) segs.push(`Failed locator: ${loc}`);

  const outcome = assertionOutcome(v.failure.errorMessage);
  if (outcome) segs.push(outcome);

  if (v.pageMessage) segs.push(`On page: ${v.pageMessage}`);

  // Plain-English meaning, demoted below the hard facts.
  segs.push(EXPLAIN[v.category]);
  return segs.filter(Boolean);
}

// Slicing at a fixed length mid-word ("expect(received).toBe(…") is worse than
// useless for diagnosis — it hides exactly the text a human needs to tell a real
// regression from a false-positive rule match. Back off to the last word boundary.
function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len).replace(/\s+\S*$/, '') + '…';
}

// Word-wrap to a fixed column width so a long detail (e.g. the full error message)
// is shown in its entirety across multiple rows instead of truncated mid-sentence —
// the diagnosis is the whole point of the table. Words longer than `width` (a
// selector, a URL) are hard-split so a single token can never overflow the cell.
function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > width) {
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** A box-drawn summary table of verdicts, fact-first for triage. */
export function renderTable(verdicts: Verdict[]): string {
  const c1 = 46, c2 = 16, c3 = 68;
  const bar = (l: string, m: string, r: string) =>
    `${l}${'─'.repeat(c1 + 2)}${m}${'─'.repeat(c2 + 2)}${m}${'─'.repeat(c3 + 2)}${r}`;
  const pad = (s: string, n: number) => s.padEnd(n, ' ');
  const row = (a: string, b: string, c: string) =>
    `│ ${pad(a, c1)} │ ${pad(b, c2)} │ ${pad(c, c3)} │`;

  const lines = [bar('┌', '┬', '┐'), row('Test', 'Verdict', 'Detail')];
  for (const v of verdicts) {
    lines.push(bar('├', '┼', '┤'));
    // Each logical segment (locator → assertion → reason → meaning) wraps
    // independently so they stay on their own lines instead of running together.
    // Test/Verdict print on the first physical line, detail continues below.
    const detailLines = detailSegments(v).flatMap(seg => wrap(seg, c3));
    lines.push(row(truncate(`${v.failure.testName} [${v.failure.project}]`, c1), v.category, detailLines[0]));
    for (const d of detailLines.slice(1)) lines.push(row('', '', d));
  }
  lines.push(bar('└', '┴', '┘'));
  return lines.join('\n');
}

// Markdown escaping for a GFM table cell: pipes break columns, newlines break rows.
const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Markdown for GitHub's $GITHUB_STEP_SUMMARY (or any Markdown-rendering CI summary
 * page) — the run result visible the instant you open the run, no artifact download
 * needed. Ported from live-e2e.yml's hand-rolled version so every consumer gets it
 * for free instead of re-implementing (and re-breaking) the same truncation logic.
 */
export function renderJobSummary(verdicts: Verdict[], title = 'Verdict'): string {
  let body = `## ${title}\n\n`;
  if (!verdicts.length) {
    body += 'No failures.\n';
    return body;
  }
  const counts = summarize(verdicts);
  body += Object.entries(counts).map(([k, n]) => `**${k}**: ${n}`).join('  ·  ') + '\n\n';
  body += '| Category | Test | Detail |\n|---|---|---|\n';
  for (const v of verdicts) {
    // Same fact-first segments as the terminal table (locator → assertion → reason →
    // meaning), joined into one cell.
    const detail = esc(truncate(detailSegments(v).join('  ·  '), 240));
    body += `| ${v.category} | ${esc(v.failure.testName)} | ${detail} |\n`;
  }
  return body;
}

/** Count verdicts by category for the summary line. */
export function summarize(verdicts: Verdict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of verdicts) counts[v.category] = (counts[v.category] ?? 0) + 1;
  return counts;
}

/** The JSON artifact CI persists / downstream tools read. */
export function toReport(verdicts: Verdict[], timestamp: string) {
  return {
    timestamp,
    total: verdicts.length,
    summary: summarize(verdicts),
    verdicts,
  };
}
