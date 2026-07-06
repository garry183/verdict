#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verdict CLI — two subcommands, matching the two CI jobs:
//
//   verdict triage <report.json...>   cheap, runs every CI run: ingest + classify.
//                                      Prints the verdict table, writes a JSON report.
//                                      Non-blocking by default (exit 0).
//
//   verdict heal   <report.json...>   out-of-band (nightly / scheduled / post-deploy):
//                                      for SELECTOR_BROKEN failures, discover on live
//                                      DOM, gate, and (with --apply) rewrite + re-run.
//                                      Drives a browser — never put this in a PR gate.
//
// Deliberately dependency-free arg parsing; no framework.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { ingestPlaywrightFile, type IngestMeta } from './ingest/playwright-json.js';
import { classify } from './core/rules.js';
import type { ClassificationContext, FailureContext, Verdict } from './core/types.js';
import { renderTable, summarize, toReport } from './report.js';
import { runHeal, type HealOutcome } from './heal/index.js';
import { extractPageMessage } from './heal/page-context.js';
import { renderDashboard } from './dashboard/render.js';
import type { HealRecord } from './heal/log.js';

/** Read a heals.ndjson log into records (missing file → []). */
function readHeals(path: string | undefined): HealRecord[] {
  const p = path ?? 'heals.ndjson';
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as HealRecord; } catch { return null; } })
    .filter((r): r is HealRecord => r !== null);
}

function writeDashboard(verdicts: Verdict[], heals: HealRecord[], out: string): void {
  const html = renderDashboard({ timestamp: new Date().toISOString(), verdicts, heals });
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

function classifyAll(failures: FailureContext[]): Verdict[] {
  return failures.map(failure => {
    const ctx: ClassificationContext = { failure, allFailuresThisRun: failures, health: {} };
    return {
      failure,
      category: classify(ctx),
      pageMessage: extractPageMessage(failure.errorContextPath),
    };
  });
}

// ── triage ────────────────────────────────────────────────────────────────────

async function cmdTriage(args: Args): Promise<number> {
  const reports = args._;
  if (!reports.length) { console.error('usage: verdict triage <report.json...> [--json out] [--strict]'); return 2; }

  const failures = ingestAll(reports, ciMeta(args.flags));
  const verdicts = classifyAll(failures);

  const counts = summarize(verdicts);
  if (!verdicts.length) {
    console.log('✓ Verdict: no failures across reports.');
  } else {
    console.log('\n' + renderTable(verdicts) + '\n');
    console.log('Summary: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  }

  // Emit artifacts even on a green run — the dashboard's self-heal success rate is
  // most meaningful precisely when the run is green (a healed locator stayed fixed).
  const out = str(args.flags.json);
  if (out) {
    writeFileSync(out, JSON.stringify(toReport(verdicts, new Date().toISOString()), null, 2));
    console.log(`\nWritten: ${out}`);
  }

  const html = str(args.flags.html);
  if (html) writeDashboard(verdicts, readHeals(str(args.flags.heals)), html);

  const broken = counts.SELECTOR_BROKEN ?? 0;
  if (broken) console.log(`\n${broken} SELECTOR_BROKEN — run \`verdict heal\` out-of-band to attempt fixes.`);

  // Non-blocking by default. --strict fails the step on a genuine regression.
  if (args.flags.strict && (counts.REAL_REGRESSION ?? 0) > 0) return 1;
  return 0;
}

// ── dashboard ─────────────────────────────────────────────────────────────────

async function cmdDashboard(args: Args): Promise<number> {
  const reportPath = args._[0];
  if (!reportPath) { console.error('usage: verdict dashboard <verdict-report.json> [--heals heals.ndjson] [--out dashboard.html]'); return 2; }

  let verdicts: Verdict[];
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { verdicts: Verdict[] };
    verdicts = report.verdicts ?? [];
  } catch (e) {
    console.error(`  ! failed to read ${reportPath}: ${(e as Error).message}`);
    return 1;
  }

  writeDashboard(verdicts, readHeals(str(args.flags.heals)), str(args.flags.out) ?? 'dashboard.html');
  return 0;
}

// ── heal ────────────────────────────────────────────────────────────────────

async function cmdHeal(args: Args): Promise<number> {
  const reports = args._;
  if (!reports.length) { console.error('usage: verdict heal <report.json...> [--base-url u] [--apply] [--gate n] [--project-dir d] [--log f]'); return 2; }

  const failures = ingestAll(reports, ciMeta(args.flags));
  const verdicts = classifyAll(failures);
  const broken = verdicts.filter(v => v.category === 'SELECTOR_BROKEN');

  if (!broken.length) { console.log('✓ No SELECTOR_BROKEN failures — nothing to heal.'); return 0; }
  console.log(`Attempting heal on ${broken.length} SELECTOR_BROKEN failure(s)...\n`);

  // Reuse one browser across all heals (cost — this is the whole point of out-of-band).
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();

  const apply = args.flags.apply === true || str(args.flags.apply) === 'true';
  const gate = str(args.flags.gate) ? Number(str(args.flags.gate)) : undefined;
  const projectDir = str(args.flags['project-dir']);
  const logFile = str(args.flags.log);

  const counts: Record<string, number> = {};
  try {
    for (const v of broken) {
      const outcome: HealOutcome = await runHeal(v.failure, v.category, {
        browser,
        baseUrl: str(args.flags['base-url']),
        gate,
        apply: apply ? (projectDir ? { projectDir } : true) : false,
        logFile: logFile ?? undefined,
      });
      counts[outcome.verdict] = (counts[outcome.verdict] ?? 0) + 1;
      const applied = outcome.apply?.applied ? ' [applied]' : '';
      console.log(`  ${outcome.verdict.padEnd(9)} ${v.failure.testName} [${v.failure.project}]${applied}`);
      if (outcome.newSelector) console.log(`            ${outcome.oldSelector} → ${outcome.newSelector} (${outcome.confidence.toFixed(2)})`);
    }
  } finally {
    await browser.close();
  }

  console.log('\nHeal summary: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'triage': return cmdTriage(args);
    case 'heal': return cmdHeal(args);
    case 'dashboard': return cmdDashboard(args);
    default:
      console.log('verdict — CI test-triage + self-heal\n');
      console.log('  verdict triage    <report.json...>        ingest + classify (cheap, every run)');
      console.log('  verdict heal      <report.json...>        discover + gate + apply (out-of-band)');
      console.log('  verdict dashboard <verdict-report.json>   render the HTML dashboard');
      return cmd ? 2 : 0;
  }
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
