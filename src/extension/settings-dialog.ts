// Floating /decisions settings dialog: ONE overlay with an internal route stack.
// The two roots, "main" (Skill picker) and "tools" (Tool picker), are peer tabs; every other route is pushed above the active tab.
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
  ADVANCED_FIELDS, TOOL_FIELDS, advancedValueText, backendLabel, describeError, dialogHeightBudget, fieldFor, fieldValue, layoutMenu, modelLabel,
  sanitizeTerminalText, type SettingsGroup,
} from "./settings-model.ts";

/** Percent sizes are resolved by Pi on every render; the options object itself is read once. */
export const SETTINGS_OVERLAY_OPTIONS = {
  anchor: "top-center", width: "70%", minWidth: 46, maxHeight: "70%",
  margin: { top: 1, right: 1, bottom: 1, left: 1 },
} as const satisfies OverlayOptions;

/** Which always-allowed list an allowlist route edits. Omitted means skills. */
export type AllowlistKind = "skills" | "tools" | "mcp";
export type SettingsRoute =
  | { kind: "main" } | { kind: "advanced" } | { kind: "tools" } | { kind: "provider" }
  | { kind: "model"; filter?: { backend: BackendSelection["backend"]; provider?: string } }
  | { kind: "edit"; key: string; group?: SettingsGroup } | { kind: "options"; key: string; group?: SettingsGroup }
  | { kind: "status" } | { kind: "allowlist"; scope: AllowlistScope; list?: AllowlistKind };
export type InitialRoute = "main" | "advanced" | "tools" | "provider" | "model" | { allowlist: AllowlistScope; list?: AllowlistKind };
export type DialogResult = "closed" | "shutdown";

