# OpenRouter top-ten decision models by last-week tokens

Research/access date: **2026-10-12 UTC** (HTTP retrieval approximately 03:59–04:02 UTC). Scope: discover ONLY the ten most-used **decision** model variants, measuring prompt + completion tokens over the last seven completed UTC daily buckets. No inference calls, credentials, installs, tests, or implementation edits were performed. This file is the authorized research handoff.

## Answer / recommended route

**A working public route exists.** Join the live decision catalog to the public website's full weekly model leaderboard, sort by token totals yourself, and take ten:

1. `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`
2. `GET https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens`

Both returned HTTP 200 without authentication during this research. The catalog returned 19 entries: 18 concrete model variants and one redirect alias. The full leaderboard returned 654 aggregate rows and token usage for every concrete decision catalog model, including free variants. The current top ten are shown below. [S1][S2]

**Important qualification:** the second URL is an **undocumented frontend endpoint**, not the supported Data API. It is observable primary-source website behavior; isolate its parser, bound HTTP requests, cache a validated snapshot, and fail explicitly if it breaks. No official stability guarantee was established. Do not silently substitute first ten catalog items, cheapest models, largest contexts, request counts, trending growth, or guessed zero usage.

## Observed snapshot: current top ten

Source: OpenRouter (openrouter.ai/rankings), accessed 2026-10-12 UTC; usage through **2026-10-11**, trailing seven completed UTC dates **2026-10-05 through 2026-10-11 inclusive**. Licensed under CC BY 4.0. The frontend has no `meta.as_of`; use an accurately labeled retrieval timestamp instead of inventing it. Token figures are provider-reported tokenizer counts, not quality scores. [S2][S3][S4]

| Rank | Catalog ID to send to Decisions API | Seven-day prompt + completion tokens | Ranking `variant_permaslug` |
| ---: | --- | ---: | --- |
| 1 | `typesafe/jev-1.13` | 3,359,670,383,787 | `typesafe/jev-1.13-20260917` |
| 2 | `perplexity/pplx-decider-v1.1-27b` | 71,465,391,606 | `perplexity/pplx-decider-v1.1-27b-20261006` |
| 3 | `openai/gpt-6-luna-decisions` | 48,268,091,013 | `openai/gpt-6-luna-decisions-20261006` |
| 4 | `cloudflare/clef-flash` | 37,269,378,167 | `cloudflare/clef-flash` |
| 5 | `inception/mercury-decide:free` | 25,472,312,027 | `inception/mercury-decide-20260930:free` |
| 6 | `liquid/d1` | 12,526,551,021 | `liquid/d1-20260930` |
| 7 | `cloudflare/clef` | 11,067,471,867 | `cloudflare/clef` |
| 8 | `nace-ai/drex-v1.5` | 10,456,871,306 | `nace-ai/drex-v1.5-20261009` |
| 9 | `microsoft/microsoft-decision-1` | 8,926,732,791 | `microsoft/microsoft-decision-1-20261009` |
| 10 | `upstage/solar-decide` | 4,181,138,097 | `upstage/solar-decide-20260928` |

This is **an observed snapshot**, not a permanent hardcoded ranking. Rank 11 was `upstage/solar-decide-flash` at 3,912,350,538 tokens. Refresh at runtime to preserve the user's criterion.

## Verified request/response shape

### Catalog

```http
GET /api/v1/models?output_modalities=decisions HTTP/1.1
Host: openrouter.ai
```

Relevant fields observed in the real JSON:

```json
{
  "data": [
    {
      "id": "inception/mercury-decide:free",
      "canonical_slug": "inception/mercury-decide-20260930",
      "architecture": {"output_modalities": ["decisions"]}
    },
    {
      "id": "~typesafe/jev-latest",
      "canonical_slug": "~typesafe/jev-latest",
      "alias_target": {"name": "TypeSafe: Jev 1.13", "slug": "typesafe/jev-1.13"}
    }
  ]
}
```

The alias entry's description explicitly states it always redirects to the latest Jev family model. It has no independent traffic row. **Use `alias_target` to identify/deduplicate aliases**, not a hand-invented mapping; do not assign an alias the target's traffic and let both occupy top-ten slots. The concrete target already ranks first. [S1]

### Weekly leaderboard

```http
GET /api/frontend/v1/rankings/models?view=week&metric=tokens HTTP/1.1
Host: openrouter.ai
```

Relevant real response excerpt:

```json
{
  "data": [
    {
      "date": "2026-10-11 00:00:00",
      "model_permaslug": "typesafe/jev-1.13-20260917",
      "variant": "standard",
      "variant_permaslug": "typesafe/jev-1.13-20260917",
      "total_prompt_tokens": 3068580716187,
      "total_completion_tokens": 291089667600,
      "count": 1049243726,
      "change": 0.08374765206728232,
      "rankingMetricValue": 3359670383787
    }
  ]
}
```

