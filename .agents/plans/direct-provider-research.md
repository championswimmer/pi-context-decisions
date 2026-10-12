# Direct decision providers: verified research and coder handoff

Research/access date: **2026-10-12 UTC**. Scope: real non-chat decision APIs for TypeSafe Jev, OpenAI, and OpenRouter; terminology, transport schemas, discovery, auth, errors, Pi differences, and proposed offline tests. This is research, not implementation. No paid inference requests, builds, tests, installs, or remote mutations were performed. Public HTTP GETs, official docs, installed Pi **1.1.0**, and the reference extension were inspected. Web docs do not expose a publication date; statements below describe their accessed version, not a historical availability guarantee.

## Executive answer

All three providers have real dedicated decision endpoints; **`noul` is not a typo**. TypeSafe/OpenRouter use `noul`, OpenAI calls the equivalent primitive `predicate`, and Pi calls it `bool`. All return a probability, not a hard Boolean. `choice` selects a supplied category. `score` is the expected **zero-based rubric level index**, not a probability, confidence, or arbitrary numerical quantity. OpenRouter's correct all-decisions discovery is **`GET /api/v1/models?output_modalities=decisions`**, NOT default `/api/v1/models` and NOT a guessed `/decisions/models`. OpenAI direct is currently documented as **public beta**, OpenRouter's endpoint is explicitly **alpha**. [T1][O1][R1][R2][P1]

| Transport | Exact POST URL | Model examples | Wire request |
| --- | --- | --- | --- |
| TypeSafe direct | `https://api.typesafe.ai/v1/systemone` | `jev-latest`, pinned `jev-1.13.0` | `{model,state,questions: Record<id,Question>}` |
| OpenAI direct | `https://api.openai.com/v1/decisions` | `gpt-6-luna` (only currently documented direct model) | `{model,input,questions: Question[]}` |
| OpenRouter direct | `https://openrouter.ai/api/alpha/decisions` | full catalog ID, e.g. `typesafe/jev-1.13`, `openai/gpt-6-luna-decisions` | `{model,state,questions: Record<id,Question>}` |

All three examples use `Authorization: Bearer <API key>` and `Content-Type: application/json`. Do not send decision models to `/chat/completions`, fabricate JSON with a chat model, or assume OpenAI and OpenRouter use the same request schema. [T1][O1][R1]

## 1. TypeSafe Jev direct: verified contract

### Request and response

`state`: string, object, or array. `questions`: map keyed by caller IDs. Every question requires `type` and `instructions`. Instructions may be string/object/array. [T1, Request body and Question types]

```json
{
  "model": "jev-latest",
  "state": {"prompt": "Implement API request validation", "skill": {"name": "typescript", "description": "TypeScript API patterns"}},
  "questions": {
    "useful": {
      "type": "noul",
      "instructions": "Would this skill help accomplish the requested task?",
      "criteria": {"true": "Actionable help for the task", "false": "No actionable help"}
    },
    "category": {
      "type": "choice",
      "instructions": "How relevant is the skill to the prompt?",
      "criteria": {"directly_relevant": "Actionable help for a concrete task requirement", "related": "Adjacent topic without direct task help", "irrelevant": "No useful connection"}
    },
    "relevance": {
      "type": "score",
      "instructions": "How useful is the skill for completing the prompt?",
      "criteria": ["Irrelevant: no help", "Related: adjacent topic or optional background", "Directly relevant: actionable help for a task requirement"]
    }
  }
}
```

Illustrative response shape (synthetic fixture, not a paid/live result):

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "useful": {"type": "noul", "noul": 0.96},
    "category": {"type": "choice", "choice": "directly_relevant", "probabilities": {"directly_relevant": 0.8, "related": 0.15, "irrelevant": 0.05}, "confidence": 0.6},
    "relevance": {"type": "score", "score": 1.75, "legend": {"0": "Irrelevant: no help", "1": "Related: adjacent topic or optional background", "2": "Directly relevant: actionable help for a task requirement"}, "probabilities": {"0": 0.05, "1": 0.15, "2": 0.8}, "confidence": 0.6}
  },
  "usage": {"input_tokens": 500, "output_tokens": 70}
}
```

- `noul.criteria` is optional; true/false meanings may be supplied. `noul` is 0..1 probability of yes.
- `choice.criteria`: option -> description; descriptions may be string/object/array/**null**. Max **255** options. Answer `choice`, full `probabilities` map, and `confidence` are required in native TypeSafe docs.
- `score.criteria`: ordered string/object/array levels, lowest first. **2..10** levels. Native response has `score`, `legend`, `probabilities`, and `confidence`; probabilities use stringified zero-based level indices. Expected score is `sum(index * probability)` and can be fractional.
- Native response `usage` has `input_tokens` and `output_tokens`; native docs do not promise `usage.cost`. Do not invent a cost. [T1]

### Models, discovery, and limits

`GET https://api.typesafe.ai/v1/models` with TypeSafe Bearer auth returns `{models:[{name,description,release_date},...]}`. Docs say this currently lists aliases; versioned IDs remain valid even if not listed. Current stable/preview aliases both point to `jev-1.13.0`; aliases can move. For reproducibility pin the version and preserve response `model`. [T2, Aliases and Listing models]

