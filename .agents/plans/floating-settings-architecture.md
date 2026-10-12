# Floating `/decisions` settings dialog: architecture and coder handoff

Status: **proposed, not implemented.** Architect, 2026-10-12. Builds on `.agents/plans/floating-settings-research.md`; the facts below were re-checked against installed Pi 1.1.0 (`CA` = `node_modules/@earendil-works/pi-coding-agent`, `TUI` = `node_modules/@earendil-works/pi-tui`). No release, tag, version bump or live inference is part of this work.

## 1. Decision

Use **one** `ctx.ui.custom(factory, { overlay: true, overlayOptions: SETTINGS_OVERLAY_OPTIONS, onHandle })` per settings interaction. It is a bordered, top-anchored panel that hosts an **internal route stack** (main, advanced, provider, model, edit, choice, status, allowlist). There are no nested `ctx.ui.select`/`input`/`custom` calls on the terminal path. The existing allowlist component is embedded as a route. Relevance tuning moves into **Advanced**, with no persisted schema change. RPC keeps a `select`/`input` fallback with the same Main/Advanced grouping. Headless commands are unchanged.

Rejected:
- **Stacked custom overlays per submenu.** `done` calls `TUI.hideOverlay()`, which pops the **topmost** overlay, not its own (CA `interactive-mode.js:2342`, TUI `tui.js:468`). Unwinding order becomes our problem.
- **Pi `SettingsList`.** It updates values optimistically before our async validated save can fail, uses a fixed `maxVisible` (not responsive), and doesn't propagate submenu focus to `Input`.
- **`SelectList` for routes.** It has a fixed `maxVisible` and no disabled, pending or auth rows.
- **Non-capturing/detached dialog as v1.** Not required for output to keep streaming. It adds a second-command concurrency path and a hotkey decision; see §9, optional R1.

## 2. Verified host facts the design depends on

| Fact | Evidence | Design consequence |
|---|---|---|
| An overlay custom does not replace `editorContainer`. Ordinary `select`/`input` do replace it. | CA `interactive-mode.js:2324-2390`, `2109-2206` | Overlay replaces the "status-area block" look. |
| A focused overlay owns keys, not the agent stream. Agent events re-render independently. | research §3; TUI `tui.js:739-750` | Background printing continues with the dialog focused. |
| Only extension terminal-input listeners precede the focused component. Pi's Esc interrupt lives in the editor. | CA `interactive-mode.js:2017-2034`; TUI `tui.js:685-698` | While the dialog is focused, Esc/Ctrl+C go to the dialog and do **not** interrupt the agent. Document this. |
| Streaming does not call `setFocus(editor)`. If another dialog steals focus, the TUI re-focuses the overlay on the next key. | CA `setFocus(this.editor)` sites are dialog restores only; TUI `tui.js:251-336,722-736` | No focus babysitting needed. |
| `done` → `hideOverlay()` pops the topmost overlay, then `component.dispose()`. | CA `interactive-mode.js:2335-2350` | Single overlay. Call `done` exactly once. |
| An `overlayOptions` function is resolved **once** at show time. Percentage `width`/`maxHeight` are resolved **per render**. | CA `interactive-mode.js:2360-2372`; TUI `tui.js:72-83,827-858` | Use a static object with percentages. Never mutate options. Fixed size per dialog. |
| `maxHeight` slices from the top. Lines are space-padded to overlay width. | TUI `tui.js:970-973`, `148-166` | The component must render ≤ budget itself. No background bleed. |
| Anchors `top-center` etc. and margins exist. Position is clamped on screen. | TUI `tui.d.ts:118-161`, `tui.js:860-915` | Top-anchored panel leaves the bottom rows visible: latest transcript, editor, other prompts. |
| Regular-mode appends rewrite the old overlay rows before they scroll off, with no full redraw. | TUI `tui-main-screen.js:212-235,334-412` (inference) | Scrollback stays clean. A real-renderer test verifies this (§7-D). |
| `ctx.signal` is the **agent run** signal (undefined when idle). Every ctx getter throws after invalidation. Spreading ctx defeats the guard. | CA `types.d.ts:239-240`; `runner.js:488-492,613-700,724-727` | The dialog uses its own lifetime signal and a lazy guarded ctx adapter. Never `{...ctx}`. |
| Reload emits `session_shutdown`, then invalidates. `resetExtensionUI()` pops one overlay **without resolving** custom. | CA `agent-session.js:2939-2940`; `interactive-mode.js:366,1898-1908` | Close the dialog in `session_shutdown`, or the handler hangs and ranking keeps running. |
| Pi installs app keybindings globally (`setKeybindings`). | CA `interactive-mode.js:397` | Use `getKeybindings().matches(data, "tui.select.up/down/pageUp/pageDown/confirm/cancel")` (user remaps honored, simple fakes). |

