// ─────────────────────────────────────────────────────────────────────────────
// Minimal Verdict dashboard — a single self-contained HTML file (zero deps, inline
// CSS). Generated as a CI artifact: category counts for this run plus a per-test
// breakdown with the fact-first detail (locator / on-page reason / plain-English
// meaning) that report.ts also renders to the terminal and job summary.
// ─────────────────────────────────────────────────────────────────────────────

import type { FailureCategory, Verdict } from '../core/types.js';

export interface DashboardData {
  timestamp: string;
  verdicts: Verdict[]; // this run
}

const CAT_COLOR: Record<FailureCategory, string> = {
  REAL_REGRESSION: '#e5484d',
  MISSING_ROUTE: '#e5484d',
  SECURITY_FINDING: '#e93d82',
  AUTH: '#f5a623',
  SELECTOR_BROKEN: '#f5a623',
  FLAKY: '#8e4ec6',
  INFRA: '#8b8d98',
  ENVIRONMENT: '#12a594',
  THRESHOLD_DRIFT: '#3b82f6',
  UNKNOWN: '#5a5d68',
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function countBy<T extends string>(items: T[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const i of items) m[i] = (m[i] ?? 0) + 1;
  return m;
}

function chips(counts: Record<string, number>, colors: Record<string, string>): string {
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (!keys.length) return '<span class="muted">none</span>';
  return keys
    .map(k => `<span class="chip" style="--c:${colors[k] ?? '#5a5d68'}">${esc(k)} <b>${counts[k]}</b></span>`)
    .join('');
}

/** Render the dashboard HTML string. Pure — no I/O. */
export function renderDashboard(data: DashboardData): string {
  const { timestamp, verdicts } = data;

  const catCounts = countBy(verdicts.map(v => v.category));

  const first = verdicts[0]?.failure;
  const commit = first?.commit ? esc(first.commit.slice(0, 8)) : '—';
  const branch = first?.branch ? esc(first.branch) : '—';

  const rows = verdicts
    .map(v => {
      const f = v.failure;
      const detail = v.pageMessage
        ? `<span class="err">⚠ ${esc(v.pageMessage)}</span>`
        : `<span class="err">${esc((f.errorMessage ?? '').split('\n')[0].slice(0, 120))}</span>`;
      return `<tr>
        <td>${esc(f.testName)}<div class="sub">${esc(f.project)}${f.file ? ' · ' + esc(f.file) : ''}</div></td>
        <td><span class="pill" style="--c:${CAT_COLOR[v.category]}">${v.category}</span></td>
        <td class="detail">${detail}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verdict — ${esc(timestamp)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif;
         background: #0e0f12; color: #e6e7ea; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .meta { color: #8b8d98; font-size: 12px; margin-bottom: 22px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .tile { background: #17181c; border: 1px solid #24262c; border-radius: 12px; padding: 16px 18px; }
  .tile .label { color: #8b8d98; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .big { font-size: 34px; font-weight: 700; margin-top: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip, .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
         padding: 2px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
         background: color-mix(in srgb, var(--c) 16%, transparent); color: color-mix(in srgb, var(--c) 85%, white); }
  .pill { font-weight: 600; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; background: #17181c; border: 1px solid #24262c; border-radius: 12px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8b8d98;
       padding: 10px 14px; border-bottom: 1px solid #24262c; }
  td { padding: 11px 14px; border-bottom: 1px solid #1d1f24; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .sub { color: #8b8d98; font-size: 11px; margin-top: 2px; }
  .detail { max-width: 420px; }
  code { background: #0e0f12; border: 1px solid #24262c; border-radius: 5px; padding: 1px 5px; font-size: 12px; word-break: break-all; }
  .err { color: #d98b8b; }
  .muted { color: #5a5d68; }
</style></head>
<body>
  <h1>Verdict</h1>
  <div class="meta">${esc(timestamp)} · branch ${branch} · commit ${commit} · ${verdicts.length} failing test(s)</div>

  <div class="tiles">
    <div class="tile">
      <div class="label">This run — verdicts</div>
      <div class="big">${verdicts.length}</div>
      <div class="chips">${chips(catCounts, CAT_COLOR)}</div>
    </div>
  </div>

  <table>
    <thead><tr><th>Test</th><th>Verdict</th><th>Detail</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">No failures 🎉</td></tr>'}</tbody>
  </table>
</body></html>`;
}
