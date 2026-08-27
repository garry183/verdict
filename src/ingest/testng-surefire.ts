// ─────────────────────────────────────────────────────────────────────────────
// TestNG + Appium (Java/Maven) → FailureContext[].
//
// Built and verified against a real project: D:\frameworks\livsol (TestNG/Appium,
// Android, Java 21, Maven Surefire, Allure). Two artifact sources, each read for what
// it's actually good at — do not merge this into one parser, they carry different signal:
//
//   1. target/surefire-reports/TEST-<FQCN>.xml — the STATUS source. One file per test
//      class, one <testcase> per method, a nested <failure>/<error> element when it
//      failed. Verified live: a failed @BeforeClass/@BeforeMethod attributes its
//      <failure> to the first test method in the class and marks every downstream
//      method in that class <skipped> with the same message — a whole-class cascade
//      from ONE cause. We only ever emit the <failure>/<error> testcase (mirrors
//      playwright-json.ts: passed/skipped are dropped, never emitted as failures), so
//      the cascade collapses to exactly one FailureContext for free — no extra dedup
//      needed, same principle as ARCHITECTURE.md §7.
//   2. target/allure-results/ — the ATTACHMENT + TIMING source. Screenshot and page-
//      source (Appium's AX-tree-equivalent) are NOT referenced from the result.json;
//      they live in the *-container.json that wraps the @AfterMethod fixture, keyed by
//      the result's uuid via container.children[]. Verified: attachments:[] on every
//      *-result.json in this project; the real png/xml links are only reachable by
//      joining through the container. Allure also carries precise start/stop epoch-ms
//      timestamps surefire's XML does not (surefire only has the class-total <time>).
//
// Retry signal — VERIFIED, not assumed: this project's RetryAnalyzer (MAX_RETRY_COUNT=1,
// applied via RetryAnnotationTransformer to every @Test) retries the method IN PROCESS.
// Checked a real run where two methods retried and one is a locator-drift failure that
// could never pass on retry: surefire's TEST-*.xml and every *-result.json in
// allure-results still contain exactly ONE <testcase>/result per method — no duplicate
// entries for the retried attempt, unlike Playwright's JSON report which lists every
// attempt in `results[]`. TestNG only hands its listeners the FINAL invocation. So there
// is no artifact-level signal here to derive "failed once then passed on retry" from —
// retryPassed is always false for this ingester. (If that ever needs to change, it needs
// a TestNG listener that logs each attempt itself; the existing report files cannot answer it.)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FailureContext } from '../core/types.js';
import type { IngestMeta } from './playwright-json.js';

export interface AppiumIngestMeta extends IngestMeta {
  // Where to look for screenshot/page-source attachments + precise timing. Defaults to
  // the sibling `allure-results` next to the given surefire-reports directory. Pass
  // `null` explicitly to skip attachment/timing enrichment entirely.
  allureResultsDir?: string | null;
  // Where `<classname>`s resolve to on disk, for the report's `file` field. Only used
  // when the resolved path actually exists — never guessed. Relative to cwd.
  sourceRoot?: string;
}

const DEFAULT_PROJECT = 'appium-android';
const DEFAULT_SOURCE_ROOT = 'src/test/java';

// ── XML helpers (no XML parser dependency — same hand-rolled-regex approach as
// page-context.ts's YAML-block reader; surefire's shape is simple and well-known) ──

function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

function cdataOrText(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}

interface RawFailure {
  classname: string;
  name: string;
  timeSec: number;
  type: string | null;
  message: string | null;
  stack: string | null;
}

/** Pure — parse one surefire TEST-<FQCN>.xml body into its failing testcases only. */
export function parseSurefireXml(xml: string): RawFailure[] {
  const out: RawFailure[] = [];
  const TESTCASE_RE = /<testcase\b([^>]*?)\/>|<testcase\b([^>]*?)>([\s\S]*?)<\/testcase>/g;
  let m: RegExpExecArray | null;
  while ((m = TESTCASE_RE.exec(xml))) {
    const attrs = m[1] ?? m[2] ?? '';
    const inner = m[3];
    if (!inner) continue; // self-closing testcase = passed, no failure to report

    const failMatch =
      inner.match(/<(failure|error)\b([^>]*?)>([\s\S]*?)<\/\1>/) ??
      inner.match(/<(failure|error)\b([^>]*?)\/>/);
    if (!failMatch) continue; // <skipped>-only or clean pass with system-out noise

    const failAttrs = failMatch[2] ?? '';
    const failBody = failMatch[3] ?? '';
    const classname = attr(attrs, 'classname') ?? '';
    const name = attr(attrs, 'name') ?? '';
    const timeSec = Number(attr(attrs, 'time') ?? '0') || 0;

    out.push({
      classname,
      name,
      timeSec,
      type: attr(failAttrs, 'type'),
      message: attr(failAttrs, 'message'),
      stack: failBody ? cdataOrText(failBody) : null,
    });
  }
  return out;
}

// ── Allure attachment + timing index ───────────────────────────────────────────

