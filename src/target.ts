// ─────────────────────────────────────────────────────────────────────────────
// Parse the broken locator out of a Playwright error message.
//
// When a locator fails, Playwright echoes it in the error text, e.g.
//   "locator.click: Timeout 30000ms ... waiting for getByRole('button', { name: 'Checkout' })"
//   "locator.waitFor: ... waiting for locator('[data-testid="empty-cart"]')"
//   "strict mode violation: getByText('Welcome') resolved to 3 elements"
// This is the most reliable source of the test's *intent* — what element it meant
// to reach — surfaced in the triage report so a human can go fix it directly.
//
// FILTER CHAINS: modern suites hide the identifying text in a `.filter({ hasText })`
// hung off a nameless base, e.g.
//   "getByRole('button').filter({ hasText: /advance payment/i }).first()"
// The base carries no name; the anchor lives in the filter. We recover it into
// `name` (so the report has a text anchor) and keep the FULL chain in `raw`
// (so the report shows the real locator).
// ─────────────────────────────────────────────────────────────────────────────

export type TargetKind =
  | 'role'      // getByRole(role, { name })
  | 'text'      // getByText / getByLabel / getByPlaceholder / getByTitle / getByAltText
  | 'testid'    // getByTestId
  | 'css'       // locator('css | xpath | text=')
  | 'byLocator' // Selenium/Appium By.id / By.xpath / By.accessibilityId / ...
  | 'unknown';

export interface BrokenTarget {
  kind: TargetKind;
  role: string | null;   // for kind 'role'
  name: string | null;   // accessible name / text / label — the semantic anchor
  raw: string;           // the exact selector snippet echoed in the error (oldSelector)
}

const NONE: BrokenTarget = { kind: 'unknown', role: null, name: null, raw: '' };

// Pull a name from a getByRole options blob: { name: 'X' } or { name: /x/i }.
function nameFromOpts(opts: string | undefined): string | null {
  if (!opts) return null;
  const str = opts.match(/name:\s*['"]([^'"]+)['"]/);
  if (str) return str[1];
  const rx = opts.match(/name:\s*\/([^/]+)\//);
  return rx ? rx[1] : null;
}

// Recover the anchor from a `.filter({ hasText: /x/i })` or `.filter({ hasText: 'x' })`.
// Used when the base locator carries no name of its own. Kept identical in spirit to
// ax-context.intentFromError so the online and offline paths agree.
function hasTextAnchor(s: string | undefined): string | null {
  if (!s) return null;
  const rx = s.match(/hasText:\s*\/([^/]+)\//i);
  if (rx) return rx[1].trim();
  const str = s.match(/hasText:\s*(['"])(.*?)\1/i);
  return str ? str[2].trim() : null;
}

// Trailing method chain after a base locator: .filter({…}).first().nth(2) … Captured
// so `raw` reflects the whole expression, not just the nameless base.
const CHAIN = '((?:\\.\\w+\\([^)]*\\))*)';

/**
 * Extract the first locator reference from an error message.
 * Order matters: the most specific / semantic forms first.
 */
export function parseBrokenTarget(errorMessage: string | null): BrokenTarget {
  if (!errorMessage) return NONE;

  // Quotes are matched by backreference (\1) so a nested quote — e.g. the " inside
  // locator('[data-testid="x"]') or an apostrophe in getByText("Don't") — doesn't
  // prematurely terminate the capture. A trailing CHAIN captures any .filter()/.first()
  // so `raw` is the whole expression and a filter's hasText can anchor a nameless base.
  const role = errorMessage.match(
    new RegExp(`getByRole\\((['"])(.*?)\\1\\s*(?:,\\s*\\{([^}]*)\\})?\\s*\\)${CHAIN}`)
  );
  if (role) {
    const name = nameFromOpts(role[3]) ?? hasTextAnchor(role[4]) ?? hasTextAnchor(errorMessage);
    return { kind: 'role', role: role[2], name, raw: role[0] };
  }

  const testid = errorMessage.match(/getByTestId\((['"])(.*?)\1\s*\)/);
  if (testid) return { kind: 'testid', role: null, name: testid[2], raw: testid[0] };

  const text = errorMessage.match(
    new RegExp(`getBy(?:Text|Label|Placeholder|Title|AltText)\\((['"])(.*?)\\1[^)]*\\)${CHAIN}`)
  );
  if (text) return { kind: 'text', role: null, name: text[2], raw: text[0] };

  const css = errorMessage.match(new RegExp(`locator\\((['"])(.*?)\\1\\)${CHAIN}`));
  if (css) {
    // A data-testid inside a raw CSS locator is still a testid intent.
    const tid = css[2].match(/\[data-testid=["']?([^"'\]]+)/);
    if (tid) return { kind: 'testid', role: null, name: tid[1], raw: css[0] };
    // Otherwise a nameless CSS base — recover a filter's hasText as the anchor if any.
    return { kind: 'css', role: null, name: hasTextAnchor(css[3]) ?? null, raw: css[0] };
  }

  // Selenium/Appium: "...waiting for element found by By.id: com.pkg:id/foo to be
  // clickable" / "By.xpath: //android.widget.Button[...]". Verified live against a real
  // livsol drift (a renamed resource-id). Unlike Playwright's chainable locators this is
  // always a flat `By.<strategy>: <value>` pair, so the whole match is both the anchor
  // and the raw echo.
  const byLocator = errorMessage.match(/\bBy\.(\w+):\s*([^\s,]+)/);
  if (byLocator) {
    return { kind: 'byLocator', role: byLocator[1], name: byLocator[2], raw: byLocator[0] };
  }

  return NONE;
}
