import { test, expect } from '@playwright/test';

// Login via OTP flow for https://stageshop.livguard.com/
// Locators verified against the live staging DOM (2026-07-05). All inline, single spec.

const BASE_URL = 'https://stageshop.livguard.com/';
const MOBILE = '4567845670';
const OTP = '9876';

test('login via OTP from header', async ({ page }) => {
  await page.goto(BASE_URL);

  await expect(page.getByRole('button', { name: 'Select location', exact: true })).toBeVisible();

  // Header → Account dropdown → Login / Register (no bare "Login" link in the header).
  // Assert visibility first (bounded timeout) so a drifted locator fails clean —
  // a locator-not-found error the classifier recognizes, not a generic 30s timeout.
  const account = page.getByRole('button', { name: 'Account' });
  await expect(account).toBeVisible();
  await account.click();
  await page.getByRole('button', { name: 'Login / Register' }).click();

  // Login modal — step 1: mobile number (has a fixed "+91" prefix, separate from the
  // input's own accessible name — verified live, do not prepend "M").
  const mobile = page.getByRole('textbox', { name: 'Mobile Number' });
  await expect(mobile).toBeVisible();
  await mobile.fill(MOBILE);
  await page.getByRole('button', { name: 'Login via OTP' }).click();

  // Login modal — step 2: OTP. Single input, not per-digit boxes.
  const otp = page.getByRole('textbox', { name: 'Enter Your OTP' });
  await expect(otp).toBeVisible();
  await otp.fill(OTP);

  // Same bounded-visibility-first pattern as above, for the same reason.
  const submit = page.getByRole('button', { name: 'Login', exact: true });
  await expect(submit).toBeVisible();
  await submit.click();
});
