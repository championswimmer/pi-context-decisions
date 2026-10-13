// Floating /decisions settings dialog: ONE overlay with an internal route stack.
// Never opens nested ctx.ui.select/input/custom: Pi's custom `done` removes the TOPMOST overlay,
// so stacked dialogs could close the wrong one. Close only through `done`, exactly once.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import type { AllowlistScope } from "../apps/allowlist.ts";
import type { AuthStatus } from "../catalog/picker-models.ts";
import type { BackendSelection } from "../core/backends/factory.ts";
import type { ContextDecisionsSettings } from "../settings.ts";
import { createAllowlistComponent, type AllowlistPickerDeps } from "./allowlist-picker.ts";
import type { CommandContext } from "./contracts.ts";
import {
  ADVANCED_FIELDS, advancedField, advancedValueText, backendLabel, describeError, dialogHeightBudget, layoutMenu, modelLabel,
  sanitizeTerminalText, type AdvancedKey, type StatusSection,
} from "./settings-model.ts";

/** Percent sizes are resolved by Pi on every render; the options object itself is read once. */
export const SETTINGS_OVERLAY_OPTIONS = {
  anchor: "top-center", width: "70%", minWidth: 46, maxHeight: "70%",
  margin: { top: 1, right: 1, bottom: 1, left: 1 },
} as const satisfies OverlayOptions;

export type SettingsRoute =
  | { kind: "main" } | { kind: "advanced" } | { kind: "provider" }
  | { kind: "model"; filter?: { backend: BackendSelection["backend"]; provider?: string } }
  | { kind: "edit"; key: AdvancedKey } | { kind: "choice"; key: AdvancedKey }
  | { kind: "status" } | { kind: "allowlist"; scope: AllowlistScope };
export type InitialRoute = "main" | "advanced" | "provider" | "model" | { allowlist: AllowlistScope };
export type DialogResult = "closed" | "shutdown";

export interface DialogSnapshot { settings: ContextDecisionsSettings; settingsError?: string; hasCwd: boolean }
export interface ProviderRow { id: string; backend: "pi" | "typesafe" | "openai" | "openrouter"; provider: string; label: string; status: AuthStatus; guide?: string }
export interface ModelRow { id: string; label: string; selection: BackendSelection | null; status: AuthStatus | "none"; guide?: string; note?: string }
/** Built in commands.ts. No ctx crosses this boundary; every async method receives a dialog-owned signal. */
export interface SettingsDialogOps {
  snapshot(): DialogSnapshot;
  projectCount(signal: AbortSignal): Promise<{ count: number; warning?: string }>;
  toggleEnabled(): Promise<void>;
  updateSetting(key: string, text: string): Promise<void>;
  listProviders(signal: AbortSignal): Promise<ProviderRow[]>;
  listModels(filter: Extract<SettingsRoute, { kind: "model" }>["filter"], signal: AbortSignal): Promise<ModelRow[]>;
  selectModel(selection: BackendSelection | null, signal: AbortSignal): Promise<{ message: string }>;
  statusSections(signal: AbortSignal): Promise<StatusSection[]>;
  allowlist(scope: AllowlistScope, signal: AbortSignal): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">>;
}
export interface DialogTui { requestRender(): void; terminal?: { readonly rows: number } }
export type DialogTheme = Pick<Theme, "fg" | "bg">;
export type SettingsDialogComponent = Component & Focusable & {
  dispose(): void;
  close(result: DialogResult): void;
  navigate(route: InitialRoute): void;
  isClosed(): boolean;
};
export interface SettingsDialogOptions { initialRoute?: InitialRoute; onClose?: () => void }

type Tone = "ok" | "warn" | "muted";
interface Item { label: string; value?: string; description?: string; tone?: Tone; disabled?: string; toggle?: boolean; run(): void }
interface Banner { text: string; tone: "info" | "success" | "error" }
interface Frame {
  route: SettingsRoute;
  selected: number;
  offset: number;
  scroll: number;
  loading: boolean;
  op?: AbortController;
  banner?: Banner;
  providers?: ProviderRow[];
  models?: ModelRow[];
  sections?: StatusSection[];
  pageSize?: number;
  input?: Input;
  child?: Component & Focusable & { dispose(): void };
}

