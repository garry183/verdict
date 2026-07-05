// ─────────────────────────────────────────────────────────────────────────────
// Live-DOM explorer — ported from livguard-ecomm/agents/explorer/crawl-page.mjs,
// stripped of livguard coupling (staging URLs, storage-state, output artifacts).
//
// It navigates to the page, derives actionable elements from the accessibility
// tree, and — critically — VERIFIES every candidate locator's live count. Only
// locators that resolve to exactly one element become candidates (the origin's
// count===1 → confidence 5 rule). Each surviving candidate is scored against the
// broken target; the best score feeds the confidence gate.
//
// It also reports page health: a 5xx / unreachable page reads as selector-rot in
// the error text but is really INFRA — so a failed navigation returns NO candidates
// and pageHealthy=false, and the heal is abandoned (NO_DOM), never faked.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { BrokenTarget } from './target.js';
import { scoreCandidate, type Candidate } from './scoring.js';

export interface DiscoverResult {
  pageHealthy: boolean;
  httpStatus: number;
  candidates: Candidate[]; // scored, best first
}

export interface DiscoverOptions {
  timeoutMs?: number;
  browser?: Browser; // inject for reuse/testing; otherwise one is launched + closed
}

const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'tab', 'switch', 'searchbox', 'spinbutton', 'slider', 'heading',
]);

const escName = (n: string) => n.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const escRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface AxNode { role?: { value?: string }; name?: { value?: string }; childIds?: string[]; nodeId: string }

/** Discover + score candidate locators for a broken target on the live page. */
export async function discoverCandidates(
  url: string,
  target: BrokenTarget,
  opts: DiscoverOptions = {}
): Promise<DiscoverResult> {
  const timeout = opts.timeoutMs ?? 60000;
  const browser = opts.browser ?? (await chromium.launch());
  const owns = !opts.browser;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    let httpStatus = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      httpStatus = resp?.status() ?? 0;
    } catch {
      return { pageHealthy: false, httpStatus: 0, candidates: [] };
    }
    // 5xx / no response → INFRA masquerading as selector-rot. Do not heal.
    if (httpStatus === 0 || httpStatus >= 500) {
      return { pageHealthy: false, httpStatus, candidates: [] };
    }

    // Best-effort settle for client-rendered pages.
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* non-fatal */ }

    // ── Actionable elements from the CDP accessibility tree ──────────────────
    const flat: { role: string; name: string }[] = [];
    try {
      const cdp = await context.newCDPSession(page);
      const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AxNode[] };
      await cdp.detach();
      for (const n of nodes) {
        const role = n.role?.value || 'generic';
        const name = n.name?.value || '';
        if (role !== 'generic' && (name || ACTIONABLE_ROLES.has(role))) flat.push({ role, name });
      }
    } catch { /* AX tree unavailable — no candidates */ }

    // ── Build + verify locators, keep count===1, score vs the broken target ──
    const seen = new Set<string>();
    const candidates: Candidate[] = [];

    for (const { role, name } of flat) {
      if (!ACTIONABLE_ROLES.has(role)) continue;
      if (!name && role !== 'textbox' && role !== 'searchbox') continue;
      const key = `${role}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const strategies: { selector: string; count: number }[] = [];
      if (name) {
        // exact getByRole
        try {
          const count = await page.getByRole(role as any, { name, exact: true }).count();
          if (count > 0) strategies.push({ selector: `getByRole('${role}', { name: '${escName(name)}', exact: true })`, count });
        } catch { /* invalid role for getByRole — skip */ }
        // regex getByRole (looser)
        try {
          const count = await page.getByRole(role as any, { name: new RegExp(escRe(name), 'i') }).count();
          if (count > 0) strategies.push({ selector: `getByRole('${role}', { name: /${escRe(name)}/i })`, count });
        } catch { /* skip */ }
      }
      if (role === 'textbox' || role === 'searchbox') {
        if (name) {
          try {
            const count = await page.getByLabel(name).count();
            if (count > 0) strategies.push({ selector: `getByLabel('${escName(name)}')`, count });
          } catch { /* skip */ }
        }
      }

      const unique = strategies.filter(s => s.count === 1)[0];
      if (!unique) continue; // only trust count===1 locators as heal candidates

      const cand: Candidate = { role, name, selector: unique.selector, count: 1, confidence: 0 };
      cand.confidence = scoreCandidate(target, cand);
      candidates.push(cand);
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return { pageHealthy: true, httpStatus, candidates };
  } finally {
    if (owns) await browser.close();
  }
}
