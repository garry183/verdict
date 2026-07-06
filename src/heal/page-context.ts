// ─────────────────────────────────────────────────────────────────────────────
// Extracts the real on-page reason for a failure from Playwright's error-context.md
// — an AX-tree dump of the page at the moment it failed. The bare Playwright
// exception ("element(s) not found") only says a locator didn't resolve; it never
// says WHY the page didn't have it. Often the real reason is sitting right there in
// a validation banner or alert the page rendered instead — e.g. "This mobile number
// is not registered." This surfaces that, independent of classification category:
// a SELECTOR_BROKEN verdict caused by bad test data is still SELECTOR_BROKEN, but
// the user should not have to open a screenshot to learn why.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';

// Curated, not exhaustive — matches common validation/status phrasing. Deliberately
// conservative: silence (null) beats surfacing an irrelevant paragraph. Extend as
// real cases surface, the same way the classifier's own patterns grew.
// "please enter/log in" is too generic — matches ordinary form instructions, not
// just errors (e.g. "Please enter your mobile number to continue" on first load).
// Keep only phrasing that's specific to an actual validation/error outcome.
const VALIDATION_SIGNALS =
  /not registered|invalid|incorrect|already (exists|registered|in use)|is required|expired|too many attempts|please (register|try again)|error occurred|failed to|unauthorized|forbidden|out of stock|unavailable|access denied|session (expired|timed out)/i;

/**
 * Pull the first line from the failure's AX-tree snapshot that reads like a real
 * validation/status message. Returns null if there's no error-context file, it's
 * unreadable, or nothing in it matches a known signal.
 */
export function extractPageMessage(errorContextPath: string | null): string | null {
  if (!errorContextPath || !existsSync(errorContextPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(errorContextPath, 'utf8');
  } catch {
    return null;
  }

  // The AX-tree dump lives in the fenced ```yaml block after the error details.
  const block = raw.match(/```yaml\n([\s\S]*?)\n```/);
  if (!block) return null;

  for (const line of block[1].split('\n')) {
    const text = line
      .replace(/^\s*-\s*(paragraph|text|alert):?\s*/i, '')
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (text && VALIDATION_SIGNALS.test(text)) return text;
  }
  return null;
}
