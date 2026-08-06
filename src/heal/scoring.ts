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
  via?: 'role' | 'label' | 'testid' | 'text'; // which strategy produced the selector
  testid?: string;       // the test id, when via === 'testid' (scored against the old testid)
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** Token Jaccard — order-insensitive overlap of two names (multi-word match). */
export function similarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter); // |∩| / |∪|
}

/** Levenshtein edit distance (single-row DP, O(n) memory). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Character-level similarity: 1 − editDistance/maxLen, on normalized strings.
 * This is the fuzzy match. Token Jaccard scores single-word typo drift at 0
 * ('Account'→'Accouniuut' share no whole word); edit distance recovers it (~0.7).
 */
export function editSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const x = a.toLowerCase().trim(), y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  return maxLen ? 1 - levenshtein(x, y) / maxLen : 0;
}

/**
 * Combined name similarity — the better of word-overlap and character-edit.
 * Multi-word renames stay covered by Jaccard; single-word typo drift is caught by
 * edit distance. Taking the max only ever RAISES a score, so the confidence gate
 * (and, on apply, the re-run) remain the backstops against a wrong-but-similar
 * match like 'Login'→'Logout' (~0.5 edit-sim, lands below the gate).
 */
export function nameSimilarity(a: string | null, b: string | null): number {
  return Math.max(similarity(a, b), editSimilarity(a, b));
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
  // testid ↔ testid is its own axis: compare the old test id to the new one directly,
  // not the element's accessible name. An unchanged testid (AX name drifted, element
  // intact) → ~1.0. A renamed testid ('checkout'→'checkout-btn') → ~0.7, landing
  // PROPOSED — correct until a git-diff rename signal justifies crossing the gate.
  if (target.kind === 'testid' && c.via === 'testid') {
    const sim = editSimilarity(target.name, c.testid ?? '');
    const uniq = c.count === 1 ? 1 : 0.3;
    return Math.min(1, Math.max(0, 0.9 * sim + 0.1 * uniq));
  }

  const nameScore = target.name ? nameSimilarity(target.name, c.name) : 0;
  const roleScore = target.role ? (c.role === target.role ? 1 : 0.2) : 0.5;
  const uniq = c.count === 1 ? 1 : 0.3;
  const score = 0.55 * nameScore + 0.35 * roleScore + 0.1 * uniq;
  return Math.min(1, Math.max(0, score));
}
