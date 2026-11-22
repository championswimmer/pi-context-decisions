# OpenRouter decision models vs. a manual skill baseline

**Measured November 22, 2026 UTC.** I labeled the tasks before making any decision-model request, then measured how well each model reproduced those decisions. The run used the account's `OPENROUTER_API_KEY` directly, not Pi OAuth. Of 40 concrete decision models, **24 returned a valid score in the opening probe, 23 completed all ten skill-selection cases, and one completed seven**. The run took **68.1 seconds** wall-clock from the first probe through the last case and used **520 POSTs** with no retries. OpenRouter reported **$0.031391** including the probes.

- **Best strict selection at the current threshold:** Clef Omni found all 22 required skills, added five acceptable skills and one off-topic skill, and selected nothing on the two unrelated tasks. Its median was **252 ms**, but one case took **3.87 s**.
- **Fastest among the currently selectable models:** Jev 1.14 had a **192 ms** median and **204 ms** p95. It found all 22 required skills but advertised **21 off-topic skills on related tasks**, plus two picks on the unrelated controls. Perplexity Decider Flash v1.3 also got all 22, with only four off-topic and one control pick, at **224 ms** median and zero provider-reported cost in this run.
- **Strong ranking but permissive selection:** Regular Perplexity Decider v1.3 (`:free`) and Microsoft Decision 1.1 both found **22/22** and ranked the required skills well (mean nDCG@12 **0.995** and **0.992**). They nevertheless added nine and 14 off-topic skills, respectively, at the default threshold. A good ranking does not guarantee a selective threshold.
- **Keep the shared default at `0.375`.** Raising it to `0.50` cut unwanted picks on the held-out cases without missing a required skill there, but lost three required picks on the development cases. This suggests a useful stricter setting to try, not a universal default.

## Baseline (written before inference)

The [frozen baseline JSON](decision-model-baseline.json) contains the exact prompts and the rationale for each label. I used only the [30 public demo skill names and descriptions](../../examples/skill-picker-demo/README.md). **Required** means advertise it; **optional** means it could help but is not required; **everything else is a deny** for that task. No decision model supplied those labels. The two unrelated controls deny all 30 skills.

| Task | Required: allow | Optional: acceptable but not required |
| --- | --- | --- |
| Signup keyboard validation | `react-components`, `form-validation`, `web-accessibility`, `browser-testing` | `product-copy`, `unit-testing`, `typescript-types` |
| Checkout webhook | `node-api`, `payments`, `database-migrations`, `email-delivery` | `postgres-queries`, `security-review`, `unit-testing`, `api-contracts`, `observability` |
| Read-only SQL report | `postgres-queries` | None |
| GraphQL field and contract | `graphql-schema`, `authentication`, `technical-docs` | `security-review`, `unit-testing` |
| Thunder explanation (control) | None | None |
| Container build and CI | `docker-containers`, `kubernetes-deploy`, `github-actions` | `observability`, `technical-docs` |
| CSV cleanup and tests | `python-data`, `python-testing`, `test-data` | None |
| Responsive CSS and tokens | `css-layout`, `design-tokens` | `web-accessibility`, `browser-testing` |
| Latency runbook | `incident-response`, `observability` | `technical-docs`, `kubernetes-deploy` |
| Cat poem (control) | None | None |

Across the ten cases the baseline contains **22 required, 16 optional, and 262 rejected** skill–case pairs. A required-only baseline has 22 picks and no unwanted picks by construction; that is the reference, not a measured model result.

## Results at the current threshold (`0.375`)

One row per model that completed **10/10** cases. Timing is end-to-end elapsed time for one case, from preparing the production score request to receiving, validating, and selecting from both parallel shards. P95 is nearest-rank (the maximum with ten samples). **Strict precision** counts only required picks as correct; **strict F1** balances that precision with required recall. Optional picks are shown separately and are **not** counted as off-topic. “Control picks” counts advertisements on the two tasks that require no skills. **nDCG@12** measures ranking before thresholding on the eight related tasks, with gain 3 for required and 1 for optional. Cost sums provider-reported values for the ten scored cases, not the opening probe; zero reported is not a pricing guarantee.

