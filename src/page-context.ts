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

// Same intent as extractPageMessage, different markup: Appium's page-source dump is a
// raw Android view-hierarchy XML (ScreenshotOnFailureListener / BasePage capture — see
// livsol, verified live 2026-08-27), not an AX-tree. There is no fenced block to scope
// into; the on-screen text lives in `text="..."` and `content-desc="..."` attributes on
// any node (a toast, an error TextView, a content-description on an ImageView). Same
// conservative rule as the Playwright reader: only surface a line that matches a known
// validation/status signal, never the first text node found.
const XML_TEXT_ATTR = /\b(?:text|content-desc)="([^"]*)"/g;

function unescapeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Appium/Android equivalent of extractPageMessage — reads the page-source XML dump. */
export function extractAppiumPageMessage(errorContextPath: string | null): string | null {
  if (!errorContextPath || !existsSync(errorContextPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(errorContextPath, 'utf8');
  } catch {
    return null;
  }

  for (const m of raw.matchAll(XML_TEXT_ATTR)) {
    const text = unescapeXmlEntities(m[1]).trim();
    if (text && VALIDATION_SIGNALS.test(text)) return text;
  }
  return null;
}

/**
 * Dispatches to the right reader by the attachment's own shape: Playwright's dump is
 * always `error-context.md`, Appium's page-source is always `.xml` (see
 * ScreenshotOnFailureListener). Lets callers stay engine-agnostic — same seam as
 * `errorContextPath` itself.
 */
export function extractAnyPageMessage(errorContextPath: string | null): string | null {
  if (!errorContextPath) return null;
  return errorContextPath.toLowerCase().endsWith('.xml')
    ? extractAppiumPageMessage(errorContextPath)
    : extractPageMessage(errorContextPath);
}