## 3. Files and ownership

| File | Change |
|---|---|
| `src/extension/settings-model.ts` (**new**, pure: no Pi/TUI imports) | Field metadata, row builders, `describeError` (moved from `commands.ts` `safeError`), `sanitizeTerminalText`, `dialogHeightBudget`, `layoutMenu`. |
| `src/extension/settings-dialog.ts` (**new**) | Root component, router, op/lifetime management, frame rendering, `openSettingsDialog`, `createSettingsDialogManager`, `SETTINGS_OVERLAY_OPTIONS`. |
| `src/extension/commands.ts` | Split reporting from logic, build `SettingsDialogOps`, terminal routing, RPC fallback with Advanced. `registerCommands` returns `{ closeDialogs(): void }`. |
| `src/extension/runtime.ts` | Keep the `registerCommands` handle. Call `closeDialogs()` **first, synchronously** in `session_shutdown`, and defensively at the start of `session_start`. Do **not** put the dialog in `pending`. |
| `src/extension/allowlist-picker.ts` | Add optional `maxRows?: () => number` to `AllowlistPickerDeps`; when present it replaces `floor(terminal.rows*0.8)`. Remove `showAllowlistPicker` (dead after routing). |
| `src/extension/contracts.ts` | No change expected (`ui.custom` is already optional). |
| Tests | New: `test/extension-settings-model.test.ts`, `test/extension-settings-dialog.test.ts`, `test/extension-settings-overlay-render.test.ts`. Update: `extension-decisions-settings`, `extension-wiring`, `extension-allowlist-commands`, `extension-allowlist-picker`, `extension-allowlist-runtime`. |
| Docs | `README.md` settings section and keys; `AGENTS.md` rules (§8). |

Suggested split if two coders work in parallel:
- **A** owns `settings-model.ts`, `settings-dialog.ts`, and the dialog and render tests.
- **B** owns `commands.ts`, `runtime.ts`, `allowlist-picker.ts`, and the command/RPC test updates.
- The §4 interfaces are the contract between them. A lands the types first.

## 4. Stable contracts

