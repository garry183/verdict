# Verdict

**Renders a verdict on every failing test — real bug, locator drift (auto-healed), or flaky (scored).**

An open-source, Playwright-native, CI-artifact-driven triage + self-heal layer you
drop on top of an existing test suite. It reads your CI report and artifacts, decides
*why* each test failed, auto-heals broken locators behind a confidence gate, and tracks
how often self-healing actually worked.

## Why
Test suites fail for different reasons, and treating them alike wastes engineering time:
- A **real regression** should block and alert.
- A **locator drift** (the app's markup moved) should be fixed automatically — the test
  logic is fine, the selector is stale.
- A **flake** should be scored and quarantined, not chased every run.

Verdict makes that call deterministically, then acts on it.

## How it works
1. **Ingest** — parse a CI test report (Playwright JSON) + trace/screenshot artifacts.
2. **Classify** — a deterministic 5-rule engine assigns a `FailureCategory`.
3. **Heal** — on `SELECTOR_BROKEN`, an explorer agent rediscovers the locator from live
   DOM. It **auto-applies only above a confidence gate**; below it, it proposes a fix for
   a human. A wrong auto-heal is worse than a red test, so the gate is the whole point.
4. **Score** — the rest feed a persistent flakiness score with quarantine thresholds.
5. **Display** — a dashboard surfaces verdicts, flakiness, and self-heal success rate.

## Status
🚧 **v0.1 in progress.** Core classifier ported and stable; ingest, heal loop, and
dashboard in build. See [`HANDOFF.md`](./HANDOFF.md) for scope and decisions.

## Not another self-healing tool?
Correct — the wedge is deliberate. Healenium is Selenium; Testim/Mabl/Functionize are
closed SaaS with their own recorders. Verdict is free, Playwright-native, and driven by
the CI artifacts you already produce. See [`HANDOFF.md`](./HANDOFF.md#decisions-locked).

## License
MIT.
