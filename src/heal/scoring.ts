// ─────────────────────────────────────────────────────────────────────────────
// Pure candidate scoring — how confident are we that a discovered element is the
// one the broken locator meant to reach?
//
// Confidence is what makes the heal loop trustworthy: it gates HEALED vs PROPOSED.
// Kept pure (no Playwright, no I/O) so the gate logic is unit-testable in isolation.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrokenTarget } from './target.js';

/** A live element the explorer verified resolves to exactly one node. */
export interface Candidate {
  role: string;
  name: string;
  selector: string;      // the verified locator, e.g. getByRole('button', { name: 'Checkout' })
  count: number;         // live resolution count — candidates we keep have count === 1
  confidence: number;    // 0..1, filled by scoreCandidate
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** Token Jaccard — order-insensitive overlap of two names. */
export function similarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter); // |∩| / |∪|
}

/**
 * Score a candidate against the broken target.
 *   name  55%  — semantic match of the accessible name / text (the strongest anchor)
 *   role  35%  — same ARIA role
 *   uniq  10%  — resolves to exactly one element (baseline for any kept candidate)
 *
 * When the target carries no name (raw CSS with no testid), name match is
 * unknowable → the score stays low on purpose, so it lands as PROPOSED, never a
 * silent HEALED. Under-healing is safe; a wrong auto-heal is a false green.
 */
export function scoreCandidate(target: BrokenTarget, c: Candidate): number {
  const nameScore = target.name ? similarity(target.name, c.name) : 0;
  const roleScore = target.role ? (c.role === target.role ? 1 : 0.2) : 0.5;
  const uniq = c.count === 1 ? 1 : 0.3;
  const score = 0.55 * nameScore + 0.35 * roleScore + 0.1 * uniq;
  return Math.min(1, Math.max(0, score));
}