```ts
// settings-dialog.ts
export const SETTINGS_OVERLAY_OPTIONS = {
  anchor: "top-center", width: "70%", minWidth: 46, maxHeight: "70%",
  margin: { top: 1, right: 1, bottom: 1, left: 1 },
} as const satisfies OverlayOptions;
// settings-model.ts — must match TUI resolution for the options above:
export function dialogHeightBudget(rows: number | undefined): number; // undefined → Infinity; else max(1, min(floor(rows*0.7), rows-2))

export type SettingsRoute =
  | { kind: "main" } | { kind: "advanced" } | { kind: "provider" }
  | { kind: "model"; filter?: { backend: BackendSelection["backend"]; provider?: string } }
  | { kind: "edit"; key: AdvancedKey } | { kind: "choice"; key: AdvancedKey }
  | { kind: "status" } | { kind: "allowlist"; scope: AllowlistScope };
export type InitialRoute = "main" | "advanced" | "provider" | "model" | { allowlist: AllowlistScope };

export interface DialogSnapshot { settings: ContextDecisionsSettings; settingsError?: string; hasCwd: boolean }
export interface ProviderRow { id: string; backend: "pi" | "typesafe" | "openai" | "openrouter"; provider: string; label: string; status: AuthStatus; guide?: string }
export interface ModelRow { id: string; label: string; selection: BackendSelection | null; status: AuthStatus | "none"; guide?: string; note?: string }
export interface SettingsDialogOps {            // built in commands.ts; no ctx crosses this boundary
  snapshot(): DialogSnapshot;                   // sync, no I/O (controller.getSettings/getSettingsError)
  projectCount(signal: AbortSignal): Promise<{ count: number; warning?: string }>;
  toggleEnabled(): Promise<void>;
  updateSetting(key: string, text: string): Promise<void>; // reuses updateSetting(); throws SettingsError
  listProviders(signal: AbortSignal): Promise<ProviderRow[]>;
  listModels(filter: Extract<SettingsRoute, { kind: "model" }>["filter"], signal: AbortSignal): Promise<ModelRow[]>;
  selectModel(selection: BackendSelection | null, signal: AbortSignal): Promise<{ message: string }>; // requireNative+requireCredentials+update; never toggles enabled
  statusLines(signal: AbortSignal): Promise<string[]>;     // same content as headless /decisions status
  allowlist(scope: AllowlistScope, signal: AbortSignal): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">>;
}
export function createSettingsDialogComponent(
  tui: { requestRender(): void; terminal?: { readonly rows: number } },
  theme: Pick<Theme, "fg" | "bg">,
  done: (result: "closed" | "shutdown") => void,
  ops: SettingsDialogOps,
  options?: { initialRoute?: InitialRoute },
): Component & Focusable & { dispose(): void; close(result: "closed" | "shutdown"): void; navigate(route: InitialRoute): void };
export function createSettingsDialogManager(): {
  open(ctx: CommandContext, ops: SettingsDialogOps, initialRoute: InitialRoute): Promise<"closed" | "shutdown" | "focused-existing">;
  closeAll(): void;                              // idempotent → active.close("shutdown")
};
```

**Main rows**, in this order and nothing else:
1. `Context decisions` · On/Off: toggles in place.
2. `Provider / execution` · label: opens the provider route.
3. `Model` · label: opens the model route, filtered by the current backend if one is set.
4. `Always allowed · Global` · count: opens the allowlist route.
5. `Always allowed · Project` · count, `…` while loading. Disabled with a reason when there is no cwd. Warnings show as tone and description.
6. `Advanced…`
7. `Status…`
8. `Close`

Settings errors show as a banner.

**Advanced fields** come from an explicit `ADVANCED_FIELDS` list that covers every `RelevanceSettings` key except `pinned`:

| Key | Kind |
|---|---|
| `enabled` | bool |
| `mode` | choice |
| `minLabel` | choice |
| `relatedThreshold`, `directThreshold` | decimal 0–2 |
| `maxSkills`, `minCandidates` | int 0–1000 |
| `chunkSize` | int 1–50 |
| `concurrency` | int 0–32, `0 = all batches parallel` |
| `timeoutMs` | int 1–300000 |
| `failMode` | choice; the `open` option description warns that every skill stays advertised on failure |
| `maxPromptChars` | int 1–4000 |
| `maxDescriptionChars` | int 1–400 |

Bounds and hints come from the existing `settings.ts` rules; validation stays in `updateSetting`/`parseSettings`. `pinned` stays headless-only (`pin`/`unpin`) and is shown in Status.

## 5. Behavior: routes, keys, async state

**Keys.** These are the `getKeybindings()` IDs:
- up/down/pageUp/pageDown move the selection.
- confirm (Enter) activates.
- Space toggles bool rows.
- cancel (Esc/Ctrl+C) acts by route:
  - edit: cancels without saving.
  - non-root route: pops.
  - main: closes.
- The allowlist route receives **all** input; its own `done(saved)` pops the route.

| Route | Content | Activate | Notes |
|---|---|---|---|
| main / advanced | rows from the snapshot | per §4 | The description line under the list shows the selected row's help or disabled reason. |
| provider | `listProviders` rows with `configured` / `missing key` | missing → banner with the full guide (env var + `/login <provider>`, OpenAI non-OAuth note), stay, persist nothing. Configured → push `model` with filter. | Show a "Checking credentials…" placeholder row. |
| model | `listModels` rows + `None (no decision calls)` | missing → guide banner. Otherwise `selectModel`: success → pop to **main** with banner message (+ `note`); failure → error banner, stay. | Never touches `enabled`. |
| edit | label, bounds hint, current value, `Input` prefilled | Enter → `updateSetting(key, text)`: success → pop with "Saved" banner; `SettingsError` → banner, keep the text. | `Input.onSubmit`/`onEscape`. |
| choice | enum options with descriptions | Enter persists that exact option | Fail-open is never reachable by cycling. |
| status | `statusLines` wrapped and scrollable | Enter refreshes | Errors render as lines. |
| allowlist | `ops.allowlist(scope)` → "Loading…" → embedded `createAllowlistComponent(childTui, theme, done', {...deps, maxRows: innerBudget, report: banner})` | child-owned | On pop: `child.dispose()`, refresh project count. |

