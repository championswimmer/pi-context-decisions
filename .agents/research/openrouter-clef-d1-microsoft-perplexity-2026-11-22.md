# OpenRouter Clef, Liquid D1, Microsoft, and Perplexity checks — 2026-11-22 UTC

The [OpenRouter Decisions catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions) lists three Clef variants and four concrete Liquid D1 variants. The old `liquid/d1` ID is absent; OpenRouter's rolling `~liquid/d1-latest` and `~liquid/d1-ultra-latest` aliases resolve to `liquid/d1.2` and `liquid/d1.2-ultra`, respectively. The catalog keeps concrete IDs only. The requested Microsoft model is `microsoft/microsoft-decision-1.1`, and regular Perplexity Decider v1.3 is listed as `perplexity/pplx-decider-v1.3:free`.

Using only `OPENROUTER_API_KEY`, sent one 16-question score request to each Clef/Liquid ID (including the old `liquid/d1` as a diagnostic), then one 30-question request to each successful Clef/Liquid model and to the latest Microsoft and Perplexity variants. Used the production skill relevance request builder, the first public demo case, and the direct OpenRouter backend. No retries. All 10 catalog variants shown below returned all 30 scores in one HTTP 200 response. The legacy ID returned HTTP 404 on the 16-question attempt and was not added.

| Model | Weekly rank | Weekly tokens | Catalog change |
| --- | ---: | ---: | --- |
| `liquid/d1-ultra` | 4 | 275,356,685,190 | Already listed |
| `perplexity/pplx-decider-v1.3:free` | 5 | 232,109,682,778 | Already listed; supersedes removed Decider v1.2 |
| `liquid/d1.1` | 6 | 93,715,760,755 | Already listed |
| `perplexity/pplx-decider-flash-v1.3:free` | 8 | 60,108,700,793 | Already listed; unchanged |
| `cloudflare/clef-flash` | 12 | 26,557,452,284 | Added |
| `liquid/d1.2-ultra` | 14 | 19,599,199,230 | Added |
| `microsoft/microsoft-decision-1.1` | 16 | 12,876,482,257 | Added; older Microsoft Decision 1 remains unlisted |
| `cloudflare/clef` | 17 | 12,243,330,513 | Added |
| `liquid/d1.2` | 20 | 9,525,052,959 | Added |
| `cloudflare/clef-omni` | 26 | 2,391,884,447 | Added |

Ranks and counts come from the same [November 14–20 weekly leaderboard](openrouter-weekly-popularity-2026-11-21.md), joined by exact variant ID or canonical slug carrying its variant suffix, not from a new weekly snapshot. The live checks made 18 requests for $0.002023648 in reported cost. This verifies one 30-question text workload on this account, not the 50-question ceiling, classifier routing via Pi, or threshold quality. No threshold, credentials, or runtime catalog behavior changed.
