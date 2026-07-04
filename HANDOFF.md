# Verdict — Handoff & Decisions

> Read this first. It carries the product intent and every decision made so a new
> session (or teammate) does not relitigate settled ground. Source of these
> decisions: a design session in the `livguard-ecomm` QA framework repo, 2026-07-04.

## One-line product
**Verdict renders a verdict on every failing test:** real bug, locator drift
(auto-healed), or flaky (scored) — an open-source, Playwright-native,
CI-artifact-driven triage + self-heal layer you drop on top of an existing suite.

## How it works (the loop)
1. **Ingest** a CI test report + artifacts (Playwright JSON first; trace/screenshot).
2. **Classify** each failure via the deterministic 5-rule engine → `FailureCategory`.
3. **Heal** — on `SELECTOR_BROKEN`, run an explorer-style agent against live DOM to
   rediscover the locator. **Auto-apply only above a confidence gate; otherwise
   propose (flag/PR), never silently apply.**
4. **Score** — everything else runs through the flakiness rules → persistent score.
5. **Display** — dashboard: verdicts, flakiness scores, and **self-heal success rate**.

## Decisions locked (do not reopen without reason)
- **Build this (was "idea #3"). Idea #1 is dropped.**
- **Standalone repo, not inside livguard-ecomm.** That framework is the *proof case*
  we test against, not the product's home.
- **Positioning wedge:** OSS + Playwright-native + CI-artifact-driven. Do NOT compete
  head-on with Healenium (Selenium), Testim/Mabl/Functionize (closed SaaS, own
  recorders). The free, Playwright-native, drop-on-top niche is the gap.
- **The make-or-break risk is heal *correctness*.** A wrong heal ships a false green —
  worse than a red test. The **confidence gate is non-negotiable**: below threshold →
  PROPOSED, never HEALED. Every heal is logged with confidence + old/new selector.
- **Go-to-market:** ship free on GitHub first; validate on real repos; then freemium
  (15-day trial) and possibly sell. Goal: a *product* to show, not just a framework.
- **Build-first, test-on-livguard, then decide.**

## MVP scope (what "done" means for v0.1)
The MVP must prove exactly ONE thing: **the heal loop is trustworthy and measurable.**
Everything else is ported and already proven.

- [x] `FailureContext` shape + `ClassificationContext` — the classifier seam (`src/core/types.ts`)
- [x] 5-rule classifier ported + generalized (`src/core/rules.ts`)
- [ ] Playwright report ingester → `FailureContext[]` (`src/ingest/`)
- [ ] Heal loop: explorer → candidate locator + confidence → gate → apply-or-propose (`src/heal/`)
- [ ] `heals.ndjson` logger + self-heal-success-rate metric (heal stayed green next run ÷ total)
- [ ] Minimal dashboard tile for verdicts + heal rate

## Out of scope for v0.1
Multi-framework ingest (Jest/JUnit), hosted SaaS, auth/billing, PR-bot integration.
Prove the loop on one repo first.

## What NOT to assume (carried lessons)
- Inspect the **screenshot/trace artifact before classifying** — infra (502/503) reads
  as selector-rot in the error text.
- "Explorer found a locator" ≠ "found the *correct* locator." That gap is the whole risk.
- Verify any selector against **live DOM** before trusting it — never from code review alone.
