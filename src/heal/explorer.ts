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

import { chromium, devices } from 'playwright';
import type { Browser, Page } from 'playwright';
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
  // Path to a Playwright storageState JSON (cookies + localStorage). When the heal
  // runs in the same image as CI with the suite's auth state, logged-in, URL-
  // addressable pages are reachable directly — no login flow. We navigate straight
  // to the failing page's URL (from the trace); we never click a path to it, since
  // the path is itself made of locators that may have drifted.
  storageState?: string;
  // Attribute(s) that carry a test id. Defaults to the common set below. Set this to
  // the project's Playwright `testIdAttribute` so generated getByTestId() locators
  // match how the suite actually addresses elements.
  testIdAttribute?: string | string[];
}

const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'tab', 'switch', 'searchbox', 'spinbutton', 'slider', 'heading',
]);

const escName = (n: string) => n.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const escRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface AxNode { role?: { value?: string }; name?: { value?: string }; childIds?: string[]; nodeId: string }

// Attributes that carry a test id, in preference order. Ported from browser-use's
// STATIC_ATTRIBUTES — covers the common testid conventions across suites.
const DEFAULT_TESTID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-selenium'];

// Tags / ARIA roles that mark an element interactive. Ported from browser-use's
// ClickableElementDetector.is_interactive (the DOM-only predicates).
const INTERACTIVE_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'details', 'summary', 'option'];
const INTERACTIVE_ROLES = [
  'button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab', 'textbox',
  'combobox', 'slider', 'spinbutton', 'searchbox', 'switch', 'listbox', 'gridcell',
];

function normalizeTestIdAttrs(opt?: string | string[]): string[] {
  if (!opt) return DEFAULT_TESTID_ATTRS;
  return Array.isArray(opt) ? opt : [opt];
}

// A DOM element the sweep judged interactive (or testid-addressable).
interface Hit { role: string; name: string; testid: string | null; testidAttr: string | null }

// CSS-escape a testid value for use inside an [attr="…"] selector.
const cssEsc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Second-source harvest — a single in-page DOM sweep that finds interactive and
 * testid-addressable elements the accessibility tree omits: clickable <div>/<span>
 * (cursor:pointer / onclick / tabindex / role), custom widgets, and any node carrying
 * a testid. Ported from browser-use's is_interactive, using the DOM-only predicates
 * (cursor/role/tabindex/handler/tag) rather than CDP per-node event-listener lookups.
 *
 * Known limit: a handler bound purely via addEventListener with no cursor:pointer,
 * role, or tabindex is not visible from evaluate() and won't be caught. In practice
 * real controls set cursor:pointer, so coverage is high.
 */
