# Floating `/decisions` settings: Pi 1.1.0 research

Status: research handoff, not implemented. Inspected 2026-10-12. User reports npm `0.1.0` published; this task must not publish/tag/bump the package. Initial `git status --short` was clean. Only this evidence file is written by research.

## Recommendation

Use **one** `ctx.ui.custom(..., { overlay: true })` terminal interaction for the complete settings flow. Render a bordered, viewport-sized component above the transcript; put provider/model selectors, edits, status and Advanced into an internal route stack instead of calling `ctx.ui.select()`/`input()` from the floating terminal path. Embed the existing allowlist component as a routed child where practical. Keep RPC/headless flows separate and functional.

The supported Pi overlay does not replace the transcript or editor and does not suspend an already-running agent. A focused dialog owns keyboard input, **not** the agent stream. Thus the requested "background keeps printing/scrolling while settings remains displayed" is feasible without making the dialog input-passive or returning the command immediately.

Source-root shorthand below:
- **CA** = `node_modules/@earendil-works/pi-coding-agent` (installed package version 1.1.0).
- **TUI** = `node_modules/@earendil-works/pi-tui` (installed package version 1.1.0).
- Repository source citations are working-tree evidence, unchanged by this researcher.

## 1. Existing behavior and why it looks inline

- `src/extension/commands.ts:257-299`: `settingsDialog` loops over `ctx.ui.select`, builds every non-pinned relevance field into the top-level list, and uses `ctx.ui.input` for nonboolean edits. It is not currently a floating custom overlay.
- `src/extension/commands.ts:92-145`: provider/model helpers use inline selects. Merely changing the root dialog leaves their submenus inline.
- `src/extension/commands.ts:150-182`: status uses `controller.report`, producing a large notification/transcript block rather than an in-dialog view.
- `src/extension/contracts.ts:14-23`: `CommandContext.ui.custom` is already an optional public method, sufficient for a TUI-only capability check; `mode` is available.
- `src/extension/runtime.ts:74-91`: reporting uses notifications; `setStatus` is a compact footer indicator. Do not confuse this indicator with the settings editor. It can remain an independent small status line.
- `src/extension/allowlist-picker.ts:208-211`: allowlist already uses `ctx.ui.custom` with `overlay:true`, width/maxHeight `80%`. Its component factory is reusable separately (`createAllowlistComponent`).
- `test/extension-decisions-settings.test.ts:13-48,50-64`: current settings tests mock `select`/`input` and expect scoring fields in the main menu; these need deliberate replacement for TUI flow, not a fallback that preserves the old interface in production.

## 2. Documented public contracts

Read in full: CA `docs/extensions.md` (274 lines), `docs/tui.md` (125), `docs/sdk.md` (147). Inspected linked declaration and relevant checked examples/implementation.

- CA `docs/tui.md:64-76`: `custom` completes via supplied callback; `overlay:true` draws above existing content; handle can focus or temporarily hide; focused overlays retain input across ordinary renders; **do not call `OverlayHandle.hide()` for a `ctx.ui.custom`-created overlay**.
- CA `dist/core/extensions/types.d.ts:120-131`:
  ```ts
  ctx.ui.custom<T>(
    factory: (tui, theme, keybindings, done: (result:T)=>void) => Component | Promise<Component>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: OverlayHandle) => void;
    }
  ): Promise<T>
  ```
  Component additionally permits `dispose?():void`.
- TUI `dist/tui.d.ts:134-161`: overlay options include `width`, `minWidth`, `maxHeight`, `anchor`, offsets, row/col, margin, responsive `visible`, and `nonCapturing`.
- TUI `dist/tui.d.ts:177-194`: handle exposes `setHidden`, `isHidden`, `focus`, `unfocus({target})`, `isFocused`, `getBounds`; `hide` permanently removes the overlay but is inappropriate for custom-owned completion.
- CA `docs/extensions.md:241-250`: only `mode === "tui"` supports custom terminal components; RPC supports selected primitive dialogs, not custom components. `hasUI` alone is insufficient.
- CA `docs/tui.md:21-31,44-50`: bound visible columns with supplied utilities, `invalidate` plus `requestRender`, propagate Focusable state to Input for IME.

## 3. Background output is independent from input focus (observed code)

