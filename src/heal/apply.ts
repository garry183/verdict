// ─────────────────────────────────────────────────────────────────────────────
// Apply a HEALED locator to the spec source — the last, riskiest step of the loop.
// A wrong apply ships a false green, so every apply is guarded by a re-run:
//
//   locate old selector in source (exact, quote/space-normalized)
//     → if not uniquely locatable → DO NOT apply (stays PROPOSED)
//   rewrite the call → re-run ONLY that test → confirm it RAN and PASSED
//     → confirmed green → keep the edit  (applied)
//     → not green / inconclusive / no report → REVERT, downgrade to PROPOSED
//
// Rules encoded here come from second-brain memory (used as hard rules):
//   • silent-noop-antipattern: a green test can pass for the wrong reason — require
//     the test to be PRESENT in the re-run report with a passed status, not merely
//     "absent from failures".
//   • json-reporter-silent-failure: reporters write nothing if global-setup dies —
//     a missing/empty re-run report is NOT a pass. Fail safe → revert.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, isAbsolute, basename } from 'node:path';
import type { FailureContext } from '../core/types.js';
import type { HealOutcome } from './index.js';

export interface ApplyOptions {
  projectDir?: string;                 // cwd of the target repo (default process.cwd())
  // Injectable re-run: given the failure, run just that test and return the path to
  // the JSON report it produced (or null if the run failed to produce one).
  runTest?: (failure: FailureContext, projectDir: string) => string | null;
  dryRun?: boolean;                    // locate + would-apply, but never write/re-run
}

export interface ApplyResult {
  applied: boolean;
  reRunGreen: boolean | null;          // null = inconclusive (no usable report)
  reason: string;
  file: string | null;
}

const norm = (s: string) => s.replace(/\s+/g, '').replace(/"/g, "'");
const leafTitle = (testName: string) => testName.split(' › ').pop() ?? testName;

/** The method name a selector call uses, e.g. getByRole / getByTestId / locator. */
function methodOf(selector: string): string | null {
  const m = selector.match(/(getBy[A-Za-z]+|locator)\s*\(/);
  return m ? m[1] : null;
}

/**
 * Find every balanced `method(...)` call in source. Returns [start,end) ranges and
 * the exact call text, so we replace a full expression — never a truncated string.
 */
function findCalls(source: string, method: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = new RegExp(`\\b${method}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index;
    let depth = 0, i = m.index + m[0].length - 1; // at the '('
    let inStr: string | null = null;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
      } else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    out.push({ start, end: i, text: source.slice(start, i) });
  }
  return out;
}

/**
 * Locate the unique source call matching the broken selector.
 * Matches on normalized text (quote-style / whitespace insensitive) so the error's
 * echoed form lines up with the source's form. Returns null unless exactly one
 * candidate matches — ambiguity means we refuse to apply (never guess).
 */
function locateOldSelector(
  source: string,
  oldSelector: string
): { start: number; end: number } | null {
  const method = methodOf(oldSelector);
  if (!method) return null;
  const target = norm(oldSelector);
  const calls = findCalls(source, method);
  const hits = calls.filter(c => {
    const n = norm(c.text);
    return n === target || n.startsWith(target) || target.startsWith(n);
  });
  return hits.length === 1 ? { start: hits[0].start, end: hits[0].end } : null;
}

/** Confirm the test is PRESENT in a re-run report AND passed. Absence ≠ pass. */
function confirmPassed(reportPath: string, testName: string, project: string): boolean {
  if (!existsSync(reportPath)) return false; // json-reporter-silent-failure rule
  let report: any;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return false; }
  const leaf = leafTitle(testName);
  let ran = false, passed = false;
  const walk = (suites: any[] = []) => {
    for (const s of suites) {
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests ?? []) {
          if (spec.title === leaf && (t.projectName ?? 'default') === project) {
            ran = true;
            if (t.status === 'expected' || t.status === 'flaky') passed = true;
          }
        }
      }
      walk(s.suites);
    }
  };
  walk(report.suites);
  return ran && passed; // must have actually run and passed
}

/** Default re-run: `npx playwright test <file> -g "<leaf>"`, JSON report to a temp file. */
function defaultRunTest(failure: FailureContext, projectDir: string): string | null {
  if (!failure.file) return null;
  const reportPath = join(projectDir, '.verdict-rerun.json');
  try { if (existsSync(reportPath)) writeFileSync(reportPath, ''); } catch { /* ignore */ }
  const leaf = leafTitle(failure.testName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Playwright treats the positional arg as a REGEX over test-file paths — an absolute
  // Windows path (\, :) never matches. Filter by the regex-escaped basename instead.
  const fileArg = basename(failure.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = spawnSync(
    'npx',
    ['playwright', 'test', fileArg, '-g', leaf, '--reporter=json', '--retries=0'],
    {
      cwd: projectDir,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      encoding: 'utf8',
      shell: process.platform === 'win32', // npx needs shell on Windows
    }
  );
  // Whatever the exit code, success is decided by confirmPassed on the report — not
  // the exit code (a run can exit 1 yet the target test passed, or exit 0 with no report).
  return res.error ? null : reportPath;
}

/**
 * Apply a HEALED outcome to source, guarded by a re-run. Only call for verdict
 * HEALED with a newSelector. Returns whether the edit was kept.
 */
export function applyHeal(
  failure: FailureContext,
  outcome: HealOutcome,
  opts: ApplyOptions = {}
): ApplyResult {
  const projectDir = opts.projectDir ?? process.cwd();
  if (outcome.verdict !== 'HEALED' || !outcome.newSelector || !outcome.oldSelector) {
    return { applied: false, reRunGreen: null, reason: 'not a HEALED outcome', file: null };
  }
  if (!failure.file) {
    return { applied: false, reRunGreen: null, reason: 'no spec file on failure', file: null };
  }

  // file may be absolute (resolved against the report's rootDir at ingest) or relative.
  const filePath = isAbsolute(failure.file) ? failure.file : join(projectDir, failure.file);
  if (!existsSync(filePath)) {
    return { applied: false, reRunGreen: null, reason: `spec not found: ${failure.file}`, file: failure.file };
  }

  const original = readFileSync(filePath, 'utf8');
  const loc = locateOldSelector(original, outcome.oldSelector);
  if (!loc) {
    // Can't uniquely locate the old selector in source → refuse to apply.
    return { applied: false, reRunGreen: null, reason: 'old selector not uniquely locatable in source', file: failure.file };
  }

  const patched = original.slice(0, loc.start) + outcome.newSelector + original.slice(loc.end);
  if (opts.dryRun) {
    return { applied: false, reRunGreen: null, reason: 'dryRun: located, not written', file: failure.file };
  }

  writeFileSync(filePath, patched, 'utf8');

  // Re-run just this test and confirm it actually ran AND passed.
  const runTest = opts.runTest ?? defaultRunTest;
  const reportPath = runTest(failure, projectDir);
  const green = reportPath ? confirmPassed(reportPath, failure.testName, failure.project) : false;

  if (green) {
    return { applied: true, reRunGreen: true, reason: 'heal verified: test ran and passed', file: failure.file };
  }

  // Not green (or inconclusive / no report) → revert. Fail safe.
  writeFileSync(filePath, original, 'utf8');
  return {
    applied: false,
    reRunGreen: reportPath ? false : null,
    reason: reportPath
      ? 're-run did not pass — reverted, downgraded to PROPOSED'
      : 'no re-run report (run may have died in setup) — reverted, downgraded to PROPOSED',
    file: failure.file,
  };
}

export { locateOldSelector as _locateOldSelector, findCalls as _findCalls };
