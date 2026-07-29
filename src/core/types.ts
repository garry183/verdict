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
  | 'INFRA'          // the SYSTEM UNDER TEST broke: 5xx / network / nav timeout on load
  | 'ENVIRONMENT'    // the TEST HARNESS's preconditions weren't provisioned: missing
                     // secrets/env vars, missing/expired auth state, a failed setup
                     // project. Blocking, but a CI/config problem — not a code bug.
  | 'AUTH'           // API returned 401/403 — auth rejected, not a code regression
  | 'MISSING_ROUTE'  // API returned 404/405/410 across many tests — base-URL/prefix/deploy, one cause
  | 'SECURITY_FINDING' // the security suite's own probe/assertion caught a real vulnerability
                     // signature (missing cookie flag, secret in localStorage, BOLA, 5xx on a
                     // hostile payload, ...). Always a genuine defect for a dev/security owner —
                     // never healable, and never INFRA: the suite's whole point is to make the
                     // app misbehave, so its own 5xx is the finding, not a symptom to write off.
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
  // Playwright's AX-tree dump of the page at failure time. Often carries the real
  // on-screen reason (a validation banner, "not registered", etc.) that the bare
  // exception text never does — see extractPageMessage.
  errorContextPath: string | null;

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

/**
 * Offline heal-candidate probe — mined from the error-context AX snapshot (no browser),
 * so it can run in triage on every CI run. Confirms whether the broken locator's
 * intended text is still on the page, and lists the same-role elements the page DOES
 * have now as a shortlist. Anchors are volatile-value-free (no prices/quantities).
 * Produced by heal/ax-context.mineAxCandidates; attached to SELECTOR_BROKEN verdicts.
 */
export interface AxProbe {
  intendedRole: string | null;
  intendedText: string | null;
  oldPresent: boolean;     // is the intended text still present in the snapshot?
  candidates: string[];    // ranked suggested locators (verify before trusting)
  present: string[];       // same-role stable anchors the page now has
}

/** The verdict Verdict renders — classification + optional heal outcome. */
export interface Verdict {
  failure: FailureContext;
  category: FailureCategory;
  // The real on-page reason, when one was found in the failure's AX-tree dump —
  // independent of category. A SELECTOR_BROKEN verdict caused by "mobile number
  // not registered" is still SELECTOR_BROKEN, but the user should see WHY.
  pageMessage?: string | null;
  // Offline heal-candidate shortlist mined from the AX snapshot (SELECTOR_BROKEN only).
  axProbe?: AxProbe | null;
  heal?: {
    verdict: HealVerdict;
    oldSelector: string | null;
    newSelector: string | null;
    confidence: number;      // 0..1 — must clear the gate to auto-apply
  };
}
