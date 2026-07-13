// ─────────────────────────────────────────────────────────────────────────────
// Verdict report rendering — terminal table + machine-readable JSON.
// Table style ported from livguard-ecomm/scripts/ci-triage.js renderTable.
// ─────────────────────────────────────────────────────────────────────────────

import type { Verdict } from './core/types.js';

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
    const detail = v.heal?.newSelector
      ? `→ ${v.heal.newSelector}`
      : v.pageMessage
        ? `⚠ ${v.pageMessage}`
        : (v.failure.errorMessage ?? '').split('\n')[0];
    // Wrap the detail so the full message is preserved; Test/Verdict/Heal print on
    // the first physical line, the remaining detail lines continue below them.
    const detailLines = wrap(detail, c4);
    lines.push(row(truncate(`${v.failure.testName} [${v.failure.project}]`, c1), v.category, heal, detailLines[0]));
    for (const d of detailLines.slice(1)) lines.push(row('', '', '', d));
  }
  lines.push(bar('└', '┴', '┘'));
  return lines.join('\n');
}

// Markdown escaping for a GFM table cell: pipes break columns, newlines break rows.
const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const firstLine = (s: string | null | undefined): string => (s ?? '').split(/\r?\n/)[0];

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
    // pageMessage is the real on-page reason (pulled from the AX-tree dump at failure
    // time) when one was found — prefer it: "not registered" beats "element not found".
    const why = v.pageMessage
      ? `⚠ ${esc(truncate(v.pageMessage, 140))}`
      : esc(truncate(firstLine(v.failure.errorMessage), 140));
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