1. CA `dist/core/agent-session.js:1510-1532,1634-1657`: extension commands are checked/executed immediately **even during streaming**. The handler is awaited, but the command path does not abort, wait for idle, or pause the active agent. Avoid adding `ctx.waitForIdle`/`abort` to open settings.
2. CA `dist/modes/interactive/interactive-mode.js:2737-2748,2821-2868`: a session subscription independently dispatches events; assistant starts/updates mutate the streaming chat component and request render. There is no custom-overlay guard suppressing these updates.
3. CA `dist/modes/interactive/interactive-mode.js:2109-2149,2167-2206`: ordinary select/input clear `editorContainer`, install the dialog there, change focus, and set a blocked program-status annotation. This is the inline UI being replaced.
4. CA `dist/modes/interactive/interactive-mode.js:2324-2390`: overlay custom mode calls `this.ui.showOverlay` and does not clear/editor-replace the underlying container. Non-overlay custom mode does replace it.
5. TUI `dist/tui-main-screen.js:211-236`: every render computes the base document first, then composites overlays, then applies differential rendering. The base document is not frozen.
6. TUI `dist/tui.js:950-1017`: overlays are rendered into terminal-relative viewport positions. `viewportStart = max(0, workingHeight - termHeight)` means growing underlying content does not move the floating box away with transcript history.
7. TUI `dist/tui-alt-screen.js:1426-1454`: fullscreen render also composites overlays onto the screen. Fullscreen transcript scroll is UI-owned; regular mode scrollback is terminal-owned (CA `docs/tui.md:54-62`). Do not promise identical scrollback mechanics across modes.

**Inference grounded in the above:** a pending `custom()` promise need not be detached simply to allow existing output to continue. Verify actual integration with a synthetic stream; mocks alone do not prove terminal compositing.

The extension runner emits `ui_prompt_start`/`ui_prompt_end` around custom interactions (CA `dist/core/extensions/runner.js:357-391`). This is lifecycle/status annotation, not an implementation of stream suspension. Do not claim "no UI prompt state".

## 4. Focus and persistence choices

- Defaults capture keyboard focus. This is correct for an editable settings dialog and does not block output.
- TUI `dist/tui.js:365-463`: `nonCapturing:true` prevents initial focus; `focus` brings an overlay forward; `unfocus` can route input to a previous/explicit target while leaving it visible; `setHidden` is temporary.
- Focus restoration across regular rendering and nested modal targets is implemented in TUI `dist/tui.js:248-336,705-738`.
- **Optional future UX**, not required to keep output printing: a "Return input to session" key can call handle.unfocus(), and reopening `/decisions` can refocus the existing handle. That requires one-dialog-per-runtime state and a reopening path. Do not add arbitrary unbound hotkeys or a timer merely to keep the overlay alive.
- Prefer a synchronous factory returning the already-built root component. Code can start async provider loading within that instance using generation/AbortController ownership. No await inside render/handleInput; render/loading/error are state transitions.

## 5. Important cleanup/stacking hazard

CA `dist/modes/interactive/interactive-mode.js:2335-2358`: `custom`'s completion callback calls **`this.ui.hideOverlay()`**, which removes the **topmost** overlay, not an entry-specific handle. TUI `dist/tui.js:467-484` confirms stack pop semantics.

Therefore:
- Do not complete a parent custom overlay while a separately-created child overlay is on top.
- A single root dialog with internal child components/routes is the lowest-risk design. The existing allowlist `createAllowlistComponent` can be embedded, with its `done` mapped to route back rather than root completion; call its `dispose` when leaving that route.
- If architecture chooses stacked allowlist custom interactions instead, explicitly unwind child before parent on close/shutdown; do not rely on parent handle.hide or dispose alone to resolve custom promises. Document external-other-extension overlays as an upstream limitation if unavoidable.
- Calling component `dispose` alone does not resolve the `custom` promise. Closure must invoke the saved `done` exactly once, with idempotent component cleanup. Handle.hide alone similarly leaves prompt lifecycle pending.
- Custom has no `signal` option. The extension must own a UI-lifetime abort and route that to `done`, independent of request-time decision AbortControllers.

CA `dist/core/agent-session.js:2936-2941` emits `session_shutdown(reason:"reload")` **before** invalidating the old runner. CA `docs/extensions.md:62-69,257-263` requires teardown on shutdown and warns captured contexts become stale on replacement. Existing `runtime.ts:100-115` only cancels decision work, not a future settings custom interaction. Add independently managed overlay lifetime cleanup on session shutdown/start/replacement as appropriate. Do not register the UI lifetime in `pending`: `controller.update` intentionally aborts that set after settings saves (`runtime.ts:57-64`) and must not close the settings dialog after every edit.

