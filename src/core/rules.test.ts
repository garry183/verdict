// ─────────────────────────────────────────────────────────────────────────────
// Regression suite for classify() — the one function in this tool where a wrong
// answer is expensive and doesn't announce itself. Every case here is either a
// verbatim real error message (cited in rules.ts's own comments as "confirmed
// live") or came directly out of a real, reproduced incident. No invented/
// paraphrased error text — a classifier is only as good as the ground truth it's
// checked against, and paraphrasing risks testing a string the real world never
// produces.
//
// Run via `npm test` (node --test picks up dist/**/*.test.js after `npm run
// build`). Any change to rules.ts must pass all of these before it ships — this
// is what would have caught the 2026-08-28 cascade bug (widening INFRA_SIGNALS
// enough to legitimately catch device-drop failures also pushed a real run's
// genuine-infra count over ruleInfra's own "3+ -> distrust the whole run"
// threshold, silently relabeling two real bugs as INFRA) before it shipped,
// instead of catching it by manual luck.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './rules.js';
import type { ClassificationContext, FailureContext, HealthEntry } from './types.js';

function mkFailure(overrides: Partial<FailureContext> & { errorMessage: string | null }): FailureContext {
  return {
    testName: 'com.example.Test.method',
    project: 'appium-android',
    suite: 'e2e',
    file: null,
    status: 'failed',
    retryPassed: false,
    durationMs: 1000,
    errorStack: null,
    screenshotPath: null,
    errorContextPath: null,
    startTime: '2026-01-01T00:00:00.000Z',
    commit: null,
    branch: null,
    ...overrides,
  };
}

function mkCtx(
  failure: FailureContext,
  allFailuresThisRun: FailureContext[] = [failure],
  health: Record<string, HealthEntry> = {}
): ClassificationContext {
  return { failure, allFailuresThisRun, health };
}

// ── Appium/TestNG real-failure cases (livsol, 2026-08-27/28) ─────────────────

test('InvalidElementStateException on a correct, still-valid id -> REAL_REGRESSION, not drift', () => {
  const failure = mkFailure({
    testName: 'NewLeadTest.submitCreateLeadFormWithInvalidEmailFormat',
    errorMessage:
      "org.openqa.selenium.InvalidElementStateException: Cannot set the element to 'balu.venkatesan@livguard.com'. Did you interact with the correct element?",
  });
  assert.equal(classify(mkCtx(failure)), 'REAL_REGRESSION');
});

test('AssertionError on real app behavior (Roof image validation) -> REAL_REGRESSION', () => {
  const failure = mkFailure({
    testName: 'SiteSurveyTest.proceedToReviewWithoutRoofImageIsBlocked',
    errorMessage:
      'java.lang.AssertionError: Expected Review survey to be blocked while Roof is missing expected [true] but found [false]',
  });
  assert.equal(classify(mkCtx(failure)), 'REAL_REGRESSION');
});

test('AssertionError from the FAB-tap-race @BeforeClass -> REAL_REGRESSION', () => {
  const failure = mkFailure({
    testName: 'SiteSurveyTest.seedNewSiteSurveyLeads',
    errorMessage:
      'java.lang.AssertionError: Expected Create Lead form to open from the FAB expected [true] but found [false]',
  });
  assert.equal(classify(mkCtx(failure)), 'REAL_REGRESSION');
});

test('NoSuchElementException (real livsol locator drift, verbatim) -> SELECTOR_BROKEN', () => {
  const failure = mkFailure({
    errorMessage:
      '...but the element was not found: org.openqa.selenium.NoSuchElementException: An element could not be located on the page using the given search parameters..',
  });
  assert.equal(classify(mkCtx(failure)), 'SELECTOR_BROKEN');
});

test('BasePage timeout, element never resolved (post-2026-08-28 message shape) -> SELECTOR_BROKEN', () => {
  const failure = mkFailure({
    errorMessage:
      'org.openqa.selenium.TimeoutException: Timed out waiting for element to be visible (NoSuchElementException -- element never resolved): mounting structure group (By.id: com.lshp.livsol360:id/pro_btn_mark_location)',
  });
  assert.equal(classify(mkCtx(failure)), 'SELECTOR_BROKEN');
});

test('BasePage timeout, element resolved but never became clickable -> UNKNOWN (ambiguous, not drift)', () => {
  const failure = mkFailure({
    errorMessage:
      'org.openqa.selenium.TimeoutException: Timed out waiting for element to be clickable (element resolved but never became clickable): sign in button (By.id: com.lshp.livsol360:id/btn_signin)',
  });
  assert.equal(classify(mkCtx(failure)), 'UNKNOWN');
});

test('BasePage timeout, pre-fix bare lambda hashcode message -> UNKNOWN (documents the bug this was fixed for; NOT a target to match)', () => {
  const failure = mkFailure({
    errorMessage:
      'org.openqa.selenium.TimeoutException: Expected condition failed: waiting for com.lshp.livsol.pageobjects.BasePage$$Lambda/0x000001b781337188@1fd35a92 (tried for 20 seconds with 500 milliseconds interval)',
  });
  assert.equal(classify(mkCtx(failure)), 'UNKNOWN');
});

