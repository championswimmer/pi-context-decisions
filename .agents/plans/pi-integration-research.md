# Pi integration research / coder handoff

## Scope and evidence baseline

Inspected 2026-10-12 (local UTC clock), read-only except this authorized handoff. Target is the locally installed **@earendil-works/pi-coding-agent 1.1.0 / pi-ai 1.1.0**, not older `@mariozechner/*` releases. The sibling reference is `../pi-skill-picker-jev` at **691f456b59032be656422ab998ccb98c6e6fada5**, clean when inspected. Local installation source is authoritative for what this host runs; bundled catalogs are not proof of current vendor availability, price, or endpoint entitlements. No tests, builds, live paid decisions, installs, credential changes, or remote state changes were performed.

Below, `PI/` means `/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/`; `AI/` means `PI/node_modules/@earendil-works/pi-ai/`. These are exact installed-file evidence paths, not remote commit-pinned evidence. Sibling citations refer to that recorded clean revision. This plan itself is working-tree evidence.

Fully inspected relevant bundled documentation: `docs/extensions.md`, `docs/codemode.md`, `docs/models.md`, `docs/custom-provider.md`, `docs/skills.md`, `docs/mcp.md`, `docs/configuration.md`, `docs/providers.md`, `docs/virtual-models.md`, `docs/packages.md`; followed relevant cross references into exported declaration files and implementation, plus `examples/extensions/jev-router.ts` and `dynamic-tools.ts`. Followed links for signatures into local installed code rather than assume main-branch documentation matches this release. External vendor endpoint discovery/validation belongs to the separate provider research plan.

## Recommendation (observed APIs; proposed application policy)

Implement the three requested layers with **native Pi classification as one adapter**, standalone direct HTTP adapters as the other adapters, and a **skill advertisement filter in `before_agent_start`**. Build an extension-owned classifier picker from the registry; do not try to convert classifier models into chat models or replace the native `/model` UI. The installed catalog already supplies fourteen OpenRouter classifier models, so this version needs no model registration to meet catalog-based selection. Treat broader tool/MCP filtering as future application layers with explicit limitations, not as an implemented security boundary.

### 1. Core / native classifier adapter

Public exact signatures in `PI/dist/core/model-registry.d.ts:25-52`:

```ts
await ctx.modelRegistry.refresh(options?); // async: await before synchronous reads
ctx.modelRegistry.findOfType("classifier", provider, modelId);
ctx.modelRegistry.getModelsOfType("classifier", provider?); // synchronous, readonly list
await ctx.modelRegistry.getAvailableOfType("classifier", provider?, options?);
await ctx.modelRegistry.classify(model, { state, questions }, options?);
await ctx.modelRegistry.getApiKeyForProvider(provider);
await ctx.modelRegistry.getProviderAuth(provider);
```

`classify()` never rejects for normal provider errors: inspect `stopReason: "stop" | "error" | "aborted"` and `errorMessage`; answers on success are keyed by question ID. Runtime authenticates at request time and catches errors (`PI/dist/core/model-runtime.js:553-566`). Follow sibling `src/classifier-backend.ts:27-55`: resolve provider/model, use an AbortController + 30s timeout, combine caller signal via `AbortSignal.any`, clear timer in finally, check stop reason before normalizing answers, report optional usage.

Native question/answer schema (`AI/dist/types.d.ts:459-511`; `PI/docs/codemode.md:99-132`):

- choice: `{type:"choice", instructions, criteria:Record<string,string>}` → `{type:"choice",choice,probabilities,confidence}`.
- score: `{type:"score", instructions, criteria:string[]}` → `{type:"score",score,confidence}`. Ordered criteria lowest first; score is expected **level index**, range **0..criteria.length-1**, not universally 0..1.
- bool: `{type:"bool",instructions,criteria:{true:string,false:string}}` → `{type:"bool",probability}` (probability of true).
- context is JSON state + named questions; text-only relevance is sufficient. Keep images out of MVP: installed System One adapter rejects them even though some bundled OpenRouter classifiers advertise image input (`AI/dist/api/system-one-shared.js:83-91`). This is a real catalog/adapter mismatch, not a promise of support.