function backendFilter(selection: ContextDecisionsSettings["backend"]): { backend: BackendSelection["backend"]; provider?: string } | undefined {
  if (!selection) return undefined;
  return selection.backend === "pi" ? { backend: "pi", provider: selection.provider } : { backend: selection.backend };
}
function authText(status: AuthStatus | "none"): string { return status === "ok" ? "configured" : status === "missing" ? "missing key" : status === "none" ? "" : "unverified key"; }

export function createSettingsDialogComponent(tui: DialogTui, theme: DialogTheme, done: (result: DialogResult) => void,
  ops: SettingsDialogOps, options: SettingsDialogOptions = {}): SettingsDialogComponent {
  const lifetime = new AbortController();
  const stack: Frame[] = [];
  let closed = false;
  let focused = false;
  let busy = false;
  let snap: DialogSnapshot = ops.snapshot();
  let project: { count?: number; warning?: string; loading: boolean } = { loading: false };
  let projectOp: AbortController | undefined;
  const kb = () => getKeybindings();
  const redraw = () => { if (!closed) tui.requestRender(); };
  const top = (): Frame | undefined => stack[stack.length - 1];
  const refreshSnapshot = () => { try { snap = ops.snapshot(); } catch { /* keep the last good snapshot */ } };
  // The allowlist has its own search/save help. On tiny heights it outranks extra footer chrome.
  const innerBudget = () => {
    const budget = dialogHeightBudget(tui.terminal?.rows);
    return Math.max(1, budget - (budget < 7 ? 2 : 4));
  };
  const applyFocus = () => {
    const frame = top();
    if (frame?.input) frame.input.focused = focused && !closed;
    if (frame?.child) frame.child.focused = focused && !closed;
  };

  const newFrame = (route: SettingsRoute): Frame => ({ route, selected: 0, offset: 0, scroll: 0, loading: false });
  const leave = (frame: Frame) => {
    frame.op?.abort(); frame.op = undefined; frame.loading = false;
    if (frame.input) frame.input.focused = false;
    frame.child?.dispose(); frame.child = undefined;
  };
  const markClosed = () => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    lifetime.abort(); projectOp?.abort(); projectOp = undefined;
    while (stack.length) leave(stack.pop()!);
  };
  const close = (result: DialogResult) => {
    if (closed) return;
    markClosed();
    done(result);
  };

  /** Route-local async load. Leaving the route or restarting the load drops any late completion. */
  const load = <T,>(frame: Frame, run: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void) => {
    frame.op?.abort();
    const controller = new AbortController();
    frame.op = controller; frame.loading = true;
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const settle = (change: () => void) => {
      if (closed || frame.op !== controller || signal.aborted) return;
      frame.op = undefined; frame.loading = false;
      change(); redraw();
    };
    (async () => run(signal))().then((value) => settle(() => apply(value)), (error) => settle(() => { frame.banner = { text: describeError(error), tone: "error" }; }));
  };
  /**
   * One serialized mutation at a time; saves are never cancelled by navigation, only by closing.
   * The persisted snapshot always refreshes, but `ok` runs only while the ORIGIN frame is still on
   * the stack, and its `current` flag says whether that frame is still the visible route: route
   * changes (pop/unwind) must be gated on it, or a late save would close or rewind whatever screen
   * the user has since navigated to.
   */
  const mutate = <T,>(frame: Frame, run: () => Promise<T>, ok: (value: T, current: boolean) => void) => {
    if (busy || closed) return;
    busy = true; redraw();
    (async () => run())().then((value) => {
      busy = false;
      if (closed) return;
      refreshSnapshot();
      if (stack.includes(frame)) ok(value, top() === frame);
      redraw();
    }, (error) => {
      busy = false;
      if (closed) return;
      refreshSnapshot();
      if (stack.includes(frame)) frame.banner = { text: describeError(error), tone: "error" };
      redraw();
    });
  };
  const loadProject = () => {
    projectOp?.abort();
    if (!snap.hasCwd) { project = { loading: false }; return; }
    const controller = new AbortController();
    projectOp = controller; project = { ...project, loading: true };
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const settle = (next: typeof project) => { if (closed || projectOp !== controller || signal.aborted) return; projectOp = undefined; project = next; redraw(); };
    (async () => ops.projectCount(signal))().then((result) => settle({ count: result.count, warning: result.warning, loading: false }),
      () => settle({ loading: false, warning: "Project list unavailable" }));
  };

  const enter = (frame: Frame) => {
    refreshSnapshot();
    const route = frame.route;
    if (route.kind === "main") loadProject();
    else if (route.kind === "provider") load(frame, (signal) => ops.listProviders(signal), (rows) => { frame.providers = rows; frame.selected = 0; });
    else if (route.kind === "model") load(frame, (signal) => ops.listModels(route.filter, signal), (rows) => { frame.models = rows; frame.selected = 0; });
    else if (route.kind === "status") load(frame, (signal) => ops.statusSections(signal), (sections) => {
      frame.sections = sections.map((section) => ({ title: sanitizeTerminalText(section.title, 120), fields: section.fields.map((field) => ({
        ...field, label: sanitizeTerminalText(field.label, 120), value: sanitizeTerminalText(field.value, 1200),
      })) }));
      frame.scroll = 0;
    });
    else if (route.kind === "edit") {
      const input = new Input({ prompt: "Value: " });
      input.setValue(String(snap.settings.relevance[route.key]));
      input.handleInput("\x05"); // Ctrl+E: start editing at the end of the current value
      frame.input = input;
    } else if (route.kind === "allowlist") {
      load(frame, (signal) => ops.allowlist(route.scope, signal), (deps) => {
        let lastReport: string | undefined;
        const child = createAllowlistComponent({ requestRender: redraw }, theme, (saved) => {
          if (closed || frame.child !== child) return;
          pop();
          refreshSnapshot();
          if (route.scope === "project") loadProject();
          const parent = top();
          if (parent && saved) parent.banner = { text: lastReport ?? "Always-allowed list saved", tone: "success" };
        }, { ...deps, maxRows: innerBudget, report: (message) => { lastReport = sanitizeTerminalText(message, 200); } });
        frame.child = child;
        applyFocus();
      });
    }
  };
  const push = (route: SettingsRoute) => {
    if (closed) return;
    const frame = newFrame(route);
    stack.push(frame);
    enter(frame); applyFocus(); redraw();
  };
  const pop = () => {
    const frame = stack.pop();
    if (frame) leave(frame);
    if (!stack.length) { close("closed"); return; }
    refreshSnapshot(); applyFocus(); redraw();
  };
  /** Drop every route above main (a finished model choice returns to the root screen). */
  const unwind = () => {
    while (stack.length > 1) leave(stack.pop()!);
    refreshSnapshot(); applyFocus();
  };
  const toRoute = (route: InitialRoute): SettingsRoute => route === "main" ? { kind: "main" }
    : typeof route === "object" ? { kind: "allowlist", scope: route.allowlist } : { kind: route };
  const navigate = (route: InitialRoute) => {
    if (closed) return;
    while (stack.length) leave(stack.pop()!);
    const main = newFrame({ kind: "main" });
    stack.push(main); enter(main);
    if (route !== "main") { const frame = newFrame(toRoute(route)); stack.push(frame); enter(frame); }
    applyFocus(); redraw();
  };

  const ok = (frame: Frame, text: string) => { frame.banner = { text, tone: "success" }; };
  const itemsFor = (frame: Frame): Item[] => {
    const route = frame.route;
    const settings = snap.settings;
    if (route.kind === "main") return [
      { label: "Context decisions", value: settings.enabled ? "On" : "Off", toggle: true, tone: settings.enabled ? "ok" : "muted",
        description: "Immediately enables or disables skill filtering. Choosing a provider or model never changes this.",
        run: () => mutate(frame, () => ops.toggleEnabled(), () => ok(frame, `Context decisions ${snap.settings.enabled ? "enabled" : "disabled"}`)) },
      { label: "Provider / execution", value: backendLabel(settings.backend), description: "Choose Pi's classifier pipeline or a direct TypeSafe, OpenAI or OpenRouter endpoint.", run: () => push({ kind: "provider" }) },
      { label: "Model", value: modelLabel(settings.backend), description: "Pick the decision model. Providers without a key are labelled and cannot be selected.", run: () => push({ kind: "model", filter: backendFilter(settings.backend) }) },
      { label: "Always allowed · Global", value: String(settings.globalAllowlist.length), description: "Skills always advertised in every project, never scored. Not a restriction list.", run: () => push({ kind: "allowlist", scope: "global" }) },
      { label: "Always allowed · Project", value: !snap.hasCwd ? "n/a" : project.loading ? "…" : `${project.count ?? "?"}${project.warning ? " ⚠" : ""}`,
        tone: project.warning ? "warn" : undefined,
        description: project.warning ?? "Skills always advertised for this working directory only. Not a restriction list.",
        ...(snap.hasCwd ? {} : { disabled: "No working directory is available for a project list." }),
        run: () => push({ kind: "allowlist", scope: "project" }) },
      { label: "Advanced…", description: "Thresholds, batching, concurrency, timeout, failure mode and size limits.", run: () => push({ kind: "advanced" }) },
      { label: "Status…", description: "Credentials, last decision and allowlist counts. Makes no inference calls.", run: () => push({ kind: "status" }) },
      { label: "Close", run: () => close("closed") },
    ];
    if (route.kind === "advanced") return ADVANCED_FIELDS.map((field) => ({
      label: field.label, value: advancedValueText(field, settings), description: field.hint, toggle: field.kind === "bool",
      ...(field.key === "failMode" && settings.relevance.failMode === "open" ? { tone: "warn" as const } : {}),
      run: () => {
        if (field.kind === "bool") mutate(frame, () => ops.updateSetting(`relevance.${field.key}`, String(!settings.relevance[field.key])), () => ok(frame, "Saved"));
        else if (field.kind === "choice") push({ kind: "choice", key: field.key });
        else push({ kind: "edit", key: field.key });
      },
    }));
    if (route.kind === "provider") {
      if (!frame.providers) return [{ label: frame.loading ? "Checking credentials…" : "No providers available", disabled: frame.loading ? "Checking credentials without any inference calls…" : "No providers available.", run: () => {} }];
      return frame.providers.map((row) => ({
        label: sanitizeTerminalText(row.label, 120), value: authText(row.status), tone: row.status === "ok" ? "ok" as const : "warn" as const,
        description: row.status === "ok" ? "Enter chooses a model for this provider." : "No usable credentials. Press Enter for the setup guide.",
        run: () => {
          if (row.status !== "ok") frame.banner = { text: sanitizeTerminalText(row.guide ?? "Credentials are missing.", 600), tone: "error" };
          else push({ kind: "model", filter: { backend: row.backend, ...(row.backend === "pi" ? { provider: row.provider } : {}) } });
        },
      }));
    }
    if (route.kind === "model") {
      if (!frame.models) return [{ label: frame.loading ? "Checking credentials…" : "No models available", disabled: frame.loading ? "Checking credentials without any inference calls…" : "No matching models.", run: () => {} }];
      return frame.models.map((row) => ({
        label: sanitizeTerminalText(row.label, 120), value: authText(row.status), tone: row.status === "missing" ? "warn" as const : row.status === "none" ? "muted" as const : undefined,
        description: sanitizeTerminalText(row.status === "missing" ? "No usable credentials. Press Enter for the setup guide." : row.note ?? "Enter selects this model without enabling anything.", 600),
        run: () => {
          if (row.status === "missing") { frame.banner = { text: sanitizeTerminalText(row.guide ?? "Credentials are missing.", 600), tone: "error" }; return; }
          mutate(frame, () => ops.selectModel(row.selection, lifetime.signal), (result, current) => {
            const message = { text: sanitizeTerminalText(result.message, 400), tone: "success" as const };
            if (!current) { frame.banner = message; return; } // saved, but the user moved on: no route change
            unwind();
            const root = top();
            if (root) root.banner = message;
          });
        },
      }));
    }
    if (route.kind === "choice") {
      const field = advancedField(route.key);
      return (field?.options ?? []).map((option) => ({
        label: option.value, value: String(settings.relevance[route.key]) === option.value ? "current" : "",
        tone: route.key === "failMode" && option.value === "open" ? "warn" as const : undefined, description: option.description,
        run: () => mutate(frame, () => ops.updateSetting(`relevance.${route.key}`, option.value), (_value, current) => { if (!current) { ok(frame, "Saved"); return; } pop(); const parent = top(); if (parent) ok(parent, "Saved"); }),
      }));
    }
    return [];
  };

  const crumb = (frame: Frame): string => {
    const route = frame.route;
    switch (route.kind) {
      case "main": return "Decisions";
      case "advanced": return "Decisions › Advanced";
      case "provider": return "Decisions › Provider";
      case "model": return "Decisions › Model";
      case "edit": case "choice": return `Decisions › Advanced › ${advancedField(route.key)?.label ?? route.key}`;
      case "status": return "Decisions › Status";
      case "allowlist": return `Decisions › Always allowed · ${route.scope === "global" ? "Global" : "Project"}`;
    }
  };
  const hint = (frame: Frame): string => {
    switch (frame.route.kind) {
      case "main": return "↑↓ move · Enter select · Space toggle · Esc close";
      case "edit": return "Enter save · Esc cancel";
      case "status": return "↑↓ / PgUp PgDn scroll · Enter refresh · Esc back";
      case "allowlist": return "Esc back";
      default: return "↑↓ move · Enter select · Space toggle · Esc back";
    }
  };
  const wrap = (text: string, width: number, limit: number): string[] => wrapTextWithAnsi(sanitizeTerminalText(text, 1200), Math.max(1, width)).slice(0, Math.max(0, limit));
  const bannerLines = (frame: Frame, width: number): string[] => {
    const banner = frame.banner ?? (frame.route.kind === "main" && snap.settingsError ? { text: `Settings error: ${snap.settingsError}. Repair with /decisions model or settings.`, tone: "error" as const } : undefined);
    if (!banner) return [];
    const color = banner.tone === "error" ? "error" : banner.tone === "success" ? "success" : "warning";
    return wrap(banner.text, width, 4).map((line) => theme.fg(color, line));
  };

  const borderLine = (left: string, right: string, label: string, tag: string, width: number): string => {
    const inner = width - 2;
    let tagText = tag ? ` ${tag} ` : "";
    if (visibleWidth(tagText) > inner - 6) tagText = "";
    const labelText = truncateToWidth(` ${label} `, Math.max(0, inner - 1 - visibleWidth(tagText)), "…");
    const fill = Math.max(0, inner - 1 - visibleWidth(labelText) - visibleWidth(tagText));
    return theme.fg("border", `${left}─`) + theme.fg("accent", labelText) + theme.fg("border", "─".repeat(fill)) + theme.fg("warning", tagText) + theme.fg("border", right);
  };
  const ruleLine = (left: string, right: string, width: number): string => theme.fg("border", left + "─".repeat(width - 2) + right);
  const footerLines = (frame: Frame, inner: number, budget: number): string[] => {
    if (budget < 5 || (frame.route.kind === "allowlist" && budget < 7)) return []; // Preserve focus on tiny terminals.
    const room = Math.min(2, budget - 4);
    const full = wrapTextWithAnsi(hint(frame), inner);
    if (full.length <= room) return full;
    const compact = frame.route.kind === "edit" ? "Enter save · Esc cancel" : frame.route.kind === "allowlist" ? "Esc back"
      : frame.route.kind === "status" ? "↑↓ scroll · Enter refresh · Esc" : "↑↓ move · Enter/Space · Esc";
    const short = wrapTextWithAnsi(compact, inner);
    if (short.length <= room) return short;
    // At very narrow widths use complete key names, not clipped fragments of instructions.
    return [inner >= 12 ? "↑↓ · ↵ · Esc" : inner >= 3 ? "Esc" : "↵"];
  };
  const bodyLine = (text: string, inner: number): string => theme.fg("border", "│") + " " + truncateToWidth(text, inner, "…", true) + " " + theme.fg("border", "│");

  /** Allocate `budget` lines to sections by priority (min lines first, then the rest); keep visual order. */
  const fit = (budget: number, sections: { lines: string[]; min: number }[]): string[] => {
    const taken = sections.map(() => 0);
    let remaining = Math.max(0, budget);
    for (let i = 0; i < sections.length; i++) { const take = Math.min(sections[i].min, sections[i].lines.length, remaining); taken[i] = take; remaining -= take; }
    for (let i = 0; i < sections.length; i++) { const take = Math.min(sections[i].lines.length - taken[i], remaining); taken[i] += take; remaining -= take; }
    return sections.flatMap((section, i) => section.lines.slice(0, taken[i]));
  };

  const listBody = (frame: Frame, inner: number, bodyBudget: number): string[] => {
    const items = itemsFor(frame);
    frame.selected = Math.min(Math.max(0, frame.selected), Math.max(0, items.length - 1));
    const selected = items[frame.selected];
    const longest = items.reduce((max, item) => Math.max(max, visibleWidth(sanitizeTerminalText(item.label, 120))), 0);
    const valueWidth = Math.min(28, items.reduce((max, item) => Math.max(max, visibleWidth(sanitizeTerminalText(item.value ?? "", 160))), 0));
    // Labels get every column the values do not need, so long provider names are not clipped needlessly.
    const labelCol = Math.max(8, Math.min(longest, inner - 2 - 2 - valueWidth));
    const row = (item: Item, index: number): string => {
      const mark = index === frame.selected ? "❯" : " ";
      const text = `${mark} ${truncateToWidth(sanitizeTerminalText(item.label, 120), labelCol, "…", true)}${item.value ? `  ${sanitizeTerminalText(item.value, 160)}` : ""}`;
      const line = truncateToWidth(text, inner, "…");
      return index === frame.selected ? theme.fg("accent", line) : item.disabled ? theme.fg("dim", line) : item.tone === "warn" ? theme.fg("warning", line) : item.tone === "ok" ? theme.fg("success", line) : item.tone === "muted" ? theme.fg("muted", line) : line;
    };
    const banner = bannerLines(frame, inner);
    const bannerCount = banner.length ? Math.min(banner.length, Math.max(1, Math.min(4, bodyBudget - 1))) : 0;
    const descSource = selected?.disabled ?? selected?.description ?? "";
    // Do not displace a row when the whole list fits exactly. Longer lists still show selection help.
    const spare = bodyBudget - bannerCount - items.length;
    const wantDesc = bodyBudget >= 8 && descSource && spare !== 0 ? Math.max(1, Math.min(2, spare)) : 0;
    const descLines = wantDesc === 0 ? [] : wantDesc === 1
      ? [theme.fg("muted", truncateToWidth(sanitizeTerminalText(descSource, 1200), inner, "…"))]
      : wrap(descSource, inner, 2).map((line) => theme.fg("muted", line));
    const descCount = Math.min(descLines.length, Math.max(0, bodyBudget - 1 - bannerCount));
    const listBudget = Math.max(1, bodyBudget - bannerCount - descCount);
    const heights = items.map(() => 1);
    const layout = layoutMenu(heights, frame.selected, listBudget, frame.offset);
    frame.offset = layout.start;
    const rows = items.slice(layout.start, layout.end).map((item, i) => row(item, layout.start + i));
    if (!items.length) rows.push(theme.fg("muted", "Nothing to show"));
    return [...rows, ...descLines.slice(0, descCount), ...banner.slice(0, bannerCount)];
  };

  const statusBody = (sections: StatusSection[], inner: number): string[] => {
    // Keep diagnostics readable on very wide terminals, with hanging indents for long values.
    const width = Math.min(inner, 88);
    const labelWidth = Math.min(18, Math.max(0, ...sections.flatMap((section) => section.fields.map((field) => visibleWidth(field.label)))));
    return sections.flatMap((section, index) => [
      ...(index ? [""] : []), theme.fg("accent", section.title),
      ...section.fields.flatMap((field) => {
        const color = (text: string) => field.warning ? theme.fg("warning", text) : text;
        if (width < labelWidth + 14) return [
          theme.fg("muted", `${field.label}:`),
          ...wrapTextWithAnsi(field.value, Math.max(1, width - 2)).map((line) => `  ${color(line)}`),
        ];
        const prefix = truncateToWidth(`${field.label}:`, labelWidth + 1, "…", true) + "  ";
        return wrapTextWithAnsi(field.value, width - labelWidth - 3).map((line, i) =>
          (i === 0 ? theme.fg("muted", prefix) : " ".repeat(labelWidth + 3)) + color(line));
      }),
    ]);
  };

  const component: SettingsDialogComponent = {
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; applyFocus(); },
    isClosed: () => closed,
    close,
    navigate,
    dispose() { markClosed(); },
    invalidate() { for (const frame of stack) { frame.input?.invalidate(); } },
    render(width: number): string[] {
      const w = Math.max(1, Math.floor(width));
      const frame = top();
      if (closed || !frame) return [];
      const budget = dialogHeightBudget(tui.terminal?.rows);
      let tag = busy ? "saving…" : frame.loading ? "checking…" : "";
      if (w < 8 || budget < 3) {
        // Too small for a frame: keep the one thing that matters visible.
        const items = frame.child || frame.input ? [] : itemsFor(frame);
        const line = frame.child ? (frame.child.render(w)[0] ?? "") : frame.input ? (frame.input.render(w)[0] ?? "") : items[Math.min(frame.selected, items.length - 1)]?.label ?? crumb(frame);
        return [truncateToWidth(`${tag ? `${tag} ` : ""}${sanitizeTerminalText(line, 200)}`, w, "…", true)];
      }
      const inner = w - 4;
      const footer = footerLines(frame, inner, budget);
      const bodyBudget = budget - 2 - (footer.length ? 1 + footer.length : 0);
      let body: string[];
      const route = frame.route;
      if (route.kind === "allowlist" && frame.child) body = frame.child.render(inner).slice(0, bodyBudget);
      else if (route.kind === "allowlist") body = fit(bodyBudget, [{ lines: [theme.fg("muted", frame.loading ? "Loading skill inventory…" : "Nothing to show")], min: 1 }, { lines: bannerLines(frame, inner), min: 1 }]);
      else if (route.kind === "edit" && frame.input) {
        const field = advancedField(route.key);
        body = fit(bodyBudget, [
          { lines: [theme.fg("accent", sanitizeTerminalText(field?.label ?? route.key, 120))], min: 1 },
          { lines: wrap(field?.hint ?? "", inner, 3).map((line) => theme.fg("muted", line)), min: 0 },
          { lines: frame.input.render(inner), min: 1 },
          { lines: bannerLines(frame, inner), min: 1 },
        ]);
        // Keep priorities honest on tiny heights: input and banner outrank label and hint.
        if (bodyBudget < 4) body = fit(bodyBudget, [{ lines: [], min: 0 }, { lines: [], min: 0 }, { lines: frame.input.render(inner), min: 1 }, { lines: bannerLines(frame, inner), min: 1 }]);
      } else if (route.kind === "status") {
        const banner = bannerLines(frame, inner);
        const lines = frame.sections ? statusBody(frame.sections, inner) : [theme.fg("muted", frame.loading ? "Collecting status without inference calls…" : "Nothing to show")];
        const room = Math.max(1, bodyBudget - Math.min(banner.length, Math.max(0, bodyBudget - 1)));
        frame.scroll = Math.min(Math.max(0, frame.scroll), Math.max(0, lines.length - room));
        frame.pageSize = room;
        if (!tag && lines.length > room) tag = `${frame.scroll + 1}–${Math.min(frame.scroll + room, lines.length)} / ${lines.length}`;
        body = [...lines.slice(frame.scroll, frame.scroll + room), ...banner.slice(0, bodyBudget - room)];
      } else body = listBody(frame, inner, bodyBudget);
      body = body.slice(0, bodyBudget);
      return [borderLine("╭", "╮", crumb(frame), tag, w), ...body.map((line) => bodyLine(line, inner)),
        ...(footer.length ? [ruleLine("├", "┤", w), ...footer.map((line) => bodyLine(theme.fg("dim", line), inner))] : []), ruleLine("╰", "╯", w)];
    },
    handleInput(data: string) {
      if (closed) return;
      const frame = top();
      if (!frame) return;
      const keys = kb();
      if (frame.child) { frame.child.handleInput?.(data); return; }
      if (frame.input) {
        if (keys.matches(data, "tui.select.cancel")) { pop(); return; }
        if (keys.matches(data, "tui.select.confirm") || matchesKey(data, "return")) {
          const route = frame.route;
          if (route.kind === "edit") {
            const text = frame.input.getValue().trim();
            mutate(frame, () => ops.updateSetting(`relevance.${route.key}`, text), (_value, current) => { if (!current) { ok(frame, "Saved"); return; } pop(); const parent = top(); if (parent) ok(parent, "Saved"); });
          }
          return;
        }
        frame.input.handleInput(data);
        redraw();
        return;
      }
      if (keys.matches(data, "tui.select.cancel")) { if (stack.length > 1) pop(); else close("closed"); return; }
      if (frame.route.kind === "status") {
        if (keys.matches(data, "tui.select.up")) frame.scroll = Math.max(0, frame.scroll - 1);
        else if (keys.matches(data, "tui.select.down")) frame.scroll += 1;
        else if (keys.matches(data, "tui.select.pageUp")) frame.scroll = Math.max(0, frame.scroll - (frame.pageSize ?? 5));
        else if (keys.matches(data, "tui.select.pageDown")) frame.scroll += frame.pageSize ?? 5;
        else if (matchesKey(data, "home")) frame.scroll = 0;
        else if (matchesKey(data, "end")) frame.scroll = Number.POSITIVE_INFINITY;
        else if (keys.matches(data, "tui.select.confirm") && !frame.loading) enter(frame);
        redraw();
        return;
      }
      const items = itemsFor(frame);
      if (!items.length) return;
      if (keys.matches(data, "tui.select.up")) frame.selected = Math.max(0, frame.selected - 1);
      else if (keys.matches(data, "tui.select.down")) frame.selected = Math.min(items.length - 1, frame.selected + 1);
      else if (keys.matches(data, "tui.select.pageUp")) frame.selected = Math.max(0, frame.selected - 5);
      else if (keys.matches(data, "tui.select.pageDown")) frame.selected = Math.min(items.length - 1, frame.selected + 5);
      else if (keys.matches(data, "tui.select.confirm") || (matchesKey(data, "space") && items[frame.selected]?.toggle)) {
        const item = items[Math.min(frame.selected, items.length - 1)];
        if (item.disabled) frame.banner = { text: item.disabled, tone: "info" };
        else { frame.banner = undefined; item.run(); }
      } else return;
      redraw();
    },
  };
  navigate(options.initialRoute ?? "main");
  return component;
}