async function harvestInteractive(page: Page, testIdAttrs: string[]): Promise<Hit[]> {
  return page.evaluate(({ tags, roles, tidAttrs }) => {
    const impliedRole = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
        if (t === 'search') return 'searchbox';
        if (t === 'hidden') return 'generic';
        return 'textbox';
      }
      return el.getAttribute('role') || 'generic';
    };
    const nameOf = (el: Element): string => {
      const raw = el.getAttribute('aria-label')
        || (el as HTMLElement).innerText
        || el.getAttribute('title')
        || el.getAttribute('placeholder')
        || el.getAttribute('alt')
        || '';
      return raw.trim().slice(0, 120);
    };

    const out: { role: string; name: string; testid: string | null; testidAttr: string | null }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;

      let testid: string | null = null;
      let testidAttr: string | null = null;
      for (const a of tidAttrs) { const v = el.getAttribute(a); if (v) { testid = v; testidAttr = a; break; } }

      const roleAttr = el.getAttribute('role') || '';
      const interactive =
        tags.indexOf(tag) !== -1 ||
        roles.indexOf(roleAttr) !== -1 ||
        el.hasAttribute('onclick') ||
        el.hasAttribute('tabindex') ||
        getComputedStyle(el).cursor === 'pointer';

      if (!interactive && !testid) continue; // keep testid-only elements too
      out.push({ role: impliedRole(el), name: nameOf(el), testid, testidAttr });
    }
    return out;
  }, { tags: INTERACTIVE_TAGS, roles: INTERACTIVE_ROLES, tidAttrs: testIdAttrs });
}

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
    // Use a realistic desktop profile (real Chrome UA), not the bare Playwright
    // headless default — many sites (Cloudflare/WAF, bot-protection) 5xx the default
    // UA, which would read as an unhealthy page and abandon an otherwise valid heal.
    const context = await browser.newContext({
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 900 },
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
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

    // ── Harvest candidate elements from TWO sources ──────────────────────────
    // 1) the CDP accessibility tree — semantic, with computed accessible names.
    // 2) a DOM interactivity sweep — catches pointer/role/tabindex/onclick elements
    //    and testid-addressed nodes the AX tree omits (clickable <div>s, widgets).
    // Both feed the SAME count===1 verify + score pipeline: detection widens, trust
    // does not.
    const hits: Hit[] = [];

    try {
      const cdp = await context.newCDPSession(page);
      const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AxNode[] };
      await cdp.detach();
      for (const n of nodes) {
        const role = n.role?.value || 'generic';
        const name = n.name?.value || '';
        if (role !== 'generic' && (name || ACTIONABLE_ROLES.has(role))) hits.push({ role, name, testid: null, testidAttr: null });
      }
    } catch { /* AX tree unavailable — the DOM sweep below still runs */ }

    try {
      for (const h of await harvestInteractive(page, normalizeTestIdAttrs(opts.testIdAttribute))) hits.push(h);
    } catch { /* evaluate blocked (e.g. CSP) — AX hits still stand */ }

    // ── Build + verify locators, keep count===1, score vs the broken target ──
    const seen = new Set<string>();
    const candidates: Candidate[] = [];

    for (const { role, name, testid, testidAttr } of hits) {
      const key = `${role}|${name}|${testid ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const strategies: { selector: string; count: number; via: Candidate['via']; testid?: string }[] = [];

      // testid — the most stable identity; try first. getByTestId only matches the
      // default `data-testid`; for other testid attrs (data-cy/data-test/…) emit an
      // attribute CSS locator so the healed selector resolves regardless of config.
      if (testid) {
        const useGetByTestId = testidAttr === 'data-testid' || testidAttr === null;
        const selector = useGetByTestId
          ? `getByTestId('${escName(testid)}')`
          : `locator('[${testidAttr}="${cssEsc(testid)}"]')`;
        const locator = useGetByTestId ? page.getByTestId(testid) : page.locator(`[${testidAttr}="${cssEsc(testid)}"]`);
        try {
          const count = await locator.count();
          if (count > 0) strategies.push({ selector, count, via: 'testid', testid });
        } catch { /* skip */ }
      }

      // getByRole for real ARIA roles (not the 'generic' placeholder or inputs).
      if (name && role !== 'generic' && role !== 'textbox' && role !== 'searchbox') {
        try {
          const count = await page.getByRole(role as any, { name, exact: true }).count();
          if (count > 0) strategies.push({ selector: `getByRole('${role}', { name: '${escName(name)}', exact: true })`, count, via: 'role' });
        } catch { /* invalid role for getByRole — skip */ }
        try {
          const count = await page.getByRole(role as any, { name: new RegExp(escRe(name), 'i') }).count();
          if (count > 0) strategies.push({ selector: `getByRole('${role}', { name: /${escRe(name)}/i })`, count, via: 'role' });
        } catch { /* skip */ }
      }

      // labelled inputs.
      if ((role === 'textbox' || role === 'searchbox') && name) {
        try {
          const count = await page.getByLabel(name).count();
          if (count > 0) strategies.push({ selector: `getByLabel('${escName(name)}')`, count, via: 'label' });
        } catch { /* skip */ }
      }

      // named clickable with no usable ARIA role (e.g. a <div> with text) → getByText.
      if (name && role === 'generic') {
        try {
          const count = await page.getByText(name, { exact: true }).count();
          if (count > 0) strategies.push({ selector: `getByText('${escName(name)}', { exact: true })`, count, via: 'text' });
        } catch { /* skip */ }
      }

      const unique = strategies.filter(s => s.count === 1)[0];
      if (!unique) continue; // only trust count===1 locators as heal candidates

      const cand: Candidate = {
        role, name, selector: unique.selector, count: 1, confidence: 0,
        via: unique.via, testid: unique.testid,
      };
      cand.confidence = scoreCandidate(target, cand);
      candidates.push(cand);
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return { pageHealthy: true, httpStatus, candidates };
  } finally {
    if (owns) await browser.close();
  }
}
