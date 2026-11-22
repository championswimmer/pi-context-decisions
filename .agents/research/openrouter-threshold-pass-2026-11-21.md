# OpenRouter score threshold check — 2026-11-21 UTC

**Recommendation: keep the shared normalized default at `0.375` (raw `0.75` on the 0–2 scale).** Higher thresholds removed irrelevant picks for the only model that returned scores, but this is not a cross-model result and says nothing directly about tool or MCP gating.

## What ran

One score-only pass over all ten [ranked models](openrouter-weekly-popularity-2026-11-21.md), including Luna as a diagnostic despite its existing catalog exclusion. Each model received one request per four labeled demo cases (three related, one unrelated), using `runOnce`'s production score arm over 30 skill names and descriptions. Only public demo metadata and prompts were supplied; labels and skill bodies were not sent. Used the direct OpenRouter backend with Pi-first credential resolution and environment fallback, fail closed, cap 12, and a benchmark timeout of 20 s. A one-attempt request monitor per model/case prevented retries. No choice calls, tool/MCP evaluations, or Pi-native classifier calls were made.

**40 physical requests, 4 successes, 36 failures, 0 retries.** Successful responses reported **$0.0016543** in total usage cost. `google/gemini-decision-1` returned all 30 scores on each of its four calls, resolving to `google/gemini-decision-1-20261111` (end-to-end 331–432 ms). Each of the other models failed on all four cases:

- HTTP 404 with a guardrail indicator: `typesafe/jev-1.13`, `typesafe/jev-1.14`.
- HTTP 404 without that indicator: `perplexity/pplx-decider-v1.2`, `liquid/d1-ultra`, `perplexity/pplx-decider-v1.3:free`, `liquid/d1.1`, `openai/gpt-6-luna-decisions`, `perplexity/pplx-decider-flash-v1.3:free`.
- HTTP 422: `nace-ai/drex-max`.

These observations apply to this account, endpoint, and 30-question score payload. No follow-up calls on smaller batches or alternative credentials were made. The catalog remains a popularity snapshot, not a list of models verified to serve this workload. The existing Luna exclusion remains in place.

## Offline re-selection of Gemini's successful responses

Each row uses the same saved scores, production cap of 12 per case, and inclusive eligibility (`score >= 2 × threshold`). Required/acceptable/off-topic counts are totals over the three related cases. No additional inference was made for the sweep.

| Normalized threshold | Required caught | Acceptable picks | Off-topic picks | Picks on unrelated control |
| ---: | ---: | ---: | ---: | ---: |
| 0.25 | 11/11 | 13 | 10 | 2 |
| **0.375 (current)** | **11/11** | **13** | **10** | **0** |
| 0.40–0.475 (tested at 0.025 steps) | 11/11 | 13 | 9 | 0 |
| 0.50 | 11/11 | 12 | 8 | 0 |
| 0.55 | 11/11 | 9 | 7 | 0 |
| 0.625 | 11/11 | 6 | 2 | 0 |
| 0.75 | 11/11 | 1 | 0 | 0 |

The current threshold already rejected every skill on the unrelated control; lowering it to `0.25` or `0.30` added two unrelated picks. For Gemini, `0.625` is worth testing on held-out tasks if fewer extra advertisements matter: it cut off-topic picks from 10 to 2 without missing any required skills here, but also discarded seven plausible adjacent skills. `0.75` discarded most adjacent help. One model and four author-labeled tasks are too little evidence to raise a setting that also applies to tools, MCP groups, and other backends.

## Retest after resetting OpenRouter auth

On the user's request, repeated the same 40-request pass with their current credentials. Pi's public registry resolved an OpenRouter OAuth credential, and `OPENROUTER_API_KEY` was unset. Gemini again succeeded on all four cases; the other nine models repeated their original HTTP statuses and guardrail indicators on all four cases. No 401 or 403 was observed. Gemini's threshold sweep produced the same selection counts and provider-reported cost ($0.0016543 for this retest). This does not establish whether the failures are specific to OAuth, account routing, or the payload. No default or catalog change was made for the retest.

## Environment API key retest

Repeated the same 40 requests using only `OPENROUTER_API_KEY`, bypassing Pi's credential lookup for this diagnostic. Results matched the OAuth retest: Gemini 4/4, eight models 0/4 with HTTP 404 (guardrail indicator on both TypeSafe models), and Drex Max 0/4 with HTTP 422. No 401 or 403, and no retries. The threshold sweep counts were unchanged. OpenRouter reported $0.0016543 for the successful requests. Changing the credential source did not fix the failures on this workload; that pass did not test smaller batches or native Pi routing.

## Follow-up: distinguish policy 404s from the Drex batch limit

