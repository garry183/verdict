// ─────────────────────────────────────────────────────────────────────────────
// Playwright JSON report → FailureContext[].
//
// Ported from livguard-ecomm/scripts/ci-triage.js (`parsePlaywright` + `walkSuites`),
// with three deliberate corrections the origin parser gets wrong for Verdict:
//
//   1. ARTIFACTS. The origin drops `result.attachments`. Verdict extracts the
//      screenshot + trace paths — they are the heal loop's primary input, not just
//      display. The trace.zip carries the DOM snapshot at failure time: the exact
//      DOM the broken locator saw. The heal explorer reads that, then verifies its
//      candidate against live DOM before the confidence gate.
//   2. FLAKY SIGNAL. The origin sets `retried = retry > 0`, which is NOT flakiness
//      (a test can retry and still fail). The correct signal is Playwright's
//      test-level `status === 'flaky'` — an attempt failed, a later one passed —
//      which is exactly what `ruleFlaky` reads via `retryPassed`.
//   3. PROJECT. The origin drops `projectName`, but `ruleRealRegression` counts
//      failures across projects. We capture it.
//
// Self-contained: we type only the slice of the report we read, so Verdict does not
// depend on @playwright/test to parse an artifact it did not produce.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FailureContext, TestStatus } from '../core/types.js';

// ── Minimal Playwright JSON report shape (the slice we read) ──────────────────
// Mirrors @playwright/test's testReporter.d.ts (JSONReport*). Fields we ignore
// are omitted; unknown extra fields are tolerated.

interface PwLocation {
  file: string;
  line: number;
  column: number;
}

interface PwError {
  message?: string;
  stack?: string;
  location?: PwLocation;
}

interface PwAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

/** A single attempt of a test. One per retry. */
interface PwResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  retry: number;
  startTime: string;
  error?: PwError;
  errors?: PwError[];
  attachments?: PwAttachment[];
}

/** One (spec × project) — carries all attempts in `results`. */
interface PwTest {
  projectName?: string;
  results: PwResult[];
  // 'flaky' = an attempt failed then a later attempt passed — the true flaky signal.
  status: 'skipped' | 'expected' | 'unexpected' | 'flaky';
}

interface PwSpec {
  title: string;
  ok: boolean;
  tests: PwTest[];
  file?: string;
  line?: number;
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

export interface PwReport {
  suites?: PwSuite[];
  // Playwright reports spec `file` relative to config.rootDir (often the testDir, not
  // the repo root). We resolve against it so heal/apply can find the source on disk.
  config?: { rootDir?: string };
}

// ── Run-level provenance the JSON report does not carry ───────────────────────
// commit/branch come from CI env; `suite` is the logical bucket (e2e|visual|api)
// the origin tracked per result-file key. Callers supply these.

export interface IngestMeta {
  suite?: string | null;
  commit?: string | null;
  branch?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Playwright colorizes error messages; strip ANSI so rules match on clean text.
// Built via fromCharCode(27) (ESC) to avoid a raw control byte in source.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const clean = (s: string | undefined): string | null =>
  s ? s.replace(ANSI, '').trim() || null : null;

/** Pick a screenshot attachment path — prefer the failure screenshot over diffs. */
function findScreenshot(atts: PwAttachment[]): string | null {
  const images = atts.filter(a => a.path && a.contentType.startsWith('image/'));
  if (!images.length) return null;
  // Default failure attachment is named 'screenshot'; visual diffs add -actual/-diff.
  const primary = images.find(a => a.name === 'screenshot')
    ?? images.find(a => !/-(diff|expected|previous)$/.test(a.name));
  return (primary ?? images[0]).path ?? null;
}

/** Pick the trace.zip path — named 'trace' with a zip content type. */
function findTrace(atts: PwAttachment[]): string | null {
  const trace = atts.find(
    a => a.path && (a.name === 'trace' || a.contentType === 'application/zip')
  );
  return trace?.path ?? null;
}

/** Pick the error-context.md path — Playwright's AX-tree dump at failure time. */
function findErrorContext(atts: PwAttachment[]): string | null {
  const ctx = atts.find(a => a.path && a.name === 'error-context');
  return ctx?.path ?? null;
}

/** Map a Playwright result status to Verdict's coarse TestStatus. */
function toTestStatus(s: PwResult['status']): TestStatus {
  if (s === 'passed') return 'passed';
  if (s === 'skipped') return 'skipped';
  return 'failed'; // failed | timedOut | interrupted
}

// ── Core parser (pure — testable without the filesystem) ──────────────────────

/**
 * Flatten a parsed Playwright JSON report into FailureContext[].
 * Emits one entry per (test × project) that is `unexpected` (failed) or `flaky`.
 * Passing/skipped tests are not failures and are dropped.
 */
export function parsePlaywrightReport(
  report: PwReport,
  meta: IngestMeta = {}
): FailureContext[] {
  const out: FailureContext[] = [];
  const { suite = null, commit = null, branch = null } = meta;
  const rootDir = report.config?.rootDir ?? null;
  // Resolve a report-relative spec path to an absolute one so downstream heal/apply
  // can locate it. Left null when there is no file. Absolute paths pass through.
  const resolveFile = (f: string | null | undefined): string | null =>
    f ? (rootDir ? resolve(rootDir, f) : f) : null;

  function walk(suites: PwSuite[] | undefined, titlePath: string[]): void {
    for (const s of suites ?? []) {
      const nextPath = s.title ? [...titlePath, s.title] : titlePath;
      for (const spec of s.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (test.status !== 'unexpected' && test.status !== 'flaky') continue;

          const results = [...test.results].sort((a, b) => a.retry - b.retry);
          const final = results[results.length - 1];
          if (!final) continue;

          // The failing attempt carries the error + artifacts. For a flaky test
          // the final attempt passed, so we reach back to the last failed one.
          const failed = [...results].reverse().find(r => toTestStatus(r.status) === 'failed');
          const evidence = failed ?? final;
          const atts = evidence.attachments ?? [];

          out.push({
            testName: [...nextPath, spec.title].join(' › '),
            project: test.projectName ?? 'default',
            suite,
            file: resolveFile(spec.file ?? s.file),
            status: toTestStatus(final.status),
            // The single most important corrected signal for ruleFlaky:
            retryPassed: test.status === 'flaky',
            durationMs: evidence.duration ?? 0,
            errorMessage: clean(evidence.error?.message),
            errorStack: clean(evidence.error?.stack),
            screenshotPath: findScreenshot(atts),
            tracePath: findTrace(atts),
            errorContextPath: findErrorContext(atts),
            startTime: evidence.startTime ?? '',
            commit,
            branch,
          });
        }
      }
      walk(s.suites, nextPath);
    }
  }

  walk(report.suites, []);
  return out;
}

// ── File loader ─────────────────────────────────────────────────────────────

/** Read a Playwright JSON report from disk and normalize it. */
export function ingestPlaywrightFile(
  filePath: string,
  meta: IngestMeta = {}
): FailureContext[] {
  const raw = readFileSync(filePath, 'utf8');
  const json = JSON.parse(raw) as PwReport;
  return parsePlaywrightReport(json, meta);
}
