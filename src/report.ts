// ─────────────────────────────────────────────────────────────────────────────
// Verdict report rendering — terminal table + machine-readable JSON.
// Table style ported from livguard-ecomm/scripts/ci-triage.js renderTable.
// ─────────────────────────────────────────────────────────────────────────────

import type { Verdict, FailureCategory } from './core/types.js';
import { parseBrokenTarget } from './heal/target.js';
import { intentFromError } from './heal/ax-context.js';

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
  REAL_REGRESSION: 'A genuine break — this test failed for real. Needs a developer to look at the app, NOT a locator fix.',
  SELECTOR_BROKEN: 'The element the test looks for was not found — the page changed / locator drifted. Candidate for self-heal.',
  THRESHOLD_DRIFT: 'The screenshot differs beyond tolerance — a visual change. Approve a new baseline or fix the UI.',
  UNKNOWN: 'Verdict could not classify this automatically — read the error below and triage by hand.',
};

// The element the test was trying to reach, in words a human can read, pulled from
// the locator Playwright echoes in the error. "Looking for the 'Checkout' button"
// beats "expect(locator).toBeVisible() failed" for anyone triaging.
function humanTarget(errorMessage: string | null): string | null {
  const t = parseBrokenTarget(errorMessage);
  if (!t.raw) return null;
  // parseBrokenTarget drops .filter({ hasText }); recover the real anchor text from the
  // full Locator expression so "Looking for" names the element, not a bare getByRole.
  const name = t.name ?? intentFromError(errorMessage).text;
  if (name) return `Looking for: "${name}"${t.role ? ` (${t.role})` : ''}`;
  return `Locator: ${t.raw}`;
}

// The logical pieces of the Detail cell, in priority order: what it means, then which
// element, then the on-page reason or raw error. renderTable wraps each; the job
// summary joins them with a separator.
function detailSegments(v: Verdict): string[] {
  const segs: string[] = [EXPLAIN[v.category]];
  const loc = humanTarget(v.failure.errorMessage);
  if (loc) segs.push(loc);
  if (v.heal?.newSelector) segs.push(`→ candidate: ${v.heal.newSelector}`);
  else if (v.pageMessage) segs.push(`⚠ ${v.pageMessage}`);
  else {
    const first = (v.failure.errorMessage ?? '').split('\n')[0].trim();
    if (first) segs.push(first);
  }
  // Offline heal shortlist mined from the AX snapshot (SELECTOR_BROKEN). Confirms the
  // wanted element is gone and shows what the page has now — the fresher-readable "what
  // changed", plus a candidate to verify (never auto-trusted).
  const ax = v.axProbe;
  if (ax) {
    if (ax.intendedText && !ax.oldPresent) segs.push(`"${ax.intendedText}" is no longer on the page.`);
    if (ax.present.length) segs.push(`Page now has: ${ax.present.join(' · ')}`);
    if (ax.candidates.length) segs.push(`Closest candidate (verify): ${ax.candidates[0]}`);
  }
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

/** A box-drawn summary table of verdicts, most actionable columns first. */
export function renderTable(verdicts: Verdict[]): string {
  const c1 = 46, c2 = 16, c3 = 12, c4 = 60;
  const bar = (l: string, m: string, r: string) =>
    `${l}${'─'.repeat(c1 + 2)}${m}${'─'.repeat(c2 + 2)}${m}${'─'.repeat(c3 + 2)}${m}${'─'.repeat(c4 + 2)}${r}`;
  const pad = (s: string, n: number) => s.padEnd(n, ' ');
  const row = (a: string, b: string, c: string, d: string) =>
    `│ ${pad(a, c1)} │ ${pad(b, c2)} │ ${pad(c, c3)} │ ${pad(d, c4)} │`;

  const lines = [bar('┌', '┬', '┐'), row('Test', 'Verdict', 'Heal', 'Detail')];
  for (const v of verdicts) {
    lines.push(bar('├', '┼', '┤'));
    const heal = v.heal ? v.heal.verdict : '—';
    // Each logical segment (meaning → element → reason) wraps independently so they
    // stay on their own lines instead of running together. Test/Verdict/Heal print on
    // the first physical line, the remaining detail lines continue below them.
    const detailLines = detailSegments(v).flatMap(seg => wrap(seg, c4));
    lines.push(row(truncate(`${v.failure.testName} [${v.failure.project}]`, c1), v.category, heal, detailLines[0]));
    for (const d of detailLines.slice(1)) lines.push(row('', '', '', d));
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
  body += '| Category | Test | Heal | Why |\n|---|---|---|---|\n';
  for (const v of verdicts) {
    // Lead with the plain-English meaning + which element, then the on-page reason /
    // raw error — the same segments as the terminal table, joined into one cell.
    const why = esc(truncate(detailSegments(v).join('  ·  '), 200));
    body += `| ${v.category} | ${esc(v.failure.testName)} | ${v.heal?.verdict ?? '—'} | ${why} |\n`;
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