**Async rules.** These are the contract:
1. **Lifetime.** One `AbortController`, aborted by `close()`. `close(result)` is idempotent: set `closed`, abort the lifetime, dispose the child, unfocus the `Input`, then call `done(result)` **exactly once**. `dispose()` is idempotent and only cleans up (Pi calls it after `done`).
2. **Route ops.** Starting a load (provider, model, status, allowlist deps, project count) creates `AbortSignal.any([lifetime, routeOp])`. Leaving the route or restarting the load aborts the previous op. A completion applies only if `!closed && opId === current`. Otherwise it is dropped silently: no render, no ops.
3. **Mutations.** Only one at a time (`busy`). The title shows `saving…`. Further activations are ignored, but Esc/back still work. Saves are **not** aborted (the controller queue is atomic). Results after close are ignored.
4. **No optimistic state.** Display comes from a cached `ops.snapshot()`. It refreshes on open, after each successful mutation, and on route entry, **never per render** (render runs every streaming frame).
5. **Errors.** `describeError()` turns errors into a sanitized route-local banner, at most 3 wrapped lines. The dialog never calls `controller.report`. Footer status still updates via `controller.setStatus(scopedCtx)` after saves.
6. Render and handleInput never await. All transitions are state changes plus `tui.requestRender()`.

**Scoped ctx** (`commands.ts`): `scopedContext(ctx, signal, isOpen)` returns `Object.defineProperties({}, …)` with lazy getters for `hasUI`, `mode`, `cwd`, `ui` and `modelRegistry`. Each getter throws `DialogClosedError` if closed and otherwise reads the original `ctx`. `signal` is the dialog op signal. The real `ctx.signal` (the agent run) is never used by dialog work. Every op uses it, including the existing allowlist ranking path, which currently does `{ ...ctx, signal }`. Fix that path too.

**Manager.**
- One active dialog per runtime.
- `open` while one is active calls `active.navigate(initialRoute)` and `handle.focus()`, then returns `"focused-existing"` with no second `custom`.
- The handler returns immediately on `"shutdown"` without touching ctx.
- An error from `custom` (factory) → `report(describeError)` on a live ctx only.

**Command routing.**
- **Terminal path.** Applies when `ctx.mode === "tui" && ctx.ui.custom`. The following open the dialog:

  | Command | Initial route |
  |---|---|
  | `/decisions` | main |
  | `settings` (no args) | main |
  | `relevance` (no args) | advanced |
  | `provider` (no args) | provider |
  | `model` (no args) | model |
  | `allowlist <scope>` | allowlist |

  Deep links push `[main, target]`, so Esc returns to main.
- **RPC path** (`hasUI` without that): a `select` main list with the same eight items plus `Done`. `Advanced…` opens a `select` of the relevance fields plus `Back`, edited via `input`. Allowlist items report the terminal-UI guidance.
- **Headless:** unchanged, including all text output.

**Frame.** The frame is drawn from rounded border characters themed with `border`/`borderAccent`:
- The top border carries the breadcrumb title (`Decisions › Advanced`) and the `saving…` / `checking…` state.
- Body lines are `│ <content padded to inner width> │`.
- The bottom border carries the route's key hints, so there is no extra hint row.
- Inner width is `width - 4`.

Height budget is `dialogHeightBudget(tui.terminal?.rows)`. When the budget shrinks, drop parts in this order:
1. Description.
2. Extra banner lines.
3. List rows beyond the viewport.

Always keep, in order of priority: both borders, the selected row, and one banner line. If the budget is below 3, render only the selected row. `layoutMenu` keeps the selected row visible and counts the line cost of multi-line rows.