Current published Jev 1.13 limits: **text only**, **64k total state + all questions**, additionally **32k state + longest single question**. Published default capacity **100k tokens/sec and 80 requests/sec**, explicitly dynamic and subject to change, higher limits available on custom/enterprise plans. **$0.042/M input tokens**, output tokens free; pricing is provider-claimed and included only to support optional usage display. [T2, Current models]

Errors explicitly documented: `401` missing/invalid key; `422` request validation; `429` rate limit; `529` overloaded. Retry 429/529 with exponential backoff and honor `Retry-After` where present. Do not retry malformed questions or bad auth blindly. [T1, Errors][T2, Current models]

### Credential requirement

Use `TYPESAFE_API_KEY` as requested. The reference extension's custom HTTP token/baseURL mode is NOT evidence for ignoring this variable. No key was printed or used during this research. [T2, Listing models][F1]

## 2. OpenAI direct: different wire schema

Official guide documents **`gpt-6-luna` only**, **public beta**, dedicated `POST /v1/decisions`. This is actual API support, not a hypothetical Responses/structured-output emulation. Official SDK minimums include JS **7.30.0** and Python **3.26.0**; plain `fetch` avoids a new SDK dependency. The vendor's approximately 10x speed claim was not independently measured and is not an implementation guarantee. [O1, opening and How decisions work]

### Request

`input` is either a text string or user messages containing text/images. Unlike TypeSafe, the guide does not define object-valued `input`; serialize application `state` to JSON text. `questions` is an array. Give each question a unique `name` and map response answers by this name, **not array position**. [O1][P2]

```json
{
  "model": "gpt-6-luna",
  "input": "{\"prompt\":\"Implement API validation\",\"skill\":\"TypeScript API patterns\"}",
  "questions": [
    {"type": "predicate", "name": "useful", "instructions": "Would this skill help accomplish the task? True means actionable help; false means no actionable help."},
    {"type": "choice", "name": "category", "instructions": "How relevant is the skill?", "choices": [{"value": "directly_relevant", "description": "Actionable task help"}, {"value": "related", "description": "Adjacent topic only"}, {"value": "irrelevant", "description": "No help"}]},
    {"type": "score", "name": "relevance", "instructions": "How useful is the skill for the prompt?", "levels": [{"label": "Irrelevant", "description": "No useful connection"}, {"label": "Related", "description": "Adjacent topic or background"}, {"label": "Directly relevant", "description": "Actionable help for the task"}]}
  ]
}
```

Mapping:

- Public `noul` -> wire `predicate`. There is **no predicate `criteria` field** in the inspected guide/adapter. Append true/false meanings to instructions, as Pi does.
- Public `choice.criteria` map -> `choices:[{value,description?}]`.
- Public `score.criteria` ordered strings -> `levels:[{label}]`; richer labels/descriptions possible on OpenAI's wire but not Pi's string-only question type. [O1][P2:17-41]

Illustrative answer excerpt (synthetic fixture):

```json
{
  "answers": [
    {"type": "predicate", "name": "useful", "probability": 0.96},
    {"type": "choice", "name": "category", "choice": "directly_relevant", "probabilities": [{"value": "directly_relevant", "probability": 0.8}, {"value": "related", "probability": 0.15}, {"value": "irrelevant", "probability": 0.05}], "confidence": 0.6},
    {"type": "score", "name": "relevance", "score": 1.75, "probabilities": [{"value": 0, "label": "Irrelevant", "probability": 0.05}, {"value": 1, "label": "Related", "probability": 0.15}, {"value": 2, "label": "Directly relevant", "probability": 0.8}], "confidence": 0.6}
  ]
}
```

