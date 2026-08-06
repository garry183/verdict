# RUN-EVIDENCE.md — What a Playwright run actually contains

> **Hard rule for every session (human or agent): NEVER ASSUME what a failing run
> contains. Extract it.** Before you reason about a failure — its locator, its cause,
> which product/account it used, drift vs. real bug — pull the fields below from the
> actual artifacts. Do not invent a locator, do not guess the cause from the error
> headline, do not spot-check a *guessed* element. This document is the ground truth,
> dissected from a **real Playwright 1.61.1 run** (livguard-ecomm e2e-smoke, the
> LockTheDeal checkout failure) plus controlled local captures. Fields shown are copied
> from real bytes, not the docs.

Why this file exists: three separate misclassifications/misreports on that one run
traced back to the same root cause — reasoning from the error *headline* instead of the
full evidence. The classifier called locator drift a `REAL_REGRESSION`; the report
showed a useless one-liner; the diagnosis chased the wrong element. Every one of those
was avoidable by reading what was already in the artifact.

---

## The three artifact sources

A CI run hands you (at most) three things per failing test. The heal loop and the
report should read all three before deciding anything.

| Source | File(s) | Carries |
|---|---|---|
| **1. JSON report** | `test-results/*-results.json` (Playwright `json` reporter) | test identity, status, retries, **full error message**, **errorLocation (file:line:col)**, **error.snippet**, **annotations**, attachment paths, stdout/stderr |
| **2. trace.zip** | `test-results/<test>/trace.zip` (attachment) | action stream (every PW call + params), **DOM snapshots**, **network (all requests/responses)**, console, action logs, screencast, context options, source files |
| **3. attachments** | `error-context.md`, `test-failed-*.png`, `video.webm` | **AX-tree of the page at failure** (the renamed element is here), screenshot, video |

The HTML report (`playwright-report/index.html` + `data/`) is sources 1–3 repackaged for
humans: `data/*.md` = error-context, `data/*.zip` = trace, `data/*.png|webm` = media.
There is no separate JSON in an HTML report; read the `.zip`/`.md` directly.

---

## Source 1 — JSON report (per failing test)

Shape below is the **real** serialized `json` reporter output (verified). The recursive
walk is `suites[] → specs[] → tests[] → results[]`. Emit a failure for each `test` whose
`status` is `unexpected` or `flaky`.

| Field | Real example (this run / local capture) | Answers | Verdict today |
|---|---|---|---|
| `spec.title` + suite titles | `LockTheDeal — Add to Cart & Checkout Flow › …complete purchase flow…` | which test | ✅ extracted |
| `test.projectName` | `chromium`, `mobile-chrome` | which browser | ✅ extracted |
| `test.status` | `unexpected` \| `flaky` \| `skipped` | flaky signal (`flaky`→retryPassed) | ✅ extracted |
| `result.error.message` | `expect(locator).toBeVisible() failed\n\nLocator: getByRole('button').filter({ hasText: /advance payment/i }).first()\nExpected: visible\nTimeout: 10000ms\nError: element(s) not found\n\nCall log:\n  - …waiting for <locator>` | locator, drift-vs-real, cause | ✅ extracted (but see parse gaps) |
| `result.errorLocation` | `{file:"tests/e2e/add-to-cart-checkout.spec.ts", line:54, column:7}` | **exact assertion site** for apply | ❌ **DROPPED** — apply.ts text-searches instead |
| `result.error.snippet` | source lines around the failure with `> 54 \|  … ^` marker | human context, apply anchor | ❌ dropped |
| `test.annotations` | `[{type:"account",description:"…"},{type:"product",description:"…"}]` (present when the test emits them) | **which account/product** | ❌ **DROPPED** — the clean fix for "which product/account" |
| `result.attachments[]` | `{name:"trace",path:"…/trace.zip"}`, `{name:"screenshot",path:"…test-failed-1.png"}`, `{name:"error-context",...}`, `{name:"video",...}` | paths to sources 2 & 3 | ⚠️ trace+screenshot+error-context yes; **video no** |
| `result.stdout` / `result.stderr` | `[]` here; arrays of `{text}` chunks | app/test logs | ❌ dropped |
| `result.retry` / `result.duration` | `0` / `10643` | flakiness/timing | ✅ duration; retry via status |

