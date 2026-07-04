# Assets to Port from livguard-ecomm

Origin repo: `D:\Frameworks\livguard-ecomm`. Verdict's four subsystems each have a
working prototype there. **Port the logic, strip the coupling** (staging URLs,
`config/env`, livguard DOM specifics). Do not `cp -r`.

| Verdict subsystem | Origin source | Status | Port notes |
|---|---|---|---|
| **Classifier core** | `brain/types.ts`, `brain/rules.ts` | ✅ Ported → `src/core/` | `RuleContext` → `ClassificationContext`; `NormalizedTestEntry` → `FailureContext`. Decoupled from Playwright report shape. |
| **Ingest** | `scripts/ci-triage.js` (`parsePlaywright`), `brain/analyze.ts` | ⬜ TODO → `src/ingest/` | Reuse the recursive `walkSuites` parser. Add artifact-path extraction (screenshot/trace) — the origin drops these; Verdict needs them for the heal loop. |
| **Persistence / scoring** | `brain/history.ts`, `brain/health.ts` | ⬜ TODO | `run-history.ndjson` + `test-health.json` scoring logic. Quarantine thresholds: healthy <0.2, watch <0.5, quarantined ≥0.5. |
| **Heal engine** | `agents/explorer/crawl-homepage.mjs`, `.claude/agents/explorer.md` | ⬜ TODO → `src/heal/` | The explorer's semantic-locator discovery + `.or()`-chain + confidence scoring IS the heal engine. Extract the per-element strategy scorer; feed it the broken test's target. **The confidence number it already produces is the gate input.** |
| **Dashboard** | `dashboard/generators/` | ⬜ TODO | Display layer. Add a self-heal-success-rate tile (new — origin has no heal concept). |

## Key origin lessons that shaped these types
- `brain/rules.ts` REAL_REGRESSION = "2+ projects fail same test" — kept, generalized.
- Explorer schema v2 already emits `confidence` (1–5) per strategy + `.or()` chains and
  flags `testability_gap` — that scoring is exactly what the heal gate consumes.
- Origin `ci-triage.js` documents an `ANTHROPIC_API_KEY` "enhanced root-cause" path that
  it never implements. Verdict's LLM surface, if any, lives in the gated heal path — not
  the deterministic classify path.

## Do NOT port
- Anything importing livguard `config/env`, `STAGING_BASE_URL`, or `@pages/@modules`.
- Livguard-specific DOM facts (cart aria-labels, pincode headers, cookie-consent overlay).
- The two-account CI auth machinery — product-repo concern, not Verdict's.
