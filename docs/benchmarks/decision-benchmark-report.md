# Top-20 OpenRouter decision models: three-run skill-picking benchmark

Measured 2026-11-24 UTC, **3 repeats per model per prompt** (9 runs per model), production score-only picker (threshold 0.375, cap 12), 30 mock skills. Spec: [`decision-benchmark.json`](decision-benchmark.json) (frozen before any request). Roster: [`decision-models-top20.json`](decision-models-top20.json). Raw: [`decision-benchmark-results-2026-11-24-x3.json`](decision-benchmark-results-2026-11-24-x3.json). Interactive page: `decision-benchmark-site.html`, published at https://sites.arnavg.in/research/decision-model-benchmark-top20/.

**Accuracy** = (correct picks - wrong picks) / required picks, per run; wrong = neither required nor acceptable. Values are mean ± sample SD over the 9 runs (mixes prompt difficulty and repeat noise). run-a/b/c should-pick sets are disjoint (frontend, devops, python-data).

| Model | Accuracy | Wrong picks/run | Latency ms | Cost per 1k |
| --- | ---: | ---: | ---: | ---: |
| `nace-ai/drex-max` | 100% ± 0 | 0.0 ± 0.0 | 686 ± 107 | $0.31 |
| `perplexity/pplx-decider-v1.2` | 100% ± 0 | 0.0 ± 0.0 | 314 ± 11 | $0.07 |
| `liquid/d1.1` | 80% ± 17 | 0.8 ± 0.7 | 418 ± 176 | $0.08 |
| `nace-ai/drex-v1.5` | 75% ± 38 | 1.0 ± 1.5 | 410 ± 180 | $0.12 |
| `cloudflare/clef-flash` | 72% ± 22 | 1.0 ± 0.9 | 450 ± 181 | $0.13 |
| `perplexity/pplx-decider-flash-v1.2` | 72% ± 4 | 1.0 ± 0.0 | 754 ± 780 | $0.04 |
| `cloudflare/clef` | 69% ± 27 | 1.2 ± 1.1 | 562 ± 192 | $1.10 |
| `liquid/d1.2-ultra` | 67% ± 33 | 1.3 ± 1.3 | 293 ± 80 | $0.17 |
| `perplexity/pplx-decider-v1.3:free` | 67% ± 33 | 1.3 ± 1.3 | 318 ± 14 | $0.00 |
| `respan/span-02` | 64% ± 11 | 1.3 ± 0.5 | 354 ± 98 | $0.23 |
| `perplexity/pplx-decider-flash-v1.3:free` | 64% ± 11 | 1.3 ± 0.5 | 370 ± 255 | $0.00 |
| `openai/gpt-6-luna-decisions` | 39% ± 48 | 2.3 ± 2.0 | 223 ± 38 | $0.57 |
| `liquid/d1.2` | 38% ± 30 | 2.2 ± 1.1 | 339 ± 109 | $0.08 |
| `microsoft/microsoft-decision-1.1` | 36% ± 33 | 2.3 ± 1.3 | 373 ± 135 | $0.16 |
| `google/gemini-decision-1` | 25% ± 22 | 2.7 ± 0.5 | 380 ± 129 | $0.42 |
| `liquid/d1-ultra` | 13% ± 41 | 3.2 ± 1.7 | 466 ± 225 | $0.17 |
| `typesafe/jev-1.13` | 1% ± 42 | 3.7 ± 1.8 | 183 ± 11 | $0.19 |
| `microsoft/microsoft-decision-1` | -1% ± 23 | 3.8 ± 1.2 | 588 ± 174 | $0.13 |
| `typesafe/jev-1.14` | -2% ± 39 | 3.8 ± 1.7 | 177 ± 11 | $0.19 |
| `respan/span-01-lite` | failed (HTTP 400, all 9) | | | |

`respan/span-01-lite` failed every request with HTTP 400 and was not backfilled. 360 POSTs, $0.0375 reported cost. Regenerate the table with `scripts/summarize-decision-benchmark.ts` (single-run layout; not yet updated for repeats).
