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
Verdict: an open-source, Playwright-native, CI-artifact-driven test-triage layer. It
classifies every failing test (real bug / locator drift / flaky / infra / environment /
auth / missing-route / security finding / threshold drift) — deterministically, no AI.

**Self-healing is removed for now, not gone.** An earlier version rediscovered a drifted
locator on the live DOM and applied it behind a confidence gate. That code is intact on
the `archive/self-heal` branch (pushed to `origin`), not deleted — paused pending more
real-world validation, not abandoned. Don't reintroduce heal code on `main`/`selftest`
without an explicit decision to do so; if asked to work on heal, start from that branch.

Full product context + MVP scope + locked decisions: **`HANDOFF.md`**.
Reusable source to port from the origin framework: **`ASSETS-TO-PORT.md`**.

## Architecture
```
src/core/     — types.ts (FailureContext, the classifier seam) + rules.ts (8-rule engine). PORTED, stable.
src/ingest/   — CI report → FailureContext[]. Playwright JSON first.
```

- **`FailureContext`** (`src/core/types.ts`) is the single seam: every ingester writes
  it, every rule reads it. Change it deliberately.

## Conventions
- TypeScript, ESM (`"type": "module"`), NodeNext resolution. `.js` extensions in imports.
- `npm run typecheck` before committing.
- The classifier stays deterministic — no LLM in the classify path.

## Origin
Ported from `D:\Frameworks\livguard-ecomm` (a Playwright QA framework). The `brain/`
(flakiness), `agents/explorer/` (locator discovery), `scripts/ci-triage.js`
(artifact parsing), and `dashboard/` there are the prototypes for Verdict's four
subsystems. Port *logic*, strip livguard coupling (staging URLs, config/env).
See `ASSETS-TO-PORT.md`.
