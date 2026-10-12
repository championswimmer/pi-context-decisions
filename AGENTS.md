# Agent guide

`pi-context-decisions` is a Pi extension with four decision backends, one internal `bool`/`choice`/`score` API, and per-prompt skill-advertisement relevance filtering. Load it early. **Tool/MCP visibility is plan-only, not an implemented permission boundary.**

## Layout and status

- `src/extension.ts`: Pi package entry; `src/extension/`: lifecycle, `/decisions` user settings command, host contracts. Register only `decisions`; no compatibility alias.
- `src/settings.ts`: validated, atomic, credential-free user settings plus global always-allowed skill names.
- `src/project-allowlist.ts`: names-only `<cwd>/.pi/pi-context-decisions.json`; `src/apps/allowlist.ts`: pure scope policy.
- `src/extension/settings-dialog.ts`: the floating `/decisions` dialog (one overlay, internal routes); `settings-model.ts`: pure field/row/layout helpers (no Pi/TUI imports). `src/extension/allowlist-picker.ts`: A-Z/fuzzy and explicit relevance-ranked scoped editor, embedded as a dialog route.
- `src/index.ts`: portable application/core exports.
- `src/decision/`: canonical primitives, validation, client, typed errors.
- `src/core/`: Pi classifier and direct TypeSafe/OpenAI/OpenRouter transports/codecs/auth.
- `src/host/pi-credentials.ts`: opt-in standalone public SDK credential adapter, exported as `./pi-credentials`; active extensions keep using `ctx.modelRegistry`.
- `src/catalog/`: **static checked-in eight survivors of the original top ten** OpenRouter decisions plus pure picker merge. Snapshot 2026-10-12, token window October 5–11. Future updates require code changes, never runtime discovery.
- `src/apps/`: metadata-only relevance and skill policy; public `pickSkills` composes existing ranking/filtering for all four backends. Explicit picks default to no inventory minimum; automatic hook defaults to eight.
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
- Score thresholds are raw 0–2 rubric indices, inclusive and ordered (`relatedThreshold <= directThreshold`); persisted decimal settings are supported. Scoring defaults to `chunkSize: 50`, `concurrency: 0` (all batches parallel); positive concurrency 1–32 limits batch fan-out. Reduce batch size for a lower declared provider/client `maxQuestions`; evaluate every candidate, not just the first batch. Pins/manual-only policy and stable references survive selection.
- `/decisions` opens settings: immediate enable toggle, provider/execution path, model, both allowlists, **Advanced…** (every relevance knob except legacy `pinned`), Status, Close. In the terminal it is ONE floating `ctx.ui.custom(..., { overlay: true, overlayOptions: SETTINGS_OVERLAY_OPTIONS })` dialog hosting an internal route stack (main/advanced/provider/model/edit/choice/status/allowlist). Never call nested `ctx.ui.select`/`input`/`custom` from it: Pi's `done` removes the TOPMOST overlay, so stacked overlays can close the wrong one; close only through the saved `done`, exactly once, never `OverlayHandle.hide()`. RPC keeps select/input menus with the same grouping; headless text commands are unchanged. Provider/model availability uses public request-time Pi credential resolution, not chat-model inventory guesses; label missing keys and guide to the matching env variable or `/login <provider>`. Reject unusable selections before atomic persistence; never enable filtering as a side effect of selecting a provider/model. Headless arguments support the same behavior.
- Scoped allowlists mean **always included**, not restrict-to-only: global matches user/temporary/missing scope, project matches project scope. Effective pins bypass scoring/threshold/cap and survive fail-closed. Persist names only; project files are bounded, regular-file-only reads and atomic writes. Malformed project lists warn and become empty, never full inventory.
- `/decisions` settings expose both allowlist editors. A-Z search is local; typing/tabs make no calls. Only explicit Ctrl+R/search Enter ranks the query with configured decisions (`rubric: "topic"`, same 50/all-parallel batching); no model/key gives inline setup guidance. Cancel old/closed ranking, reject stale completions, show stale query state. Save only on explicit Ctrl+S; preserve unloaded names. RPC/headless use `/decisions allow <scope> list|add|remove|clear`; never call custom overlays outside `mode === "tui"`.
- Keep terminal text sanitized and visible-width bounded; propagate focus to Input for IME. Mocked key/render tests are not a visual terminal pass.
- Dialog lifetime and context: dialog work uses a dialog-owned `AbortSignal`, never `ctx.signal` (that is the agent-run signal) and never a spread `{...ctx}`; use `scopedContext`, whose `ui`/`modelRegistry` getters throw once the dialog is closed (Pi invalidates every ctx property after reload). `registerCommands` returns `closeDialogs()`, called FIRST and synchronously in `session_shutdown` (and at `session_start`), because Pi removes a custom overlay on reload without resolving it. The dialog is NOT in `pending`: settings saves abort in-flight decisions, never the dialog. The dialog must render within `dialogHeightBudget(rows)`, because Pi slices overlay output at `maxHeight`; percent sizes are re-resolved per render, option functions are not. No optimistic state: show values from `ops.snapshot()`, refreshed after each successful save and on route entry, never per render. Dialog errors render inline, not as transcript notifications.
- While the dialog has focus the session keeps streaming underneath, but Esc/Ctrl+C act on the dialog, not the agent. A key that hands typing back while the dialog stays open is deliberately not implemented.
- Only mutate `before_agent_start.systemPromptOptions.skills`. Do not claim access control or silently implement MCP/tool filtering. Later extensions may overwrite selections.
- Keep native OpenRouter entries constrained to the same static retained list; do not destructively override Pi's provider. Missing native registrations stay errors, not automatic direct-backend fallback.

## Verification and publishing

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run --ignore-scripts
```

Every behavior change needs focused tests and the full offline suite. `test/extension-settings-overlay-render.test.ts` drives Pi's real `TuiMainScreen` into `@xterm/headless` (dev dependency, pinned to the version pi-tui tests with): a renderer test, not a visual terminal pass. An optional manual pass is possible in tmux with an isolated `PI_CODING_AGENT_DIR=$(mktemp -d)`, `--offline --no-session -ne -e ./src/extension.ts` and a `!` bash loop for background output; choose "Do not trust (this session only)" at the trust prompt and delete the temp dir afterwards. Local dev dependencies and lockfile make typecheck reproducible; no sibling tooling is required. Default checks must not make inference calls. Report commands actually run, failure modes, and unverified paths. A mocked UI is not a visual terminal check.

Live smoke validation on 2026-10-12 retained eight OpenRouter models after two confirmed guardrail restrictions; do not replenish the static list automatically. Direct Luna also passed all three primitives using Pi's stored `openai` API key with the env key absent. `scripts/live-smoke.ts` requires explicit `PI_CONTEXT_DECISIONS_LIVE=1` and may incur charges; explicit `gpt-6-luna`/`openai`/`luna` selects only Luna, while the no-argument default excludes it. Smoke credentials are SDK Pi-first/env-second. Default checks remain offline.

Releases: tag-driven via `.github/workflows/release.yml` (npm trusted publishing, no `NPM_TOKEN`); follow `.agents/skills/release/SKILL.md`. Never `npm publish`, tag, or push a tag without explicit user authorization for that release. `0.1.0` is published manually once by the user; keep `package.json` and `package-lock.json` versions in sync.

Do not install, commit, push, or touch network unless authorized. The designated sole Git publisher handles tested milestones; inspect staged content for secrets, never force-push, and leave unrelated work untouched.