export interface DialogLife { isOpen(): boolean }
export interface SettingsDialogManager {
  open(ctx: Pick<CommandContext, "ui">, makeOps: (life: DialogLife) => SettingsDialogOps, initialRoute: InitialRoute): Promise<DialogResult | "focused-existing">;
  /** Idempotent and synchronous: resolves any pending `open` with "shutdown" and aborts dialog work. */
  closeAll(): void;
  isOpen(): boolean;
}
export function createSettingsDialogManager(): SettingsDialogManager {
  let active: { component: SettingsDialogComponent; handle?: OverlayHandle } | undefined;
  let opening = false;
  let closeRequested = false;
  return {
    async open(ctx, makeOps, initialRoute) {
      if (active || opening) {
        active?.component.navigate(initialRoute);
        try { active?.handle?.focus(); } catch { /* handle may belong to a disposed overlay */ }
        return "focused-existing";
      }
      const custom = ctx.ui.custom;
      if (!custom) throw new Error("Terminal custom UI is unavailable");
      opening = true; closeRequested = false;
      const life = { closed: false };
      try {
        const ops = makeOps({ isOpen: () => !life.closed });
        return await custom.call(ctx.ui, (tui, theme, _keys, done) => {
          const component = createSettingsDialogComponent(tui, theme, done, ops, { initialRoute, onClose: () => { life.closed = true; } });
          active = { component }; opening = false;
          if (closeRequested) queueMicrotask(() => component.close("shutdown"));
          return component;
        }, { overlay: true, overlayOptions: SETTINGS_OVERLAY_OPTIONS, onHandle: (handle) => { if (active) active.handle = handle; } }) as DialogResult;
      } finally { active = undefined; opening = false; life.closed = true; }
    },
    closeAll() {
      if (active) active.component.close("shutdown");
      else if (opening) closeRequested = true;
    },
    isOpen: () => !!active || opening,
  };
}