**Terminology:** user's `noul` is real TypeSafe wire terminology, not necessarily a typo. Expose a documented `noul` convenience method if wanted but translate to native Pi **bool**. TypeSafe/OpenRouter serialize bool→`type:"noul"`, read answer `.noul` as true probability (`AI/dist/api/system-one-shared.js:45-71`). OpenAI uses **predicate**, appending true/false meanings to instructions (`AI/dist/api/openai-decisions.js:16-40`). Do not pass `noul` directly to native Pi's classifier context.

### 2. Model picker: all catalog OpenRouter decisions + native providers

**Observed:** Classifiers deliberately do not appear in native `/model` (`PI/docs/models.md:129-167`). No documented extension API injects a classifier-specific picker into that chat picker. Provide `/context-decisions model` (suggested command, not an existing API) with `ctx.ui.select(...)`, guarded by `ctx.hasUI`, and noninteractive configuration/commands. Keep selected classifier independent of `ctx.model`, which remains the user's chat model.

List `getModelsOfType("classifier")`, not only `getAvailableOfType`, to include models for providers without credentials; annotate auth status rather than hide entries. Native supported classifier APIs include `typesafe-system-one`, `cloudflare-workers-ai-system-one`, `llama-cpp-classify`, `openai-decisions` (`AI/dist/types.d.ts:19`). Preserve other native providers. Parse a full model name on its **first slash**: `openrouter/typesafe/jev-1.13` means provider `openrouter`, ID `typesafe/jev-1.13` (sibling `src/classifier-backend.ts:4-10`). Better persist `{provider,id}` to avoid ambiguity.

**Catalog observed at PI 1.1.0:** `AI/dist/providers/data/openrouter.json:1`, inspected by JSON extraction, contains these fourteen classifier IDs under `typesafe-system-one`:

1. `~typesafe/jev-latest`
2. `cloudflare/clef`
3. `cloudflare/clef-flash`
4. `inception/mercury-decide:free`
5. `jaredpalmer/kev-4b`
6. `liquid/d1`
7. `openai/gpt-6-luna-decisions`
8. `perplexity/pplx-decider-v1.1-27b`
9. `respan/span-01`
10. `respan/span-01-lite`
11. `respan/span-01-lite:free`
12. `togethercomputer/tev1-4b-experimental`
13. `typesafe/jev-1.13`
14. `upstage/solar-decide`

Other inspected bundled IDs: TypeSafe `jev-latest`; OpenAI `gpt-6-luna`. These are observed catalog IDs, NOT independently verified vendor availability claims. OpenRouter already binds System One to classifiers (`AI/dist/providers/openrouter.js:21-33`). Pi starts with a bundled catalog and overlays pi.dev updates; `pi update --models` refreshes it (`PI/docs/models.md:15`). Refresh picker metadata with `registry.refresh` rather than hardcode this finite list.

**Danger:** Legacy `pi.registerProvider("openrouter", {models:[...]})` replaces **all existing provider models**, including chat/image ones (`PI/dist/core/extensions/types.d.ts:1416-1424`). Do not call it merely to add decision models. `models.json` entries can add/replace individual models without wholesale provider replacement (`PI/docs/models.md:66`); this extension should not edit users' config automatically. If vendor-live models are absent from Pi catalog, record a separate discovery/missing-model strategy and verify safe additive registration first. The fourteen bundled entries satisfy installed-catalog enumeration, not a guarantee of every future OpenRouter listing.

### 3. Credentials and direct APIs

For direct OpenRouter/OpenAI, use resolved Pi credentials first, then env only when absent or explicitly unusable:

```ts
const key = (await registry.getApiKeyForProvider("openrouter"))
  || process.env.OPENROUTER_API_KEY;
```

