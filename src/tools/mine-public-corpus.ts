#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Public-corpus rule-mining miner.
//
// NOT a training pipeline — Verdict's classifier stays deterministic (CLAUDE.md).
// This pulls real public Playwright JSON reports through the *unmodified* ingest +
// classify pipeline and buckets the results so a human can find real gaps to write
// new deterministic rules against — the same loop every shipped rule came from
// (see memory: classifier-http-status-clustering, classifier-security-suite-
// unknown-blindspot), just applied to public runs instead of one customer at a time.
//
// Usage: node --env-file=.env dist/tools/mine-public-corpus.js
//        [--repo-limit 50] [--runs-per-repo 10] [--run-cap 300] [--page 1]
//
// Run this in the FOREGROUND, in bounded batches (increment --page each call) —
// not backgrounded. A full pass takes longer than fits comfortably in one call, and
// background bash tasks in this environment do not reliably survive a session gap
// (verified live: killed mid-run twice across a multi-day idle). Output files are
// append-only across invocations, so batches accumulate into the same corpus.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchCode, searchRepositories, listFailedRuns, listArtifacts, downloadArtifactZip } from './github-api.js';
import { readZip } from './zip.js';
import { parsePlaywrightReport, type PwReport } from '../ingest/playwright-json.js';
import { classify } from '../core/rules.js';
import type { ClassificationContext, FailureContext, Verdict } from '../core/types.js';

const CORPUS_DIR = '.corpus';

interface Args {
  repoLimit: number; runsPerRepo: number; runCap: number; page: number; reposFile: string | null;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return {
    repoLimit: Number(flags['repo-limit'] ?? 50),
    runsPerRepo: Number(flags['runs-per-repo'] ?? 10),
    runCap: Number(flags['run-cap'] ?? 300),
    // Lets successive foreground batches reach a new slice of search results instead
    // of re-covering the same top-ranked repos — see findCandidateRepos.
    page: Number(flags.page ?? 1),
    // Bypasses GitHub search entirely — one owner/repo per line. Added after search
    // (content-search, workflow-search, and star-sorted topic-search) converged on
    // the same 2 productive repos out of 90 tried: algorithmic discovery hit its
    // ceiling, so a hand-curated list of repos known to run real Playwright E2E
    // suites is the next lever, not another query variant.
    reposFile: flags['repos-file'] ?? null,
  };
}