An answer may instead have **`type:"refusal"`**, carrying its name; handle as a refused question, not irrelevant/zero. Choice distributions are arrays, NOT TypeSafe maps. Score distributions use numeric level `value` and optional labels as shown. Preserve provider response/usage metadata separately from normalized answers. [O1, image example and response excerpts][P2:72-110]

### Inputs, limits, and operational differences

Official guide: images must be inline `data:image/...;base64,...` URLs in `input_image` parts next to `input_text`; hosted HTTP(S) URLs and `file_id` inputs are unsupported. No audio/video support was established. [O1, Check an image]

**Pi-specific evidence**, not independently live-verified OpenAI limits: installed Pi docs state inputs above **922k** tokens are rejected; above roughly **600k** currently risk ~5-second gateway timeouts. Pi adapter imposes **128 images** and excludes **504** from retries because repeating oversized requests reproduces the timeout. Preserve the distinction: the 128/922k/600k numbers were inspected in Pi documentation/code, not an independently retrieved complete OpenAI REST reference. No authoritative Decisions-specific OpenAI numeric question/choice limit or exhaustive error table was verified; do not transplant Jev's 255/10 limits and claim OpenAI guarantees them. [P1:143][P2:16,45-53,116-124]

Guide pricing: **$0.10/M input tokens**, no cache-read/cache-write/output charges for Decisions; regional premiums and long-context multipliers apply. ZDR/HIPAA/data residency are eligibility-limited; do not promise them just by selecting this backend. [O1, Pricing and availability]

### Credential precedence and OAuth caveat

Resolve an **OpenAI API key** from Pi first, then `OPENAI_API_KEY`; never fetch an `openai-codex`/ChatGPT token for this endpoint. Installed Pi explicitly says ChatGPT OAuth cannot use Decisions and hides `gpt-6-luna` while `openai` is logged in via `/login`, **even when OPENAI_API_KEY exists**. Pi-native mode may consequently require logout. For the direct mode, an unusable OAuth resolution should not prevent the explicitly requested valid env API-key fallback; do not forward OAuth access tokens as API keys. The exact safe detection strategy should be implemented against the verified registry metadata, not token-prefix heuristics. [P1:143][P5]

## 3. OpenRouter direct: uniform alpha contract and model discovery

The official reference and OpenRouter-maintained skills repository agree on the dedicated URL and TypeSafe-like request/response. **Always send the complete catalog `id`**, including the vendor prefix and any leading `~` alias. [R1][R2]

Use the TypeSafe request above but change `model` to `typesafe/jev-1.13` and URL to `https://openrouter.ai/api/alpha/decisions`. `state` is string/object/array; questions are ID-keyed. Noul criteria are optional; when supplied OpenRouter's skill describes exactly true/false. Instructions/criteria may be JSON structures. Optional fields include `session_id`, `trace`, `user`, and `provider` routing preferences. `session_id` max 256 characters. Optional attribution headers do not replace the Bearer key. [R1][R2:46-50]

