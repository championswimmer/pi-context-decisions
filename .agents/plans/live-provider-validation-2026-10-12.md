# Live provider validation — 2026-10-12

## Scope and authorization

The user authorized billable TypeSafe and OpenRouter inference with environment credentials, and removal of unroutable/guardrail-restricted models. Keys were checked for presence only and never printed, stored, or included in this report. No OpenAI-direct calls were made.

One tiny non-sensitive request used `state = {text: "The sky is blue on a clear day.", topic: "weather"}` and three named questions: `bool` (does the text say blue), `choice` (weather/cooking), and `score` (irrelevant/related/directly relevant). It exercised the real `createDecisionClient` and direct backend implementations, including auth, fixed endpoint, codecs, and response validation. Calls were sequential with a 15-second whole-call timeout, existing bounded transport retry policy, and only one confirmation per restricted model. All attempts completed without transport retries.

## Observed results

| Backend/model | HTTP | P(true) | Choice | Score 0–2 | Calls | Reported USD cost |
|---|---:|---:|---|---:|---:|---:|
| TypeSafe `jev-latest` | 200 | 0.99 | weather | 1.98 | 1 | Not reported |
| OpenRouter `typesafe/jev-1.13` | 200 | 0.99 | weather | 1.98 | 1 | 0.000017976 |
| OpenRouter `perplexity/pplx-decider-v1.1-27b` | 200 | 0.9981381724022358 | weather | 1.368520038080542 | 1 | 0.000006680 |
| OpenRouter `openai/gpt-6-luna-decisions` | 404 twice | — | — | — | 2 | Not reported |
| OpenRouter `cloudflare/clef-flash` | 200 | 0.9774 | weather | 1.5168 | 1 | 0.000011818 |
| OpenRouter `inception/mercury-decide:free` | 404 twice | — | — | — | 2 | Not reported |
| OpenRouter `liquid/d1` | 200 | 0.999954602127873 | weather | 1.6779338909178354 | 1 | 0.000008280 |
| OpenRouter `cloudflare/clef` | 200 | 0.9872 | weather | 1.7825 | 1 | 0.000074640 |
| OpenRouter `nace-ai/drex-v1.5` | 200 | 0.9979 | weather | 1.8785 | 1 | 0.000003840 |
| OpenRouter `microsoft/microsoft-decision-1` | 200 | 0.9992903294039388 | weather | 1.3450767472221106 | 1 | 0.000005208 |
| OpenRouter `upstage/solar-decide` | 200 | 0.994659 | weather | 1.962763 | 1 | 0.000057000 |

**13 physical POSTs**: one TypeSafe, eight successful OpenRouter, and four restricted OpenRouter attempts. Successful OpenRouter `usage.cost` sums to **USD 0.000185442**, as reported by the responses; this is not an independently reconciled bill and does not imply TypeSafe or failed calls cost zero. No raw error bodies or credentials were logged. The transport maps HTTP 404 to `invalid_request`; an injected monitoring fetch checked error text only in memory and emitted boolean `guardrail: true`, `unavailable: false` for both attempts on each excluded model.

Both excluded models consistently failed on this account with guardrail-associated HTTP 404. This is not evidence of global unavailability. No schema, auth, transient rate-limit, timeout, or server errors occurred among retained models. All successful models returned `noul`, `choice`, and `score` with expected answer fields; TypeSafe passed its stricter metadata checks. No core implementation fix was needed for these live schemas.

## Catalog patch

- Removed `openai/gpt-6-luna-decisions` (original rank 3) and `inception/mercury-decide:free` (original rank 5).
- Retained **eight** models, in original descending weekly-token order; no replenishment from lower ranks.
- Preserved original snapshot date 2026-10-12, usage window October 5–11, original count 10, original `popularityRank`, and original token counts.
- Recorded excluded IDs and routing-check date in static metadata. Native Pi and direct picker/configuration paths share the same retained allowlist.
- Runtime discovery/rankings/cache remain absent. Future catalog updates are reviewed code changes.
- Original full ten and discovery provenance remain in `.agents/plans/openrouter-weekly-popularity.md` and Git history; this follow-up does not overwrite historical research.

## Reproduction (explicit opt-in, billable)

```bash
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts
# Optional allowed model-ID arguments limit calls, for example:
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts jev-latest typesafe/jev-1.13
```

Set `TYPESAFE_API_KEY` and/or `OPENROUTER_API_KEY` in the environment. Do not pass keys as CLI arguments. The script uses env-only credentials (no host registry supplied), excludes OpenAI-direct operations, never emits raw provider errors/auth headers, and is outside default offline checks. Removed models cannot be selected through the reusable smoke script after pruning.

## Verification and limitations

Executed catalog tests: **9/9 passed**. Local `npm run typecheck`, a scoped strict TypeScript check of `scripts/live-smoke.ts`, and `git diff --check` passed. Script without explicit opt-in exited 2 before network access. Full suite initially produced **152/154 passing**: the two failures were stale extension/settings test assumptions (hard-coded ten and a removed free model used for settings round-trip), reported to the integration owner rather than edited out of scope. The final full-suite rerun is pending those integration-owner fixture repairs; this task does not claim an all-green suite.

These calls verify one text-only fixture through direct backends, not task quality, all rubric/cardinality sizes, multimodal support, native Pi routing, account-independent availability, or terminal UI rendering. Availability and guardrails can change later; this remains a static account-observed snapshot, not a runtime health check.
