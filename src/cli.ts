#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verdict CLI:
//
//   verdict triage <report.json...>   ingest + classify. Prints the verdict table,
//                                      writes a JSON report. Non-blocking by default
//                                      (exit 0).
//
// Deliberately dependency-free arg parsing; no framework.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { ingestPlaywrightFile, type IngestMeta } from './ingest/playwright-json.js';
import { classify, parseHttpStatus, httpStatusReason } from './core/rules.js';
import type { ClassificationContext, FailureContext, HealthEntry, Verdict } from './core/types.js';
import { renderTable, renderJobSummary, summarize, toReport } from './report.js';
import { extractPageMessage } from './page-context.js';
import { renderDashboard } from './dashboard/render.js';
import {
  readHistory, computeHealth, appendRunSummary, HISTORY_FILE, type RunSummary,
} from './store/history.js';

function writeDashboard(verdicts: Verdict[], out: string): void {
  const html = renderDashboard({ timestamp: new Date().toISOString(), verdicts });
  writeFileSync(out, html);
  console.log(`Dashboard: ${out}`);
}

// ── arg parsing ───────────────────────────────────────────────────────────────

interface Args { _: string[]; flags: Record<string, string | boolean>; }

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

// commit/branch default from CI env (GitHub or Bitbucket).
function ciMeta(flags: Args['flags']): IngestMeta {
  return {
    suite: str(flags.suite) ?? null,
    commit: str(flags.commit) ?? process.env.GITHUB_SHA ?? process.env.BITBUCKET_COMMIT ?? null,
    branch: str(flags.branch) ?? process.env.GITHUB_REF_NAME ?? process.env.BITBUCKET_BRANCH ?? null,
  };
}

// ── shared: ingest + classify ─────────────────────────────────────────────────

/** Build the durable run summary appended to history (failures + their verdicts). */
function toRunSummary(verdicts: Verdict[], meta: IngestMeta): RunSummary {
  return {
    timestamp: new Date().toISOString(),
    commit: meta.commit ?? null,
    branch: meta.branch ?? null,
    suite: meta.suite ?? null,
    total: verdicts.length,
    outcomes: verdicts.map(v => ({
      testName: v.failure.testName,
      project: v.failure.project,
      retryPassed: v.failure.retryPassed,
      category: v.category,
    })),
  };
}

function ingestAll(reports: string[], meta: IngestMeta): FailureContext[] {
  const all: FailureContext[] = [];
  for (const path of reports) {
    try {
      all.push(...ingestPlaywrightFile(path, meta));
    } catch (e) {
      console.error(`  ! failed to read ${path}: ${(e as Error).message}`);
    }
  }
  return all;
}

function classifyAll(
  failures: FailureContext[],
  health: Record<string, HealthEntry> = {}
): Verdict[] {
  return failures.map(failure => {
    const ctx: ClassificationContext = { failure, allFailuresThisRun: failures, health };
    // Prefer the AX-tree on-page reason (e2e/visual). For API failures there is no
    // AX tree — surface the HTTP status instead so "Why" reads "HTTP 404 — endpoint
    // not found", never the useless "expect(received).toBe(expected)".
    const apiStatus = failure.suite === 'api' ? parseHttpStatus(failure.errorMessage) : null;
    const category = classify(ctx);
    return {
      failure,
      category,
      pageMessage:
        extractPageMessage(failure.errorContextPath) ??
        (apiStatus !== null ? httpStatusReason(apiStatus) : null),
    };
  });
}

// ── triage ────────────────────────────────────────────────────────────────────

async function cmdTriage(args: Args): Promise<number> {
  const reports = args._;
  if (!reports.length) { console.error('usage: verdict triage <report.json...> [--json out] [--strict] [--history f] [--no-history]'); return 2; }

  const meta = ciMeta(args.flags);
  const failures = ingestAll(reports, meta);

  // History-driven health: read PRIOR runs, score flakiness, classify with that, then
  // append THIS run. First run sees empty health (fine); later runs get real signal —
  // this is what turns the score-gated rules (REAL_REGRESSION, THRESHOLD_DRIFT, the
  // API rule) from always-0 blind into history-aware.
  const noHistory = args.flags['no-history'] === true;
  const historyFile = str(args.flags.history) ?? HISTORY_FILE;
  const health = noHistory ? {} : computeHealth(readHistory(historyFile));
  const verdicts = classifyAll(failures, health);
  if (!noHistory) appendRunSummary(toRunSummary(verdicts, meta), historyFile);

  const counts = summarize(verdicts);
  if (!verdicts.length) {
    console.log('✓ Verdict: no failures across reports.');
  } else {
    console.log('\n' + renderTable(verdicts) + '\n');
    console.log('Summary: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  }

  const out = str(args.flags.json);
  if (out) {
    writeFileSync(out, JSON.stringify(toReport(verdicts, new Date().toISOString()), null, 2));
    console.log(`\nWritten: ${out}`);
  }

  const html = str(args.flags.html);
  if (html) writeDashboard(verdicts, html);

  // The HTML dashboard only exists inside a downloadable artifact — nobody opens
  // that to check a run. When running in GitHub Actions, write the verdict straight
  // onto the run's summary page so it's visible the instant you open the run.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderJobSummary(verdicts, 'Verdict'));
  }

  // Non-blocking by default. --strict fails the step on a genuine regression.
  if (args.flags.strict && (counts.REAL_REGRESSION ?? 0) > 0) return 1;
  return 0;
}

// ── dashboard ─────────────────────────────────────────────────────────────────

async function cmdDashboard(args: Args): Promise<number> {
  const reportPath = args._[0];
  if (!reportPath) { console.error('usage: verdict dashboard <verdict-report.json> [--out dashboard.html]'); return 2; }

  let verdicts: Verdict[];
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { verdicts: Verdict[] };
    verdicts = report.verdicts ?? [];
  } catch (e) {
    console.error(`  ! failed to read ${reportPath}: ${(e as Error).message}`);
    return 1;
  }

  writeDashboard(verdicts, str(args.flags.out) ?? 'dashboard.html');
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'triage': return cmdTriage(args);
    case 'dashboard': return cmdDashboard(args);
    default:
      console.log('verdict — CI test-triage\n');
      console.log('  verdict triage    <report.json...>        ingest + classify (cheap, every run)');
      console.log('  verdict dashboard <verdict-report.json>   render the HTML dashboard');
      return cmd ? 2 : 0;
  }
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
