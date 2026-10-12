# pi-context-decisions

A [Pi](https://pi.dev) extension that uses decision/classifier models to filter **skill advertisements** for each prompt. Core adapters, the unified decision API, model picker, settings, and skill relevance filtering are implemented. **Tool and MCP visibility filtering is not implemented**; see the [MCP visibility plan](.agents/plans/mcp-visibility.md).

Requires Pi 1.1.0 APIs and Node 22.18+. Pre-alpha; TypeSafe, the eight retained OpenRouter models, and direct OpenAI Luna passed live `bool`/`choice`/`score` checks on 2026-10-12. Luna used Pi's saved `openai` API key with `OPENAI_API_KEY` absent. Native Pi inference remains unverified.

## Load early

```bash
npm install
pi -e ./src/extension.ts -e ./other-extension.ts
```

Keep this extension first or near the start of your configured extensions/packages. Pi awaits handlers in load order. We filter the skills Pi supplies in `before_agent_start`; later handlers see the filtered array, but can overwrite it. There is no extension-priority guarantee.

For a local package install, `pi install /absolute/path/to/pi-context-decisions` is supported; ensure package ordering remains appropriate. This package is not published to npm yet.

## Choose a model

**No backend is selected by default**, so startup and prompts make no decision calls until you configure one. Selection persists across sessions and opts in to sending bounded task/skill metadata on eligible prompts.

```text
/context-decisions model                       # picker (TUI/RPC)
/context-decisions model pi typesafe jev-latest  # Pi internal classifier
/context-decisions model typesafe jev-1.13.0     # direct TypeSafe
/context-decisions model openai gpt-6-luna       # direct OpenAI
/context-decisions model openrouter typesafe/jev-1.13
/context-decisions model none                   # stop decision calls
/context-decisions status
```

Native Pi classifiers are listed independently of the chat model; Pi's `/model` excludes classifiers. The picker preserves all non-OpenRouter native classifiers. For OpenRouter, **only the checked-in eight surviving models** are allowed in the picker and settings. A “via Pi” entry appears only if the exact classifier is registered; direct entries are always offered, annotated with credential availability. We do not replace Pi's OpenRouter provider or its chat/image models. Missing native models are a configuration error, not an automatic switch to a paid direct backend.

### Static OpenRouter snapshot

Verified **2026-10-12 UTC**, ranked by prompt + completion tokens during **2026-10-05 through 2026-10-11**:

1. `typesafe/jev-1.13`
2. `perplexity/pplx-decider-v1.1-27b`
3. `cloudflare/clef-flash` (original rank 4)
4. `liquid/d1` (original rank 6)
5. `cloudflare/clef` (original rank 7)
6. `nace-ai/drex-v1.5` (original rank 8)
7. `microsoft/microsoft-decision-1` (original rank 9)
8. `upstage/solar-decide` (original rank 10)

The original top ten was trimmed after live validation: `openai/gpt-6-luna-decisions` and `inception/mercury-decide:free` each returned HTTP 404 with guardrail restrictions twice for this account. They are excluded from both native and direct picker/settings choices; no lower-ranked models were added. These are account-specific routing observations, not claims of global model unavailability. See the [live validation report](.agents/plans/live-provider-validation-2026-10-12.md).

Source: [OpenRouter rankings](https://openrouter.ai/rankings), catalog joined with an **unofficial frontend ranking endpoint**, CC BY 4.0. Exact counts and provenance are in `src/catalog/openrouter-models.ts`. This is a dated popularity snapshot of public routed traffic, not model quality or a live availability guarantee. **No runtime ranking, discovery, or cache requests occur.** Update the list via a reviewed code change; persisted models outside the current list produce an explicit settings error.

## Credentials and backends

| Backend | Operation | Credentials |
|---|---|---|
| Pi | `ctx.modelRegistry.classify()` | Pi request-time authentication |
| TypeSafe direct | `https://api.typesafe.ai/v1/systemone` | Pi-resolved `typesafe` first, then `TYPESAFE_API_KEY` |
| OpenAI direct | `https://api.openai.com/v1/decisions` | Pi-resolved `openai` API key first, then `OPENAI_API_KEY` |
| OpenRouter direct | `https://openrouter.ai/api/alpha/decisions` | Pi-resolved `openrouter` first, then `OPENROUTER_API_KEY` |

All three direct backends use Pi's public request-time `getProviderAuth(provider)` first, then the named env variable when Pi resolution is missing, fails, or is incompatible. Pi resolution itself includes runtime overrides, saved credentials, configured `models.json` API keys, and environment fallback. Saved credentials normally live in `~/.pi/agent/auth.json`; `PI_CODING_AGENT_DIR` overrides the directory. The extension never reads credential files directly and delegates config references/secret commands to Pi. Keys are never stored in extension settings, logged, or returned by status. Direct endpoints are fixed HTTPS destinations, with bounded requests, retries, timeout, cancellation, and validated responses.

**OpenAI ChatGPT OAuth cannot call Decisions.** Resolve the exact `openai` provider API key, never `openai-codex` or the current chat provider. Direct mode rejects request-time OAuth auth even if Pi's cached snapshot is empty, and can fall back to `OPENAI_API_KEY`; native Pi may hide the classifier while OAuth login is active. OpenRouter's own OAuth can resolve an API-compatible key and is not rejected by this OpenAI-specific rule. OpenAI Decisions is beta; OpenRouter Decisions is alpha.

Pi's OpenRouter System One parser is stricter than the direct alpha parser; some model responses may fail “via Pi” when metadata is omitted. Use the explicitly selected direct option as a workaround. Pi cost metadata, when present, is a catalog estimate, not a provider bill.

## Settings and relevance policy

```text
/context-decisions settings                    # dialog; JSON summary headless
/context-decisions settings enabled false
/context-decisions enable
/context-decisions disable
/context-decisions relevance mode choice
/context-decisions relevance maxSkills 12
/context-decisions relevance minCandidates 8
/context-decisions relevance minLabel directly_relevant
/context-decisions relevance chunkSize 10         # scoring batch size, 1–24
/context-decisions relevance relatedThreshold 1.25 # raw 0–2, inclusive
/context-decisions relevance directThreshold 1.75  # must be >= relatedThreshold
/context-decisions relevance concurrency 2
/context-decisions relevance timeoutMs 8000
/context-decisions relevance failMode open      # explicit opt-in to retaining all ads on failure
/context-decisions pin typescript
/context-decisions unpin typescript
/context-decisions test                         # explicit synthetic bool call; may incur cost
```

Settings live in `<Pi agent dir>/pi-context-decisions/settings.json`, atomically written with mode `0600`. Defaults:

- Relevance enabled, `score` mode; skips fewer than **8 unique automatic skills** and empty prompts.
- Score rubric: **irrelevant → related → directly relevant** (indices 0–2). Fractional scores are expected rubric indices, not class probabilities. Default policy labels: score ≥1.5 directly relevant, ≥0.75 related, otherwise irrelevant; normalized score = score/2. Persisted `relatedThreshold` and `directThreshold` accept decimals in [0, 2], ordered lowest first. `minLabel` chooses which inclusive threshold selects skills. Choice mode instead uses the model's categorical label; the numeric thresholds apply only to score mode.
- Keep related or better, cap **12 unpinned** selections; pinned names bypass cap/threshold. Original skill order and object references are preserved. Manual-only skills are not sent for classification.
- **Fail closed**: decision failures hide unverified automatic advertisements, retaining pinned/manual-only entries. `failMode open` explicitly retains the full inventory on failure; status labels that fallback.
- Whole filtering deadline **8000ms**, chunks up to **24 questions**, concurrency **2** (configurable up to 4).
- Configurable prompt ≤4000 characters and each description ≤400; names ≤64, JSON state ≤65536 characters per batch, inventory ≤1000 unique candidates. These are local safety bounds, not provider token-limit guarantees.

Invalid persisted settings are reported explicitly and advertisements fail closed until repaired with commands or a file edit + `/reload`. Unknown read fields are ignored with a warning; writes reject unknown fields and credentials. Failed writes do not change the active configuration.

### Privacy and scope

Each eligible prompt sends **bounded prompt text plus skill names/descriptions** to the selected endpoint. Untrusted task/metadata stays in state, not classifier instructions. No skill bodies, file paths, images, transcripts, tool results, or MCP inventory are sent. Nothing is retained per turn beyond the latest bounded diagnostic summary (latency, counts, safe error code, optional usage).

This changes **advertisements, not permissions**: explicit `/skill:name`, reading skill files, and already loaded instructions remain possible. Tools and MCP servers are untouched. Cancellation/shutdown aborts in-flight filtering; subsequent prompts use Pi's fresh supplied inventory.

## Application/core API

Provider names `noul` (TypeSafe/OpenRouter), `predicate` (OpenAI), and Pi's `bool` are normalized to **one internal primitive: `bool`**, alongside `choice` and `score`. Bool answers contain P(true), not a coerced Boolean. Required scalar answers are validated; optional confidence/distributions/legend remain optional.

```typescript
import { createBackend, createDecisionClient } from "pi-context-decisions";

const decisions = createDecisionClient(createBackend(
  { backend: "typesafe", model: "jev-latest" },
  { registry: ctx.modelRegistry },
));
const { answer } = await decisions.bool(
  { task: "Review validation changes" },
  { instructions: "Does this task involve code review?" },
  { timeoutMs: 8000, signal: ctx.signal },
);
// answer.probability is in [0, 1].
```

`choice`, `score`, named-question `decide`, and bounded `decideChunked` share the same contract. State is a JSON object; instructions and rubric criteria intentionally use a string-only, text/JSON subset. Errors reject with typed codes; applications choose fallback policy. The static router allowlist is enforced by extension configuration/picker; low-level backend constructors remain reusable independently.

Standalone hosts can opt into Pi's local SDK credential resolution without loading a session:

```typescript
import { createPiCredentialRegistry } from "pi-context-decisions/pi-credentials";
const registry = await createPiCredentialRegistry();
const luna = createDecisionClient(createBackend({ backend: "openai" }, { registry }));
```

This host-only adapter uses public `ModelRuntime`/`ModelRegistry`, respects Pi's normal agent-directory paths, and does not refresh model catalogs over the network. Active extensions must instead pass `ctx.modelRegistry` to retain in-process credentials/provider overrides. The portable main export has no Pi runtime dependency.

### Reusable skill picker

`pickSkills` works with any of the four core backends through the same decision client. It evaluates **every** unique automatic candidate in bounded batches, ranks by expected relevance, applies threshold/cap/pins, and returns the original skill objects in inventory order. Names and descriptions are the only skill information transmitted; file paths are retained locally for Pi's selected advertisements. It does not read or attach full skill bodies.

```typescript
import { createBackend, createDecisionClient, pickSkills } from "pi-context-decisions";

const client = createDecisionClient(createBackend(selection, {
  registry: ctx.modelRegistry,
  getRegistry: () => ctx.modelRegistry, // required when selection.backend is "pi"
}));
const picked = await pickSkills(prompt, thirtySkills, client, {
  chunkSize: 10, maxQuestions: 24, concurrency: 2,
  relatedThreshold: 1.25, directThreshold: 1.75, // raw rubric indices in [0, 2]
  minLabel: "related", maxSkills: 6, timeoutMs: 8000,
});
// picked.items: all candidate scores; picked.kept: selected original objects.
// An explicit picker has minCandidates: 0 by default; the automatic hook defaults to 8.
// Inside an early before_agent_start handler:
// event.systemPromptOptions.skills = picked.kept;
```

Passing `null` as the client intentionally skips filtering without calls. Active errors return `fail-closed` and a safe error code; retaining the inventory on errors requires explicit `failMode: "open"`. Use `maxQuestions` to impose a lower provider limit; effective batch size is the smaller of `chunkSize` and `maxQuestions`. The extension uses a conservative cap of 24. Configure `minCandidates` to change the automatic inventory-size gate. Disabled, unconfigured, or below-minimum prompts make no decision calls. The existing early hook already attaches the selected advertisements for each eligible prompt; no second hook or provider-specific application logic is needed.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```

Offline tests include provider fixtures, credential precedence/OAuth, malformed responses, deadlines, batching, real extension registration mocks, picker/headless commands, persistence, and lifecycle skill-array mutations. Live TypeSafe/OpenRouter and direct Luna checks passed; a terminal visual check has not been performed. Explicitly opt into billable public-fact checks (never part of `npm test`):

```bash
# Only Luna; Pi's saved openai API key works without an env key.
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts gpt-6-luna
# Only TypeSafe (or pass a retained OpenRouter ID).
PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/live-smoke.ts jev-latest
```

The smoke script resolves Pi credentials first, then env; it never substitutes `openai-codex`. `openai` and `luna` are aliases for the explicit Luna target. With no model arguments it checks TypeSafe plus the retained router list, **not Luna**. Without the opt-in it exits before SDK initialization or network activity. It prints safe source-kind/presence booleans/status/scalars/usage, never credentials or raw provider error bodies. The UI uses Pi's built-in dialogs/status APIs, including RPC support.

See [AGENTS.md](AGENTS.md) and `.agents/plans/` for contributor handoffs. `../pi-skill-picker-jev` was a pattern reference, not a dependency. Research plans retain historical proposals; the implemented static snapshot and fail-closed defaults above supersede earlier dynamic/fail-open recommendations.
