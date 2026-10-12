# Direct OpenAI Luna with Pi-stored credentials

Date: 2026-10-12. User explicitly authorized a bounded live paid call. This follow-up implements the handoff in `pi-stored-credentials-followup.md`; no credential values or raw provider bodies are recorded here.

## Implemented credential path

- All three direct backends prefer the exact provider's public `getProviderAuth`: `openai`, `openrouter`, or `typesafe`; missing/failing resolution falls back to the corresponding env variable.
- Request-time OpenAI source `OAuth` is rejected independently of Pi's stale/empty snapshot. OpenRouter OAuth is not blanket-rejected because it can resolve an API-compatible provider key.
- Active extension callers already pass `ctx.modelRegistry`; this retains runtime/API-key and provider-extension overrides.
- Standalone host adapter `src/host/pi-credentials.ts` uses ROOT public `ModelRuntime` and `ModelRegistry`, with `refreshOnCreate:false`, `allowModelNetwork:false`. Normal SDK paths honor `PI_CODING_AGENT_DIR` (default `~/.pi/agent`; saved credentials are normally `auth.json`, configured API keys in `models.json`). No raw credential-file reads/parsing, session construction, or model discovery network requests.
- SDK credential metadata prevents standalone OpenAI OAuth resolution/refresh before lookup. No `openai-codex` lookup or substitution occurs.
- Smoke script reads Pi credentials first, not merely process env. Luna requires an explicit target (`gpt-6-luna`, `openai`, or `luna`); the existing no-argument batch does not add OpenAI. No-opt-in and invalid-target checks precede SDK initialization.

## Live operation and evidence

Command actually run:

```bash
env -u OPENAI_API_KEY PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts gpt-6-luna
```

Only one nonsensitive fixed public-weather-fact request was sent to `https://api.openai.com/v1/decisions`, through the actual implemented direct backend and unified decision client. No OpenRouter or TypeSafe calls were repeated. The earlier safe research metadata confirmed exact provider `openai` stored kind `api_key`.

| Field | Observed |
|---|---|
| SDK runtime available | true |
| Requested provider | openai |
| Requested model | gpt-6-luna |
| Actual response model | gpt-6-luna |
| Primary env key present | false |
| Pi-resolved key present | true |
| Resolved source kind | api_key |
| HTTP outcome | 200 |
| Physical POST calls | 1 |
| Latency | 1455ms |
| bool: text says sky is blue, P(true) | 1 |
| choice: topic | weather |
| score: weather relevance, levels 0..2 | 1.96 |
| Reported input tokens | 419 |
| Reported output tokens | 0 |
| Reported total tokens | 419 |
| Provider-reported cost | not provided; no cost inferred |

The API's wire `predicate` is normalized to internal `bool`; all three answers passed the same client validation as offline fixtures. Only bounded safe status/scalars/usage and source-kind/presence booleans were logged. Keys, auth headers, credential records, exception text, and raw request/response bodies were neither printed nor persisted.

## Offline verification

- Before core changes, new source-aware regression tests reproduced unsupported richer resolution and stale OAuth-source defects.
- Focused credential suite: 33 passed (legacy and new paths).
- Full offline suite after implementation: 177 passed.
- `npm run typecheck`: passed with local dependencies.
- Additional scoped strict TypeScript check includes `scripts/live-smoke.ts`: passed.
- `npm pack --dry-run --ignore-scripts`: passed (31 files).
- `git diff --check`: passed.

New tests cover Pi API key without env, Pi-vs-env precedence for all three, resolver errors/timeouts, cancellation, exact provider identity, source-aware OAuth exclusion despite stale snapshots, OpenRouter OAuth compatibility, delegated resolved config references, host metadata errors, and smoke opt-in/invalid-target guard.

## Limits

This verifies a tiny direct Luna text/JSON request, not exhaustive classifier quality, entitlement stability, multimodal payloads, native Pi inference, UI rendering, or user-configured external secret commands. Saved/config env-reference and command interpretation is intentionally delegated to Pi rather than duplicated by the extension; offline adapter tests use already-resolved reference fixtures. No live TypeSafe/OpenRouter retests were requested or performed in this follow-up. A standalone SDK runtime cannot inherit the active process's in-memory `--api-key` overlay; active extensions must continue using their provided `ctx.modelRegistry`.
