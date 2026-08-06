# CLAUDE.md — Verdict

Guidance for Claude Code working in this repo. **On session start, read `HANDOFF.md`
first** — it holds the product intent and locked decisions.

## Rule 0 — Never assume what a run contains. Extract it.
Before reasoning about ANY failing test — its locator, its cause, which product/account
it used, drift vs. real bug — **read the evidence from the actual artifacts**, don't
guess from the error headline and don't spot-check a *guessed* element. The full
inventory of what a Playwright run carries (report fields, trace.zip streams,
error-context AX tree) and how to pull each is in **`RUN-EVIDENCE.md`** — the ground
truth dissected from real runs. Every classifier/heal/report change must be verified
against a real regenerated artifact, never a fixture invented from memory. This rule
exists because reasoning from the headline instead of the evidence caused three separate
misreports on one run (drift called REAL_REGRESSION; useless report line; wrong element
chased).

## What this is
Verdict: an open-source, Playwright-native, CI-artifact-driven test-triage +
self-heal layer. It classifies every failing test (real bug / locator drift / flaky)
and, for locator drift, rediscovers and applies a correct locator behind a confidence
gate — tracking self-heal success rate.

Full product context + MVP scope + locked decisions: **`HANDOFF.md`**.
Reusable source to port from the origin framework: **`ASSETS-TO-PORT.md`**.

## Architecture
```
src/core/     — types.ts (FailureContext, the classifier seam) + rules.ts (5-rule engine). PORTED, stable.
src/ingest/   — CI report → FailureContext[]. Playwright JSON first.
src/heal/     — explorer → candidate locator + confidence → gate → apply-or-propose.
```

- **`FailureContext`** (`src/core/types.ts`) is the single seam: every ingester writes
  it, every rule reads it. Change it deliberately.
- **Heal correctness is the product.** Below the confidence gate → `PROPOSED`, never
  `HEALED`. A wrong auto-heal = false green = credibility death. Log every heal.

## Conventions
- TypeScript, ESM (`"type": "module"`), NodeNext resolution. `.js` extensions in imports.
- `npm run typecheck` before committing.
- Deterministic core (the 5 rules) stays deterministic — no LLM in the classify path.
  LLM/agent work belongs in the heal path only, gated.

## Origin
Ported from `D:\Frameworks\livguard-ecomm` (a Playwright QA framework). The `brain/`
(flakiness), `agents/explorer/` (locator discovery), `scripts/ci-triage.js`
(artifact parsing), and `dashboard/` there are the prototypes for Verdict's four
subsystems. Port *logic*, strip livguard coupling (staging URLs, config/env).
See `ASSETS-TO-PORT.md`.
