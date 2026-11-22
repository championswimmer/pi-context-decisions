# OpenRouter weekly decision-model popularity — 2026-11-21

Retrieved at approximately 23:25 UTC from the [public decision catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions) and the [unofficial weekly frontend leaderboard](https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens), following the [original methodology](openrouter-weekly-popularity.md). Source: [OpenRouter rankings](https://openrouter.ai/rankings), CC BY 4.0.

The leaderboard had 709 rows and its newest usage date was 2026-11-20, so the latest complete weekly window was **2026-11-14 through 2026-11-20 UTC**. The catalog returned 45 decision entries: 40 concrete variants and 5 redirect aliases. Each concrete variant matched exactly one `variant_permaslug` by exact ID or canonical slug with the variant suffix preserved. Aliases were excluded, and paid/free variants were not combined. Ranks use exact prompt + completion token totals, sorted descending rather than relying on the response array order.

| Rank | Catalog ID | Weekly tokens | Ranking variant |
| ---: | --- | ---: | --- |
| 1 | `typesafe/jev-1.13` | 2,928,928,802,721 | `typesafe/jev-1.13-20260917` |
| 2 | `typesafe/jev-1.14` | 2,228,772,203,880 | `typesafe/jev-1.14-20261014` |
| 3 | `perplexity/pplx-decider-v1.2` | 497,458,491,360 | `perplexity/pplx-decider-v1.2-20261016` |
| 4 | `liquid/d1-ultra` | 275,356,685,190 | `liquid/d1-ultra-20261015` |
| 5 | `perplexity/pplx-decider-v1.3:free` | 232,109,682,778 | `perplexity/pplx-decider-v1.3-20261112:free` |
| 6 | `liquid/d1.1` | 93,715,760,755 | `liquid/d1.1-20261027` |
| 7 | `openai/gpt-6-luna-decisions` | 87,507,974,349 | `openai/gpt-6-luna-decisions-20261006` |
| 8 | `perplexity/pplx-decider-flash-v1.3:free` | 60,108,700,793 | `perplexity/pplx-decider-flash-v1.3-20261112:free` |
| 9 | `nace-ai/drex-max` | 41,326,695,423 | `nace-ai/drex-max-20261016` |
| 10 | `google/gemini-decision-1` | 39,751,518,937 | `google/gemini-decision-1-20261111` |

The next model was `microsoft/microsoft-decision-1` with 31,594,709,532 tokens. The catalog does not backfill below rank 10. Popularity is not a quality or routing guarantee.