Illustrative response contract (provider IDs/cost shown in official examples; numbers are not this research's measured results):

```json
{
  "id": "gen-dec-example",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {"useful": {"type": "noul", "noul": 0.96}, "relevance": {"type": "score", "score": 1.75}},
  "usage": {"input_tokens": 476, "output_tokens": 70, "cost": 0.000019992}
}
```

Key incompatibility: in OpenRouter's contract **`confidence`, `probabilities`, and `legend` are optional**; the scalar `noul`/`choice`/`score` for the appropriate discriminator is required. Parsers MUST permit missing optional fields, reject missing answer IDs/unexpected discriminators, and preserve provided distributions. Cost is USD when present; do not require it for parsing success. [R2:54-79]

### Actual model inventory observed

Unauthenticated public GET `https://openrouter.ai/api/v1/models?output_modalities=decisions` returned **19** entries on the access date. Default GET omitted most decision-only entries; `/api/v1/decisions/models` returned 404. Official pinned model guide independently prescribes the modality-filter query and says only entries with `architecture.output_modalities` containing `decisions` accept alpha Decisions. Treat the inventory as dynamic, not a hardcoded support list. [R3:5-24][R4]

Observed IDs and model-level catalog context lengths (tokens):

| ID | context_length | input modalities |
| --- | ---: | --- |
| `microsoft/microsoft-decision-1` | 32768 | text |
| `nace-ai/drex-v1.5` | 131072 | text |
| `cloudflare/clef-omni` | 65536 | text,image |
| `upstage/solar-decide-flash` | 524288 | text |
| `perplexity/pplx-decider-v1.1-27b` | 262144 | text,image |
| `openai/gpt-6-luna-decisions` | 1050000 | text,image |
| `liquid/d1` | 65536 | text |
| `cloudflare/clef-flash` | 65536 | text,image |
| `cloudflare/clef` | 65536 | text,image |
| `togethercomputer/tev1-4b-experimental` | 32768 | text |
| `inception/mercury-decide` | 65536 | text |
| `inception/mercury-decide:free` | 65536 | text |
| `upstage/solar-decide` | 524288 | text |
| `respan/span-01` | 0 | text |
| `respan/span-01-lite` | 0 | text |
| `respan/span-01-lite:free` | 0 | text |
| `jaredpalmer/kev-4b` | 8192 | text |
| `~typesafe/jev-latest` | 64000 | text |
| `typesafe/jev-1.13` | 64000 | text |

A catalog context length of **0 is not evidence of unlimited context**: treat as unknown. Catalog input image flags establish model capability metadata, NOT the alpha wire encoding; no concrete alpha image schema was independently verified. Implement the requested text relevance workflow first and reject images unless a supported encoding is verified. Catalog values can disagree with provider-specific limits (e.g. OpenAI via router 1.05M vs installed Pi direct 922k); use actual per-provider endpoints caps and measured failures rather than assuming equal hard limits. [R3:20,29][R4][P1]

The official model guide says every catalog decision model speaks the same three primitives. This is documented provider intent, NOT live verification that every model currently handles every possible batch/options/input. No model-by-model inference probes were performed. [R3:3]

### Do not reuse the legacy System One compatibility path indiscriminately

OpenRouter also documents **`https://openrouter.ai/api/v1/systemone`** for models whose descriptions declare TypeSafe System One compatibility, using the bare ID after the vendor prefix. Its pinned guide makes **alpha Decisions** the contract every decisions catalog entry declares. Thus merely registering every new model with Pi's built-in `typesafe-system-one` API is not sufficient evidence of working all-model support. [R3:41]

Pi's built-in TypeSafe adapter appends `systemone` to the model base URL, maps `bool` to `noul`, requires choice distributions/confidence and score confidence, drops score distributions/legend, and rejects all image inputs. These limitations conflict with accepting all OpenRouter optional-response schemas/multimodal catalog entries. Architecture should consider a custom Pi classifier transport that delegates to the verified alpha HTTP adapter, or explicitly limit compatibility-mode registration to supported models. This is a proposed integration decision for the architect, not an implementation in this plan. [P3][P4]

### Auth and errors

OpenRouter direct credential order: **Pi provider `openrouter` resolution first**, then `OPENROUTER_API_KEY`. Use fixed `https://openrouter.ai` auth destination; avoid arbitrary baseURL configs that could exfiltrate keys. No key is needed for the public model inventory GET. [R1][R4][P5][F1]

Official TypeScript Decisions SDK lists errors: **400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529**, plus default 4xx/5xx. Treat 402 as insufficient payment/credits; 413 as oversized input; 404 can be invalid model/route. No alpha schema-preserving error body fixture was retrieved, so test defensive JSON and text/HTML error handling rather than inventing one mandatory shape. A bounded retry policy for 429/5xx with `Retry-After`/jitter is a proposed extension policy, not a verified OpenRouter mandate. No streaming contract was established; implement one JSON response. [R5]

## 4. Pi and reference extension evidence relevant to direct adapters

Installed package root used below: `/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent` (`$PI`). These are installed-file observations, not repository commit citations.

- `$PI/docs/models.md:130-159` and `$PI/docs/codemode.md:79-130`: classifier model types and non-chat API; normalized `bool` question/answer; score is expected index. Classifiers are absent from normal `/model`; application needs its own classifier picker / registry listing, not a replacement chat picker. [P1]
- `$PI/dist/core/model-registry.js:102-116`: `getProviderAuth(provider)` delegates to runtime; `getApiKeyForProvider(provider)` returns `resolution.auth.apiKey`, catching failures to undefined; `isUsingOAuth(model)` delegates by provider. Native resolution can already include env credentials; explicit env fallback is still necessary for absent/unusable registry results. Do not bypass Pi by reading auth JSON files. [P5]
- `$PI/dist/core/model-runtime.js:436-464`: auth status labels runtime/stored/configured/environment; request preparation resolves auth with optional overrides. Do not log secret resolution objects. [P6]
- Reference repo `../pi-skill-picker-jev` inspected at clean HEAD **`691f456b59032be656422ab998ccb98c6e6fada5`**. `src/decision.ts:45-80` gets OpenRouter key from `ctx.modelRegistry.getApiKeyForProvider('openrouter')`, races auth with cancellation/deadline; `src/classifier-backend.ts:26-52` uses `findOfType('classifier',provider,id)` and `ctx.modelRegistry.classify`, checks `stopReason`; `src/picker.ts:47-56,86-111` constructs ID-keyed score questions from skill descriptions with truncation. These are appropriate inspiration, not provider-schema authorities. [F1][F2][F3]

## 5. Proposed coder-facing contract and semantics

This section is a recommendation/inference from inspected contracts, NOT a new provider guarantee.

1. Public application API exposes **noul/choice/score**. Use one batch context `{state,questions}`; keep IDs deterministic and stable. Public `noul` answer has an explicit probability (optionally alias `noul`) rather than Boolean coercion. Keep scalar results plus optional confidence/distributions/legend/model/provider/usage.
2. Native Pi adapter maps public noul <-> Pi bool, checks `stopReason`, and does not pretend to recover metadata Pi drops. Direct TypeSafe/OpenRouter use TypeSafe-like schemas; direct OpenAI translates explicitly. If using string-only public instructions/rubrics, document that intentional subset rather than claim all provider JSON-rich features.
3. For exact labels **directly relevant / related / irrelevant**, `choice` is the faithful categorical operation. For ordered relevance ranking use `score` levels **[irrelevant, related, directly relevant]** giving 0..2, and normalize by 2 only if requested. The normalized score is not `P(directly_relevant)` and not confidence. A middling expected score can mix both extremes, so any threshold/label conversion is an application policy to calibrate, not provider truth.
4. Classify prompt + skill metadata; treat prompt/skill contents as untrusted evidence. One question per skill allows fan-out against shared prompt; chunk by context/call limits, not arbitrary all-catalog batches. Preserve skill identity outside numeric batch IDs. Keep explicit user-selected/pinned skills separate from predictive filtering.
5. Avoid leaking state, skill text, or credentials into diagnostic logs. Sending project-private skill text to external providers requires intentional user configuration. Metadata-only scoring is lower-disclosure than full skill files.
6. Fetch catalog with bounded timeout, cache/latest-good snapshot, refresh UI without blocking extension startup forever; use returned prices/context/modalities and preserve native classifiers alongside all discovered decision entries. Discovery error should show stale status, not silently report complete support.
7. Fetch adapters should have injectable transport, fixed HTTPS destinations, cancellation/deadlines, JSON-or-text HTTP errors, bounded retries, redacted errors, strict answer validation. Missing scalar/ID, wrong type, invalid number/out-of-range probability, choice outside supplied set, duplicate named OpenAI answer: fail explicitly, not empty results interpreted as irrelevant. Optional fields stay optional, especially OpenRouter.

## 6. Proposed offline tests (not run)

- Exact URL/method/Bearer/JSON body fixture tests for all 3 providers; assert OpenRouter alpha path is not `/api/v1/decisions` and OpenAI has `input`/questions array rather than state/map.
- Noul translation: TypeSafe/OpenRouter `noul:0.8` -> public probability; Pi bool; OpenAI predicate with true/false semantics appended to instructions.
- Choice/score OpenAI request mapping and answer-array-to-ID mapping; reordered answers, duplicate IDs, missing IDs, refusal types. Mixed primitives in one batch.
- TypeSafe required distributions/confidence versus valid OpenRouter **scalar-only** response; preserve optional score legend/distribution where returned; allow absent usage and cost.
- Numeric validation: finite 0..1 probabilities; expected score within 0..N-1; choice in criteria; no silent defaults/clamping of provider errors; approximate sum validation should allow reasonable floating-point rounding.
- Provider-specific local limits: TypeSafe choices 255 and scores 2..10; text-only; 64k total plus 32k longest-question distinction documented; do not reuse those numbers as falsely verified OpenAI limits.
- Native Pi error/aborted results, TypeSafe 401/422/429/529, OpenRouter 402/413/429/524/529, JSON/text errors, Retry-After, max attempts, auth no retries, abort during delay, timeout during request, OpenAI oversized 504 no-retry policy.
- Auth: Pi key beats env; missing/failed Pi resolution falls back to env; both absent yields actionable error; TypeSafe env works; OAuth cannot be forwarded to OpenAI Decisions and configured env API key can be used in direct mode; never resolve provider `openai-codex` for direct OpenAI; errors redact keys.
- Catalog: exact `output_modalities=decisions` GET; include `~` alias IDs and non-Jev models; reject non-decision entries even if name looks like one; malformed JSON/429/timeout/offline/zero-context/stale cache; don't overwrite native entries inadvertently.
- Relevance: rubric ordering 0=irrelevant,1=related,2=direct; fractional scores; expected score vs category ambiguity; skill batching identity; user-pinned overrides; adversarial instructions inside skill descriptions; explicit cold-start/error behavior.

## 7. Evidence index and remaining gaps

Primary sources retrieved and inspected:

- **[T1]** TypeSafe API reference: https://docs.typesafe.ai/api (also full markdown https://docs.typesafe.ai/api.md). Sections Evaluation endpoint, Request body, Question/Answer types, Errors.
- **[T2]** TypeSafe models: https://docs.typesafe.ai/models (full https://docs.typesafe.ai/models.md). Current models, Aliases, Listing models.
- **[O1]** OpenAI Decisions guide: https://developers.openai.com/api/docs/guides/decisions (full https://developers.openai.com/api/docs/guides/decisions.md). Full guide retrieved, including Pricing and availability.
- **[R1]** OpenRouter endpoint reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request . Request example/fields inspected; fetched page's rendering incompletely exposes nested schema, so paired with pinned official source below.
- **[R2]** OpenRouterTeam official skills, commit **33597a44e38b0cdc38ea1256ef8bcf50c2704e3d**, `skills/openrouter-decisions/references/decisions-api.md:3-79,90-114`: https://github.com/OpenRouterTeam/skills/blob/33597a44e38b0cdc38ea1256ef8bcf50c2704e3d/skills/openrouter-decisions/references/decisions-api.md#L3-L79
- **[R3]** Same commit, `skills/openrouter-decisions/references/models.md:3-41`: https://github.com/OpenRouterTeam/skills/blob/33597a44e38b0cdc38ea1256ef8bcf50c2704e3d/skills/openrouter-decisions/references/models.md#L3-L41
- **[R4]** Actual public catalog JSON: https://openrouter.ai/api/v1/models?output_modalities=decisions (GET access-date snapshot, not commit-pinned). Model IDs/context/modalities above observed directly. Do not interpret listing as inference success.
- **[R5]** OpenRouter official TypeScript Alpha.Decisions SDK: https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README , Errors and Parameters tables.
- **[P1]** Installed Pi 1.1.0 `$PI/docs/models.md:130-159`; `$PI/docs/codemode.md:79-130`.
- **[P2]** Installed `$PI/node_modules/@earendil-works/pi-ai/dist/api/openai-decisions.js:4-110,116-160`.
- **[P3]** Installed `$PI/node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js:10-95`.
- **[P4]** Installed `$PI/node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one.js:3-19`.
- **[P5]** Installed `$PI/dist/core/model-registry.js:102-116`.
- **[P6]** Installed `$PI/dist/core/model-runtime.js:436-464`.
- **[F1]** Local clean reference `../pi-skill-picker-jev/src/decision.ts:45-80`, HEAD `691f456b59032be656422ab998ccb98c6e6fada5`.
- **[F2]** Same reference `src/classifier-backend.ts:26-52`.
- **[F3]** Same reference `src/picker.ts:47-56,86-111`.

Remaining unverified: live paid inference responses on any provider; exhaustive OpenAI REST schema/limits/error codes (one guessed reference path returned 404 and search did not locate authoritative alternative); alpha OpenRouter image input wire encoding; all 19 individual model operational behavior and model-specific cardinality limits; classifier-registration extension hook mechanics (covered by separate Pi integration research). No blanket availability, accuracy, latency, or schema promises should be made for those gaps. Official OpenRouter model guide's all-three-primitives claim is documented intent; use offline adapter tests now and optional explicitly authorized public-data smoke tests later.