Use **`total_prompt_tokens + total_completion_tokens`**. The website JS defines `getTotalTokens` with exactly this expression. Ignore `count`, `change`, cached/reasoning/BYOK fields, and original array order. Array order includes trending/new ordering and is NOT the required descending popularity order. Default `/models?view=week` and explicit `metric=tokens` both returned the same measured token totals in this inspection. [S2][S5]

These are **already seven-day aggregates**, not seven daily rows to sum again. The website explains that This Week means seven completed UTC buckets ending at the newest completed daily bucket. Each row's `date` is latest observed usage for that row; older inactive models can have an older row date. Derive reported dataset usage-through from the maximum valid row date, not every individual row or wall-clock rendering time. The webpage raw HTML said `Usage data through Oct 11, 2026`. Exa's independently retrieved cached page still said Oct 10: prefer the direct current HTTP JSON/HTML for this snapshot, and record retrieval time + usage-through separately. [S2][S3]

## Joining identifiers without variant corruption

Observed `canonical_slug` does not include `:free` even when the catalog `id` does. Therefore construct candidate keys:

- Exact catalog `id`.
- Catalog `canonical_slug`, **with the catalog variant suffix appended when absent**. For `inception/mercury-decide:free`, use `inception/mercury-decide-20260930:free`, not bare canonical slug.

Join against `variant_permaslug`. Standard variants have no suffix. Free and paid variants are separate model entries and separate popularity totals, as the rankings page explicitly documents. Do not aggregate free and paid into one model, strip dates heuristically, or overwrite an alias target's metric. Do not accept an ambiguous multi-row match. [S1][S2][S3]

In this observed inventory all 18 non-alias decision IDs matched exactly one leaderboard variant using this rule. Metadata alias handling accounts for the remaining nineteenth entry.

## Supported Data API exists, but cannot currently establish this top ten

Official supported route:

```http
GET /api/v1/datasets/rankings-daily?start_date=2026-10-05&end_date=2026-10-11&period=day HTTP/1.1
Host: openrouter.ai
Authorization: Bearer <OpenRouter API key resolved through Pi first, env second>
```

Response: `{data:[{date,model_permaslug,total_tokens:string}],meta:{as_of,start_date,end_date,version}}`. The supported API requires any valid OpenRouter key, shares limits **30 requests/min/key and 500 requests/day/account**, and is licensed CC BY 4.0. Token string fields should use exact integer arithmetic (`BigInt`). A seven-day sliding window must use seven inclusive completed UTC dates and daily rows; `period=week` groups ISO weeks and is not inherently a trailing seven-day window. [S4][S6]

**Coverage blocker:** this supported API exposes only **top 50 models overall per day**, plus a single aggregated `other` row. Missing decisions can be below top fifty rather than zero. There is no documented `model` filter or decision-modality option. Documented modality enum is `text | image | image_output | audio | tool_calling`; `decisions` is excluded. A direct unauthenticated GET with `modality=decisions` returned **HTTP 400** with:

```json
{"error":{"message":"modality: Invalid option: expected one of \"text\"|\"image\"|\"image_output\"|\"audio\"|\"tool_calling\"","code":400}}
```

No valid authenticated data retrieval was performed. Do not use incomplete top-50 totals to claim complete decision rankings, even if ten decision rows appear somewhere during the week. Some days for those rows can still be censored. [S4][S6][S7]

## Tempting wrong frontend endpoint

`GET /api/frontend/v1/rankings/modality-models?routeSegment=decisions&view=week` also returned HTTP 200 and decision rows, **but all prompt/completion token totals were zero** while `count` was populated. It is not a usable token popularity source in the observed response. Do not substitute count rankings or interpret these zero placeholder fields as evidence no tokens were processed. The generic full models endpoint contains real nonzero totals for the same rows. [S8][S2]

## Coder implementation policy (recommendation, not provider guarantees)

1. Separate catalog fetch, weekly metric fetch/parser, catalog-to-variant join, validated complete snapshot, and deterministic top-ten selector. Inject fetch for offline fixtures.
2. Accept only `architecture.output_modalities` containing `decisions`. Resolve/deduplicate catalog redirect aliases from `alias_target`. Preserve full API `id` for requests.
3. Strictly validate a `{data: array}` leaderboard shape. Required metric fields must be nonnegative integers. JSON numeric integers must be safe integers; reject imprecise numbers. Accept exact integer strings if a future response uses them. Sort descending exact totals; tie-break catalog IDs lexically.
4. Every non-alias catalog model must have an unambiguous matching metric to claim a complete decision top ten. Missing/ambiguous rows are **unknown**, not zero. An explicitly returned zero is distinguishable from missing. Do not require all rows have the same date: inactivity produces older row dates.
5. Bound GET timeout/response sizes (observed response ~435KB). Never attach keys to the unauthenticated frontend/catalog requests. Do not follow arbitrary cross-origin redirects. Keep only vetted fixed HTTPS OpenRouter destinations.
6. Refresh when the completed daily usage bucket changes or on explicit command, with a conservative configurable TTL such as several hours. Cache last verified top ten with source URL, usage-through, retrieval time, catalog fingerprint, token totals as strings, and stale status. Public data is safe to cache; never cache auth tokens there.
7. If full fresh metrics are unavailable, use an already-validated cached top ten **only with an explicit stale warning and date**. If no verified cached snapshot exists, expose no OpenRouter picker entries and show an actionable ranking-unavailable message; native non-OpenRouter models remain usable. Do not fall back to unranked ten or all OpenRouter classifiers.
8. The table above may serve as a provenance-bearing **dated seed snapshot**, if architect chooses, but must be labeled stale when later reused rather than pretending it is live. Runtime discovery is preferable. No universal availability SLA established for frontend endpoint.
9. Apply the resulting OpenRouter allowlist to both native-Pi OpenRouter classifier picker entries and direct OpenRouter entries. Preserve non-OpenRouter native classifier choices; unavailable native model registrations are a separate architecture concern.
10. Display attribution: `Source: OpenRouter (openrouter.ai/rankings), usage through <UTC date>, retrieved <UTC timestamp>. Licensed under CC BY 4.0.` The frontend lacks official `meta.as_of`; do not fabricate a documented Data API citation timestamp.