function loadReposFile(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

/**
 * Candidate repos, in priority order (highest-measured-yield tier filled first):
 *
 *   1. Config/workflow content-search queries — confirms actual Playwright JSON
 *      reporter usage or an `upload-artifact` step naming a report path. Measured
 *      yield: 2/80 repos converted across two real passes — low, but real.
 *   2. Repo-popularity queries (topic:playwright, sorted by stars) — TRIED AND
 *      REJECTED as the primary tier: tested head-to-head, 0/30 conversions. A repo
 *      tagged `topic:playwright` is usually a tool ABOUT browser automation
 *      (scrapers, automation frameworks) rather than a product that USES Playwright
 *      for its own E2E suite — the wrong proxy. Kept only as a last-resort filler in
 *      case content search runs dry before the limit is reached.
 */
async function findCandidateRepos(limit: number, page: number): Promise<string[]> {
  const codeQueries = [
    // Most precise: these target repos whose artifact is a literal .json results
    // file (what this miner needs), not the default HTML report bundle most
    // Playwright CI boilerplate produces — added after these three surfaced real
    // active products (baserow, streamlit, vercel/next.js, cloudflare/cloudflare-docs,
    // a UK government service) where the earlier queries mostly surfaced tutorials
    // and browser-automation tooling.
    'test-results.json upload-artifact path:.github/workflows',
    'results.json playwright path:.github/workflows',
    'outputFile playwright.config path:.github/workflows OR path:playwright.config.ts',
    'reporter json filename:playwright.config.ts',
    'reporter json filename:playwright.config.js',
    'upload-artifact playwright-report path:.github/workflows',
    'upload-artifact test-results path:.github/workflows',
    'upload-artifact playwright-report path:.github/workflows extension:yaml',
  ];
  const repoQueries = [
    'topic:playwright stars:>300',
    'topic:e2e-testing stars:>100',
    'topic:playwright-tests',
  ];

  // Run every query to completion first, THEN cap — a size-based early-break per
  // query let an abundant early query crowd out every later one before it ever ran.
  // Verified live: two consecutive "0 yield" batches turned out to never even query
  // `reporter json filename:playwright.config.ts` at all — the one query that found
  // both repos that have ever worked. Even without the early break, plain
  // `[...set].slice(0, limit)` would have the same problem (Set iteration order is
  // insertion order, so the first query's results still dominate the front) — round-
  // robin across queries so every source gets fair representation before the cutoff.
  const perQuery: string[][] = [];
  const seen = new Set<string>();
  for (const q of codeQueries) {
    const items = await searchCode(q, 100, page);
    perQuery.push(items.map(i => i.repository.full_name).filter(name => !seen.has(name) && (seen.add(name), true)));
  }
  for (const q of repoQueries) {
    const items = await searchRepositories(q, 100, page);
    perQuery.push(items.map(i => i.full_name).filter(name => !seen.has(name) && (seen.add(name), true)));
  }

  const interleaved: string[] = [];
  for (let i = 0; interleaved.length < limit && perQuery.some(list => i < list.length); i++) {
    for (const list of perQuery) if (i < list.length) interleaved.push(list[i]);
  }
  return interleaved.slice(0, limit);
}

function classifyRun(failures: FailureContext[]): Verdict[] {
  return failures.map(failure => {
    const ctx: ClassificationContext = { failure, allFailuresThisRun: failures, health: {} };
    return { failure, category: classify(ctx) };
  });
}

/**
 * Writes every zip entry to `destDir` (so a human can later pull screenshots /
 * error-context.md for a sampled case per Rule 0) and returns the parsed Playwright
 * JSON report, found by shape (`suites` array) rather than a fixed filename — repos
 * name it report.json/results.json/test-results.json inconsistently.
 */
function extractZipTo(zipBuf: Buffer, destDir: string): PwReport | null {
  const entries = readZip(zipBuf);
  let report: PwReport | null = null;
  for (const entry of entries) {
    const outPath = join(destDir, entry.name);
    mkdirSync(join(outPath, '..'), { recursive: true });
    writeFileSync(outPath, entry.data);
    if (!report && entry.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(entry.data.toString('utf8'));
        if (Array.isArray(parsed.suites)) report = parsed as PwReport;
      } catch { /* not JSON or not the report — keep scanning */ }
    }
  }
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(CORPUS_DIR, { recursive: true });
  // ndjson, appended as each run completes — not one JSON.stringify at the end. A
  // 300-run pass takes minutes against arbitrary public repos and WILL get
  // interrupted sometimes (verified live: a session boundary killed one mid-run) —
  // write-once-at-the-end meant the fully-detailed manifest was silently lost while
  // verdicts.ndjson/skipped.log (already append-as-you-go) survived intact.
  const manifestPath = join(CORPUS_DIR, 'manifest.ndjson');
  const verdictsPath = join(CORPUS_DIR, 'verdicts.ndjson');
  const skippedPath = join(CORPUS_DIR, 'skipped.log');
  // Init-if-missing, never truncate: this tool is meant to be run as several
  // foreground batches (--page 1, --page 2, ...) that accumulate into the same
  // corpus, not one long background run — see the class comment above on why.
  for (const p of [manifestPath, verdictsPath, skippedPath]) if (!existsSync(p)) writeFileSync(p, '');
  const skip = (reason: string) => appendFileSync(skippedPath, reason + '\n');

  // Append-only output across batches (see above) means nothing else stops a later
  // batch from re-mining a run an earlier one already recorded — HarborGuard and
  // NASA-AMMOS satisfy nearly every query variant, so they show up as "candidates"
  // in almost every batch. Verified live: 8 of 19 manifest entries were exact
  // repo+runId duplicates after one re-run. Load what's already mined and skip it
  // before spending an API call, not after.
  const alreadyMined = new Set(
    existsSync(manifestPath) && readFileSync(manifestPath, 'utf8').trim()
      ? readFileSync(manifestPath, 'utf8').trim().split('\n')
        .map(line => { const m = JSON.parse(line) as { repo: string; runId: number }; return `${m.repo}#${m.runId}`; })
      : []
  );

  let repos: string[];
  if (args.reposFile) {
    repos = loadReposFile(args.reposFile);
    console.log(`Loaded ${repos.length} hand-curated repos from ${args.reposFile}.`);
  } else {
    console.log(`Searching for candidate repos (cap ${args.repoLimit}, page ${args.page})...`);
    repos = await findCandidateRepos(args.repoLimit, args.page);
    console.log(`Found ${repos.length} candidate repos.`);
  }

  let minedRuns = 0;
  for (const fullName of repos) {
    if (minedRuns >= args.runCap) { skip(`run-cap reached, stopped before ${fullName}`); break; }
    const [owner, repo] = fullName.split('/');
    let runs;
    try {
      runs = await listFailedRuns(owner, repo, args.runsPerRepo);
    } catch (e) {
      skip(`${fullName}: failed to list runs — ${(e as Error).message}`);
      continue;
    }

    for (const run of runs) {
      if (minedRuns >= args.runCap) break;
      if (alreadyMined.has(`${fullName}#${run.id}`)) continue;

      let artifacts;
      try {
        artifacts = await listArtifacts(owner, repo, run.id);
      } catch (e) {
        skip(`${fullName}#${run.id}: failed to list artifacts — ${(e as Error).message}`);
        continue;
      }
      const candidate = artifacts.find(a => !a.expired && /report|result/i.test(a.name));
      if (!candidate) { skip(`${fullName}#${run.id}: no matching non-expired report artifact`); continue; }

      let zipBuf: Buffer;
      try {
        zipBuf = await downloadArtifactZip(candidate.archive_download_url);
      } catch (e) {
        skip(`${fullName}#${run.id}: artifact download failed — ${(e as Error).message}`);
        continue;
      }

      const destDir = join(CORPUS_DIR, fullName.replace('/', '-'), String(run.id));
      let report: PwReport | null;
      try {
        report = extractZipTo(zipBuf, destDir);
      } catch (e) {
        skip(`${fullName}#${run.id}: zip extraction failed — ${(e as Error).message}`);
        continue;
      }
      if (!report) { skip(`${fullName}#${run.id}: artifact had no Playwright JSON report`); continue; }

      const meta = { commit: run.head_sha, branch: run.head_branch, suite: null };
      const failures: FailureContext[] = parsePlaywrightReport(report, meta);
      if (!failures.length) { skip(`${fullName}#${run.id}: report had no unexpected/flaky tests`); continue; }

      const verdicts = classifyRun(failures);
      const categoryCounts: Record<string, number> = {};
      for (const v of verdicts) categoryCounts[v.category] = (categoryCounts[v.category] ?? 0) + 1;

      // Ground truth on whether this run's Playwright job had a REAL failure or only
      // flaky (retry-passed) ones — the run-level `conclusion: failure` filter is
      // coarse (it can reflect an unrelated job, e.g. a Docker build, in the same
      // workflow; verified on a real HarborGuard run: report stats showed
      // unexpected:0, flaky:2 despite the run being listed as failed). Surfacing the
      // report's own stats here beats trying to pre-filter it away — a human sampling
      // the corpus can see immediately whether a 100%-FLAKY run is real signal or this.
      const reportStats = (report as unknown as { stats?: Record<string, number> }).stats ?? null;

      appendFileSync(manifestPath, JSON.stringify({
        repo: fullName, runId: run.id, runUrl: run.html_url,
        commit: run.head_sha, branch: run.head_branch,
        failureCount: failures.length, categoryCounts, reportStats,
      }) + '\n');
      for (const v of verdicts) {
        appendFileSync(verdictsPath, JSON.stringify({
          repo: fullName, runId: run.id, runUrl: run.html_url,
          testName: v.failure.testName, project: v.failure.project, suite: v.failure.suite,
          category: v.category, errorMessage: v.failure.errorMessage,
        }) + '\n');
      }
      minedRuns++;
      console.log(`  [${minedRuns}/${args.runCap}] ${fullName}#${run.id} — ${failures.length} failures`);
    }
  }

  console.log(`\nDone. Mined ${minedRuns} runs. Manifest: ${manifestPath}, verdicts: ${verdictsPath}`);
  console.log(`Skipped entries logged to ${skippedPath}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
