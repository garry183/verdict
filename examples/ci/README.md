# Running Verdict in CI

One job: `verdict triage`, run after your test workflow. It's near-zero cost — reads the
JSON report, no browser — so it can run every time and doesn't need to gate the build
(`--strict` opts in to failing the step on a real regression).

> Self-healing (a second `heal` job that rediscovered and applied drifted locators) has
> been removed for now — see the note at the top of the repo's `README.md`. The examples
> below cover triage only.

## Files

- `github-actions/verdict-triage.yml` — triage after your test workflow.
- `bitbucket-pipelines.yml` — Bitbucket parity (same resolved commands).

## Wire-up checklist

1. Point the triage trigger at **your** test workflow name and artifact paths.
2. Keep the two platforms in parity — same resolved commands, same secret names. Re-check
   after any edit (`/cicd-pipeline --audit`).

## CLI

```
verdict triage    <report.json...>      [--suite s] [--json out] [--html dash.html] [--strict]
verdict dashboard <verdict-report.json> [--out dashboard.html]
```

`triage --html` emits a self-contained dashboard (verdict category breakdown + per-test
detail).