All external text (provider/model IDs, labels, notes, paths, errors) goes through `sanitizeTerminalText` (strip `\p{Cc}\p{Cf}`, bound the length), then `truncateToWidth`/`wrapTextWithAnsi`. No themed strings are cached. The root `focused` setter propagates focus to the edit `Input` and to the embedded allowlist component.

## 6. Ordered steps

| # | Step | Depends on | Acceptance |
|---|---|---|---|
| 1 | `settings-model.ts` | — | Model tests in §7-A pass; no Pi/TUI imports (grep). |
| 2 | Allowlist `maxRows` option; remove `showAllowlistPicker` | — | Existing allowlist tests pass (RPC-guard case moved to the command test). New: with `maxRows: () => 9` it renders ≤ 9 lines, and the selected row stays visible. |
| 3 | `commands.ts` refactor: `saveModel` / `statusLines` / `listNames` return values (CLI wrappers report); `scopedContext`; ops builder; RPC Advanced submenu | 1 (`describeError`) | All headless tests unchanged. RPC tests show `Advanced…` and no `relevance.*` in main. |
| 4 | `settings-dialog.ts` component, router, manager | 1, 2, §4 types | Tests in §7-B pass. |
| 5 | Wire terminal routing, single instance, `closeDialogs` in runtime shutdown/start | 3, 4 | Tests in §7-C pass. |
| 6 | Real-renderer integration test | 4 | §7-D passes. |
| 7 | README/AGENTS updates | 5 | Docs state the honest boundaries (§8). |
| 8 | Full checks plus independent review, then publisher commit (no tag/publish) | all | `npm ci --ignore-scripts && npm test && npm run typecheck && npm pack --dry-run --ignore-scripts`, `git diff --check`. |

## 7. Test contracts (falsifying)

**A. Model** (`test/extension-settings-model.test.ts`)
- `ADVANCED_FIELDS` keys equal `Object.keys(defaultSettings().relevance) − pinned`.
- Main rows contain none of them.
- `dialogHeightBudget` matches the independent oracle `max(1, min(floor(r*0.7), r-2))` for r in 3..80.
- `layoutMenu` keeps the selected row inside the viewport for every budget 1..30 × row count 0..40, including 3-line rows.

**B. Component** (`test/extension-settings-dialog.test.ts`; fake ops with deferred promises, fake `tui {requestRender, terminal}`, identity theme)

Toggle, provider and model:
- Toggling with a slow save calls `toggleEnabled` once, even after a second Enter.
- The toggle display changes only after the snapshot refreshes.
- Provider route: Esc before `listProviders` resolves aborts the op signal. The late resolution causes no render and no rows.
- Missing key: the banner contains the env var and `/login <provider>`, and `selectModel` is never called.
- Model success: pops to main with the banner. Failure: stays with the error. `toggleEnabled` is never called.

Edit and choice:
- Edit route: the Input is prefilled.
- Invalid value: the error shows and `updateSetting` is called once.
- Esc: `updateSetting` is not called.
- `focused = true` sets `input.focused` only in the edit route.
- `failMode` changes only via explicit choice of `open`.

Allowlist:
- Child output is ≤ the inner budget.
- Esc from search pops to main; it does not close.
- Child `dispose` runs on leaving.
- Ctrl+S saved feedback appears as a banner, not a report.

Close and shutdown:
- Esc on main calls `done("closed")` once.
- `close("shutdown")` calls `done` once and aborts the lifetime signal.
- Pending ops resolving afterwards trigger no `requestRender` and no ops call.

Rendering, for widths {40, 80, 120} × rows {8, 12, 24, 40} × every route (loaded and loading):
- Every line has `visibleWidth === width`.
- Line count ≤ `dialogHeightBudget(rows)`.
- After navigating to the last row, the selected row is present.
- Hostile labels (CJK, emoji, combining characters, `\x1b`, `\u202e`) are sanitized and bounded.