// ── Device-drop INFRA cases (2026-08-28, run 33156195964) ────────────────────

test('adb losing the device mid-run -> INFRA', () => {
  const failure = mkFailure({
    errorMessage:
      "org.openqa.selenium.WebDriverException: Could not retrieve the currently focused package and activity. Original error: Error executing adbExec. Original error: 'Command 'C:\\\\...\\\\adb.exe -P 5037 -s R9ZL20J2RFT shell dumpsys window displays' exited with code 1'; Command output: adb.exe: device 'R9ZL20J2RFT' not found",
  });
  assert.equal(classify(mkCtx(failure)), 'INFRA');
});

test('UiAutomator2 instrumentation process crashed -> INFRA', () => {
  const failure = mkFailure({
    errorMessage:
      "org.openqa.selenium.WebDriverException: 'POST /elements' cannot be proxied to UiAutomator2 server because the instrumentation process is not running (probably crashed). Check the server log and/or the logcat output for more details",
  });
  assert.equal(classify(mkCtx(failure)), 'INFRA');
});

// ── The cascade-guard regression (the actual 2026-08-28 near-miss) ───────────
//
// Reproduces the exact run shape that broke: 8 failures, only 2 of them real
// bugs, the other 6 either genuinely INFRA (device drop) or ambiguous generic
// timeouts. Before the fix, ALL 8 came back INFRA once the genuine-infra count
// crossed ruleInfra's "3+ -> distrust the whole run" threshold. This is the
// single most important test in this file — it is the one a future change to
// either INFRA_SIGNALS or the cascade threshold must not break.
test('real failures survive the INFRA cascade even when 3+ other failures in the same run are genuine infra', () => {
  const realEmail = mkFailure({
    testName: 'SiteSurveyTest.backOutOfConductSiteSurveyFormMidFillWithoutSaving',
    errorMessage:
      "org.openqa.selenium.InvalidElementStateException: Cannot set the element to 'balu.venkatesan@livguard.com'. Did you interact with the correct element?",
  });
  const realAssertion = mkFailure({
    testName: 'SiteSurveyTest.proceedToReviewWithoutRoofImageIsBlocked',
    errorMessage:
      'java.lang.AssertionError: Expected Review survey to be blocked while Roof is missing expected [true] but found [false]',
  });
  const deviceDrop1 = mkFailure({
    testName: 'SiteSurveyTest.submitSurveyShowsSubmittedConfirmation',
    errorMessage:
      "org.openqa.selenium.WebDriverException: 'POST /elements' cannot be proxied to UiAutomator2 server because the instrumentation process is not running (probably crashed).",
  });
  const deviceDrop2 = mkFailure({
    testName: 'SiteSurveyTest.uploadMandatoryRoofAndBuildingFrontImages',
    errorMessage:
      "org.openqa.selenium.WebDriverException: Could not retrieve the currently focused package and activity. Original error: Error executing adbExec. ... adb.exe: device 'R9ZL20J2RFT' not found",
  });
  const deviceDrop3 = mkFailure({
    testName: 'SiteSurveyTest.submitSurveyWithNetworkDisabled',
    errorMessage:
      "org.openqa.selenium.WebDriverException: Could not retrieve the currently focused package and activity. Original error: Error executing adbExec. ... adb.exe: device 'R9ZL20J2RFT' not found",
  });
  const ambiguousTimeout1 = mkFailure({
    testName: 'SiteSurveyTest.backgroundAndResumeViaRecentsRetainsStep1Progress',
    errorMessage:
      'org.openqa.selenium.TimeoutException: Expected condition failed: waiting for com.lshp.livsol.pageobjects.ProSiteSurveyPage$$Lambda/0x000001b78138e730@7cf78c85 (tried for 20 seconds with 500 milliseconds interval)',
  });
  const ambiguousTimeout2 = mkFailure({
    testName: 'SiteSurveyTest.saveAndContinueWithInvalidElectricityBillText',
    errorMessage:
      'org.openqa.selenium.TimeoutException: Expected condition failed: waiting for com.lshp.livsol.pageobjects.BasePage$$Lambda/0x000001b781337188@1fd35a92 (tried for 20 seconds with 500 milliseconds interval)',
  });

  const allFailuresThisRun = [
    realEmail, realAssertion, deviceDrop1, deviceDrop2, deviceDrop3, ambiguousTimeout1, ambiguousTimeout2,
  ];

  // Sanity: this run genuinely has 3+ infra-shaped failures (the scenario that
  // triggers the cascade at all) -- if this assertion ever fails, the fixtures
  // above no longer reproduce the real incident and need updating.
  const ctxFor = (f: FailureContext) => mkCtx(f, allFailuresThisRun);

  assert.equal(classify(ctxFor(realEmail)), 'REAL_REGRESSION',
    'a real InvalidElementStateException must not be swept into INFRA by an unrelated device drop elsewhere in the run');
  assert.equal(classify(ctxFor(realAssertion)), 'REAL_REGRESSION',
    'a real business-logic AssertionError must not be swept into INFRA by an unrelated device drop elsewhere in the run');
  assert.equal(classify(ctxFor(deviceDrop1)), 'INFRA');
  assert.equal(classify(ctxFor(deviceDrop2)), 'INFRA');
  assert.equal(classify(ctxFor(deviceDrop3)), 'INFRA');
});