### Error-message parsing — the discriminator and the gaps

The message is the single richest field. Parse these out of it:

- **The failed locator.** Prefer the dedicated `Locator:` line over inline text — it is
  the exact expression. Real value here:
  `getByRole('button').filter({ hasText: /advance payment/i }).first()`.
  - ⚠️ **Gap:** `heal/target.ts` matches `getByRole('button')` and **drops
    `.filter({ hasText: /advance payment/i })`, `.or(...)`, `.first()`, `.nth()`.**
    In this suite the identifying text lives in `.filter({ hasText })`, so the extractor
    loses the anchor entirely. A real locator extractor must keep the whole chain.
- **`Expected:` vs the failure reason — this is the drift-vs-real discriminator:**
  - `Received: <element(s) not found>` / `Error: element(s) not found` → the element
    isn't there → **locator drift** (or a real removal — the live DOM / AX tree decides,
    never the count of browsers).
  - `Received: hidden` → element exists but hidden → **maybe a real render bug**, not a
    selector problem. Do not route to heal on `hidden` alone.
- **Playwright phrasing varies by version/context** — both of these are the same
  not-found failure and both appeared in real data:
  - `expect(locator).toBeVisible() failed` … `Error: element(s) not found` (this run)
  - `Timed out 3000ms waiting for expect(locator).toBeVisible()` … `Received: <element(s) not found>` (local 1.61 capture)
  Match on the `element(s) not found` / `resolved to 0 elements` substring, not the headline.

---

## Source 2 — trace.zip (internal structure)

Unzip (fflate) and read the NDJSON streams. **Real entry listing** from the LockTheDeal
trace:

```
0-trace.trace      828 KB   library/browser event stream (actions, DOM, logs, console)
0-trace.network   1098 KB   resource-snapshot per request/response
test.trace          37 KB   test-runner stream (hooks, steps, the error+stack)
0-trace.stacks              per-action JS stack traces
resources/src@<sha>.txt     source files of the spec + helpers
resources/<sha>             DOM-snapshot resource bodies + the error-context.md copy
resources/page@…-<ts>.jpeg  screencast frames (video)
```

**Event types in `0-trace.trace`** (real counts from this run) and what each gives you:

