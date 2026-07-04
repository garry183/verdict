// ─────────────────────────────────────────────────────────────────────────────
// Verdict core types.
//
// Ported and generalized from livguard-ecomm/brain/types.ts. The original
// `RuleContext` was coupled to Playwright's report shape and to visual-suite
// specifics. Here it is decoupled: `FailureContext` is the framework-agnostic
// bundle of everything known about ONE failing test — the input a classifier
// reads. `ClassificationContext` wraps it with run-level and historical signal.
//
// This is the "FailureContext shape" — nailed down because it is now worth
// building: it is the seam every ingester writes to and every rule reads from.
// ─────────────────────────────────────────────────────────────────────────────

export type FailureCategory =
  | 'FLAKY'
  | 'INFRA'
  | 'REAL_REGRESSION'
  | 'SELECTOR_BROKEN'
  | 'THRESHOLD_DRIFT'
  | 'UNKNOWN';

export type TestStatus = 'passed' | 'failed' | 'skipped';

/** Outcome of an attempted self-heal on a SELECTOR_BROKEN failure. */
export type HealVerdict =
  | 'HEALED'    // new locator found above confidence gate, applied
  | 'PROPOSED'  // candidate found but below gate — flagged for human, NOT applied
  | 'SKIPPED'   // no viable candidate, or category is not SELECTOR_BROKEN
  | 'NO_DOM';   // could not reach live DOM to attempt a heal

/**
 * FailureContext — everything known about a single failing test.
 * Every ingester (Playwright, Jest, JUnit, ...) normalizes into this shape.
 * Rules read only from here + ClassificationContext; nothing else.
 */
export interface FailureContext {
  // identity
  testName: string;          // full title, e.g. "Cart › empty cart shows empty state"
  project: string;           // runner project, e.g. "chromium" | "mobile-chrome"
  suite: string | null;      // logical suite: e2e | visual | api | security | ...
  file: string | null;       // spec file path

  // signal
  status: TestStatus;
  retryPassed: boolean;      // first attempt failed, a later attempt passed
  durationMs: number;
  errorMessage: string | null;
  errorStack: string | null;

  // artifacts — inspect BEFORE classifying. A 502 screenshot looks like
  // selector-rot in the error text but is infra. (livguard lesson.)
  screenshotPath: string | null;
  tracePath: string | null;

  // provenance
  startTime: string;         // ISO
  commit: string | null;
  branch: string | null;
}

/** Health record per (test, project) — persisted flakiness state. */
export interface HealthEntry {
  flakiness_score: number;
  runs_analyzed: number;
  consecutive_passes: number;
  status: 'healthy' | 'watch' | 'quarantined';
  last_category: FailureCategory | null;
  last_failure_timestamp: string | null;
}

/**
 * ClassificationContext — the full input to `classify()`.
 * Wraps a single FailureContext with the cross-run and historical signal that
 * rules like REAL_REGRESSION (2+ projects) and the score-gated rules need.
 */
export interface ClassificationContext {
  failure: FailureContext;
  allFailuresThisRun: FailureContext[];
  health: Record<string, HealthEntry>;
}

/** The verdict Verdict renders — classification + optional heal outcome. */
export interface Verdict {
  failure: FailureContext;
  category: FailureCategory;
  heal?: {
    verdict: HealVerdict;
    oldSelector: string | null;
    newSelector: string | null;
    confidence: number;      // 0..1 — must clear the gate to auto-apply
  };
}