interface AllureInfo {
  screenshotPath: string | null;
  errorContextPath: string | null;
  startTimeIso: string | null;
  durationMs: number | null;
}

interface AllureAttachment { name?: string; source?: string; type?: string }
interface AllureStep { attachments?: AllureAttachment[] }
interface AllureContainer { children?: string[]; befores?: AllureStep[]; afters?: AllureStep[] }
interface AllureResult { uuid: string; fullName?: string; start?: number; stop?: number }

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

/** fullName ("pkg.Class.method") -> attachments + timing, joined via container.children. */
function loadAllureIndex(dir: string): Map<string, AllureInfo> {
  const index = new Map<string, AllureInfo>();
  if (!existsSync(dir)) return index;

  const files = readdirSync(dir);
  const attachmentsByUuid = new Map<string, AllureAttachment[]>();
  for (const f of files.filter(f => f.endsWith('-container.json'))) {
    const c = readJson<AllureContainer>(resolve(dir, f));
    if (!c) continue;
    const atts = [...(c.befores ?? []), ...(c.afters ?? [])].flatMap(step => step.attachments ?? []);
    if (!atts.length) continue;
    for (const child of c.children ?? []) {
      attachmentsByUuid.set(child, [...(attachmentsByUuid.get(child) ?? []), ...atts]);
    }
  }

  for (const f of files.filter(f => f.endsWith('-result.json'))) {
    const r = readJson<AllureResult>(resolve(dir, f));
    if (!r?.fullName) continue;
    const atts = attachmentsByUuid.get(r.uuid) ?? [];
    const screenshot = atts.find(a => a.type?.startsWith('image/'));
    const pageSource = atts.find(a => a.type === 'text/xml');
    index.set(r.fullName, {
      screenshotPath: screenshot?.source ? resolve(dir, screenshot.source) : null,
      errorContextPath: pageSource?.source ? resolve(dir, pageSource.source) : null,
      startTimeIso: typeof r.start === 'number' ? new Date(r.start).toISOString() : null,
      durationMs: typeof r.start === 'number' && typeof r.stop === 'number' ? r.stop - r.start : null,
    });
  }
  return index;
}

// ── file resolution ─────────────────────────────────────────────────────────────

/** Resolve a FQCN to its Java source file — only when it actually exists on disk. */
function resolveJavaFile(classname: string, sourceRoot: string): string | null {
  const full = resolve(sourceRoot, classname.replace(/\./g, '/') + '.java');
  return existsSync(full) ? full : null;
}

// ── Core parser ───────────────────────────────────────────────────────────────

/**
 * Ingest a target/surefire-reports directory (every top-level TEST-<FQCN>.xml —
 * NOT the junitreports/ or "Surefire suite"/ duplicates Maven also writes there,
 * and not testng-results.xml/testng-failed.xml, which are TestNG's own native report
 * and are not read here) into FailureContext[]. Failing testcases only, same contract
 * as ingestPlaywrightFile.
 */
export function ingestSurefireDir(dir: string, meta: AppiumIngestMeta = {}): FailureContext[] {
  const { suite = null, commit = null, branch = null } = meta;
  const sourceRoot = resolve(process.cwd(), meta.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const allureDir =
    meta.allureResultsDir === null ? null : meta.allureResultsDir ?? resolve(dir, '../allure-results');
  const allureIndex = allureDir ? loadAllureIndex(allureDir) : new Map<string, AllureInfo>();

  const xmlFiles = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.startsWith('TEST-') && e.name.endsWith('.xml'));

  const out: FailureContext[] = [];
  for (const entry of xmlFiles) {
    const xml = readFileSync(resolve(dir, entry.name), 'utf8');
    for (const raw of parseSurefireXml(xml)) {
      const fullName = `${raw.classname}.${raw.name}`;
      const allure = allureIndex.get(fullName) ?? null;

      // The `type` attribute is the outer exception class (org.openqa.selenium.
      // TimeoutException, org.openqa.selenium.InvalidElementStateException,
      // java.lang.AssertionError, ...) — verified reliably present on every real
      // <failure>/<error>. Prefixing it onto the message guarantees the classifier's
      // exception-name regexes match regardless of whether the prose also repeats the
      // class name (it usually does for nested causes, but not always for the outer one).
      const errorMessage = [raw.type, raw.message].filter(Boolean).join(': ') || raw.type || null;

      out.push({
        testName: fullName,
        project: DEFAULT_PROJECT,
        suite,
        file: resolveJavaFile(raw.classname, sourceRoot),
        status: 'failed',
        // See file header: verified against a real retried run — neither surefire's XML
        // nor Allure's result.json records more than the final attempt, so there is no
        // artifact signal to derive a retry-then-passed flaky flag from.
        retryPassed: false,
        durationMs: allure?.durationMs ?? Math.round(raw.timeSec * 1000),
        errorMessage,
        errorStack: raw.stack,
        screenshotPath: allure?.screenshotPath ?? null,
        errorContextPath: allure?.errorContextPath ?? null,
        startTime: allure?.startTimeIso ?? '',
        commit,
        branch,
      });
    }
  }
  return out;
}