Compared the extension's encoder with the [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) and [OpenRouter's Decisions guide](https://github.com/OpenRouterTeam/skills/blob/main/skills/openrouter-decisions/references/decisions-api.md). The extension uses the documented `/api/alpha/decisions` request: a catalog `model` ID, `state`, and a question-ID-keyed `questions` object with ordered `criteria` for `score`. The documented `/api/v1/systemone` accepts the same envelope; paired probes on five models reproduced their one-question results on both endpoints.

With only `OPENROUTER_API_KEY`, one-question probes showed distinct failures:

- Both TypeSafe Jev models returned 404 because no endpoint matched the applied guardrail data policy.
- The three Perplexity variants, two Liquid variants, and GPT-6 Luna Decisions returned 404 because no providers were allowed under the account privacy settings. These errors explicitly pointed to OpenRouter's Privacy page. The probes do not identify the individual setting responsible; check [account Privacy](https://openrouter.ai/settings/privacy) and any [workspace/key Guardrails](https://openrouter.ai/docs/guides/features/guardrails.md) without loosening policy unless intended.
- Gemini and Drex Max succeeded with a single score question. For Drex Max the production request succeeded at 16 questions and returned the same 422 at 17, 18, and 19. A synthetic 30-question request with tiny state also failed, while the full demo state with five questions worked. The existing picker scored all 30 candidates against Drex Max with **Shard size = 16** (16 + 14 questions, both HTTP 200). This is the observed limit on this route; it is not a universal OpenRouter cap.

The investigation used 35 bounded direct POSTs, no retries, and $0.00113316 in reported cost. It did not change account policies, code, catalog, or defaults. The Drex smoke pass verified compatibility with batching, not threshold quality on the full labeled case set.

## Retest after account policy changes

Ran all ten ranked models with the environment key only, again with four labeled cases and no retries. Each case used one 30-question batch, except Drex Max used 16 + 14. **44 physical POSTs**, $0.001434972 reported cost.

- **4/4 cases succeeded:** `typesafe/jev-1.13`, `typesafe/jev-1.14`, `nace-ai/drex-max`. The two Jev models previously returned guardrail 404s.
- **0/4, HTTP 404 with a guardrail indicator:** `google/gemini-decision-1`, which previously worked.
- **0/4, HTTP 404 without that indicator:** `perplexity/pplx-decider-v1.2`, `perplexity/pplx-decider-v1.3:free`, `perplexity/pplx-decider-flash-v1.3:free`, `liquid/d1-ultra`, `liquid/d1.1`, `openai/gpt-6-luna-decisions`. These six previously reported that no providers were allowed by account privacy settings; this retest did not inspect the exact policy again.

Among successful runs, the shared `0.375` threshold found 33/33 required picks, with 24 off-topic picks across positive cases and three picks on the unrelated case. `0.55` retained 33/33, reduced off-topic picks to 18, and removed all unrelated-control picks. `0.625` also retained 33/33 and reduced off-topic picks to 14, but removed 11 acceptable picks relative to `0.375`. For Drex alone, `0.425` kept all 11 required picks and eliminated its two off-topic picks. These are candidates to validate on held-out tasks, not evidence to change a shared default for all backends and tool/MCP gating.

### Second retest after account policy changes

Repeated the same environment-key-only benchmark: 44 physical POSTs, no retries, $0.001434972 reported cost. The same three passed all four cases: `typesafe/jev-1.13`, `typesafe/jev-1.14`, and `nace-ai/drex-max` with 16 + 14 questions. All other models still returned 404 on every case. Both Gemini and Luna showed guardrail indicators this time; no exact policy was inferred for the other five. At `0.55`, the successful models retained all 33 required picks and reduced off-topic picks from 25 to 18 and unrelated-control picks from three to zero versus `0.375`. No defaults or catalog entries were changed in this retest.

### One-attempt check after removing Jev 1.13

After the user opted to keep only Jev 1.14 in the OpenRouter catalog, tested the other nine originally ranked models, including Luna for diagnosis. Each received one 16-question score request against public demo metadata, with `OPENROUTER_API_KEY` only and no retries. Both Jev 1.14 and Drex Max returned all 16 scores (HTTP 200). The three Perplexity and two Liquid variants returned privacy-settings 404s; Gemini returned a guardrail-related 404; Luna returned 404 without either indicator in this probe. Nine requests, $0.000100338 reported. This compatibility check did not re-evaluate thresholds.

### Additional models outside the top ten

Fetched the public Decisions catalog (40 concrete IDs plus five redirects). As a separate account compatibility check, sent one three-level score question about a public fact to each of the 30 concrete IDs outside the original ten, using only `OPENROUTER_API_KEY` and no retries. Twelve returned HTTP 200 and a valid score:

- Baseten: `baseten/groundhog-1`, `baseten/joey-1`, `baseten/mammoth-1`, `baseten/elephant-1`.
- Cloudflare: `cloudflare/clef`, `cloudflare/clef-flash`, `cloudflare/clef-omni`.
- Microsoft: `microsoft/microsoft-decision-1`, `microsoft/microsoft-decision-1.1`.
- Nace: `nace-ai/drex-max-finance`, `nace-ai/drex-v1.5`, `nace-ai/drex-v2.0`.

Sixteen returned 404 (15 privacy-settings indicators, one guardrail indicator). `baseten/bison-1` returned 429 and `cloudflare/clairic` returned 400; neither was retried. Total reported cost was $0.000049476. This did not validate larger batches, relevance quality, or Pi-native compatibility. The extension's static picker was not backfilled.
