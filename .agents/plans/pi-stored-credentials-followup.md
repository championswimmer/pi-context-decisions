# Pi-stored provider credentials follow-up

Research date: 2026-10-12. Installed Pi coding-agent / pi-ai 1.1.0. Read-only research; only this handoff file written. No inference calls, tests/builds, credential modification, direct credential-file reads, or secrets emitted.

## Answer and observed availability

Use Pi's PUBLIC `ModelRuntime` / `ModelRegistry` authentication APIs, not raw auth-file parsing and not an internal `AuthStorage` import. Resolve EXACT provider `openai` for direct `gpt-6-luna`; never substitute `openai-codex`, the current chat model, or a subscription token.

A safe SDK probe using `ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false})`, `listCredentials()` metadata, and `getAuth('openai')` observed:

| Exact provider | Stored kind | Primary env present | Resolved API key |
|---|---|---|---|
| openai | api_key | false | yes |
| openrouter | oauth | true | not attempted (research avoided OAuth derivation/refresh) |
| typesafe | none | true | yes (Pi resolves env) |

Thus OpenAI's key is available internally even with NO `OPENAI_API_KEY` in the shell environment. This proves credential resolution only, not Luna entitlement or operational response compatibility; coder/live tester must perform the requested bounded paid call.

## Paths and precedence: source evidence

Abbreviations: `PI=/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent`; `AI=$PI/node_modules/@earendil-works/pi-ai`. Paths/line numbers below refer to installed versioned evidence, not credential files.

- Agent directory defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides and expands leading `~`: `$PI/dist/config.js:490-508`. Current SDK `getAgentDir()` returns `/Users/arnav/.pi/agent`. Saved credentials are `<agent-dir>/auth.json`; provider/model configured API keys live in `<agent-dir>/models.json`, not `settings.json`: `$PI/docs/configuration.md:9-23`.
- Documented precedence runtime `--api-key` -> auth.json -> models.json apiKey -> provider env/ambient: `$PI/docs/models.md:17-25`. Runtime overlay returns `{type:'api_key',key:override}` before persisted storage: `$PI/dist/core/runtime-credentials.js:17-30`.
- Credential record discriminants are `api_key` (`key?`, provider `env?`) and `oauth` (access/refresh/expires), one per provider: `$AI/dist/auth/types.d.ts:15-39`. List returns NONSECRET `{providerId,type}` metadata and MUST NOT resolve key commands: same file `:57-79`; `$PI/dist/core/auth-storage.js:406-418`.
- Stored key strings support `$NAME`, `${NAME}`, literals, `!command` (cached for process lifetime); model config commands are request-time uncached: `$PI/docs/providers.md:72-85`, `$PI/docs/models.md:76-80`; `$PI/dist/core/auth-storage.js:369-376`; `$PI/dist/core/resolve-config-value.js:108-131,185-218`. Let Pi execute its already configured trusted resolver; do not invent another shell parsing layer or execute arbitrary incoming commands.
- Stored credential owns provider; Pi core does NOT silently fall back after a failed OAuth refresh. It selects stored OAuth or stored API key before ambient sources: `$AI/dist/auth/resolve.js:4-38`. Our direct wrapper must explicitly add requested environment fallback on Pi resolution missing/failure/incompatible OpenAI OAuth, while preserving cancellation and timeout bounds.

## Public SDK and extension APIs

- Public package exports `ModelRuntime`, `ModelRegistry`, `getAgentDir` from root: `$PI/dist/index.d.ts:2,13,15`. `AuthStorage`/`ReadOnlyAuthStorage` declarations exist but are NOT root exports and package export map excludes their subpaths: `$PI/package.json:15-31`. Do not rely on hidden internal imports.
- `ModelRuntime.create` defaults auth and models paths; accepts `authPath`, `modelsPath`, `credentials` injection, `allowModelNetwork`, `refreshOnCreate`: `$PI/dist/core/model-runtime.d.ts:4-20`; implementation `$PI/dist/core/model-runtime.js:78-111`. With refresh disabled, getAuth is still request-time, but `isUsingOAuth()` snapshot may be stale/empty.
- `ModelRuntime.getAuth(providerId, {signal?})` resolves actual auth; `listCredentials()` reports kind safely: `$PI/dist/core/model-runtime.d.ts:89-96`. SDK official example uses ModelRuntime with default/custom paths: `$PI/examples/sdk/09-api-keys-and-oauth.ts:7-30`.
- Extension `ctx.modelRegistry.getProviderAuth(provider)` returns full resolved `AuthResult` (auth.apiKey + source); `getApiKeyForProvider` strips source and swallows errors: `$PI/dist/core/model-registry.js:102-115`; declaration `$PI/dist/core/model-registry.d.ts:51-55`. `new ModelRegistry(runtime)` adapts runtime into the extension facade (same declaration `:29`). Use actual public `getProviderAuth` for safer request-time source discrimination instead of only key string.
- `AuthResult.source` is optional. Built-in OAuth resolution returns EXACT source `OAuth`: `$AI/dist/auth/types.d.ts:87-96`; `$AI/dist/auth/resolve.js:100-118`. Built-in stored key resolution returns `stored credential`, ambient returns env variable name: `$AI/dist/auth/helpers.js:16-27`.
- `ModelRegistry.isUsingOAuth(model)` only examines model.provider via snapshot `$PI/dist/core/model-registry.js:113-115`; runtime snapshot check `$PI/dist/core/model-runtime.js:355-357`. Request-time getProviderAuth source is stronger than a stale snapshot. Public `ModelRuntime.listCredentials()` can provide provider-kind metadata independent of model availability and without resolving/refreshing OAuth.
- Exact `openai` provider supplies env API-key auth and ChatGPT OAuth; classifier filtering specifically excludes OAuth tokens because Decisions rejects them: `$AI/dist/providers/openai.js:7-29`. `openai-codex` is a separate provider and is irrelevant for this task. Do not scan/substitute it.
- OpenRouter has BOTH API key and OAuth authentication `$AI/dist/providers/openrouter.js:9-20`; do NOT generalize OpenAI's OAuth prohibition to router. TypeSafe has stored-key-capable apiKey auth via `envApiKeyAuth` `$AI/dist/providers/typesafe.js:5-15`, whose login returns api_key and stored key precedes env `$AI/dist/auth/helpers.js:10-25`.

