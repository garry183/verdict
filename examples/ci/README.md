# Running Verdict in CI

Two jobs, deliberately separate. The split is the whole cost model:

| Job | When | Cost | Blocks? |
|---|---|---|---|
| **triage** (`verdict triage`) | every test run | near-zero — reads JSON, no browser | no (opt-in `--strict`) |
| **heal** (`verdict heal`) | nightly / after deploy / manual | high — browser + one re-run per drift | no, never a PR gate |

**Why not in the PR gate:** classification is free and can run every run; healing drives a
browser and re-runs tests, so it runs out-of-band on drift only and opens a PR you review.
Triage tells you *what* broke on every run; heal *fixes* locator drift on its own schedule.

## Files

- `github-actions/verdict-triage.yml` — triage after your test workflow.
- `github-actions/verdict-heal.yml` — scheduled/manual heal → opens a PR.
- `bitbucket-pipelines.yml` — Bitbucket parity for both (same resolved commands).

## Wire-up checklist

1. Point the triage trigger at **your** test workflow name and artifact paths.
2. Set `DEPLOY_URL` (the live app the heal explorer verifies against) on both platforms.
3. For heal PRs: GitHub uses `peter-evans/create-pull-request`; Bitbucket needs
   `BITBUCKET_TOKEN`, `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG` and opens the PR via REST.
4. Keep the two platforms in parity — same resolved commands, same secret names. Re-check
   after any edit (`/cicd-pipeline --audit`).

## CLI

```
verdict triage    <report.json...>      [--suite s] [--json out] [--html dash.html] [--heals heals.ndjson] [--strict]
verdict heal      <report.json...>      [--base-url u] [--apply] [--gate 0.75] [--project-dir .] [--log heals.ndjson]
verdict dashboard <verdict-report.json> [--heals heals.ndjson] [--out dashboard.html]
```

`triage --html` emits a self-contained dashboard (verdict breakdown + self-heal success
rate tile). The rate joins past heals (`heals.ndjson`, from the heal job's artifact) against
this run's failures — a healed locator that reappears as a failure counts against it.

`triage` classifies; if it finds `SELECTOR_BROKEN`, run `heal`. `heal` without `--apply`
proposes only (no source edits). With `--apply`, an edit is kept only if the re-run confirms
the test ran **and** passed — otherwise it reverts and stays PROPOSED.
