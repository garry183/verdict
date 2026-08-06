# Verdict

**Every time a test fails in CI, Verdict tells you *why*.**

Verdict is an open-source tool you drop on top of an existing [Playwright](https://playwright.dev)
test suite. It reads the reports your CI pipeline already produces and decides what kind
of failure each one is — a real bug, a stale locator, a flaky test, a security finding,
or an environment problem — so your team spends its attention on the failures that
actually need a human, not the ones that don't. No test rewriting required.

> **Self-healing has been removed for now.** Earlier versions of Verdict could rediscover
> a drifted locator on the live DOM and rewrite it behind a confidence gate. That code is
> preserved on the [`archive/self-heal`](https://github.com/garry183/verdict/tree/archive/self-heal)
> branch, not deleted — it's paused, not abandoned, pending more real-world validation
> before it comes back. Today Verdict classifies and reports; it does not touch your test
> source.

---

## The problem it solves

When a test suite goes red in CI, someone has to figure out *why* — and the reasons are
not equal:

- **A real bug** — the app genuinely broke. Stop the line, tell a developer.
- **Locator drift** — the app is fine, but a button got renamed or moved, so the test
  can no longer find it. The test *logic* is correct; only the "address" of the element
  is stale.
- **A flaky test** — it fails randomly and passes on a retry, with no code change. Chasing
  it every run is wasted effort.
- **An environment problem** — the server returned a 500, the network dropped, or the test
  harness itself couldn't start (missing secret, expired auth state). Nothing to do with
  application code.
- **A security finding** — your own security suite caught a real vulnerability signature
  (missing cookie flag, leaked secret, a 5xx on a hostile payload). Needs a security/dev
  owner, not a locator fix.

Treating all of these the same burns engineering time. Verdict makes the call
automatically — so your team triages in seconds instead of opening every red run.

---

## What it does, in plain terms

1. **Reads the wreckage.** After your tests run, CI leaves behind a results file plus
   screenshots and Playwright's accessibility-tree dump of the page at failure time.
   Verdict reads all of it.

2. **Renders a verdict.** A set of fixed rules — no AI, no guessing — labels each failure:

   | Verdict | Meaning | What happens |
   |---|---|---|
   | `REAL_REGRESSION` | The app behaved wrong | Reported to your team |
   | `SELECTOR_BROKEN` | Locator drift — element moved/renamed | Flagged for a human to fix the selector |
   | `FLAKY` | Passed on retry; non-deterministic | Scored, quarantined |
   | `INFRA` | The app's server/network broke (5xx, timeout) | Flagged as infrastructure |
   | `ENVIRONMENT` | The test setup couldn't run (missing secret, env var, or auth state) | Flagged for CI/config owner |
   | `AUTH` | API returned 401/403 — login rejected | Flagged, not a code bug |
   | `MISSING_ROUTE` | Many endpoints returned 404 — one deploy/URL cause | Grouped as one problem |
   | `SECURITY_FINDING` | Your security suite's own probe caught a real vulnerability signature | Flagged for a security owner |
   | `THRESHOLD_DRIFT` | A visual/pixel snapshot moved | Flagged for review |

3. **Surfaces the real reason, not just the category.** Playwright's bare exception
   ("element(s) not found") never says *why* the element is gone. Verdict reads the
   accessibility-tree dump the page produced at failure time and pulls out the actual
   on-page message when there is one — e.g. "This mobile number is not registered" —
   so you don't have to open a screenshot to learn why a `SELECTOR_BROKEN` verdict fired.

4. **Remembers.** Every run is recorded to a durable history file, so flakiness scores
   are a real, accumulating measurement — not a guess from a single run.

5. **Shows you the truth.** A terminal table, a Markdown job summary, and a self-contained
   HTML dashboard all report the same verdicts and detail, whichever surface you check.

---

## How it works under the hood

Each step, and the tool that does the work:

| Step | What happens | Tool used |
|---|---|---|
| **Ingest** | Read Playwright's JSON report. Read the screenshot and Playwright's accessibility-tree dump (which often states the *real* on-page reason, e.g. "number not registered"). | Plain file reads |
| **Classify** | A deterministic 8-rule engine labels each failure. Pure logic — **no browser, no AI** — so it's instant and repeatable. It reads the failure text *and* the accumulated history, including bare action-timeouts (`locator.click: Timeout … exceeded`) whose call log shows the element never resolved — not just assertions that print "not found". | TypeScript |
| **Persist** | Append a one-line summary of the run to `.verdict/history/runs.ndjson`, committed to your repo. This is the durable source of truth; flakiness is scored from the last 30 runs. | NDJSON files + git |
| **Report** | Render a terminal table, a self-contained HTML dashboard (no framework, opens in any browser), and write the verdict straight onto the CI run's summary page. | Zero-dependency HTML |

---

## Tech stack

| Area | Choice | Why |
|---|---|---|
| Language | **TypeScript** on **Node.js** (ESM) | Matches the Playwright ecosystem; type safety on the classifier seam |
| Test framework (target) | **Playwright** | The suite Verdict sits on top of |
| Storage | **NDJSON** (append-only files, committed to git) | Free, durable, human-readable, survives CI artifact expiry. (A SQLite query index is on the roadmap.) |
| Dashboard | **Zero-dependency HTML** | Opens anywhere, nothing to install or host |
| CI | **GitHub Actions** + **Bitbucket Pipelines** | Runs triage on every build |
| Build | **tsc** (TypeScript compiler) | No bundler needed |
| License | **MIT** | |

**Deliberately absent: any AI/LLM in the decision path.** Classification is fully
deterministic. If AI is ever added (for fixing application bugs — a roadmap item), it
will be fenced by a deterministic gate before it and a deterministic verification after
it. The model never gets to decide a test is green.

---

## Using it

Install and build:

```bash
npm install
npm run build
```

**Triage** — runs on every CI build:

```bash
verdict triage test-results/results.json --html dashboard.html --suite e2e
# --json out.json     write a machine-readable report
# --strict            fail the CI step on a real regression
# --history <file>    where to keep the durable run history (default .verdict/history/runs.ndjson)
```

**Dashboard** — render the HTML report from a saved verdict file:

```bash
verdict dashboard verdict-report.json --out dashboard.html
```

---

## What's built vs. what's coming

**Working today:**
- Deterministic classifier (the verdicts above, including `SECURITY_FINDING` for
  security-suite probes), history-aware flake scoring.
- Playwright report + screenshot ingest, with the real on-page reason surfaced
  independent of category.
- Durable NDJSON history from the first run.
- Terminal table, Markdown job summary, and HTML dashboard reporting.

**On the roadmap** (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)):
- Self-healing, reintroduced once validated further (see the note at the top).
- Page-Object awareness (fix one locator, heal every test that uses it).
- De-duplication (collapse 40 red tests from one broken selector into one fix).
- SQLite query index over the history.
- Real-bug ticketing to Linear/Jira.
- Fragility scoring and an application-bug fix agent (AI, gated).

---

## Why not "just another test-triage tool"?

The wedge is deliberate: **free, Playwright-native, and driven by the CI artifacts you
already produce** — no recorder, no separate agent to run, no vendor lock-in. Drop it on
top of a report your suite already writes and get a verdict, not just a red X.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`HANDOFF.md`](./HANDOFF.md) for the full
design and locked decisions, and [`RUN-EVIDENCE.md`](./RUN-EVIDENCE.md) for what a real
Playwright run actually carries (report fields, trace streams, AX snapshots) and how
Verdict reads each one — the ground truth every classifier change is verified against.

## License
MIT.