// ── Historical false-positive precedent (already fixed once; must stay fixed) ─

test('a Playwright locator.waitFor timeout is SELECTOR_BROKEN, not INFRA, despite containing "Timeout"', () => {
  // The original INFRA rule matched bare /Timeout/ and swept every failure with
  // 3+ timeouts into INFRA, including cross-project locator drift. Fixed by
  // scoping INFRA_SIGNALS to true infra phrasing (network/DNS/5xx/nav) and
  // excluding bare action/assertion timeouts, which LOCATOR_NOT_FOUND already
  // owns via the `locator\.waitFor` pattern. This test guards that scoping.
  const failure = mkFailure({
    project: 'chromium',
    errorMessage: 'TimeoutError: locator.waitFor: Timeout 10000ms exceeded.',
  });
  assert.equal(classify(mkCtx(failure)), 'SELECTOR_BROKEN');
});

// ── Baseline coverage for the non-Appium rules (Playwright-shaped) ───────────

test('a retry-passed failure is FLAKY regardless of error text', () => {
  const failure = mkFailure({ retryPassed: true, errorMessage: 'anything at all' });
  assert.equal(classify(mkCtx(failure)), 'FLAKY');
});

test('a genuine 5xx/navigation failure is INFRA', () => {
  const failure = mkFailure({
    project: 'chromium',
    errorMessage: 'page.goto: Timeout 30000ms exceeded.\nNavigation failed because browser has disconnected',
  });
  assert.equal(classify(mkCtx(failure)), 'INFRA');
});

test('a missing env var in a setup project is ENVIRONMENT, not REAL_REGRESSION', () => {
  const failure = mkFailure({
    project: 'setup',
    file: 'auth.setup.ts',
    errorMessage: 'Error: AUTH_USER_EMAIL is not defined',
  });
  assert.equal(classify(mkCtx(failure)), 'ENVIRONMENT');
});

test('two cross-project failures with low flakiness history is REAL_REGRESSION', () => {
  const chromium = mkFailure({ testName: 'Cart shows empty state', project: 'chromium', errorMessage: 'expect(received).toBe(expected)\nExpected: "Your cart is empty"\nReceived: "Loading..."' });
  const firefox = mkFailure({ testName: 'Cart shows empty state', project: 'firefox', errorMessage: 'expect(received).toBe(expected)\nExpected: "Your cart is empty"\nReceived: "Loading..."' });
  const ctx = mkCtx(chromium, [chromium, firefox]);
  assert.equal(classify(ctx), 'REAL_REGRESSION');
});

test('a single-project API 404 is REAL_REGRESSION; 3+ clustered 404s is MISSING_ROUTE', () => {
  const single = mkFailure({ suite: 'api', errorMessage: 'expect(received).toBe(expected)\nExpected: 200\nReceived: "404"' });
  assert.equal(classify(mkCtx(single)), 'REAL_REGRESSION');

  const mk404 = (name: string) => mkFailure({ testName: name, suite: 'api', errorMessage: 'expect(received).toBe(expected)\nExpected: 200\nReceived: "404"' });
  const clustered = [mk404('a'), mk404('b'), mk404('c')];
  assert.equal(classify(mkCtx(clustered[0], clustered)), 'MISSING_ROUTE');
});

test('an API 401 is AUTH, not REAL_REGRESSION', () => {
  const failure = mkFailure({ suite: 'api', errorMessage: 'expect(received).toBe(expected)\nExpected: 200\nReceived: "401"' });
  assert.equal(classify(mkCtx(failure)), 'AUTH');
});

test('a security-suite assertion failure is SECURITY_FINDING even on a 500', () => {
  const failure = mkFailure({ suite: 'security', errorMessage: 'expect(received).toBe(expected)\nExpected: 400\nReceived: "500"' });
  assert.equal(classify(mkCtx(failure)), 'SECURITY_FINDING');
});

test('a visual snapshot diff with low flakiness history is THRESHOLD_DRIFT', () => {
  const failure = mkFailure({ project: 'chromium-desktop', errorMessage: 'Screenshot comparison failed: 1234 pixels (ratio 0.02 of all image pixels) are different.' });
  assert.equal(classify(mkCtx(failure)), 'THRESHOLD_DRIFT');
});
