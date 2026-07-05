// ─────────────────────────────────────────────────────────────────────────────
// Heal orchestrator — wires the pieces into the loop the product is built around:
//
//   SELECTOR_BROKEN failure
//     → parse broken target from the error         (target.ts)
//     → get the page URL from the trace.zip         (trace.ts)
//     → re-discover + score candidates on live DOM  (explorer.ts)
//     → confidence gate → HEALED | PROPOSED         (gate.ts)
//     → append to heals.ndjson                       (log.ts)
//
// Correctness rules enforced here:
//   • Only SELECTOR_BROKEN is healed. Anything else → SKIPPED.
//   • No URL (no trace, no baseUrl) or unhealthy page → NO_DOM. Never guess.
//   • Below the gate → PROPOSED. A candidate is never silently applied.
// ─────────────────────────────────────────────────────────────────────────────

import type { Browser } from 'playwright';
import type { FailureContext, FailureCategory, HealVerdict } from '../core/types.js';
import { parseBrokenTarget } from './target.js';
import { extractTraceContext } from './trace.js';
import { discoverCandidates } from './explorer.js';
import { applyGate, CONFIDENCE_GATE } from './gate.js';
import { logHeal, HEAL_LOG, type HealRecord } from './log.js';
import { applyHeal, type ApplyOptions, type ApplyResult } from './apply.js';

export interface HealOptions {
  baseUrl?: string;      // fallback page URL when the failure has no trace
  gate?: number;         // confidence gate override (default CONFIDENCE_GATE)
  timeoutMs?: number;
  browser?: Browser;     // reuse a browser across many heals
  logFile?: string | null; // where to append the heal record; null disables logging
  // Apply a HEALED locator to source, guarded by a re-run. Pass true for defaults,
  // or an ApplyOptions object. Omit to only decide + propose (no source edits).
  apply?: boolean | ApplyOptions;
}

/** The heal sub-verdict (shape of Verdict.heal) plus diagnostics. */
export interface HealOutcome {
  verdict: HealVerdict;
  oldSelector: string | null;
  newSelector: string | null;
  confidence: number;
  url: string | null;
  httpStatus: number;
  apply?: ApplyResult;   // present when apply was attempted
}

function skip(verdict: HealVerdict, oldSelector: string | null = null): HealOutcome {
  return { verdict, oldSelector, newSelector: null, confidence: 0, url: null, httpStatus: 0 };
}

/** Attempt a heal. Pure orchestration — does not write the log (see runHeal). */
export async function heal(
  failure: FailureContext,
  category: FailureCategory,
  opts: HealOptions = {}
): Promise<HealOutcome> {
  if (category !== 'SELECTOR_BROKEN') return skip('SKIPPED');

  const target = parseBrokenTarget(failure.errorMessage);
  const oldSelector = target.raw || null;

  const url = (failure.tracePath ? extractTraceContext(failure.tracePath).url : null)
    ?? opts.baseUrl
    ?? null;
  if (!url) return skip('NO_DOM', oldSelector);

  const { pageHealthy, httpStatus, candidates } = await discoverCandidates(url, target, {
    timeoutMs: opts.timeoutMs,
    browser: opts.browser,
  });
  if (!pageHealthy) return { ...skip('NO_DOM', oldSelector), url, httpStatus };

  const best = candidates[0] ?? null;
  const verdict = applyGate(best, opts.gate ?? CONFIDENCE_GATE);
  const newSelector = best && verdict !== 'SKIPPED' ? best.selector : null;

  return { verdict, oldSelector, newSelector, confidence: best?.confidence ?? 0, url, httpStatus };
}

/** Heal and append the outcome to the heal log (unless logFile === null). */
export async function runHeal(
  failure: FailureContext,
  category: FailureCategory,
  opts: HealOptions = {}
): Promise<HealOutcome> {
  const outcome = await heal(failure, category, opts);

  // Apply step: only for a HEALED verdict, and only if requested. A failed apply
  // (can't locate the selector, or the re-run didn't confirm green) is a hard
  // downgrade to PROPOSED — we never keep an unverified edit.
  if (opts.apply && outcome.verdict === 'HEALED') {
    const applyOpts = typeof opts.apply === 'object' ? opts.apply : {};
    const result = applyHeal(failure, outcome, applyOpts);
    outcome.apply = result;
    if (!result.applied) outcome.verdict = 'PROPOSED';
  }

  const logFile = opts.logFile === undefined ? HEAL_LOG : opts.logFile;
  if (logFile) {
    const record: HealRecord = {
      timestamp: new Date().toISOString(),
      testName: failure.testName,
      project: failure.project,
      verdict: outcome.verdict,
      oldSelector: outcome.oldSelector,
      newSelector: outcome.newSelector,
      confidence: outcome.confidence,
      url: outcome.url,
      commit: failure.commit,
    };
    logHeal(record, logFile);
  }

  return outcome;
}

export { CONFIDENCE_GATE } from './gate.js';
export type { HealRecord } from './log.js';
export { computeHealRate } from './log.js';
export { applyHeal } from './apply.js';
export type { ApplyOptions, ApplyResult } from './apply.js';
