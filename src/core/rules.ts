// ─────────────────────────────────────────────────────────────────────────────
// Deterministic 7-rule failure classifier.
// Ported from livguard-ecomm/brain/rules.ts, retargeted onto ClassificationContext.
//
// First non-null rule wins. Order matters: FLAKY before everything (a retry-pass
// is the strongest signal).
//
// REAL_REGRESSION vs SELECTOR_BROKEN — the correction:
// The original ordering ran REAL_REGRESSION first so a "genuine cross-project break"
// couldn't be silently healed as drift. That logic is BACKWARDS for a locator that
// resolved to nothing: a renamed/moved element fails on EVERY browser, so cross-project
// is not evidence of a real regression — it's the normal signature of drift. Counting
// projects cannot tell the two apart. So a locator-not-found failure now short-circuits
// to SELECTOR_BROKEN even when cross-project (see LOCATOR_NOT_FOUND). Nothing is
// "silently healed" by that label: the live-DOM explorer + confidence gate + verified
// re-run are the arbiter — no confident candidate → PROPOSED, never an auto-heal. If a
// real code change removed the element for good, the explorer finds no candidate and a
// human sees it. (Fix for: a renamed payment option reported as REAL_REGRESSION.)
// ─────────────────────────────────────────────────────────────────────────────

import { ClassificationContext, FailureCategory } from './types.js';

// The fingerprint of a locator that resolved to nothing — selector drift. Shared by
// ruleSelectorBroken (which routes it to heal) and ruleRealRegression (which must NOT
// claim it via the cross-project count). Covers the raw locator errors AND a web-first
// assertion (toBeVisible/toBeHidden/…) whose element wasn't found — Playwright prints
// "Received: <element(s) not found>" for that, which matches here.
const LOCATOR_NOT_FOUND =
  /resolved to 0 elements|locator returned 0 elements|element\(s\) not found|\bUnable to find\b|locator\.waitFor/i;

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

// Rule 2b — ENVIRONMENT: the test harness's preconditions weren't provisioned.
//
// Distinct from INFRA (which is the system-under-test failing: 5xx/network). This is
// the TEST's own setup failing to run: a Playwright setup-project / *.setup.ts that
// failed, or an error saying a required secret / env var / auth-state file is missing
// or expired. It's BLOCKING (nothing downstream can run) but it's a CI/config problem,
// not a code regression or locator drift — so it must never read as REAL_REGRESSION,
// and it is not healable. Ordered after INFRA so a genuine 5xx during setup stays INFRA.
//
// The "missing" text signal is scoped tightly (env/secret/auth-state phrasing) so it
// can't steal a "element missing" SELECTOR_BROKEN.
const SETUP_FILE = /\.setup\.[jt]s(\b|$)/i;
const CONFIG_SIGNAL =
  /\bnot set\b|is not defined|\bENOENT\b|(?:env|environment)\s*variable|process\.env|\.env\b|storageState|global-?setup|auth\/[\w.-]+\.json/i;

function ruleEnvironment({ failure }: ClassificationContext): FailureCategory | null {
  if (failure.status !== 'failed') return null;
  const isSetupUnit = failure.project === 'setup' || SETUP_FILE.test(failure.file ?? '');
  const configText = CONFIG_SIGNAL.test(failure.errorMessage ?? '');
  return isSetupUnit || configText ? 'ENVIRONMENT' : null;
}

// Rule 3 — REAL_REGRESSION: same test fails hard in 2+ projects, low flakiness history.
function ruleRealRegression(ctx: ClassificationContext): FailureCategory | null {
  const { failure, allFailuresThisRun, health } = ctx;
  // A locator that resolved to nothing is drift, and drift is ALWAYS cross-project —
  // so the cross-project count here is meaningless for it. Defer to SELECTOR_BROKEN,
  // where the live DOM decides drift-vs-real (no candidate → PROPOSED, never healed).
  if (LOCATOR_NOT_FOUND.test(failure.errorMessage ?? '')) return null;
  const failingProjects = allFailuresThisRun.filter(
    e => e.testName === failure.testName && e.status === 'failed' && !e.retryPassed
  );
  const crossProject = failingProjects.length >= 2;
  // Flakiness is a property of the TEST, not one project. Take the worst flake score
  // across the failing projects so the cross-project verdict is consistent (every
  // project of this test judges by the same signal) and conservative — if the test
  // is known flaky on ANY project, don't trust this run as a hard regression.
  const score = Math.max(
    0,
    ...failingProjects.map(e => health[toHealthKey(e.testName, e.project)]?.flakiness_score ?? 0)
  );
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

// Rule 3c — SECURITY_FINDING: the security suite's own assertion caught a vulnerability.
//
// Shares the same Playwright expect() diff shape as an API assertion (bare
// toBe/toHaveLength/toBeLessThan/... failures), but the suite gate on
// ruleApiAssertionFailure ('api' only) let every security-suite failure fall through
// to UNKNOWN — verified against a real LockTheDeal nightly run where all 19 security
// failures (BOLA, missing cookie Secure flag, secrets in localStorage, 5xx on
// injection/forged-header probes) landed UNKNOWN despite matching this exact shape.
//
// Deliberately does NOT reuse ruleApiAssertionFailure's status routing: a 500 there
// means "the API suite couldn't verify business logic, blame the server" (INFRA). In
// the security suite a 500 on a hostile payload (SQLi/NoSQLi probe, forged
// X-Forwarded-Proto) is usually the app crashing instead of rejecting the input
// safely — that IS the finding, not infra noise to file away. So every matching
// security-suite assertion failure is SECURITY_FINDING, full stop — a human with
// security context confirms or dismisses it, it never gets silently swept into INFRA.
function ruleSecurityFinding({ failure }: ClassificationContext): FailureCategory | null {
  if (failure.suite !== 'security' || failure.retryPassed) return null;
  return API_ASSERTION_SIGNAL.test(failure.errorMessage ?? '') ? 'SECURITY_FINDING' : null;
}

// Rule 4 — SELECTOR_BROKEN: the heal-loop's trigger. Locator no longer resolves —
// including a web-first assertion (toBeVisible etc.) that failed because the element
// wasn't found (LOCATOR_NOT_FOUND), and strict-mode / target-closed locator errors.
function ruleSelectorBroken({ failure }: ClassificationContext): FailureCategory | null {
  const msg = failure.errorMessage ?? '';
  const other = /strict mode violation|Target closed/i.test(msg);
  return msg && (LOCATOR_NOT_FOUND.test(msg) || other) ? 'SELECTOR_BROKEN' : null;
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
    ruleEnvironment(ctx) ??
    ruleRealRegression(ctx) ??
    ruleApiAssertionFailure(ctx) ??
    ruleSecurityFinding(ctx) ??
    ruleSelectorBroken(ctx) ??
    ruleThresholdDrift(ctx) ??
    'UNKNOWN'
  );
}
