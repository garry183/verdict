// ─────────────────────────────────────────────────────────────────────────────
// Verdict report rendering — terminal table + machine-readable JSON.
// Table style ported from livguard-ecomm/scripts/ci-triage.js renderTable.
// ─────────────────────────────────────────────────────────────────────────────

import type { Verdict } from './core/types.js';

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

/** A box-drawn summary table of verdicts, most actionable columns first. */
export function renderTable(verdicts: Verdict[]): string {
  const c1 = 46, c2 = 16, c3 = 12, c4 = 30;
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
        : truncate((v.failure.errorMessage ?? '').split('\n')[0], c4);
    lines.push(row(
      truncate(`${v.failure.testName} [${v.failure.project}]`, c1),
      v.category,
      heal,
      truncate(detail, c4),
    ));
  }
  lines.push(bar('└', '┴', '┘'));
  return lines.join('\n');
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
