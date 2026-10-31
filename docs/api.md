[README](../README.md) · [Documentation](README.md)

# Application and core API

Provider names `noul` (TypeSafe/OpenRouter), `predicate` (OpenAI), and Pi's `bool` are normalized to **one internal primitive: `bool`**, alongside `choice` and `score`. Bool answers contain P(true), not a coerced Boolean. Required scalar answers are validated; optional confidence/distributions/legend remain optional.

The first example runs inside a Pi extension, where `ctx` is the current extension context.

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
import { createBackend, createDecisionClient } from "pi-context-decisions";
import { createPiCredentialRegistry } from "pi-context-decisions/pi-credentials";
const registry = await createPiCredentialRegistry();
const luna = createDecisionClient(createBackend({ backend: "openai" }, { registry }));
```

This host-only adapter uses public `ModelRuntime`/`ModelRegistry`, respects Pi's normal agent-directory paths, and does not refresh model catalogs over the network. Active extensions must instead pass `ctx.modelRegistry` to retain in-process credentials/provider overrides. The portable main export has no Pi runtime dependency.

### Reusable skill picker

`pickSkills` works with any of the four core backends through the same decision client. It is a **stateless, score-only** helper: it evaluates **every** unique automatic candidate in bounded batches, ranks by expected relevance, applies threshold/cap/pins, and returns the original skill objects in inventory order. The extension builds its additive, branch-aware behavior on the same ranking and selection primitives (`scoreAdditions`, `RelevanceScoreCache`) but keeps a ledger; `pickSkills` does not. Names and descriptions are the only skill information transmitted; file paths are retained locally for Pi's selected advertisements. It does not read or attach full skill bodies.

Here `selection` is a backend selection, `prompt` is your task text, and `thirtySkills` is your inventory of skill objects (each with a name and description).

```typescript
import { createBackend, createDecisionClient, pickSkills } from "pi-context-decisions";

const client = createDecisionClient(createBackend(selection, {
  registry: ctx.modelRegistry,
  getRegistry: () => ctx.modelRegistry, // required when selection.backend is "pi"
}));
const picked = await pickSkills(prompt, thirtySkills, client, {
  chunkSize: 50, maxQuestions: 50, concurrency: 0, // all scoring batches in parallel
  threshold: 0.625,            // normalized 0–1, inclusive (raw expected index >= 1.25)
  maxSkills: 6, timeoutMs: 8000,
});
// picked.items: scored (non-pinned) candidate scores; picked.kept: selected original objects.
// An explicit picker has minCandidates: 0 by default; the extension's automatic path defaults to 8.
// Passing the removed mode/minLabel/relatedThreshold/directThreshold options is a config error (fails closed).
```

Passing `null` as the client intentionally skips filtering without calls. Active errors return `fail-closed` and a safe error code; retaining the inventory on errors requires explicit `failMode: "open"`. Use `maxQuestions` to impose a lower provider limit; effective batch size is the smaller of `chunkSize` and `maxQuestions`. The extension requests batches up to 50 and respects a lower limit declared by the selected client. Configure `minCandidates` to change the automatic inventory-size gate. Disabled, unconfigured, or below-minimum prompts make no decision calls. The extension's hooks already add the picked skills for you; no second hook or provider-specific application logic is needed.
