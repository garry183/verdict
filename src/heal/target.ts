// ─────────────────────────────────────────────────────────────────────────────
// Parse the broken locator out of a Playwright error message.
//
// When a locator fails, Playwright echoes it in the error text, e.g.
//   "locator.click: Timeout 30000ms ... waiting for getByRole('button', { name: 'Checkout' })"
//   "locator.waitFor: ... waiting for locator('[data-testid="empty-cart"]')"
//   "strict mode violation: getByText('Welcome') resolved to 3 elements"
// This is the most reliable source of the test's *intent* — what element it meant
// to reach — which the heal explorer then re-discovers on the live page.
// ─────────────────────────────────────────────────────────────────────────────

export type TargetKind =
  | 'role'      // getByRole(role, { name })
  | 'text'      // getByText / getByLabel / getByPlaceholder / getByTitle / getByAltText
  | 'testid'    // getByTestId
  | 'css'       // locator('css | xpath | text=')
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

/**
 * Extract the first locator reference from an error message.
 * Order matters: the most specific / semantic forms first.
 */
export function parseBrokenTarget(errorMessage: string | null): BrokenTarget {
  if (!errorMessage) return NONE;

  // Quotes are matched by backreference (\1) so a nested quote — e.g. the " inside
  // locator('[data-testid="x"]') or an apostrophe in getByText("Don't") — doesn't
  // prematurely terminate the capture.
  const role = errorMessage.match(
    /getByRole\((['"])(.*?)\1\s*(?:,\s*\{([^}]*)\})?\s*\)/
  );
  if (role) {
    return { kind: 'role', role: role[2], name: nameFromOpts(role[3]), raw: role[0] };
  }

  const testid = errorMessage.match(/getByTestId\((['"])(.*?)\1\s*\)/);
  if (testid) return { kind: 'testid', role: null, name: testid[2], raw: testid[0] };

  const text = errorMessage.match(
    /getBy(?:Text|Label|Placeholder|Title|AltText)\((['"])(.*?)\1/
  );
  if (text) return { kind: 'text', role: null, name: text[2], raw: text[0] };

  const css = errorMessage.match(/locator\((['"])(.*?)\1\)/);
  if (css) {
    // A data-testid inside a raw CSS locator is still a testid intent.
    const tid = css[2].match(/\[data-testid=["']?([^"'\]]+)/);
    if (tid) return { kind: 'testid', role: null, name: tid[1], raw: css[0] };
    return { kind: 'css', role: null, name: null, raw: css[0] };
  }

  return NONE;
}
