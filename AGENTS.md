# Agent guide

`pi-context-decisions` is a Pi extension with four decision backends, one internal `bool`/`choice`/`score` API, and per-prompt skill-advertisement relevance filtering. Load it early. **Tool/MCP visibility is plan-only, not an implemented permission boundary.**

## Layout and status

- `src/extension.ts`: Pi package entry; `src/extension/`: lifecycle, commands, host contracts.
- `src/settings.ts`: validated, atomic, credential-free user settings.
- `src/index.ts`: portable application/core exports.
- `src/decision/`: canonical primitives, validation, client, typed errors.
- `src/core/`: Pi classifier and direct TypeSafe/OpenAI/OpenRouter transports/codecs/auth.
- `src/host/pi-credentials.ts`: opt-in standalone public SDK credential adapter, exported as `./pi-credentials`; active extensions keep using `ctx.modelRegistry`.
- `src/catalog/`: **static checked-in eight survivors of the original top ten** OpenRouter decisions plus pure picker merge. Snapshot 2026-10-12, token window October 5–11. Future updates require code changes, never runtime discovery.
- `src/apps/`: metadata-only relevance and skill policy.
- `test/`: offline fixtures and mocked real Pi registration/lifecycle/commands.
- `.agents/skills/`: project-local skills; `.agents/plans/`: preserved research/architecture handoffs.
- `../pi-skill-picker-jev`: pattern reference only; do not copy wholesale or add as a dependency.

Earlier research plans proposed dynamic discovery and fail-open defaults. Latest user requirements override them: **static top-ten snapshot trimmed by confirmed routing failures, and default fail closed**, explicit fail-open optional. Do not overwrite historical plan files; add a uniquely named follow-up when needed.

## Working rules

- Read installed Pi docs fully and relevant linked declarations before changing host APIs. Current implementation targets `@earendil-works/*` Pi 1.1.0, not legacy namespaces.
- Read callers/tests before editing; name the files, behavior, and falsifying check. Keep changes scoped and preserve concurrent edits.
- Researchers/architects hand off through `.agents/plans/`. Mark proposed work clearly; do not describe plans as implemented.
- Keep dependency direction: apps/core → decision; extension → layers. Pure app/decision/catalog modules must not acquire Pi runtime dependencies.
- Binary aliases belong only at provider codec boundaries; internal applications use `bool`. Do not fabricate optional metadata or cost.
- Credentials for all three direct providers come from public request-time `getProviderAuth` first, then env (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`). Exact `openai` API key only, never `openai-codex`/current-chat substitution. Reject OpenAI source `OAuth` even when cached snapshots are empty; do not blanket-reject OpenRouter OAuth. Standalone SDK adapter respects Pi defaults (`~/.pi/agent`, overridden by `PI_CODING_AGENT_DIR`) and disables startup model-network refresh. Delegate references/commands to Pi; never read auth files directly, log keys, or persist secrets/settings tokens.
- Decision payloads contain bounded prompt and skill name/description metadata only. No bodies, paths, images, transcripts, or tool results. Diagnostics contain only safe codes/counts/usage.
- **Fail closed** on active decision/configuration errors. Full-inventory fallback requires explicit `failMode: "open"`; disabled/unconfigured/below-minimum behavior intentionally makes no calls and preserves advertisements.
- Only mutate `before_agent_start.systemPromptOptions.skills`. Do not claim access control or silently implement MCP/tool filtering. Later extensions may overwrite selections.
- Keep native OpenRouter entries constrained to the same static retained list; do not destructively override Pi's provider. Missing native registrations stay errors, not automatic direct-backend fallback.

## Verification and publishing

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```

Every behavior change needs focused tests and the full offline suite. Local dev dependencies and lockfile make typecheck reproducible; no sibling tooling is required. Default checks must not make inference calls. Report commands actually run, failure modes, and unverified paths. A mocked UI is not a visual terminal check.

Live smoke validation on 2026-10-12 retained eight OpenRouter models after two confirmed guardrail restrictions; do not replenish the static list automatically. Direct Luna also passed all three primitives using Pi's stored `openai` API key with the env key absent. `scripts/live-smoke.ts` requires explicit `PI_CONTEXT_DECISIONS_LIVE=1` and may incur charges; explicit `gpt-6-luna`/`openai`/`luna` selects only Luna, while the no-argument default excludes it. Smoke credentials are SDK Pi-first/env-second. Default checks remain offline.

Do not install, commit, push, or touch network unless authorized. The designated sole Git publisher handles tested milestones; inspect staged content for secrets, never force-push, and leave unrelated work untouched.
