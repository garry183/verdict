# Verdict — Architecture & Build Plan

> **Tagline:** Verdict renders a verdict on every CI test failure — *real bug*, *locator drift (auto-healed)*, *flaky (scored)*, or *environment* — from the artifacts your pipeline already produces, keeping the model out of the test run and a human on the merge button.

This document is self-contained. It captures every decision needed to build Verdict v1. Implement from it directly.

---

## 1. What Verdict is (and is not)

- **Is:** an open-source, Playwright-native, **CI-artifact-driven** triage layer that classifies every test failure, **heals broken selectors in the test/automation code**, scores flakiness, and hands real application bugs to developers. Drop-on-top — **no test rewriting required**.
- **Is not:** a test *generator* (crowded), a runtime in-test healer (that's Playwright's own Healer + Healwright + Healenium), or a product-code fixer (deferred — see Roadmap).

### Positioning (how it differs from the field)
The market has point tools: Trunk/BuildPulse (flaky only), Healenium (selectors only), Ranger (RCA only), Playwright Healer (runtime). **No one owns the full loop as one OSS, zero-rewrite, artifact-driven, propose-only pipeline.** Lead with **triage + out-of-band safety + selector healing**, NOT with "self-healing" (a commoditized word now that Playwright ships its own healer).

---

## 2. Core principles (these are the differentiators — do not violate)

1. **The model is kept out of the safety-critical path.** Classification is deterministic. Any LLM use (roadmap) is fenced by a deterministic gate before it and a deterministic verify after it.
2. **A wrong heal ships a false green — worse than a red test.** Every heal passes a confidence gate; below threshold it is *proposed*, never applied.
3. **Propose, never auto-apply to what humans own.** Verdict edits **test/automation code** freely (its house). It **never edits application code** — real bugs are reported, not fixed. Nothing is ever auto-merged; a human merges every PR.
4. **Out-of-band, never on the PR merge gate.** The expensive work (healing) runs as a separate nightly/manual workflow, never blocking a developer's merge.
5. **Own our history.** Verdict persists its own results every run so history is durable and independent of CI artifact retention. The history store is the heart of the system.
6. **The cache is a hypothesis, not an oracle.** A cache hit is always re-verified against the live DOM before it is trusted.

---

## 3. Scope

### v1 (build now)
- POM-aware **classification** every run (deterministic).
- **Results store** (durable history) — NDJSON source of truth + SQLite query index.
- **Historical backfill** (best-effort, cap last 30 runs per provider).
- **Dedup** of failures into unique root causes.
- **Selector healing** (out-of-band, deduped, re-verified cache) → PR of test-code fixes.
- **Real-bug reporting** → draft Linear/Jira ticket → human approves → file.
- **Dashboard** with verdicts, heal rate, flake scores, and **heuristic fragility scoring**.

### Roadmap (explicitly deferred, keep as documented future)
- **Code-fix agent** for real application bugs (reproduce → LLM fix behind provider interface → verify → propose-only PR). Requires the git-history bug-benchmark (revert past fix-commits to manufacture real regressions) to validate accuracy.
- **ML predictive test selection** (train on pass/fail history + code-change graph). v1 does heuristic risk only.
- **Shared/team cloud store** (Turso or Supabase) for multi-repo dashboards.
- **Never predict specific bugs** — only fragility/flakiness *risk*.

---

## 4. Pipeline overview

```
Playwright tests run in CI (GitHub Actions / Bitbucket)
        │  (on failure → artifacts: results.json, trace.zip, screenshots)
        ▼
[A] INGEST + CLASSIFY  — cheap, runs EVERY build as a reporter step
        │   parse report + traces, POM-aware, deterministic 5-rule engine
        │   → append run summary to NDJSON history (the durable store)
        ▼
   classify each failure:
   ├─ FLAKY          → score + quarantine (persistent)          [terminal, emits metric]
   ├─ ENVIRONMENT    → warn & skip (502/503 infra)              [terminal]
   ├─ SELECTOR_BROKEN→ queue for heal                            → [B]
   └─ REAL_BUG       → queue for report                          → [C]

[B] HEAL  — expensive, OUT-OF-BAND (nightly / manual), separate CI workflow, time-capped
        checkout repo → rebuild SQLite index from NDJSON
        → dedup SELECTOR_BROKEN by signature (100 failures → few unique)
        → per unique selector: check cache (re-verify on use) → else explore live DOM (staging)
        → confidence gate → HEALED (auto-write to page object) / PROPOSED (flag)
        → append summaries, update cache, edit page-object files
        → commit to branch, open PR (human merges)

[C] REPORT — real bugs
        draft ticket (trace + root cause) → HUMAN APPROVES → file to Linear/Jira (deduped)

[D] DASHBOARD — verdicts, heal success rate, flake scores, fragility risk (zero-dep HTML)
```

---

## 5. Data architecture (the heart)

Two layers. **Files are the source of truth; the database is a rebuildable index.**

