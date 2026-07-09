// ─────────────────────────────────────────────────────────────────────────────
// Deterministic 6-rule failure classifier.
// Ported from livguard-ecomm/brain/rules.ts, retargeted onto ClassificationContext.
//
// First non-null rule wins. Order matters: FLAKY before everything (a retry-pass
// is the strongest signal), REAL_REGRESSION before SELECTOR_BROKEN (a genuine
// cross-project break must not be silently "healed" as a locator drift).
// ─────────────────────────────────────────────────────────────────────────────

import { ClassificationContext, FailureCategory } from './types.js';

export function toHealthKey(testName: string, project: string): string {
  return `${testName}-${project}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Rule 1 — FLAKY (highest priority): failed then passed on retry.
function ruleFlaky({ failure }: ClassificationContext): FailureCategory | null {
  return failure.retryPassed ? 'FLAKY' : null;
}

// Rule 2 — INFRA: genuine environment/network failure, not app.
//
// IMPORTANT: match ONLY true infra signals (network, DNS, 5xx, navigation). Do NOT
// match a bare "Timeout ... exceeded" — that is a locator waitFor/click/expect
// timeout, which is the PRIMARY symptom of selector-rot and real regressions. The
// original rule matched bare /Timeout/ and swept every failure in a run with 3+
// timeouts into INFRA, masking real cross-project breaks as "just the environment".
// (Found running against livguard: 6 cross-project locator failures mislabeled INFRA.)
const INFRA_SIGNALS =
  /net::|ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|\b50[234]\b|page\.goto\b[\s\S]*?Timeout|navigation timeout/i;

function ruleInfra({ failure, allFailuresThisRun }: ClassificationContext): FailureCategory | null {
  const isInfra = (e: typeof failure) =>
    e.status === 'failed' && INFRA_SIGNALS.test(e.errorMessage ?? '');
  // Env-wide meltdown: 3+ genuine infra errors → distrust the whole run.
  if (allFailuresThisRun.filter(isInfra).length >= 3) return 'INFRA';
  // Otherwise a failure is INFRA only if it is ITSELF an infra error.
  return isInfra(failure) ? 'INFRA' : null;
}

// Rule 3 — REAL_REGRESSION: same test fails hard in 2+ projects, low flakiness history.
function ruleRealRegression(ctx: ClassificationContext): FailureCategory | null {
  const { failure, allFailuresThisRun, health } = ctx;
  const failingProjects = allFailuresThisRun.filter(
    e => e.testName === failure.testName && e.status === 'failed' && !e.retryPassed
  );
  const crossProject = failingProjects.length >= 2;
  const score = health[toHealthKey(failure.testName, failure.project)]?.flakiness_score ?? 0;
  return crossProject && !failure.retryPassed && score < 0.3 ? 'REAL_REGRESSION' : null;
}

// Rule 3b — API assertion failure: a plain value assertion broke in an API suite.
//
// API tests assert on response bodies/status codes, not locators. Playwright's
// expect() falls back to the generic "expect(received).toBe(expected)" template
// when the matcher isn't a web-first locator assertion — that literal is the
// tell, regardless of which matcher (toBe/toEqual/toContain/...) was used.
//
// ruleRealRegression's cross-project signal can't apply here: API suites run in
// a single project by design (no browser/device matrix), so there is never a
// second project to corroborate against. A low-flakiness, non-retry-passed API
// assertion break is the same "trust it" signal in single-project form.
//
// But NOT every such break is a code regression — the HTTP status the assertion
// compared against says which kind it is, and the error text already carries it
// (Playwright prints "Expected: 200 / Received: 404"). Reading it lets us split:
//   • 401/403 → AUTH (auth rejected — never a per-endpoint code regression)
//   • 5xx     → INFRA (server error that slipped past the raw-text INFRA rule)
//   • 404/405/410/501 → if ≥3 API tests this run hit a not-found status, it's a
//     base-URL / prefix / deploy problem = ONE cause (MISSING_ROUTE), not N
//     regressions. A lone not-found stays REAL_REGRESSION (an endpoint a code
//     change removed). This is the single-suite form of "N identical failures
//     share one cause" — the blind spot cross-project REAL_REGRESSION can't see.
//   • otherwise (200 + wrong body, 400/422, non-HTTP value) → REAL_REGRESSION
const API_ASSERTION_SIGNAL = /expect\(received\)\.\w+\(expected\)/;
const NOT_FOUND_STATUSES = new Set([404, 405, 410, 501]);
const AUTH_STATUSES = new Set([401, 403]);

/**
 * The RECEIVED HTTP status an API assertion compared against, from Playwright's
 * "Received: 404" diff line (status printed alone on its own line). Returns the
 * server's actual status — the diagnostic signal — or null when the assertion
 * wasn't comparing a bare status code.
 */
export function parseHttpStatus(errorMessage: string | null): number | null {
  if (!errorMessage) return null;
  const m = errorMessage.match(/^\s*Received:\s*"?(\d{3})"?\s*$/m);
  const n = m ? Number(m[1]) : NaN;
  return n >= 100 && n < 600 ? n : null;
}

/** Human one-liner for an HTTP status — the "Why" for an API failure. */
export function httpStatusReason(status: number): string {
  if (NOT_FOUND_STATUSES.has(status)) return `HTTP ${status} — endpoint not found`;
  if (AUTH_STATUSES.has(status)) return `HTTP ${status} — auth rejected`;
  if (status >= 500) return `HTTP ${status} — server error`;
  return `HTTP ${status} — unexpected status`;
}

function ruleApiAssertionFailure(
  { failure, allFailuresThisRun, health }: ClassificationContext
): FailureCategory | null {
  if (failure.suite !== 'api' || failure.retryPassed) return null;
  if (!API_ASSERTION_SIGNAL.test(failure.errorMessage ?? '')) return null;
  const score = health[toHealthKey(failure.testName, failure.project)]?.flakiness_score ?? 0;
  if (score >= 0.3) return null; // flaky history — don't trust as a hard signal

  const status = parseHttpStatus(failure.errorMessage);
  if (status !== null) {
    if (AUTH_STATUSES.has(status)) return 'AUTH';
    if (status >= 500) return 'INFRA';
    if (NOT_FOUND_STATUSES.has(status)) {
      const notFound = (e: typeof failure) => {
        const s = parseHttpStatus(e.errorMessage);
        return s !== null && NOT_FOUND_STATUSES.has(s);
      };
      const cluster = allFailuresThisRun.filter(
        e => e.suite === 'api' && e.status === 'failed' && !e.retryPassed && notFound(e)
      ).length;
      return cluster >= 3 ? 'MISSING_ROUTE' : 'REAL_REGRESSION';
    }
  }
  return 'REAL_REGRESSION';
}

// Rule 4 — SELECTOR_BROKEN: the heal-loop's trigger. Locator no longer resolves.
function ruleSelectorBroken({ failure }: ClassificationContext): FailureCategory | null {
  const patterns =
    /locator\.waitFor|resolved to 0 elements|locator returned 0 elements|element\(s\) not found|strict mode violation|Target closed|Unable to find/i;
  return failure.errorMessage && patterns.test(failure.errorMessage) ? 'SELECTOR_BROKEN' : null;
}

// Rule 5 — THRESHOLD_DRIFT: visual/pixel comparison breach, low flakiness history.
function ruleThresholdDrift({ failure, health }: ClassificationContext): FailureCategory | null {
  const isVisualFail = /toHaveScreenshot|Screenshot comparison failed|pixels \(ratio/i.test(
    failure.errorMessage ?? ''
  );
  const score = health[toHealthKey(failure.testName, failure.project)]?.flakiness_score ?? 0;
  return isVisualFail && !failure.retryPassed && score < 0.3 ? 'THRESHOLD_DRIFT' : null;
}

/** Orchestrator — first non-null wins. */
export function classify(ctx: ClassificationContext): FailureCategory {
  return (
    ruleFlaky(ctx) ??
    ruleInfra(ctx) ??
    ruleRealRegression(ctx) ??
    ruleApiAssertionFailure(ctx) ??
    ruleSelectorBroken(ctx) ??
    ruleThresholdDrift(ctx) ??
    'UNKNOWN'
  );
}
