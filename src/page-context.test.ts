// detectBlockedPage — every snapshot here is a verbatim error-context.md AX-tree block
// from a real failure, except where marked as a negative control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlockedPageInSnapshot, detectDataUnavailableInSnapshot } from './page-context.js';

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

// ── detectDataUnavailable ────────────────────────────────────────────────────

// livguard-ecomm build #273 (2026-10-22), add-to-cart-checkout.spec.ts:54, chromium — /products
// with every card out of stock at pincode 110001. Two verbatim cards (the real page had 12).
const ALL_OOS_PLP = `        - generic [ref=e330]:
          - generic [ref=e332]:
            - generic [ref=e333]:
              - generic [ref=e334]:
                - generic [ref=e335]: Out Of Stock
                - link "Livguard Zing Ultra ZU 42B20N BH L 40Ah Car Battery (30M+30M)" [ref=e336] [cursor=pointer]:
                  - /url: /products/69f87a76808251569992086f
              - generic [ref=e338]:
                - paragraph [ref=e340]: Automotive Batteries · Hatchback Sedan
                - generic [ref=e341]:
                  - paragraph [ref=e342]:
                    - text: EMI from
                    - generic [ref=e343]: ₹426/mo
                  - button "Out of Stock" [disabled] [ref=e345]
            - generic [ref=e346]:
              - generic [ref=e347]:
                - generic [ref=e348]: Out Of Stock
                - link "Livguard Zing Ultra ZU 42B20 L 35Ah Car Battery (30M+30M)" [ref=e349] [cursor=pointer]:
                  - /url: /products/69f87a768082515699920865
              - generic [ref=e351]:
                - generic [ref=e354]:
                  - button "Out of Stock" [disabled] [ref=e358]`;

test('all-out-of-stock PLP -> data unavailable, with the CTA count', () => {
  assert.deepEqual(detectDataUnavailableInSnapshot(ALL_OOS_PLP), {
    text: '2 × "Out of Stock" CTA, no enabled buy button — nothing purchasable',
  });
});

test('PDP showing the unserviceable-pincode message -> data unavailable', () => {
  // Text verified live on stageshop 2026-10-22 at pincode 110001 (PDP, authenticated).
  const pdp = `- button "Add to Cart" [disabled] [ref=e90]
- paragraph [ref=e91]: Not available on the selected pincode. Try changing other pincode.`;
  assert.deepEqual(detectDataUnavailableInSnapshot(pdp), {
    text: 'Page says "Not available on the selected pincode" — no purchasable item',
  });
});

test('negative control: one OOS card next to an enabled Add to cart is not data-unavailable (could be drift)', () => {
  const page = `- button "Out of Stock" [disabled] [ref=e1]
- button "Add to cart" [ref=e2]`;
  assert.equal(detectDataUnavailableInSnapshot(page), null);
});

test('negative control: a page with no commerce CTAs is not data-unavailable', () => {
  assert.equal(detectDataUnavailableInSnapshot(`- heading "Inverter Batteries" [level=1]\n- link "View all"`), null);
});