| Model | Median ms | P95 ms | Required found | Strict precision | Strict F1 | Optional | Off-topic | Control picks | nDCG@12 | Reported trial cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `cloudflare/clef-omni` | 252 | 3873 | 22/22 | 78.6% | 0.880 | 5 | 1 | 0 | 0.981 | $0.007424 |
| `baseten/joey-1` | 234 | 283 | 21/22 | 80.8% | 0.875 | 1 | 4 | 0 | 0.948 | $0.000442 |
| `nace-ai/drex-max-finance` | 401 | 530 | 22/22 | 75.9% | 0.863 | 6 | 1 | 0 | 0.990 | $0.000000 |
| `nace-ai/drex-max` | 728 | 1126 | 21/22 | 77.8% | 0.857 | 5 | 1 | 0 | 0.982 | $0.000000 |
| `baseten/groundhog-1` | 324 | 391 | 22/22 | 71.0% | 0.830 | 7 | 1 | 1 | 0.986 | $0.001563 |
| `cloudflare/clef-flash` | 389 | 674 | 21/22 | 70.0% | 0.808 | 5 | 4 | 0 | 0.971 | $0.000000 |
| `liquid/d1.1` | 265 | 509 | 22/22 | 66.7% | 0.800 | 9 | 2 | 0 | 0.986 | $0.000798 |
| `baseten/elephant-1` | 252 | 449 | 22/22 | 64.7% | 0.786 | 9 | 3 | 0 | 0.990 | $0.001546 |
| `cloudflare/clef` | 523 | 865 | 22/22 | 64.7% | 0.786 | 6 | 6 | 0 | 0.977 | $0.000000 |
| `perplexity/pplx-decider-flash-v1.3:free` | 224 | 292 | 22/22 | 62.9% | 0.772 | 8 | 4 | 1 | 0.987 | $0.000000 |
| `nace-ai/drex-v2.0` | 732 | 1113 | 22/22 | 62.9% | 0.772 | 10 | 3 | 0 | 0.978 | $0.000000 |
| `perplexity/pplx-decider-flash-v1.2` | 328 | 2573 | 22/22 | 61.1% | 0.759 | 9 | 4 | 1 | 0.989 | $0.000357 |
| `baseten/mammoth-1` | 294 | 353 | 22/22 | 61.1% | 0.759 | 10 | 4 | 0 | 0.984 | $0.004418 |
| `nace-ai/drex-v1.5` | 312 | 513 | 21/22 | 61.8% | 0.750 | 9 | 4 | 0 | 0.937 | $0.000000 |
| `perplexity/pplx-decider-v1.2` | 310 | 832 | 22/22 | 57.9% | 0.733 | 12 | 4 | 0 | 0.994 | $0.000715 |
| `liquid/d1.2-ultra` | 288 | 460 | 22/22 | 56.4% | 0.721 | 10 | 6 | 1 | 0.996 | $0.001675 |
| `liquid/d1.2` | 298 | 464 | 22/22 | 56.4% | 0.721 | 10 | 7 | 0 | 0.991 | $0.000798 |
| `perplexity/pplx-decider-v1.3:free` | 310 | 1356 | 22/22 | 50.0% | 0.667 | 12 | 9 | 1 | 0.995 | $0.000000 |
| `microsoft/microsoft-decision-1.1` | 338 | 715 | 22/22 | 42.3% | 0.595 | 14 | 14 | 2 | 0.992 | $0.001577 |
| `microsoft/microsoft-decision-1` | 462 | 809 | 22/22 | 38.6% | 0.557 | 13 | 20 | 2 | 0.994 | $0.001333 |
| `liquid/d1-ultra` | 254 | 795 | 22/22 | 38.6% | 0.557 | 14 | 20 | 1 | 0.992 | $0.001675 |
| `typesafe/jev-1.13` | 185 | 333 | 22/22 | 37.9% | 0.550 | 14 | 20 | 2 | 0.993 | $0.001920 |
| `typesafe/jev-1.14` | 192 | 204 | 22/22 | 37.3% | 0.543 | 14 | 21 | 2 | 0.992 | $0.001920 |

**Raw score separation:** the median-latency leader among selectable models, Jev 1.14, averaged **1.98 / 1.32 / 0.20** on required / optional / rejected skills. Clef Omni averaged **1.76 / 0.59 / 0.12**, and Decider v1.3 averaged **1.95 / 0.90 / 0.07**. These are scores on a **0–2** scale, not confidence estimates. A low *mean* rejected score does not rule out a handful of high-scoring rejects. The offline summary command prints these means for every model.