## Current repository gap

Working-tree implementation at time inspected (git was previously published through b9ec732):
- `src/core/auth.ts:23-51` ALREADY supports Pi-first/env-second for all three when `deps.registry` exists, but only uses `getApiKeyForProvider` and snapshot OAuth detector. Add richer source-aware supported API path.
- `src/extension/runtime.ts:55-59` already passes exact current `ctx.modelRegistry` into direct factories. Preserve this rather than create a separate runtime in active extension (separate runtime would miss in-process runtime overrides/provider extensions).
- `scripts/live-smoke.ts:22-35,60-61` is ENV ONLY, has no OpenAI target, and skips if env key is absent. This is why a stored OpenAI key cannot run the existing smoke script despite working extension auth. Remove env-only precheck; construct SDK registry through public ModelRuntime, pass it into direct backend deps, add explicit Luna selection.
- `src/core/backends/factory.ts` accepts registry in BackendDeps; no raw parsing is necessary.

## Concrete coder handoff

1. Extend narrow `AuthRegistryLike` with optional public `getProviderAuth(provider): Promise<{auth:{apiKey?:string};source?:string}|undefined>`. Prefer this when available; only accept nonempty key; reject `source === 'OAuth'` for EXACT openai before sending Decisions request. Retain compatibility with older key-only mock adapters conservatively using provider OAuth detector. Ensure caught errors are redacted, fallback to named env, and caller abort remains aborted rather than fallback.
2. Add explicit lazy standalone helper (e.g. `createPiCredentialRegistry`) importing `ModelRuntime` and `ModelRegistry` from ROOT PUBLIC PACKAGE, default normal auth/models paths and `refreshOnCreate:false,allowModelNetwork:false`. Allow injected runtime/factory for offline tests and optional authPath/modelsPath for host-controlled config. Avoid automatic model-network refresh. Do not instantiate sessions or load extensions to obtain keys.
3. For stronger pre-OAuth exclusion in standalone helper, inspect `runtime.listCredentials()` metadata for exact openai before resolving and return no supported Pi key for stored oauth. Do not export/list raw credentials. Preserve runtime overrides (runtime.listCredentials overlay already reflects them). Existing active extension can rely on request-time source plus isUsingOAuth, or getProviderAuthStatus metadata as appropriate.
4. Update opt-in smoke script to include `gpt-6-luna`, use SDK registry for all three, remove env-only gate, and run ONLY explicitly selected Luna first, with tiny public fact bool+choice+score state. Opt-in flag remains mandatory. Log provider/model, scalar answers, call count/status, nonsecret source class/usage; never auth/source strings of untrusted providers verbatim, keys, headers, body, or caught error messages.
5. Offline tests: stored API key beats env for each provider; missing/throwing/timedout resolution falls back; cancellation no fallback; request-time OAuth source rejected even stale snapshot false; openai-codex never queried/substituted even current chat provider or codex credential exists; OpenRouter OAuth source not blanket rejected; command/env-reference resolution delegated to Pi; no runtime discovery/session loading.
6. Live test authorization belongs to parent/user. Run Luna using internally resolved EXACT openai key with env unset; record date/result safe details. No credential mutations needed.

## Limits

No inference/entitlement checks performed in research. Current Pi's in-process `--api-key` override is not inherited by a newly created CLI runtime; active extensions must use ctx.modelRegistry. Paths/source strings/APIs are Pi1.1.0 evidence, not guarantees for unsupported versions. Full docs read: sdk, models, extensions, environment-variables, configuration, custom-provider, security, providers; relevant linked public declarations, SDK credentials example and auth implementations inspected.