## 6. Responsive rendering

- `maxHeight` **clips** rather than scrolls: TUI `dist/tui.js:972-978` takes `slice(0,maxHeight)`.
- Current allowlist height budgeting already consults `tui.terminal.rows` and 80% (`allowlist-picker.ts:119-157`). Reuse its lesson, not just its numeric constant: root borders/header/footer and route-specific inputs consume height too.
- Public `TUI.terminal` has `rows`/`columns`, render API supplies available overlay width (TUI `dist/tui.d.ts:212-238`; `dist/terminal.d.ts:18-49`). Compute a consistent height budget each render, reserve help/status/edit controls, and scroll list bodies so the selected row stays visible at 80x24 and short screens.
- Use visibleWidth/truncateToWidth/wrapTextWithAnsi, theme callback tokens; sanitize configured model/provider names and displayed errors. Do not cache ANSI strings across theme invalidation.

## 7. Menu grouping recommendation (proposal, not implementation)

Main settings (compact):
1. Context decisions enabled toggle
2. Provider / execution path
3. Model
4. Always allowed — Global
5. Always allowed — Project
6. Advanced…
7. Status… (optional compact readonly route)
8. Close

Advanced contains existing relevance/policy fields rather than introducing a new persisted settings schema: relevance.enabled, mode, minLabel, related/direct thresholds, chunkSize, concurrency, maxSkills, minCandidates, timeoutMs, failMode, existing metadata payload bounds if currently exposed. Preserve unscoped pins/headless commands. In-frame boolean controls, enum choice lists, numeric/text Inputs with unit/range hints; Esc backs out of an edit without persistence, then backs to main, then closes root. Persist only through Controller.update/saveProjectAllowlist and keep current auth/source-aware validation.

Avoid using `controller.report` for routine dialog edits/provider loading/status/errors; route-local banner prevents transcript spam and no injected user/model message should represent UI interaction. Keep explicit headless `/decisions status` reporting unchanged. The compact footer indicator may update after committed settings.

## 8. Verification handoff

Research ran **no tests/builds/inference/PTY code** and installed nothing. The following are proposed falsifying checks:

- Contract/unit: TUI `/decisions` calls custom with overlay:true and never select/input; root menu has Advanced but no raw threshold/batch controls. RPC has no custom call; headless args still work.
- Async lifecycle: one root per runtime; reopen focuses existing instance; closed/generation-changed requests cannot mutate route; shutdown/reload resolves custom and disposes inputs/allowlist/ranking work once; saving settings doesn't close UI; background status refresh doesn't reset selected row.
- Rendering: 40/80/120 columns, 24/12 rows and resize, long Unicode/model errors, Input focus/IME marker, selected row/footer after repeated downward navigation/expanded child content.
- **Real renderer integration** (no paid call): use public MainScreenTUI/AltScreenTUI with a fake Terminal implementing `dist/terminal.d.ts:18-49`, capture writes, increment base transcript component while overlay stays mounted, request/renderNow and check overlay bounds/focus persist and later base lines appear; close restores editor/focus and base lines survive. This exercises actual compositor, unlike ui.custom mocks.
- PTY smoke if implementation authorized: python3 (`/opt/homebrew/bin/python3`), script (`/usr/bin/script`), tmux (`/opt/homebrew/bin/tmux`) are available. A synthetic stream fixture can use existing Node/TUI dependencies, no new tool installation or API credentials. PTY stream capture is not automatically a visual pass; distinguish terminal/emulator screenshots or manual inspection from text assertions.
- Full offline suite/typecheck/pack after implementation. No release tag, npm publish, version bump or live inference for this UI milestone without new authorization.

## 9. Inspected vs remaining unknown

Observed source supports concurrent underlying rendering and floating overlay positioning. Checked examples: CA `examples/extensions/overlay-test.ts` in full (153 lines), `overlay-qa-tests.ts` relevant full classes for passive/focus/streaming at 939-1142 and 1249-1375. The examples demonstrate focus/composition and synthetic updates; they are not evidence of this extension's completed UI.

No actual new dialog exists yet. Actual terminal behavior, multi-extension overlay interleaving, lifecycle races and successful install of published0.1.0 are unverified. There is no need for network retrieval; the installed1.1.0 implementation is the version-specific authority for this decision.