**C. Commands/runtime** (update existing suites)
- Terminal ctx with `custom`: `/decisions` calls `custom` once with `{ overlay: true, overlayOptions: SETTINGS_OVERLAY_OPTIONS }` and never `select`/`input`.
- Each deep-link command reaches its route.
- RPC uses `select` with `Advanced…`.
- Headless output is byte-identical to before for `status`, `provider` and `allow … list`.
- A second `/decisions` while the first `custom` is pending causes no second `custom` call, and `handle.focus` is called.
- `session_shutdown` while open:
  - the pending handler resolves;
  - instrumented ctx getters that throw after shutdown are never hit;
  - ranking and credential signals are aborted;
  - there is no report.
- A settings save inside the dialog does **not** close it, and the dialog is not in `pending`.
- Dialog ops never read `ctx.signal` (instrumented getter count is 0).
- Missing-key, never-persist and OpenAI-OAuth tests still pass through the ops path.

**D. Real renderer** (`test/extension-settings-overlay-render.test.ts`)
- Setup: `new TuiMainScreen(fakeTerminal)` with a `Terminal` implementation that captures writes (80×24, then 80×12). The base is a Container of Text lines plus a focused `Input` that stands in for the editor. Use `tui.showOverlay(dialog, SETTINGS_OVERLAY_OPTIONS)`, which is the same path `custom({overlay:true})` uses (CA `interactive-mode.js:2372`).
- Append 60 base lines with `renderNow()` and assert:
  - the dialog stays focused;
  - `getBounds()` is stable (`row === 1`, height ≤ budget);
  - the bottom border line is visible (not sliced);
  - the last base line is present in `captureRenderState().previousLines`;
  - `fullRedraws` does not grow during appends.
- After close, focus returns to the stand-in and the base lines are intact.
- **Recommended, needs install authorization:** add devDependency `@xterm/headless@5.5.0` (the version pi-tui itself uses). Feed captured writes into it, then assert:
  - scrollback holds transcript lines in order with no dialog border/title characters;
  - viewport rows 1..h show the dialog;
  - the bottom rows show the newest transcript line.

  Without it, D still runs on `previousLines` and the redraw counters, and the scrollback claim stays an inference.

**E. Optional manual** (opt-in, never claimed by mocks): tmux/PTY session running `pi` with this extension. Start a long `!` bash loop or a stream, open `/decisions`, navigate, then capture the pane. Only a real terminal or screenshot inspection counts as a visual pass.

## 8. Docs/AGENTS rules to add

- `/decisions` in the terminal is a single floating overlay with internal routes. Do not call nested `ctx.ui.select`/`input`/`custom` from it. Close only via the saved `done`, exactly once. Never `OverlayHandle.hide()`.
- Dialog work uses a dialog-owned lifetime signal and a lazy guarded ctx. Never `ctx.signal`, never `{...ctx}`. Close dialogs synchronously in `session_shutdown`. Dialogs are not in `pending`; settings saves must not close them.
- Relevance tuning lives under Advanced. Main shows toggle, provider, model, both allowlists, Advanced, Status and Close.
- While the dialog has focus, the session keeps streaming underneath, but Esc/Ctrl+C act on the dialog, not the agent. Close it to interrupt or type.
- A mocked or renderer test is not a visual terminal check.

## 9. Risks, assumptions, open questions

- **Other overlays.** If another extension's overlay sits above ours at shutdown, Pi's topmost-pop `done` (and `resetExtensionUI`) can pop the wrong one. This is an upstream limitation. We still resolve our promise; document it.
- **Fixed dialog size.** The size is 70%×70%, top-anchored. The allowlist route is smaller than its old 80% overlay and relies on the existing compact layout. This is a tunable constant; check it in the step 8 review.
- **Background decisions.** Saving settings while a `before_agent_start` decision is in flight aborts it (that prompt fails closed). This is existing behavior, unchanged.
- **Mode switching.** Pi refuses to switch the TUI mode (regular/fullscreen) while an overlay is open. This is acceptable.
- **Install authorization.** `@xterm/headless` needs an `npm install` authorization (network plus lockfile change). The parent/user must approve, or D runs in reduced form.
- **Open question for the user (R1, optional, not in v1).** Should there be a "release input to session" key (`handle.unfocus()`), so the user can type prompts while the dialog stays visible, with `/decisions` re-focusing it? It needs a key choice and second-command handling. The single-instance manager already makes it cheap to add later.
