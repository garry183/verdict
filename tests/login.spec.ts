import { test, expect } from '@playwright/test';

// Login via OTP flow for https://stageshop.livguard.com/
// Locators verified against the live staging DOM (2026-07-05). All inline, single spec.

const BASE_URL = 'https://stageshop.livguard.com/';
const MOBILE = '4567845678';
const OTP = '9876';

test('login via OTP from header', async ({ page }) => {
  await page.goto(BASE_URL);

  // Header location selector — a landing-page element. Its accessible name has
  // "drifted" (real name is "Select location") so heal can rediscover it live.
  await expect(page.getByRole('button', { name: 'Select location', exact: true })).toBeVisible();

  // Header → Account dropdown → Login / Register (no bare "Login" link in the header).
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Login / Register' }).click();

  // Login modal — step 1: mobile number (has a fixed "+91" prefix).
  const mobile = page.getByRole('textbox', { name: 'MMobile Number' });
  await expect(mobile).toBeVisible();
  await mobile.fill(MOBILE);
  await page.getByRole('button', { name: 'Login via OTP' }).click();

  // Login modal — step 2: OTP. Single input, not per-digit boxes.
  const otp = page.getByRole('textbox', { name: 'Enter Your OTP' });
  await expect(otp).toBeVisible();
  await otp.fill(OTP);

  // exact:true so it doesn't match "Login / Register" or "Login via OTP".
  await page.getByRole('button', { name: 'Logiin', exact: true }).click();
});