Same provider/env mapping for `openai`/`OPENAI_API_KEY`; TypeSafe requires `TYPESAFE_API_KEY`, with Pi-resolved `typesafe` key first an optional consistent enhancement. Registry implementation delegates to runtime auth and returns undefined on resolution failure (`PI/dist/core/model-registry.js:102-112`). **Do not read auth.json yourself**: Pi owns stored credentials, API-key command resolution, refresh, and custom auth (`PI/docs/providers.md:11-20,65-79`; `PI/docs/configuration.md:11-18`). Add bounded auth wait and signal handling before network calls (sibling `src/decision.ts:44-67`). No keys in config/session history/logs/errors; only sanitized status and provider/model identifiers.

**OpenAI caveat:** ChatGPT OAuth cannot call Decisions. Native OpenAI provider removes classifiers when stored credential is OAuth (`AI/dist/providers/openai.js:25-29`); docs say even OPENAI_API_KEY does not enable native classifier while OpenAI login is OAuth (`PI/docs/models.md:144`). `getApiKeyForProvider` yields a string that may be an OAuth bearer, not an API key. Direct OpenAI must detect incompatible OAuth, avoid sending its token to Decisions, and explicitly choose env API key if allowed or report the key requirement. `registry.isUsingOAuth(chatModel)` is available if a real OpenAI chat model is known; `getProviderAuth().source` is a human-readable label, not a stable discriminant (`AI/dist/auth/types.d.ts:86-98`). Do not assume `AuthResult` contains a `type` or `methodId`. Build/test a dependency-injected auth resolver rather than cast fake models. Native and direct auth behavior may differ here and should be documented.

Observed protocol implementations for direct-code parity:

- TypeSafe: base `https://api.typesafe.ai/v1/`, POST `systemone`; OpenRouter base `https://openrouter.ai/api/v1`, POST `systemone`; JSON `{model,state,questions}`. Same System One transport (`AI/dist/api/typesafe-system-one.js:3-20`; corresponding catalog JSON). Native adapter maps bool/noul, parses `.answers` map.
- OpenAI: POST `https://api.openai.com/v1/decisions`, `{model,input:JSON.stringify(state),questions:[...]}`. Choice uses `choices:[{value,description}]`, score uses `levels:[{label}]`, bool uses predicate; answers array keyed by `name`, choice probabilities array of `{value,probability}` (`AI/dist/api/openai-decisions.js:21-40,65-123,149-160`). Refusal is an error. Usage can exist even when answers are malformed/refused (same file:157-170).

Treat these as inspected installed behavior; confirm official vendor docs in provider research before declaring endpoint limits or live defaults. Direct adapters should own fetch, schemas, validation, timeout, abort and retry policy independently from native Pi adapter; share System One codec between OpenRouter and TypeSafe rather than duplicate. API response is untrusted: reject nonfinite/missing scores, wrong types, unknown choices, invalid probability bounds, missing question IDs, and invalid JSON. Do not infer cost from placeholder zero catalog pricing (docs `models.md:165`).

### 4. Early extension ordering

**Observed:** Handlers run in extension load/registration order (`PI/docs/extensions.md:95-100`). Runner awaits each `before_agent_start` handler sequentially on the same normalized options; later handlers see earlier mutations (`PI/dist/core/extensions/runner.js:1121-1165`). Explicit CLI extension paths are merged before configured paths, deduplicated preserving first occurrence (`PI/dist/core/resource-loader.js:398-408,564-570,782-794`). Recommend launch `pi -e ./src/extension.ts -e ./other-extension.ts` with ours first. Config/package ordering is also relevant; naming a file `00-...` alone is not a universal cross-package priority guarantee. No supported `priority` option was found in the inspected extension contract.

