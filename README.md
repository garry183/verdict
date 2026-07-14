# Verdict

**Every time a test fails in CI, Verdict tells you *why* — and fixes the failures it safely can.**

Verdict is an open-source tool you drop on top of an existing [Playwright](https://playwright.dev)
test suite. It reads the reports your CI pipeline already produces, decides what kind of
failure each one is (a real bug, a stale locator, a flaky test, or an environment
problem), automatically repairs stale locators when it can *prove* the repair works, and
hands genuine bugs to your team. No test rewriting required.

---

## The problem it solves

When a test suite goes red in CI, someone has to figure out *why* — and the reasons are
not equal:

- **A real bug** — the app genuinely broke. Stop the line, tell a developer.
- **Locator drift** — the app is fine, but a button got renamed or moved, so the test
  can no longer find it. The test *logic* is correct; only the "address" of the element
  is stale. This is busywork: someone hand-patches the selector and moves on.
- **A flaky test** — it fails randomly and passes on a retry, with no code change. Chasing
  it every run is wasted effort.
- **An environment problem** — the server returned a 500, the network dropped. Nothing to
  do with the code.

Treating all four the same burns engineering time. Verdict makes the call automatically,
then acts on it — so your team only looks at the failures that actually need a human.

---

## What it does, in plain terms

1. **Reads the wreckage.** After your tests run, CI leaves behind a results file plus
   screenshots and a trace (a recording of what the browser did). Verdict reads all of it.

2. **Renders a verdict.** A set of fixed rules — no AI, no guessing — labels each failure:

   | Verdict | Meaning | What happens |
   |---|---|---|
   | `REAL_REGRESSION` | The app behaved wrong | Reported to your team |
   | `SELECTOR_BROKEN` | Locator drift — element moved/renamed | Queued for auto-heal |
   | `FLAKY` | Passed on retry; non-deterministic | Scored, quarantined |
   | `INFRA` | The app's server/network broke (5xx, timeout) | Flagged as infrastructure |
   | `ENVIRONMENT` | The test setup couldn't run (missing secret, env var, or auth state) | Flagged for CI/config owner |
   | `AUTH` | API returned 401/403 — login rejected | Flagged, not a code bug |
   | `MISSING_ROUTE` | Many endpoints returned 404 — one deploy/URL cause | Grouped as one problem |
   | `THRESHOLD_DRIFT` | A visual/pixel snapshot moved | Flagged for review |

3. **Heals what it can prove.** For a stale locator, Verdict opens the live page, finds
   the element the test *meant* to click (even if its label was mistyped or slightly
   renamed), rewrites the selector, and **re-runs the actual test to confirm the fix
   works**. If it works, it bundles the change into a pull request for a human to merge.

4. **Never lies to stay green.** This is the core principle. A wrong "fix" that makes a
   broken test pass is worse than a failing test — it hides real bugs. So every repair
   must clear a **confidence gate** *and* pass a real re-run. Anything Verdict isn't sure
   about is **proposed** for a human, never silently applied.

5. **Remembers.** Every run is recorded to a durable history file, so flakiness scores and
   heal success rates are real, accumulating measurements — not guesses from a single run.

6. **Shows you the truth.** A dashboard reports the verdicts, how many locators were
   auto-healed *and re-run-verified*, how many are proposed for review, and the honest
   reliability of past heals (did they actually keep passing, or regress?).

---

## How it works under the hood

Each step, and the tool that does the work:

| Step | What happens | Tool used |
|---|---|---|
| **Ingest** | Read Playwright's JSON report. Unzip the `trace.zip` to recover the page URL the test failed on. Read the screenshot and Playwright's accessibility-tree dump (which often states the *real* on-page reason, e.g. "number not registered"). | `fflate` (zip), plain file reads |
| **Classify** | A deterministic 7-rule engine labels each failure. Pure logic — **no browser, no AI** — so it's instant and repeatable. It reads the failure text *and* the accumulated history. | TypeScript |
| **Persist** | Append a one-line summary of the run to `.verdict/history/runs.ndjson`, committed to your repo. This is the durable source of truth; flakiness is scored from the last 30 runs. | NDJSON files + git |
| **Heal** | Launch a real Chromium browser, load the failing page (using saved login/auth state so logged-in pages work), read the live accessibility tree via Chrome DevTools Protocol, and **fuzzy-match** the intended element. Verify each candidate resolves to exactly one element, then re-run the test to confirm. | Playwright, CDP, Levenshtein edit distance |
| **Gate & apply** | Only above the confidence threshold *and* only if the re-run passes does the selector get written to the test file. Otherwise it's reverted and downgraded to a proposal. | TypeScript |
| **Report** | Render a self-contained HTML dashboard (no framework, opens in any browser) and write the verdict straight onto the CI run's summary page. | Zero-dependency HTML |

**"Fuzzy match" in plain terms:** if a button labelled `Account` gets mistyped to
`Accouniuut`, exact matching sees two unrelated words. Verdict measures how many
single-letter edits separate them (a handful) and recognizes them as ~85% the same — the
same idea as a spell-checker. That lets it recover a drifted locator that strict matching
would miss, while genuinely different labels (`Login` vs `Logout`) stay below the gate and
get proposed for a human instead.

**Why the browser step is safe:** Verdict navigates *directly* to the failing page's URL
rather than clicking its way there — because click-paths are themselves made of locators
that may have drifted. It uses your suite's saved auth state, so it runs in the same
context as CI without needing to log in.

---

## Tech stack

| Area | Choice | Why |
|---|---|---|
| Language | **TypeScript** on **Node.js** (ESM) | Matches the Playwright ecosystem; type safety on the classifier seam |
| Test framework (target) | **Playwright** | The suite Verdict sits on top of; also the browser engine for healing |
| Browser automation | **Playwright + Chromium**, **Chrome DevTools Protocol** | Loads live pages and reads the accessibility tree to rediscover elements |
| Trace parsing | **fflate** | Tiny, dependency-free unzip to read the page URL out of `trace.zip` |
| Fuzzy matching | **Levenshtein edit distance** + token overlap | Recovers typo/rename drift that exact matching misses |
| Storage | **NDJSON** (append-only files, committed to git) | Free, durable, human-readable, survives CI artifact expiry. (A SQLite query index is on the roadmap.) |
| Dashboard | **Zero-dependency HTML** | Opens anywhere, nothing to install or host |
| CI | **GitHub Actions** + **Bitbucket Pipelines** | Runs triage on every build; healing runs out-of-band |
| Build | **tsc** (TypeScript compiler) | No bundler needed |
| License | **MIT** | |

**Deliberately absent: any AI/LLM in the decision path.** Classification and healing are
both deterministic. If AI is ever added (for fixing application bugs — a roadmap item), it
will be fenced by a deterministic gate before it and a deterministic verification after
it. The model never gets to decide a test is green.

---

## Using it

Install and build:

```bash
npm install
npm run build
```

**Triage** — cheap, runs on every CI build:

```bash
verdict triage test-results/results.json --html dashboard.html --suite e2e
# --json out.json     write a machine-readable report
# --strict            fail the CI step on a real regression
# --history <file>    where to keep the durable run history (default .verdict/history/runs.ndjson)
```

**Heal** — expensive, runs out-of-band (nightly or on-demand), never on the merge gate:

```bash
verdict heal test-results/results.json \
  --base-url https://staging.example.com \
  --storage-state auth.json \   # saved login state, so logged-in pages work
  --apply                       # write + re-run-verify fixes (omit to only propose)
```

**Dashboard** — render the HTML report from a saved verdict file:

```bash
verdict dashboard verdict-report.json --heals heals.ndjson --out dashboard.html
```

---

## What's built vs. what's coming

**Working today:**
- Deterministic classifier (the verdicts above), history-aware flake scoring.
- Playwright report + trace + screenshot ingest.
- Durable NDJSON history from the first run.
- Locator healing: fuzzy rediscovery, ranked candidates, confidence gate, re-run
  verification, apply-or-propose.
- Auth-aware, direct-URL live-DOM exploration.
- Honest dashboard (auto-healed vs. proposed vs. verified reliability).

**On the roadmap** (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)):
- Page-Object awareness (fix one locator, heal every test that uses it).
- De-duplication (collapse 40 red tests from one broken selector into one fix).
- SQLite query index over the history.
- Real-bug ticketing to Linear/Jira.
- Fragility scoring and an application-bug fix agent (AI, gated).

---

## Why not "just another self-healing tool"?

The wedge is deliberate. Healenium is Selenium-based; Testim, Mabl, and Functionize are
closed SaaS with their own recorders; Playwright ships a runtime healer. Verdict is
different on purpose: **free, Playwright-native, driven by the CI artifacts you already
produce, and propose-only** — it fixes what it can prove and refuses to fake a green.
That "we'd rather stay red than lie to you" discipline is the point, not a limitation.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`HANDOFF.md`](./HANDOFF.md) for the full
design and locked decisions.

## License
MIT.
