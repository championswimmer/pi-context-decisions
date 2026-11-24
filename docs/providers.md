[README](../README.md) · [Documentation](README.md)

# Providers and credentials

Native Pi classifiers are listed independently of the chat model; Pi's `/model` excludes classifiers. The picker preserves all non-OpenRouter native classifiers. For OpenRouter, **only models in the checked-in catalog** are allowed in the picker and settings. A “via Pi” entry appears only if the exact classifier is registered; direct entries are always offered, annotated with credential availability. We do not replace Pi's OpenRouter provider or its chat/image models. Missing native models are a configuration error, not an automatic switch to a paid direct backend.

## Static OpenRouter snapshot

Retrieved **2026-11-24 UTC**, ranked by prompt + completion tokens during **2026-11-17 through 2026-11-23**. The catalog is exactly the union of the popularity top ten and the top five models by [benchmark accuracy](benchmarks/decision-benchmark-report.md) (three repeats on three prompts); every other OpenRouter model was removed, and a saved selection outside the list produces a settings error until a new model is picked. Ranks are positions among all concrete decision models in the leaderboard:

| Rank | Model |
| ---: | --- |
| 1 | `typesafe/jev-1.13` |
| 2 | `typesafe/jev-1.14` |
| 3 | `perplexity/pplx-decider-v1.2` |
| 4 | `liquid/d1-ultra` |
| 5 | `perplexity/pplx-decider-v1.3:free` |
| 6 | `perplexity/pplx-decider-flash-v1.3:free` |
| 7 | `openai/gpt-6-luna-decisions` |
| 9 | `liquid/d1.2-ultra` |
| 10 | `nace-ai/drex-max` |
| 12 | `liquid/d1.1` |
| 13 | `nace-ai/drex-v1.5` |
| 18 | `perplexity/pplx-decider-flash-v1.2` |

Not listed: `respan/span-01-lite` (rank 8). Respan models require a message-array `state`, so every request this extension sends fails with HTTP 400. Ranks 8 and above are not backfilled. The 5th accuracy slot was an exact tie between `cloudflare/clef-flash` and `perplexity/pplx-decider-flash-v1.2` (72.2%); the lower-variance model was kept. Gemini Decision 1 is no longer offered through OpenRouter (rank 11); the Google direct backend is unchanged. Availability varies by account and workload (see the [latest live score checks](../.agents/research/openrouter-top20-accuracy-2026-11-24.md)).

Source: [OpenRouter rankings](https://openrouter.ai/rankings), catalog joined with an **unofficial frontend ranking endpoint**, CC BY 4.0. Exact counts and provenance are in `src/catalog/openrouter-models.ts`. This is a dated popularity snapshot of public routed traffic, not a live availability guarantee. **No runtime popularity-ranking, model-discovery, or catalog-cache requests occur.** Update the list via a reviewed code change; persisted models outside the current list produce an explicit settings error.

## Credentials and backends

Choose the route that matches your access: **Luna** can use OpenRouter (`openai/gpt-6-luna-decisions`) or OpenAI direct (`gpt-6-luna`); **Gemini Decision 1** is available through Google direct (`gemini-decision-1`) only; it is no longer in the OpenRouter catalog. Luna's routes use different endpoints and keys. Selecting one never falls back to another provider, and a configured key is not proof of model entitlement.

| Backend | Operation | Credentials |
|---|---|---|
| Pi | `ctx.modelRegistry.classify()` | Pi request-time authentication |
| TypeSafe direct | `https://api.typesafe.ai/v1/systemone` | Pi-resolved `typesafe` first, then `TYPESAFE_API_KEY` |
| OpenAI direct | `https://api.openai.com/v1/decisions` | Pi-resolved `openai` API key first, then `OPENAI_API_KEY` |
| Google Gemini direct | `https://generativelanguage.googleapis.com/v1beta/decisions` | Pi-resolved `google` API key first, then `GEMINI_API_KEY` |
| OpenRouter direct | `https://openrouter.ai/api/alpha/decisions` | Pi-resolved `openrouter` first, then `OPENROUTER_API_KEY` |

All four direct backends use Pi's public request-time `getProviderAuth(provider)` first, then the named env variable when Pi resolution is missing, fails, or is incompatible. Pi resolution itself includes runtime overrides, saved credentials, configured `models.json` API keys, and environment fallback. Saved credentials normally live in `~/.pi/agent/auth.json`; `PI_CODING_AGENT_DIR` overrides the directory. The extension never reads credential files directly and delegates config references/secret commands to Pi. Keys are never stored in extension settings, logged, or returned by status. Direct endpoints are fixed HTTPS destinations, with bounded requests, retries, timeout, cancellation, and validated responses.

**OpenAI ChatGPT OAuth cannot call Decisions.** Resolve the exact `openai` provider API key, never `openai-codex` or the current chat provider. Direct mode rejects request-time OAuth auth even if Pi's cached snapshot is empty, and can fall back to `OPENAI_API_KEY`; native Pi may hide the classifier while OAuth login is active. OpenRouter's own OAuth can resolve an API-compatible key and is not rejected by this OpenAI-specific rule. OpenAI Decisions is beta; OpenRouter Decisions is alpha.

The [Gemini Decisions API](https://aistudio.google.com/docs/decisions-api) is a separate Gemini Developer API endpoint, not Gemini chat or Vertex AI. The direct backend uses an API key, not Google OAuth, and sends only the extension's existing bounded JSON/text metadata.

A **via Pi** choice is separate from either direct route: it appears only when the active Pi registry lists the exact model as a classifier. Pi's OpenRouter System One parser is stricter than the direct alpha parser; some model responses may fail “via Pi” when metadata is omitted. Use the explicitly selected direct option as a workaround. Pi cost metadata, when present, is a catalog estimate, not a provider bill.
