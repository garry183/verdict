// detectBlockedPage — every snapshot here is a verbatim error-context.md AX-tree block
// from a real failure, except where marked as a negative control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlockedPageInSnapshot } from './page-context.js';

// livguard-ecomm run-20261002140038-h63u, header.spec.ts:31, chromium — FortiWeb on stageshop.
const FORTIWEB = `- heading "block" [level=2]
- heading "Web Page Blocked!" [level=3]
- paragraph: The page cannot be displayed. Please contact the administrator for additional information.
- paragraph: "URL: stageshop.livguard.com/products Client IP: 223.190.80.77 Attack ID: 20000008 Message ID: 011760689761"
- paragraph`;

test('FortiWeb block page -> waf, with the attack id', () => {
  assert.deepEqual(detectBlockedPageInSnapshot(FORTIWEB), { kind: 'waf', text: 'Web Page Blocked! (Attack ID: 20000008)' });
});

test('negative control: body copy mentioning "blocked" / "502" is not a blocked page', () => {
  const page = `- heading "Search results for \\"inverter\\"" [level=1]
- paragraph: Your order was blocked by the bank. Please try again.
- paragraph: Model 502 Bad Gateway-proof inverter`;
  assert.equal(detectBlockedPageInSnapshot(page), null);
});

test('negative control: a normal product page is not blocked', () => {
  assert.equal(detectBlockedPageInSnapshot(`- heading "Inverter Batteries" [level=1]\n- link "Add to cart"`), null);
});