## Offline acceptance tests

- Top ten selected by token totals, not input order/change/count/price/context; 11+ model fixture with deliberate misleading order.
- `canonical_slug` date mapping, exact IDs, free variants; paid/free must have different totals; alias dedupe via `alias_target`.
- All required catalog models covered; missing metric/duplicate variant match yields unavailable, not arbitrary smaller ranked subset.
- Scalar token numbers safe-integer only; negative/nonfinite/fractional/unsafe integers rejected; string integers handled exactly; ties deterministic.
- Week view query preserved; no repeated daily summation of aggregate rows; UTC rollover and stale snapshot labeling.
- Optional extra leaderboard fields ignored; malformed HTML/errors/shape changes fail with redacted diagnostic.
- Zero-filled modality-only response not treated as a substitute complete usage source.
- Picker enforces allowlist for native and direct OpenRouter while preserving other providers.
- No API keys on public GETs; source/usage-through/retrieved attribution retained with cache.

## Sources actually inspected

- **[S1]** Live public decision catalog: https://openrouter.ai/api/v1/models?output_modalities=decisions — HTTP 200, 19 entries, inspected actual JSON including `canonical_slug`, free variants, and `alias_target`. Access 2026-10-12 UTC. Existing provider plan contains official discovery-document references.
- **[S2]** Live full weekly leaderboard: https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens (also without explicit metric) — HTTP 200, actual 654-row JSON inspected and joined against catalog. Access 2026-10-12 UTC; latest usage row 2026-10-11. Undocumented frontend endpoint.
- **[S3]** https://openrouter.ai/rankings — direct raw HTML inspected for `What is measured`, `Selection period`, `Freshness`, newest usage date; Exa full-page retrieval also inspected. Direct response current through Oct 11 versus cached excerpt through Oct 10. No publication date exposed.
- **[S4]** Official REST documentation, full passage retrieved: https://openrouter.ai/docs/api/api-reference/datasets/daily-token-totals-for-top-50-models — auth, exact/sampled filters, accepted modality enum, period semantics, top-50 truncation, response and limits. Access 2026-10-12 UTC.
- **[S5]** Website's actual fetched JS bundle https://openrouter.ai/_next/static/immutable/chunks/0b6ezps7t5s0f.js — inspected `modelLeaderboardOptions` calls `/api/frontend/v1/rankings/models` with `view`, and `getTotalTokens` is `total_prompt_tokens + (total_completion_tokens ?? 0)`. Website build metadata included commit `c09685eb7eeabab48bd22edbd8c436638bc0138f`; not an independently inspectable repository pin. Bundle paths can change.
- **[S6]** Official Data API cookbook, full relevant passages retrieved: https://openrouter.ai/docs/cookbook/administration/data-api — GET-only route, complete-day default end date, inclusive dates, exact integer strings, public-only traffic, top-50/other, CC BY 4.0 and citation requirements. Access 2026-10-12 UTC.
- **[S7]** Live GET https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=2026-10-05&end_date=2026-10-11&period=day&modality=decisions — HTTP 400 inspected; rejected modality error quoted above. No auth used.
- **[S8]** Live GET https://openrouter.ai/api/frontend/v1/rankings/modality-models?routeSegment=decisions&view=week — HTTP 200, actual JSON inspected; populated decision counts with zero token fields. Do not use for requested token ranking.

## Remaining uncertainty / access gaps

No stability contract for frontend endpoints; supported Data API currently lacks complete decision-specific coverage. No authenticated Data API call or provider inference was made. Popularity measures **public OpenRouter-routed tokens**, excluding private traffic; it does not establish global provider usage or model quality. Catalog and usage are mutable snapshots; source freshness dates differ from retrieval timestamps. If complete metrics become unavailable, the honest result is unavailable/stale, not a made-up ranking.
