// ─────────────────────────────────────────────────────────────────────────────
// Durable run history — the source of truth, committed to the repo.
//
// Every triage run appends ONE line of NDJSON to .verdict/history/runs.ndjson. This
// is what makes flake scoring durable and independent of CI artifact retention: a
// checkout brings the history back in git, and health is recomputed from it locally
// at job start. (Architecture §5: files are the record; any SQLite index is a
// rebuildable lens added later, never the record.)
//
// Honesty note on flake scoring: the ingester emits FAILURES only — passing tests
// are dropped upstream. So health is derived from failure history, not a full
// pass/fail roster. flakiness_score is therefore a conservative proxy: the share of
// a test's failing appearances that were retry-passes (Playwright `flaky` — an
// attempt failed then a later one passed). That is the strongest deterministic flaky
// signal we actually capture. It feeds the rules' `score < 0.3` guards: a test with
// flaky history stops being trusted as a hard REAL_REGRESSION — the safe direction.
// A true pass/fail ratio would need recording the passing roster (future work).
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureCategory, HealthEntry } from '../core/types.js';
import { toHealthKey } from '../core/rules.js';

export const HISTORY_DIR = '.verdict/history';
export const HISTORY_FILE = '.verdict/history/runs.ndjson';

/** How many recent runs feed a flake score. A window, not all-time. */
export const HEALTH_WINDOW = 30;

/** One failing test as recorded in a run summary (the slice health needs). */
export interface TestOutcome {
  testName: string;
  project: string;
  retryPassed: boolean;
  category: FailureCategory;
}

/** One line of history: everything about one run's failures. */
export interface RunSummary {
  timestamp: string;
  commit: string | null;
  branch: string | null;
  suite: string | null;
  total: number;             // failing tests this run
  outcomes: TestOutcome[];
}

/** Append one run summary as a line of NDJSON, creating the history dir if needed. */
export function appendRunSummary(summary: RunSummary, file: string = HISTORY_FILE): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(summary) + '\n', 'utf8');
}

/** Read all run summaries (oldest→newest as written). Missing file → []. */
export function readHistory(file: string = HISTORY_FILE): RunSummary[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as RunSummary; } catch { return null; } })
    .filter((r): r is RunSummary => r !== null);
}

/**
 * Compute per-(test,project) health from the last HEALTH_WINDOW runs.
 * Pure — caller supplies the history (prior runs, excluding the run being classified).
 */
export function computeHealth(
  history: RunSummary[],
  window: number = HEALTH_WINDOW
): Record<string, HealthEntry> {
  const runs = history.slice(-window);
  const health: Record<string, HealthEntry> = {};

  // Group a test's appearances (most-recent last) across the window.
  interface Appearance { runIndex: number; retryPassed: boolean; category: FailureCategory; timestamp: string; }
  const byKey = new Map<string, Appearance[]>();
  runs.forEach((run, runIndex) => {
    for (const o of run.outcomes) {
      const key = toHealthKey(o.testName, o.project);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({ runIndex, retryPassed: o.retryPassed, category: o.category, timestamp: run.timestamp });
    }
  });

  for (const [key, apps] of byKey) {
    const appearances = apps.length;
    const flaky = apps.filter(a => a.retryPassed).length;
    const score = appearances ? flaky / appearances : 0;
    const last = apps[apps.length - 1];
    // Proxy for "cooling off": runs since this test last appeared as a failure.
    const consecutivePasses = runs.length - 1 - last.runIndex;
    health[key] = {
      flakiness_score: score,
      runs_analyzed: appearances,
      consecutive_passes: consecutivePasses,
      status: score >= 0.5 ? 'quarantined' : score >= 0.3 ? 'watch' : 'healthy',
      last_category: last.category,
      last_failure_timestamp: last.timestamp,
    };
  }

  return health;
}