Early means our skill selection runs before downstream extensions consume that list, NOT that extension factory can veto every later registration. Factories/providers/tools must register before initialization can finish, but modelRegistry lives on callback context, not the factory. Register callbacks in the factory; resolve models/keys in callback. Later handlers can deliberately overwrite our decisions, so document composition requirements and test ordering.

### 5. Skill relevance application (first scope)

Use `pi.on("before_agent_start", async (event,ctx)=>...)` with `event.prompt` and **only** `event.systemPromptOptions.skills` as candidates. Options are mutable, fully normalized, and include skills, selectedTools, sections (`PI/dist/core/extensions/types.d.ts:708-720`; `PI/dist/core/system-prompt.d.ts:4-51`). Do not rescan directories or invent candidates: let Pi own project trust, configured exclusions, collision resolution and resource discovery. Sibling uses exactly this approach (`src/extension.ts:282-331`). `resources_discover` only returns additional resource paths at startup/reload; it is not a per-prompt filtering hook (`PI/dist/core/extensions/types.d.ts:538-548`).

Skill fields: `name, description, filePath, baseDir, sourceInfo, disableModelInvocation` (`PI/dist/core/skills.d.ts:9-16`). Advertisements contain metadata, not full instructions; explicit `/skill:name` loads instructions regardless of automatic invocation flag (`PI/docs/skills.md:41-57`). Respect `disableModelInvocation`, deduplicate names (first wins), retain original Skill object references and stable order, send only `{name,description}` metadata plus bounded prompt to decision endpoint. Skill metadata is untrusted data, not classifier instructions. Never send source files, secrets, full session history, or full skill bodies by default.

**Proposed relevance policy:** one question per candidate (or bounded batches) with score rubric **[irrelevant, related, directly relevant]** (ascending level 0..2). Native score is fractional expected level, so normalize `score / 2` when a 0..1 threshold is desired; do not reverse rubric to match prose order. Alternatively choice labels `directly_relevant`, `related`, `irrelevant` give explicit labels and reported probabilities; expose score and labels without treating label mapping of fractional scores as provider fact. Architecture should pick one default. Recompute advertisements for each prompt (simple MVP), retaining no sticky selections unless deliberately implementing/reference-testing cumulative policy.

Assign the complete filtered array once a validated result is ready; on provider failure default to **fail-open (original advertisements)** with bounded warning, unless explicit configurable fail-closed. This is a recommendation, not reference behavior: sibling removes originals before ranking and therefore defaults to **fail-closed** on failure (`src/extension.ts:317-329`). Choose/document policy deliberately. An aborted request should stop without misleading successful status. Empty inventory/disabled setting should make no paid calls.

Filtering advertisement does **not** prevent explicit skill commands, reading skill files, or undo previously loaded instructions. Do not advertise it as permission enforcement.

### 6. Tools and MCP feasibility / limits

- `selectedTools` mutations in before_agent_start really affect the live loadout (`PI/dist/core/agent-session.js:1590-1598,1303-1308`). `pi.setActiveTools` can also select registered tools; unknown/hidden names are ignored. Snapshot baseline carefully, or previously filtered tools can disappear from future candidate inventories.
- Exposure classes: `direct`, `model-only`, `codemode`, `deferred`, `hidden`; active set determines declared tools but codemode/deferred remain callable whenever registered (`PI/dist/core/extensions/types.d.ts:382-398`). `prepareLoadout` can hide declarations/change descriptions, not globally remove other tools from the callable/search inventories (`same file:423-443,487-491`). Codemode `ALL_TOOLS`, searchTools and describeNamespace discover indirect tools (`PI/docs/codemode.md:20-51`).
- `pi.getMcpServers()` means **extension registrations only**, not full file-configured/connected server inventory. unregister affects this extension's own registrations (`PI/dist/core/extensions/types.d.ts:1364-1368`). Core registration does not itself connect servers; built-in MCP owns connections.
- Built-in MCP writes `sections.mcp_servers` on every before_agent_start (`PI/dist/extensions/mcp/index.js:1030-1040`). If ours runs early, simply deleting/filtering this section is overwritten later. It also waits/activates connections and discovers indirectly exposed tools. Do not claim early section filtering suppresses all MCP listings/callability.
- Full context visibility selection would need cooperation with/replacement of MCP manager and codemode/tool-search discovery hooks, a verified later request-stage projection, or a new Pi API. Replacing `/mcp` disables built-in MCP support and is a major implementation scope shift (`PI/docs/mcp.md:266-276`), not a harmless selection hook. Keep this deferred and clearly label limitations.

