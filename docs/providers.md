[README](../README.md) · [Documentation](README.md)

# Providers and credentials

Native Pi classifiers are listed independently of the chat model; Pi's `/model` excludes classifiers. The picker preserves all non-OpenRouter native classifiers. For OpenRouter, **only models in the checked-in catalog** are allowed in the picker and settings. A “via Pi” entry appears only if the exact classifier is registered; direct entries are always offered, annotated with credential availability. We do not replace Pi's OpenRouter provider or its chat/image models. Missing native models are a configuration error, not an automatic switch to a paid direct backend.

## Static OpenRouter snapshot

Retrieved **2026-11-21 UTC**, ranked by prompt + completion tokens during **2026-11-14 through 2026-11-20**:

1. `typesafe/jev-1.13` **(removed in favor of Jev 1.14)**
2. `typesafe/jev-1.14`
3. `perplexity/pplx-decider-v1.2` **(removed in favor of Decider v1.3)**
4. `liquid/d1-ultra`
5. `perplexity/pplx-decider-v1.3:free`
6. `liquid/d1.1`
7. `openai/gpt-6-luna-decisions`
8. `perplexity/pplx-decider-flash-v1.3:free`
9. `nace-ai/drex-max`
10. `google/gemini-decision-1`

The catalog also includes these explicitly requested models, with ranks from the same snapshot:

| Rank | Model |
| ---: | --- |
| 12 | `cloudflare/clef-flash` |
| 14 | `liquid/d1.2-ultra` |
| 16 | `microsoft/microsoft-decision-1.1` |
| 17 | `cloudflare/clef` |
| 20 | `liquid/d1.2` |
| 26 | `cloudflare/clef-omni` |

Jev 1.13 and Decider v1.2 were removed in favor of their newer versions. Luna and Gemini Decision 1 remain available in the picker even when a particular OpenRouter account cannot route them; past account-specific routing failures do not determine catalog eligibility. The legacy `liquid/d1` ID is no longer in the public Decisions catalog. Availability varies by account and workload (see the [latest live score checks](../.agents/research/openrouter-clef-d1-microsoft-perplexity-2026-11-22.md)).

Source: [OpenRouter rankings](https://openrouter.ai/rankings), catalog joined with an **unofficial frontend ranking endpoint**, CC BY 4.0. Exact counts and provenance are in `src/catalog/openrouter-models.ts`. This is a dated popularity snapshot of public routed traffic, not model quality or a live availability guarantee. **No runtime popularity-ranking, model-discovery, or catalog-cache requests occur.** Update the list via a reviewed code change; persisted models outside the current list produce an explicit settings error.

## Credentials and backends

Choose the route that matches your access: **Luna** can use OpenRouter (`openai/gpt-6-luna-decisions`) or OpenAI direct (`gpt-6-luna`); **Gemini Decision 1** can use OpenRouter (`google/gemini-decision-1`) or Google direct (`gemini-decision-1`). The routes use different endpoints and keys. Selecting one never falls back to another provider, and a configured key is not proof of model entitlement.

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