export interface DialogSnapshot { settings: ContextDecisionsSettings; settingsError?: string; hasCwd: boolean }
export interface ProviderRow { id: string; backend: "pi" | "typesafe" | "openai" | "openrouter"; provider: string; label: string; status: AuthStatus; guide?: string }
export interface ModelRow { id: string; label: string; selection: BackendSelection | null; status: AuthStatus | "none"; guide?: string; note?: string }
/** Built in commands.ts. No ctx crosses this boundary; every async method receives a dialog-owned signal. */
export interface SettingsDialogOps {
  snapshot(): DialogSnapshot;
  /** `count` is the project skill list; `tools`/`mcpServers` are the project tool and MCP server lists (when known). */
  projectCount(signal: AbortSignal): Promise<{ count: number; tools?: number; mcpServers?: number; warning?: string }>;
  toggleEnabled(): Promise<void>;
  updateSetting(key: string, text: string): Promise<void>;
  listProviders(signal: AbortSignal): Promise<ProviderRow[]>;
  listModels(filter: Extract<SettingsRoute, { kind: "model" }>["filter"], signal: AbortSignal): Promise<ModelRow[]>;
  selectModel(selection: BackendSelection | null, signal: AbortSignal): Promise<{ message: string }>;
  statusLines(signal: AbortSignal): Promise<string[]>;
  allowlist(scope: AllowlistScope, signal: AbortSignal): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">>;
  /** Editors for the tool and MCP server allowlists. Absent in hosts without tool filtering. */
  toolAllowlist?(list: Exclude<AllowlistKind, "skills">, scope: AllowlistScope, signal: AbortSignal): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">>;
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
  lines?: string[];
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
  let project: { count?: number; tools?: number; mcpServers?: number; warning?: string; loading: boolean } = { loading: false };
  let projectOp: AbortController | undefined;
  const kb = () => getKeybindings();
  const redraw = () => { if (!closed) tui.requestRender(); };
  const top = (): Frame | undefined => stack[stack.length - 1];
  const refreshSnapshot = () => { try { snap = ops.snapshot(); } catch { /* keep the last good snapshot */ } };
  const innerBudget = () => Math.max(1, dialogHeightBudget(tui.terminal?.rows) - 2);
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
    (async () => ops.projectCount(signal))().then((result) => settle({ count: result.count, tools: result.tools, mcpServers: result.mcpServers, warning: result.warning, loading: false }),
      () => settle({ loading: false, warning: "Project list unavailable" }));
  };

  const enter = (frame: Frame) => {
    refreshSnapshot();
    const route = frame.route;
    if (route.kind === "main" || route.kind === "tools") loadProject();
    else if (route.kind === "provider") load(frame, (signal) => ops.listProviders(signal), (rows) => { frame.providers = rows; frame.selected = 0; });
    else if (route.kind === "model") load(frame, (signal) => ops.listModels(route.filter, signal), (rows) => { frame.models = rows; frame.selected = 0; });
    else if (route.kind === "status") load(frame, (signal) => ops.statusLines(signal), (lines) => { frame.lines = lines.map((line) => sanitizeTerminalText(line, 800)); frame.scroll = 0; });
    else if (route.kind === "edit") {
      const input = new Input({ prompt: "Value: " });
      input.setValue(String(fieldValue(snap.settings, route.group ?? "relevance", route.key)));
      input.handleInput("\x05"); // Ctrl+E: start editing at the end of the current value
      frame.input = input;
    } else if (route.kind === "allowlist") {
      const list = route.list ?? "skills";
      load(frame, (signal) => list === "skills" ? ops.allowlist(route.scope, signal)
        : ops.toolAllowlist ? ops.toolAllowlist(list, route.scope, signal) : Promise.reject(new Error("Tool filtering is unavailable in this host"))
      , (deps) => {
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
    : typeof route === "object" ? { kind: "allowlist", scope: route.allowlist, ...(route.list ? { list: route.list } : {}) } : { kind: route };
  /** The tab (root route) a destination belongs to: tool/MCP lists and the tool settings live under the Tool picker tab. */
  const rootFor = (route: InitialRoute): "main" | "tools" => route === "tools" || (typeof route === "object" && route.list !== undefined && route.list !== "skills") ? "tools" : "main";
  const navigate = (route: InitialRoute) => {
    if (closed) return;
    while (stack.length) leave(stack.pop()!);
    const root = newFrame({ kind: rootFor(route) });
    stack.push(root); enter(root);
    if (route !== "main" && route !== "tools") { const frame = newFrame(toRoute(route)); stack.push(frame); enter(frame); }
    applyFocus(); redraw();
  };
  /** Swap the root frame between the two peer tabs. Only possible on a tab root, so sub-routes, inputs and editors are never affected. */
  const selectTab = (kind: "main" | "tools" | "toggle") => {
    if (closed || stack.length !== 1) return;
    const current = stack[0];
    const next = kind === "toggle" ? (current.route.kind === "main" ? "tools" : "main") : kind;
    if (current.route.kind === next) return;
    leave(current);
    const root = newFrame({ kind: next });
    stack[0] = root; enter(root); applyFocus(); redraw();
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
      { label: "Advanced…", description: "Relevance threshold, shard size, max added per round, picker cadence and safety limits.", run: () => push({ kind: "advanced" }) },
      { label: "Status…", description: "Credentials, last decision and allowlist counts. Makes no inference calls.", run: () => push({ kind: "status" }) },
      { label: "Close", run: () => close("closed") },
    ];
    if (route.kind === "tools") {
      const projectValue = (n: number | undefined) => !snap.hasCwd ? "n/a" : project.loading ? "…" : `${n ?? "?"}${project.warning ? " ⚠" : ""}`;
      const noCwd = snap.hasCwd ? {} : { disabled: "No working directory is available for a project list." };
      const lists: { label: string; value: string; description: string; list: Exclude<AllowlistKind, "skills">; scope: AllowlistScope }[] = [
        { label: "Always allowed tools · Global", value: String(settings.tools.alwaysAllowedTools.length), description: "External tools always available in every project, never scored; tick a server or extension to allow all its tools. Applies in both modes.", list: "tools", scope: "global" },
        { label: "Always allowed tools · Project", value: projectValue(project.tools), description: project.warning ?? "External tools (or whole servers/extensions) always available for this working directory only.", list: "tools", scope: "project" },
        { label: "Always allowed MCP servers & extensions · Global", value: String(settings.tools.alwaysAllowedMcpServers.length), description: "MCP servers and extensions always available in every project (all their tools together), never scored. Applies in both modes.", list: "mcp", scope: "global" },
        { label: "Always allowed MCP servers & extensions · Project", value: projectValue(project.mcpServers), description: project.warning ?? "MCP servers and extensions always available for this working directory only.", list: "mcp", scope: "project" },
      ];
      return [
        ...TOOL_FIELDS.map((field): Item => ({
          label: field.label, value: advancedValueText(field, settings), description: field.hint, toggle: field.kind === "bool",
          ...(field.key === "failMode" && settings.tools.failMode === "open" ? { tone: "warn" as const } : {}),
          ...(field.key === "enabled" ? { tone: settings.tools.enabled ? "ok" as const : "muted" as const } : {}),
          run: () => {
            if (field.kind === "bool") mutate(frame, () => ops.updateSetting(`tools.${field.key}`, String(!settings.tools.enabled)), () => ok(frame, `Tool filtering ${snap.settings.tools.enabled ? "enabled" : "disabled"}`));
            else if (field.kind === "options") push({ kind: "options", group: "tools", key: field.key });
            else push({ kind: "edit", group: "tools", key: field.key });
          },
        })),
        ...lists.map((row): Item => ({ label: row.label, value: row.value, description: row.description, ...(row.scope === "project" ? noCwd : {}), ...(row.scope === "project" && project.warning ? { tone: "warn" as const } : {}),
          run: () => push({ kind: "allowlist", scope: row.scope, list: row.list }) })),
      ];
    }
    if (route.kind === "advanced") return ADVANCED_FIELDS.map((field) => ({
      label: field.label, value: advancedValueText(field, settings), description: field.hint, toggle: field.kind === "bool",
      ...(field.key === "failMode" && settings.relevance.failMode === "open" ? { tone: "warn" as const } : {}),
      run: () => {
        if (field.kind === "bool") mutate(frame, () => ops.updateSetting(`relevance.${field.key}`, String(!fieldValue(settings, "relevance", field.key))), () => ok(frame, "Saved"));
        else if (field.kind === "options") push({ kind: "options", group: "relevance", key: field.key });
        else push({ kind: "edit", group: "relevance", key: field.key });
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
    if (route.kind === "options") {
      const group = route.group ?? "relevance";
      const field = fieldFor(group, route.key);
      return (field?.options ?? []).map((option) => ({
        label: option.value, value: String(fieldValue(settings, group, route.key)) === option.value ? "current" : "",
        tone: route.key === "failMode" && option.value === "open" ? "warn" as const : undefined, description: option.description,
        run: () => mutate(frame, () => ops.updateSetting(`${group}.${route.key}`, option.value), (_value, current) => { if (!current) { ok(frame, "Saved"); return; } pop(); const parent = top(); if (parent) ok(parent, "Saved"); }),
      }));
    }
    return [];
  };

  const crumb = (frame: Frame): string => {
    const route = frame.route;
    switch (route.kind) {
      case "main": return "Decisions › Skill picker";
      case "advanced": return "Decisions › Advanced";
      case "tools": return "Decisions › Tool picker";
      case "provider": return "Decisions › Provider";
      case "model": return "Decisions › Model";
      case "edit": case "options": return `Decisions › ${route.group === "tools" ? "Tool picker" : "Advanced"} › ${sanitizeTerminalText(fieldFor(route.group ?? "relevance", route.key)?.label ?? route.key, 80)}`;
      case "status": return "Decisions › Status";
      case "allowlist": return `Decisions › Always allowed${route.list === "tools" ? " tools" : route.list === "mcp" ? " MCP servers & extensions" : ""} · ${route.scope === "global" ? "Global" : "Project"}`;
    }
  };
  const hint = (frame: Frame): string => {
    switch (frame.route.kind) {
      case "main": case "tools": return "Tab switch · ↑↓ move · Enter select · Space toggle · Esc close";
      case "edit": return "Enter save · Esc cancel";
      case "status": return "↑↓ scroll · Enter refresh · Esc back";
      case "allowlist": return "Esc back";
      default: return "↑↓ move · Enter select · Space toggle · Esc back";
    }
  };
  const wrap = (text: string, width: number, limit: number): string[] => wrapTextWithAnsi(sanitizeTerminalText(text, 1200), Math.max(1, width)).slice(0, Math.max(0, limit));
  const bannerLines = (frame: Frame, width: number): string[] => {
    const banner = frame.banner ?? ((frame.route.kind === "main" || frame.route.kind === "tools") && snap.settingsError ? { text: `Settings error: ${snap.settingsError}. Repair the settings file, or choose a model in /decisions.`, tone: "error" as const } : undefined);
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
  const bottomLine = (label: string, width: number): string => {
    const inner = width - 2;
    const text = truncateToWidth(` ${label} `, Math.max(0, inner - 1), "…");
    return theme.fg("border", "╰─") + theme.fg("dim", text) + theme.fg("border", "─".repeat(Math.max(0, inner - 1 - visibleWidth(text)) ) + "╯");
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

  const TABS = [{ kind: "main", label: "Skill picker" }, { kind: "tools", label: "Tool picker" }] as const;
  /** One line: the active tab is a `selectedBg` chip, the other is muted; both have the same padding so switching never shifts layout. */
  const tabStrip = (frame: Frame, inner: number): string => {
    const text = TABS.map((tab) => tab.kind === frame.route.kind ? theme.bg("selectedBg", theme.fg("text", `  ${tab.label}  `)) : theme.fg("muted", `  ${tab.label}  `)).join(" ");
    return truncateToWidth(text, inner, "…");
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
    // The description yields to the list: it only takes lines the full list does not need (one line minimum).
    const spare = bodyBudget - bannerCount - items.length;
    const wantDesc = bodyBudget >= 8 && descSource && spare >= 1 ? Math.min(2, spare) : 0;
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
      const tag = busy ? "saving…" : frame.loading ? "checking…" : "";
      if (w < 8 || budget < 3) {
        // Too small for a frame: keep the one thing that matters visible.
        const items = frame.child || frame.input ? [] : itemsFor(frame);
        const line = frame.child ? (frame.child.render(w)[0] ?? "") : frame.input ? (frame.input.render(w)[0] ?? "") : items[Math.min(frame.selected, items.length - 1)]?.label ?? crumb(frame);
        return [truncateToWidth(`${tag ? `${tag} ` : ""}${sanitizeTerminalText(line, 200)}`, w, "…", true)];
      }
      const inner = w - 4;
      const bodyBudget = budget - 2;
      let body: string[];
      const route = frame.route;
      if (route.kind === "allowlist" && frame.child) body = frame.child.render(inner).slice(0, bodyBudget);
      else if (route.kind === "allowlist") body = fit(bodyBudget, [{ lines: [theme.fg("muted", frame.loading ? "Loading skill inventory…" : "Nothing to show")], min: 1 }, { lines: bannerLines(frame, inner), min: 1 }]);
      else if (route.kind === "edit" && frame.input) {
        const field = fieldFor(route.group ?? "relevance", route.key);
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
        const lines = frame.lines ? frame.lines.flatMap((line) => wrapTextWithAnsi(line, inner)) : [theme.fg("muted", frame.loading ? "Collecting status without inference calls…" : "Nothing to show")];
        const room = Math.max(1, bodyBudget - Math.min(banner.length, Math.max(0, bodyBudget - 1)));
        frame.scroll = Math.min(Math.max(0, frame.scroll), Math.max(0, lines.length - room));
        body = fit(bodyBudget, [{ lines: lines.slice(frame.scroll, frame.scroll + room), min: 1 }, { lines: banner, min: 1 }]);
      } else if ((route.kind === "main" || route.kind === "tools") && bodyBudget >= 3) body = [tabStrip(frame, inner), ...listBody(frame, inner, bodyBudget - 1)];
      else body = listBody(frame, inner, bodyBudget);
      body = body.slice(0, bodyBudget);
      return [borderLine("╭", "╮", crumb(frame), tag, w), ...body.map((line) => bodyLine(line, inner)), bottomLine(hint(frame), w)];
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
            mutate(frame, () => ops.updateSetting(`${route.group ?? "relevance"}.${route.key}`, text), (_value, current) => { if (!current) { ok(frame, "Saved"); return; } pop(); const parent = top(); if (parent) ok(parent, "Saved"); });
          }
          return;
        }
        frame.input.handleInput(data);
        redraw();
        return;
      }
      if (keys.matches(data, "tui.select.cancel")) { if (stack.length > 1) pop(); else close("closed"); return; }
      if (stack.length === 1 && (frame.route.kind === "main" || frame.route.kind === "tools")) {
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { selectTab("toggle"); return; }
        if (matchesKey(data, "left")) { selectTab("main"); return; }
        if (matchesKey(data, "right")) { selectTab("tools"); return; }
      }
      if (frame.route.kind === "status") {
        if (keys.matches(data, "tui.select.up")) frame.scroll = Math.max(0, frame.scroll - 1);
        else if (keys.matches(data, "tui.select.down")) frame.scroll += 1;
        else if (keys.matches(data, "tui.select.pageUp")) frame.scroll = Math.max(0, frame.scroll - 5);
        else if (keys.matches(data, "tui.select.pageDown")) frame.scroll += 5;
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