### Layer 1 — Source of truth: append-only NDJSON, committed to the repo
- Location: `.verdict/history/` (or a dedicated `verdict-history` branch to keep `main` clean).
- Format: newline-delimited JSON, **one line per run summary**.
- Why: free, no infra, no signup, version-controlled, human-readable, git-diffable, **survives CI artifact expiry**. Append is simple and merge-friendly.
- This is what makes history durable and independent of GitHub/Bitbucket retention.

### Layer 2 — Query index: SQLite (`better-sqlite3`), rebuilt from the NDJSON
- Location: `.verdict/index.sqlite` — **gitignored, disposable**.
- Rebuilt on demand via `verdict index` (reads all NDJSON → builds tables). Fast, local, no network.
- Used for: flake scoring, trend queries, dedup lookups, the cache table.
- **Never the system of record.** Delete and rebuild anytime from NDJSON.

### Why this survives ephemeral CI
CI wipes the filesystem each run, but SQLite **never needs to persist** — `checkout` brings the NDJSON history (it's in git), and Verdict rebuilds the index locally at job start. Git is the persistence; SQLite is a lens you regenerate. Optional: cache `index.sqlite` via CI cache if history grows large (pure optimization; rebuild-from-NDJSON is the reliable default).

### `Store` interface (pluggable)
Wrap persistence behind an interface so the location is swappable: `files+sqlite` (default, v1) → `turso` / `supabase` (roadmap, team scale). Same swappable pattern used everywhere in Verdict.

---

## 6. Classification (deterministic 5-rule engine — no LLM)

Input: parsed Playwright report + trace/screenshots + (when present) page objects.

**Inspect screenshots/traces BEFORE classifying** to avoid infra false positives (e.g. a 502 page is ENVIRONMENT, not REAL_BUG).

Categories (`FailureCategory`):
- `SELECTOR_BROKEN` — locator no longer resolves / resolves to wrong element (drift).
- `REAL_BUG` — assertion fails on a correctly-located element; app behaved wrong.
- `FLAKY` — non-deterministic; flips without a code change (needs history to confirm).
- `ENVIRONMENT` — infra failure (5xx, network, timeout on load), not a code problem.

Each verdict carries: category, confidence, root-cause summary, the failing selector (if any), the page-object `file:line` it maps to (if POM present), and links to trace/screenshot.

### POM-awareness (big lever)
Page Object Model files are the central **locator registry**. When present, Verdict:
1. Maps a failing locator to the exact page-object property + `file:line`.
2. Uses the property name (`checkoutButton`) as a **human-readable element description** for re-location — free intent, no LLM.
3. Heals at the source: fixing one POM entry fixes **all** tests using it (dedup at the definition).
4. Statically scans POM for brittle selectors → fragility scoring.

Fallback: when selectors are inline (no POM), classify/heal from trace + DOM instead. Support both; lean on POM when available.

---

## 7. Dedup

**Collapse many failure *instances* into the few unique *problems*.** A renamed button breaks 40 tests → 40 red results → **1 broken selector**.

- Compute a **signature** per failure: `hash(normalized selector + page/route + failure category)`.
- Same signature = same root cause = one group.
- Heal / report **once per group**, not once per red test.
- This is what keeps the out-of-band heal job cheap even with 100+ daily failures, and prevents duplicate PRs/tickets.

---

## 8. Healing (SELECTOR_BROKEN only, in v1)

Runs in the out-of-band workflow. Per unique broken selector:

1. **Cache check** — if a validated old→new mapping exists, use it **but re-verify** (see §9).
2. **Explore** — on cache miss, load the relevant page on **staging** (Playwright live DOM), re-locate the element using the POM property name / surrounding attributes.
3. **Verify** — confirm the candidate resolves to exactly one element; optionally re-run the affected test.
4. **Confidence gate:**
   - Above threshold → `HEALED`: write the new selector into the page-object file.
   - Below threshold → `PROPOSED`: flag for human, do not apply.
   - No candidate / no DOM → `SKIPPED` / `NO_DOM`.
5. Record heal (old selector, new selector, confidence, provenance) to the store + cache.
6. Bundle all heals into **one PR** for human review.

Explorer is deterministic in v1 (matches the existing repo design). No LLM required for healing.

---

## 9. Cache correctness (critical — a stale cache = a false green)

The cache stores validated old→new selector mappings to skip re-exploration. Rules:

1. **Verify on use — never blind-trust.** Even on a hit, confirm the cached new-selector resolves to exactly one element on the *current* DOM before applying. Fail → treat as miss, re-explore. **The cache speeds the answer; it never replaces verification.**
2. **Key tightly:** `old selector + page/route + app build/version`.
3. **Invalidate on app change:** tie entries to a DOM fingerprint / deploy / version; changed pages expire or re-verify.
4. **Expiry:** TTL (N days) or max-uses (M) forces periodic fresh validation.
5. **Confidence gate still applies** to cache hits — not an auto-apply.
6. **Provenance logged** per entry (when/how validated) for audit + purge.

Principle: **a cache hit is a hypothesis, re-checked against the live DOM before it is trusted.**

---

## 10. Real-bug reporting (Linear / Jira)

For `REAL_BUG` verdicts:
1. Draft a ticket (title, trace, root-cause summary, screenshot, failing test).
2. **Human approves** (never auto-file silently).
3. **Dedup against open tickets** by signature before filing (no 40 duplicate tickets from one root cause).
4. File via a `Reporter` interface: `linear` / `jira` / `github-issue` (swappable). REST APIs or MCP servers.

---

## 11. CI workflows (two separate jobs)

### Job A — Classify (cheap, every build, inline reporter step)
- Runs as a Playwright reporter / post-step.
- Reads `results.json` + traces, classifies, **appends run summary to NDJSON**.
- No browser exploration, no healing. Milliseconds. Safe to run on every build.

### Job B — Heal (expensive, out-of-band: nightly cron OR manual dispatch, time-capped)
Runs in CI (decision: final), as a **separate workflow**, never on the PR gate:
1. `checkout` repo → get `.verdict/history/*.ndjson`, page objects, tests.
2. `verdict index` → rebuild `.verdict/index.sqlite` from NDJSON.
3. Query index: pull `SELECTOR_BROKEN`, **dedup** by signature.
4. Per unique selector: cache-check (re-verify) → else explore staging DOM → gate.
5. Write: append NDJSON summaries, update cache, edit page-object files.
6. Commit to a branch, **open PR** (human merges).
7. Discard `index.sqlite` (rebuilt next run).

Requires a **staging URL** secret (app must be reachable for DOM exploration) — unrelated to the store.

Keep Job B cheap via: dedup (100 → few), cache (repeats near-instant), and a wall-clock time cap.

---

## 12. Interfaces (swappable, same pattern throughout)
- `Store` — `files+sqlite` (v1) → `turso` / `supabase` (roadmap).
- `Reporter` — `linear` / `jira` / `github-issue`.
- `CIProvider` ingest — `github` / `bitbucket` (both; user has history on both).
- `Fixer` (roadmap only) — `mock` / `gemini` / `claude-code` (subscription) / `anthropic` (API key). Build `mock` first so the whole path is testable free.

---

## 13. Dashboard
- Zero-dependency HTML (matches existing repo approach).
- Shows: verdicts by category, heal success rate, flake scores, PR/ticket acceptance, and **fragility risk tiles** (heuristic: deep CSS/XPath, `nth-child`, no `data-testid`, previously-drifted selectors).

---

## 14. Historical backfill (needs proper research at build time)
- **Constraint:** CI artifacts expire (GitHub Actions ~30–90 days; Bitbucket similar). Backfill is bounded by actual retention.
- **v1 approach:** classify existing/available historical runs, **cap to last 30 runs per provider** (enough for flake windows). Best-effort head start only.
- **The real record is going-forward:** every run appends a durable NDJSON summary from install day, so future history is fully owned regardless of provider retention.
- **Research when implementing:** exact retention on the user's GitHub + Bitbucket, report format variance, whether to snapshot into the store vs re-parse. (User has massive history on both — check their real settings.)

---

## 15. Tech stack
- Language: **TypeScript / Node** (matches repo).
- Test framework target: **Playwright** (v1; POM-aware).
- Store: **NDJSON (files) + `better-sqlite3` (index)**.
- CI: **GitHub Actions + Bitbucket Pipelines**.
- Reporting: **Linear / Jira** APIs (or MCP).
- Dashboard: **zero-dependency HTML**.
- License: **MIT** (already set).

---

## 16. Verification discipline (standing rule)
There is a **real project with live GitHub + Bitbucket CI** available as the permanent test bed. **Every component is verified against that real pipeline before it's considered done** — not just unit tests. Build → run on the real CI → observe real verdicts → confirm.

---

## 17. Suggested build order (phased)
1. **Store foundation:** NDJSON summary schema + `verdict index` (rebuild SQLite from NDJSON). This is the heart; build it first.
2. **Classify + persist:** wire the deterministic 5-rule engine to append summaries every run (Job A). Verify verdicts on the real project's failures.
3. **POM parser:** build the locator registry (property → selector → `file:line`) + fragility scan.
4. **Dedup:** signature computation + grouping.
5. **Heal loop (Job B):** explorer + confidence gate + cache (with §9 correctness rules) → write to page objects → PR. Verify on real drift.
6. **Reporter:** Linear/Jira draft → approve → file (deduped).
7. **Dashboard:** verdicts, heal rate, flake, fragility tiles.
8. **Backfill:** best-effort historical ingest (cap 30), after researching real retention.
9. **Roadmap items** (code-fix agent, ML prediction, cloud store) — later.

---

## 18. Repo note
All code lands in the **existing `verdict` repo** (github.com/garry183/verdict) — it's tested and working. Do not scaffold a new repo. Extend the current `src/` layout.

## Positioning one-liner for README (drop the word "self-healing" from the headline)
> **Verdict** — a Playwright-native, CI-artifact-driven triage layer. It classifies every failure (real bug / locator drift / flaky / environment), heals drifted selectors in your automation code behind a confidence gate, scores flakiness from its own durable history, and hands real bugs to your team via Linear/Jira — with the model kept out of the test run and a human on every merge.
