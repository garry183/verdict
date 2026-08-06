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
import type { Candidate } from './scoring.js';

// How many above-gate candidates we will actually try to apply+verify per broken
// selector. Each attempt writes source and re-runs one test, so this caps the
// out-of-band cost. Candidates are tried in confidence order; the first whose
// re-run passes wins. Discovery scoring can be imperfect — the re-run is the truth.
const MAX_APPLY_ATTEMPTS = 3;

export interface HealOptions {
  baseUrl?: string;      // fallback page URL when the failure has no trace
  gate?: number;         // confidence gate override (default CONFIDENCE_GATE)
  timeoutMs?: number;
  browser?: Browser;     // reuse a browser across many heals
  storageState?: string; // Playwright auth state — reach logged-in pages directly
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

/** What the live-DOM discovery step produced, before any gate/apply decision. */
interface Discovery {
  oldSelector: string | null;
  url: string | null;
  httpStatus: number;
  candidates: Candidate[]; // scored, best first
  skip?: HealVerdict;      // set when discovery couldn't proceed (SKIPPED / NO_DOM)
}

/** Parse the broken target, resolve the page URL, re-discover candidates on live DOM. */
async function discover(
  failure: FailureContext,
  category: FailureCategory,
  opts: HealOptions
): Promise<Discovery> {
  const empty = { oldSelector: null, url: null, httpStatus: 0, candidates: [] as Candidate[] };
  if (category !== 'SELECTOR_BROKEN') return { ...empty, skip: 'SKIPPED' };

  const target = parseBrokenTarget(failure.errorMessage);
  const oldSelector = target.raw || null;

  const url = (failure.tracePath ? extractTraceContext(failure.tracePath).url : null)
    ?? opts.baseUrl
    ?? null;
  if (!url) return { ...empty, oldSelector, skip: 'NO_DOM' };

  const { pageHealthy, httpStatus, candidates } = await discoverCandidates(url, target, {
    timeoutMs: opts.timeoutMs,
    browser: opts.browser,
    storageState: opts.storageState,
  });
  if (!pageHealthy) return { oldSelector, url, httpStatus, candidates: [], skip: 'NO_DOM' };

  return { oldSelector, url, httpStatus, candidates };
}

/**
 * Decide a heal WITHOUT touching source — gates the single best candidate.
 * Used when apply is off (decide + propose only). Pure orchestration.
 */
export async function heal(
  failure: FailureContext,
  category: FailureCategory,
  opts: HealOptions = {}
): Promise<HealOutcome> {
  const d = await discover(failure, category, opts);
  if (d.skip) return { ...skip(d.skip, d.oldSelector), url: d.url, httpStatus: d.httpStatus };

  const best = d.candidates[0] ?? null;
  const verdict = applyGate(best, opts.gate ?? CONFIDENCE_GATE);
  const newSelector = best && verdict !== 'SKIPPED' ? best.selector : null;
  return { verdict, oldSelector: d.oldSelector, newSelector, confidence: best?.confidence ?? 0, url: d.url, httpStatus: d.httpStatus };
}

/**
 * Try to apply a real heal, verifying by re-run. Iterates the above-gate candidates
 * in confidence order (capped at MAX_APPLY_ATTEMPTS): each is written to source and
 * the affected test re-run; the FIRST that runs-and-passes is kept as HEALED. A
 * failed attempt is reverted by applyHeal, so the next attempt starts clean. If none
 * verify, the best candidate is returned as PROPOSED (never silently applied).
 */
async function healAndApply(
  failure: FailureContext,
  category: FailureCategory,
  applyOpts: ApplyOptions,
  opts: HealOptions
): Promise<HealOutcome> {
  const d = await discover(failure, category, opts);
  if (d.skip) return { ...skip(d.skip, d.oldSelector), url: d.url, httpStatus: d.httpStatus };

  const gate = opts.gate ?? CONFIDENCE_GATE;
  const eligible = d.candidates.filter(c => c.confidence >= gate).slice(0, MAX_APPLY_ATTEMPTS);

  let lastApply: ApplyResult | undefined;
  for (const c of eligible) {
    const trial: HealOutcome = {
      verdict: 'HEALED', oldSelector: d.oldSelector, newSelector: c.selector,
      confidence: c.confidence, url: d.url, httpStatus: d.httpStatus,
    };
    lastApply = applyHeal(failure, trial, applyOpts);
    if (lastApply.applied) return { ...trial, apply: lastApply };
  }

  // Nothing above the gate verified green → propose the best candidate for a human.
  const best = d.candidates[0] ?? null;
  if (!best) return { ...skip('SKIPPED', d.oldSelector), url: d.url, httpStatus: d.httpStatus };
  return {
    verdict: 'PROPOSED', oldSelector: d.oldSelector, newSelector: best.selector,
    confidence: best.confidence, url: d.url, httpStatus: d.httpStatus, apply: lastApply,
  };
}

/** Heal and append the outcome to the heal log (unless logFile === null). */
export async function runHeal(
  failure: FailureContext,
  category: FailureCategory,
  opts: HealOptions = {}
): Promise<HealOutcome> {
  const outcome = opts.apply
    ? await healAndApply(failure, category, typeof opts.apply === 'object' ? opts.apply : {}, opts)
    : await heal(failure, category, opts);

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
      // Positive proof, only when an apply actually re-ran the test and it passed.
      // Absent for a decide-only HEALED (never verified) — the metric must not treat
      // an unverified decision as a confirmed heal.
      verifiedGreen: outcome.apply?.reRunGreen === true
        ? true
        : outcome.apply ? false : undefined,
    };
    logHeal(record, logFile);
  }

  return outcome;
}

export { CONFIDENCE_GATE } from './gate.js';
export type { HealRecord } from './log.js';
export { computeHealStats } from './log.js';
export type { HealStats } from './log.js';
export { applyHeal } from './apply.js';
export type { ApplyOptions, ApplyResult } from './apply.js';
