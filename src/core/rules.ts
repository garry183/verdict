// ─────────────────────────────────────────────────────────────────────────────
// Deterministic 5-rule failure classifier.
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
    ruleSelectorBroken(ctx) ??
    ruleThresholdDrift(ctx) ??
    'UNKNOWN'
  );
}