| `type` | count | Real payload → what you learn |
|---|---|---|
| `context-options` | 1 | `viewport{1280×720}`, `isMobile`, `locale`, `colorScheme`, **`testIdAttributeName:"data-testid"`** (tells the explorer the project's testid attr), `title` (`file:line › test`) |
| `before` / `after` | 48 | every PW call: `apiName` (`browserContext.newPage`, `Before Hooks`, `locator.click`…), `method`, **`params`** (goto `url`, `selector`, `value`), `stepId`, snapshot refs |
| `log` | 144 | **human action narration** — the flow, verbatim: `navigating to "https://stageshop.livguard.com/products/68c956c082235f9f9805619b"`, `fill("110001")`, `waiting for getByRole('button').filter({ hasText: /advance payment/i }).first()` |
| `frame-snapshot` | 166 | serialized DOM at each step: `frameUrl` (**stable — read this**) + `html` tree as nested arrays (⚠️ **version-gated encoding, `version:7`; best-effort only, never the heal source of truth**) |
| `console` | 44 | page console — real: 44× `Failed to load resource: 404`. Useful for infra/JS-error signal; here it was **asset noise, not the failure cause** (don't over-weight console 404s). |
| `input` | 8 | user input events |
| `screencast-frame` | 269 | video frame refs (jpeg resources) |

**`0-trace.network`** — `resource-snapshot` per request. Real matched calls:
`GET https://stageshop.livguard.com/cart → 200`, `POST …/cart → 200`. This is where a
real API failure (5xx/401/404-on-XHR) lives, and where product SKU (in a product API
URL/body) and the account (auth'd `/user`/`/customer` call) can appear. **Stable field to
read: `snapshot.request.url` / `.method` / `snapshot.response.status`.** Do not depend on
body encoding.

**Trace extraction stability (memory `trace-used-for-url-only` still holds):**
- ✅ **Stable:** `frameUrl`, goto `params.url`, `log` messages, `apiName`/`method`,
  network `request.url`/`method`/`response.status`, `context-options`.
- ⚠️ **Fragile / version-gated:** the `frame-snapshot` `html` tree encoding. Read it only
  as best-effort corroboration; the **live DOM (or the AX tree) is the arbiter**.

---

## Source 3 — error-context.md (the underused goldmine)

Playwright writes an `error-context.md` attachment on failure: an **AX-tree (aria)
snapshot of the page at the moment it failed.** Verdict already opens this
(`heal/page-context.ts`) but **only greps it for validation phrases** (`not registered`,
etc.) and throws the rest away. The rest is the answer.

Real content from this run (abridged) — everything the failing test needed was sitting
right here:

```yaml
- main:
  - heading "Payment Options" [level=2]
  - button "UPI UPI"
  - button "Netbanking DISCOUNT 100 RS …"
  - button "Credit/Debit Card Surcharge 100 RS …"
  - button "EMI Pay in easy monthly instalments"
  - button "COD (Partial payment) Pay ₹2,160 now, ₹19,440 at delivery"   # ← the renamed element
  - button "Place Order"
  - link "Livguard INVERTUFF IT 2360TT 230Ah Inverter Battery (36M+24M)":
    - /url: /products/68c956c082235f9f9805619b                            # ← which product
  - paragraph: "SKU: IT 2360TT"                                           # ← which SKU
  - text: Subtotal ₹18,390 … Total ₹21,600                               # ← cart state
```

What the AX tree gives you, for free, offline (no live DOM, no browser):
- **The heal candidate** — the failing locator wanted a button matching `/advance
  payment/i`; the tree has `button "COD (Partial payment)…"`. Fuzzy-match the intent
  ("pay part now, rest on delivery" = advance/partial) → candidate found here.
- **Which product / SKU / price / cart state** — answers the "which product?" question
  with zero trace-scraping.
- **What the page looked like** — for the report's "Why", far better than an error line.

⚠️ It does **not** carry the account identity (not rendered). Account comes from either a
test `annotation` (best) or an auth'd network call in the trace.

---

## Locator hygiene rules (enforce on every candidate)

A heal candidate — or any locator Verdict suggests/mines — **must anchor on stable
identity, never on a volatile value.** These are the values that change between runs,
users, or deploys and make a locator flap:

- **Prices / currency:** `₹2,160`, `₹19,440`, `Rs. 100`, `$49.99`
- **Discounts / surcharges / cashback:** `DISCOUNT 100 RS`, `Surcharge: ₹100`, `You save ₹100`
- **Quantities / counts / percentages:** `Cart Items (1)`, `8 offers available`, `20% off`
- **Dates / times / timers:** `2026-07-16`, `12:30`, countdowns
- **Any thousands-separated or currency-adjacent number.**

Example from the real run — the button's accessible name is
`"COD (Partial payment) Pay ₹2,160 now, ₹19,440 at delivery"`. The only legal anchor is
**`COD (Partial payment)`**. A locator built on the price tail would break the next time
the cart total changes — a self-inflicted flake, worse than the drift it "fixed".

**Not volatile — do not strip:** model numbers / SKUs / identifiers embedded in names
(`INVERTUFF IT 2360TT`, `230Ah`, `36M+24M`). Those are stable identity. The volatile
detector is deliberately narrow (currency / %, discount phrasing, thousands-separated
numbers, dates/times) so it never mangles a product name.

Implemented in `heal/ax-context.ts` (`hasVolatile`, `stableAnchor`); the same principle
must gate the online explorer's candidates and any future scorer. Verified: the AX miner
turns that COD button into `getByRole('button', { name: /COD \(Partial payment\)/i })`.

## Whole-artifact check runs on EVERY run (in triage)

`verdict triage` (cheap, non-blocking, every CI run) now reads the artifact deeply, not
just the error headline: it classifies from the full message, extracts the on-page reason
from the AX tree (`page-context.ts`), and for every `SELECTOR_BROKEN` failure mines the
offline heal shortlist from the AX snapshot (`ax-context.mineAxCandidates`) — no browser,
so it is cheap enough to ride along every run. The heavy online steps (live-DOM discovery,
apply + re-run) stay out-of-band. Net: the "check the whole artifact before deciding" rule
is enforced automatically on every run, not left to a human or a nightly job.

## The extraction protocol (do this before reasoning)

For any failing test, in order:

1. **Report:** testName, project, status/retryPassed, **full** `error.message`,
   `errorLocation`, `annotations`, attachment paths.
2. **Locator:** parse the `Locator:` line — **keep the entire chain** (`getBy…` +
   `.filter({hasText})` + `.or()` + `.first()/.nth()`). Never reduce it to `getByRole(role)`.
3. **Discriminator:** `not found` → drift candidate; `hidden` → likely real. Never decide
   drift-vs-real by counting browsers — drift fails on every browser too.
4. **error-context.md:** read the whole AX tree — extract candidate element(s), product,
   cart/page state. This alone often closes the case.
5. **trace.zip only if 1–4 insufficient:** `log` for the flow, `network` for API
   status/product/account, `context-options` for testid attr + device.
6. **Then, and only then, classify / report / propose a heal.** If a fact isn't in the
   evidence, say "unknown — not in artifact," never guess it.

---

## Gap analysis — what Verdict extracts vs. drops (as of 2026-07-16)

| Evidence | Available in artifact | Verdict extracts? | Fix |
|---|---|---|---|
| Locator `.filter({hasText})` / `.or()` / `.first()` chain | ✅ report `Locator:` line | ❌ `target.ts` drops filters | extend `parseBrokenTarget` to keep the full chain |
| `errorLocation` file:line:col | ✅ report | ❌ | thread into `FailureContext`; use in `apply.ts` instead of text search |
| `annotations` (account/product) | ✅ report (when emitted) | ❌ | ingest `test.annotations`; surface in report — the clean "which product/account" |
| error-context AX tree (candidates, product, state) | ✅ `.md` | ✅ **done 2026-07-16** — `ax-context.mineAxCandidates` mines offline candidates + "page now has" shortlist, volatile-stripped, in every-run triage | — |
| locator hygiene: no volatile values (price/qty/discount) in anchors | n/a (rule) | ✅ **done** — `hasVolatile`/`stableAnchor`; must also gate the online explorer | extend to explorer scorer |
| drift-vs-real discriminator (`not found` vs `hidden`) | ✅ report message | ⚠️ partial | classify on `not found`; keep `hidden` out of heal |
| classifier: not-found cross-project → SELECTOR_BROKEN | ✅ | ✅ **fixed 2026-07-16** (`LOCATOR_NOT_FOUND`, validated on this run) | done |
| network status / product API / account API | ✅ trace `.network` | ❌ (URL only) | read `request.url`/`response.status` for infra + product/account |
| console errors / stdout / stderr | ✅ trace / report | ❌ | optional infra/JS-error signal (don't over-weight asset 404s) |
| video.webm | ✅ attachment | ❌ | path only, if ever needed |

**Do not "fix" any of these blind.** Each row is a change to make deliberately, verified
against a real artifact (regenerate one with the local capture recipe below), never a
fixture guessed from memory.

### Local capture recipe (regenerate real evidence any time)
`npx playwright test` with `use:{ trace:'on', screenshot:'on' }` and `--reporter=json`
against a spec that asserts a missing locator produces a real report + trace + screenshot.
Unzip the trace with fflate; the streams are `*.trace` (NDJSON) and `*.network`. Never
reason about trace/report shape from docs alone — dissect a real one.
