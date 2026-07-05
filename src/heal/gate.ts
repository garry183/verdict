// ─────────────────────────────────────────────────────────────────────────────
// The confidence gate — the non-negotiable heart of heal correctness.
//
// Above the gate → HEALED (the new locator may be auto-applied).
// Below the gate → PROPOSED (flagged for a human; NEVER applied).
// A wrong auto-heal ships a false green, which is worse than a red test — so the
// gate defaults conservative. Tune upward, never silently downward.
// ─────────────────────────────────────────────────────────────────────────────

import type { Candidate } from './scoring.js';
import type { HealVerdict } from '../core/types.js';

/** Default gate. Auto-apply only at high confidence. Override per-run if needed. */
export const CONFIDENCE_GATE = 0.75;

/** Decide the heal verdict for the best candidate found. */
export function applyGate(
  best: Candidate | null,
  gate: number = CONFIDENCE_GATE
): HealVerdict {
  if (!best) return 'SKIPPED';                 // no viable candidate discovered
  return best.confidence >= gate ? 'HEALED' : 'PROPOSED';
}