## Suggested module responsibilities (design, not implemented)

- `core/types.ts`: internal canonical question/answer types, options, model identity, metadata, errors.
- `core/pi-classifier.ts`: registry adapter with request-time auth, error normalization, timeout/signal.
- `core/system-one.ts`: shared pure wire codec/validation.
- `core/direct-{typesafe,openrouter,openai}.ts`: direct fetch and provider-specific request/response normalization.
- `core/auth.ts`: injectable credential precedence + OpenAI OAuth exclusion; no direct credential-file access.
- `decision/api.ts`: consistent `noul`, `choice`, `score` convenience methods plus named batch decide; adapter selection independent of applications.
- `applications/relevance.ts`: pure metadata→rubric→selection policy; no Pi-specific UI or credential logic.
- `extension.ts`: callbacks, settings/commands, picker, lifecycle and skill-array integration only.

Use host packages as peerDependencies, not bundled dependencies, to avoid duplicate registries/classes; explicit `pi.extensions:["./src/extension.ts"]` package manifest and `pi-package` keyword (`PI/docs/packages.md:57-102`). Repository `.agents/skills` is supported natively by Pi (`PI/docs/skills.md:63-67`); `.agents/plans` is contributor documentation, not an automatically loaded skill inventory.

## Required offline tests / reviewer checklist

1. Native lookup supports IDs with nested slashes and preserves every classifier provider; no getAll chat-only misuse; no destructive registerProvider override.
2. Model picker enumerates all registry OpenRouter classifiers and native providers, marks missing auth, works without UI, handles refresh and cancellation.
3. bool↔noul↔predicate mappings; all named answers matched; choice probabilities and score indexes consistent across direct/native adapters.
4. Credential Pi-first/env-second precedence; undefined/rejection paths, whitespace/empty handling, auth timeout; no serialized/logged secrets. Explicit OpenAI OAuth incompatibility test and env fallback policy test.
5. Direct request URLs and body snapshots for TypeSafe/OpenRouter/OpenAI; no chat-completions fallback masquerading as classifier API; missing/refused/NaN/out-of-range/error bodies rejected.
6. Relevance rubric order and `/2` normalization; stable selection, duplicate names, invocation-disabled entries, empty inventories, disabled flag, batch limits, cancellation and failure policy.
7. Hook composition: synthetic early filter + later observer; later overwriter remains possible; no candidates introduced beyond event list; failed call keeps originals for recommended fail-open default.
8. Clearly distinguish skill advertisement changes from permissions; don't silently remove explicit /skill commands; no source or transcript uploading by default.
9. Lifecycle repeated session_start/reload/shutdown resets timers and selection state; no stale callback state or unbounded retained metadata.
10. Document indirect-tool/MCP caveats and do not write tests falsely asserting selectedTools excludes codemode discovery.

## Remaining gaps

Native APIs/catalog are proven locally, not vendor-live. No official external provider limits or fresh OpenRouter live catalog retrieved in this scoped research. No guaranteed safe additive runtime registration API discovered for modifying existing provider catalog; avoid claiming one exists. Exact auth-kind detection for direct OpenAI should be resolved/tested with supported public context APIs, not invented AuthResult fields. Early ordering cannot stop later intentional overwrites. Full MCP/codemode discovery filtering needs coordinated design beyond MVP skill application. These gaps should remain visible in README and architecture plans.