## Threshold sweep

See the [per-model graphs at 0.30, 0.40, and 0.50](decision-thresholds-2026-11-22.md) for the trade-off between off-topic picks removed and required picks lost.

The first five baseline cases are the development set; the last five are the holdout. The sweep replays saved scores without additional inference, using `raw score >= 2 × normalized threshold` and the production cap of 12. Only models with all ten valid cases are pooled. The development rule is to cut unwanted advertisements without reducing **any model's** required-hit count versus `0.375`; it leaves `0.375` in place. `0.50` is shown as a less conservative alternative, not as the winner of that rule.

| Threshold | Dev required | Dev off-topic + controls | Holdout required | Holdout off-topic + controls | Holdout optional |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25 | 272/276 | 220 | 230/230 | 123 | 74 |
| 0.375 | 272/276 | 126 | 230/230 | 51 | 53 |
| 0.425 | 270/276 | 97 | 230/230 | 30 | 42 |
| 0.5 | 269/276 | 39 | 230/230 | 14 | 37 |
| 0.55 | 263/276 | 28 | 229/230 | 8 | 34 |
| 0.625 | 256/276 | 18 | 229/230 | 5 | 27 |
| 0.7 | 253/276 | 5 | 228/230 | 0 | 27 |
| 0.75 | 252/276 | 5 | 224/230 | 0 | 23 |

## Routing and incomplete runs

`baseten/bison-1` passed the one-question probe and completed **7/10** workloads (351 ms median on the seven successes). Three workloads hit HTTP 429 on a shard. It is not ranked against models with complete results. The other 16 models failed the opening one-question score probe and did not enter the larger workload:

| Probe result | Models |
| --- | --- |
| HTTP 400 | `cloudflare/clairic` |
| HTTP 404, guardrail indicator | `google/gemini-decision-1`, `parallel/decisions-fast` |
| HTTP 404, privacy-settings indicator | `heygen/heygen-decision-1`, `heygen/heygen-decision-1-turbo`, `jaredpalmer/kev-4b`, `morph/reflex`, `respan/span-01`, `respan/span-01-lite`, `respan/span-01-lite:free`, `respan/span-02`, `scaledown/classify-1`, `togethercomputer/tev1-4b-experimental`, `upstage/solar-decide`, `upstage/solar-decide-flash` |
| HTTP 404, no specific indicator | `openai/gpt-6-luna-decisions` |

## Method and reproduction

- Inventory: all 40 concrete IDs in the public OpenRouter Decisions catalog at measurement time, excluding five redirect aliases. This diagnostic includes models outside the extension's static picker. **It does not add or restore picker entries.** No direct TypeSafe or OpenAI credential resolved, and Pi-native routing was not tested.
- Workload: each model started with one public-fact score question; valid responders went through one trial per labeled case. Each case sends 30 bounded skill metadata score questions in two parallel shards (16 + 14 for every model, to accommodate the observed Drex Max limit), using the production relevance rubric. The backend received the task and skill names/descriptions, not labels, explanations, paths, skill bodies, or private data. Two model–case trials ran concurrently, with up to four shards in flight. Timeout: 15 s; no retries. The live script has a hard POST cap tied to the catalog size and a soft $0.30 provider-reported cost stopping rule.
- Limitations: one account, one subjective labeler, one trial per model–case, a small hand-authored skill inventory, and parallel requests on one machine. Timing includes network and routing, not just model compute. These results do not measure tool/MCP gating, the 50-question default ceiling, latency under production load, or general model quality. Errors describe this account and payload, not global availability.

[Raw scores, timings, and statuses](decision-model-results-2026-11-22.json) · [Frozen labels and rationales](decision-model-baseline.json)

```bash
# Offline: reconstruct the scores, rankings, and threshold table.
node --experimental-strip-types scripts/summarize-decision-benchmark.ts \
  docs/benchmarks/decision-model-results-2026-11-22.json

# Live and billable: requires OPENROUTER_API_KEY and a new output path.
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/benchmark-decision-models.ts \
  --live --output /tmp/decision-model-benchmark.json
```
