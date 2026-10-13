import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, fuzzyFilter, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { AllowlistScope, ScopedSkill } from "../apps/allowlist.ts";
import type { RelevanceItem } from "../apps/relevance.ts";

export interface AllowlistPickerDeps {
  scope: AllowlistScope;
  skills: ScopedSkill[];
  initial: readonly string[];
  locationLabel: string;
  save(names: string[]): Promise<void>;
  rank?: (query: string, skills: ScopedSkill[], signal: AbortSignal) => Promise<RelevanceItem[]>;
  unavailable?: string;
  rankLabel?: string;
  /** Embedding hosts (the settings dialog) cap the rendered height here instead of Pi's 80% default. */
  maxRows?: () => number;
  report(message: string, level?: "info" | "warning" | "error"): void;
}
export type AllowlistTheme = Pick<Theme, "fg" | "bg">;
interface Row { name: string; description: string; loaded: boolean }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const display = (value: string, limit = 1600) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, limit);
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && ["config", "auth", "invalid_request", "invalid_response", "refusal", "rate_limit", "http", "timeout", "aborted", "network"].includes(error.code)) return error.code;
  return "operation-failed";
}

/** One interaction's draft. Nothing is persisted or ranked merely by typing/toggling. */
export function createAllowlistComponent(tui: { requestRender(): void; terminal?: { readonly rows: number } }, theme: AllowlistTheme,
  done: (saved: boolean) => void, deps: AllowlistPickerDeps): Component & Focusable & { dispose(): void } {
  const names = new Set<string>();
  const skills = deps.skills.filter((skill) => {
    if (skill.scope !== deps.scope || skill.disableModelInvocation || names.has(skill.name)) return false;
    names.add(skill.name); return true;
  }).map((skill) => ({ ...skill }));
  const rows: Row[] = skills.map(({ name, description }) => ({ name, description, loaded: true }));
  for (const name of deps.initial) if (!names.has(name)) { names.add(name); rows.push({ name, description: "Not currently loaded; removing it does not affect other saved names.", loaded: false }); }
  rows.sort((a, b) => compare(a.name, b.name));
  const draft = new Set(deps.initial);
  let savedNames = new Set(draft);
  let savedEver = false;
  let mode: "az" | "relevance" = "az";
  let focused = false;
  let listFocused = false;
  let index = 0;
  let offset = 0;
  let expanded: string | undefined;
  let closed = false;
  let saving = false;
  let loading = false;
  let message: string | undefined;
  let generation = 0;
  let abort: AbortController | undefined;
  let scores = new Map<string, RelevanceItem>();
  let rankedQuery: string | undefined;
  const input = new Input({ prompt: "Search: ", placeholder: "skill name or description" });
  const redraw = () => { if (!closed) tui.requestRender(); };
  const dirty = () => draft.size !== savedNames.size || [...draft].some((name) => !savedNames.has(name));
  const searchFocus = () => { listFocused = false; input.focused = focused; };
  const cancelRank = () => { generation++; abort?.abort(); abort = undefined; loading = false; };
  const ordered = () => {
    if (mode === "relevance") return [...rows].sort((a, b) => (scores.get(b.name)?.score ?? -1) - (scores.get(a.name)?.score ?? -1) || compare(a.name, b.name));
    const matches = new Set(fuzzyFilter(rows, input.getValue(), (row) => `${display(row.name)} ${display(row.description)}`));
    return rows.filter((row) => matches.has(row));
  };
  const dispose = () => { if (!closed) { closed = true; cancelRank(); input.focused = false; } };
  const rank = async () => {
    cancelRank(); mode = "relevance"; message = undefined;
    const query = input.getValue().trim();
    if (!query) { message = "Type a search term to rank"; redraw(); return; }
    if (!deps.rank) { message = deps.unavailable ?? "Select a decision model in /decisions to enable ranking"; redraw(); return; }
    if (!skills.length) { message = "No loaded skills in this scope to rank"; redraw(); return; }
    abort = new AbortController();
    const signal = abort.signal;
    const current = generation;
    loading = true; redraw();
    try {
      // Drop even incidental extra fields before handing metadata to the ranking framework.
      const metadata = skills.map(({ name, description, scope, disableModelInvocation }) => ({ name, description, scope, disableModelInvocation }));
      const items = await deps.rank(query, metadata, signal);
      if (closed || current !== generation || signal.aborted) return;
      const expected = new Set(skills.map((skill) => skill.name));
      const received = new Set<string>();
      for (const item of items) {
        if (!expected.has(item.name) || received.has(item.name) || !Number.isFinite(item.score) || item.score < 0 || item.score > 2) throw { code: "invalid_response" };
        received.add(item.name);
      }
      if (received.size !== expected.size) throw { code: "invalid_response" };
      scores = new Map(items.map((item) => [item.name, item])); rankedQuery = query; index = 0; offset = 0;
    } catch (error) {
      if (!closed && current === generation && !signal.aborted) message = `Relevance sort unavailable (${errorCode(error)})`;
    } finally {
      if (!closed && current === generation) { loading = false; abort = undefined; redraw(); }
    }
  };
  const save = async () => {
    if (saving || closed) return;
    saving = true; message = undefined; const snapshot = [...draft].sort(compare); redraw();
    try {
      await deps.save(snapshot);
      if (closed) return;
      savedNames = new Set(snapshot); savedEver = true; message = "Always-allowed skills saved";
      deps.report(`Always-allowed ${deps.scope} list saved (${snapshot.length})`);
    } catch (error) { if (!closed) message = `Could not save allowlist (${errorCode(error)})`; }
    finally { saving = false; redraw(); }
  };
  return {
    dispose,
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; input.focused = value && !listFocused && !closed; },
    invalidate() { input.invalidate(); },
    render(width: number): string[] {
      const w = Math.max(1, Math.floor(width));
      const items = ordered(); index = Math.min(index, Math.max(0, items.length - 1));
      const tab = (text: string, active: boolean) => active ? theme.bg("selectedBg", theme.fg("text", ` ${text} `)) : ` ${text} `;
      const title = theme.fg("accent", `Always allowed · ${deps.scope === "global" ? "Global" : "Project"}${dirty() ? " ●" : ""}`);
      const tabs = `${tab("A-Z", mode === "az")} ${tab("Relevance", mode === "relevance")}${loading ? " ranking…" : ""}${saving ? " saving…" : ""}`;
      const state = message ?? (mode === "relevance" && rankedQuery !== undefined && rankedQuery !== input.getValue().trim()
        ? "stale — Ctrl+R to re-rank" : deps.unavailable ?? deps.rankLabel ?? "Ranking unavailable");
      let headers = [title,
        deps.scope === "global" ? "Global: applies to all projects" : "Project: applies to this working directory only",
        `Saved in ${display(deps.locationLabel, 1000)}`,
        tabs,
        `${draft.size} selected · ${items.length} results · always included, not a restriction list`,
        ...wrapTextWithAnsi(display(deps.rankLabel ?? deps.unavailable ?? "Ranking unavailable"), w).slice(0, 6),
        mode === "az" ? "A-Z: local fuzzy name/description search (no calls)" : rankedQuery !== undefined && rankedQuery !== input.getValue().trim()
          ? "stale — Ctrl+R to re-rank" : "Relevance: Ctrl+R explicitly ranks all scoped skills (paid call)",
        ...input.render(w), ...(message ? wrapTextWithAnsi(display(message), w).slice(0, 6).map((line) => theme.fg("warning", line)) : [])];
      let footer = [`${Math.min(index + 1, items.length)}/${items.length}`, "Type search · ↓ list · ↑↓ move · Space toggle · Enter description",
        "Ctrl+S save · Ctrl+R rank · Tab tabs · Ctrl+K clear",
        "Esc search / Esc close (discard unsaved changes)"];
      // An embedding host supplies its own budget. Otherwise Pi clips custom overlays to
      // floor(80% of terminal rows); read the public terminal size on each render so
      // resizing cannot hide focus or save help.
      const terminalRows = tui.terminal?.rows;
      const hostRows = deps.maxRows?.();
      const height = hostRows !== undefined && Number.isFinite(hostRows) ? Math.max(1, Math.floor(hostRows))
        : terminalRows === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(terminalRows * 0.8));
      if (headers.length + footer.length + 1 > height) {
        footer = height >= 8 ? ["Ctrl+S save · Space toggle · Enter info", "Tab tabs · Ctrl+R rank · Esc close"] : ["Ctrl+S save · Esc close"];
        headers = [title, `${tabs} · ${draft.size} selected · ${Math.min(index + 1, items.length)}/${items.length}`, ...input.render(w), theme.fg("warning", display(state))];
        // Compact low-priority details before sacrificing search, focus or save.
        while (headers.length + footer.length + 1 > height && headers.length > 1) {
          if (headers.length > 3) headers.pop();
          else headers.shift();
        }
        if (headers.length + footer.length + 1 > height) headers = [];
        if (footer.length + 1 > height) footer = [];
      }
      const bodyBudget = Math.max(1, height - headers.length - footer.length);
      const block = (i: number): string[] => {
        const row = items[i]; const item = scores.get(row.name);
        const prefix = `${listFocused && i === index ? "❯" : " "} ${draft.has(row.name) ? "[x]" : "[ ]"}`;
        const line = `${prefix} ${display(row.name, 128)}${row.loaded ? "" : " (not loaded)"}${mode === "relevance" && item ? ` · ${item.normalized.toFixed(2)} relevance` : ""}`;
        return [listFocused && i === index ? theme.fg("accent", line) : line,
          ...(expanded === row.name ? wrapTextWithAnsi(display(row.description), Math.max(1, w - 4)).slice(0, Math.min(3, bodyBudget - 1)).map((line) => `  • ${line}`) : [])];
      };
      if (index < offset) offset = index;
      // Scroll by rendered line cost (expanded descriptions count), not by a
      // fixed number of skill rows. The selected block always fits the budget.
      while (offset < index) {
        let cost = 0;
        for (let i = offset; i <= index; i++) cost += block(i).length;
        if (index - offset < 10 && cost <= bodyBudget) break;
        offset++;
      }
      const body: string[] = [];
      for (let i = offset; i < Math.min(items.length, offset + 10); i++) {
        const lines = block(i);
        if (body.length + lines.length > bodyBudget) break;
        body.push(...lines);
      }
      if (!items.length) body.push("No matching skills");
      return [...headers, ...body, ...footer].map((line) => truncateToWidth(line, w));
    },
    handleInput(data: string) {
      if (closed) return;
      if (matchesKey(data, "ctrl+s")) { void save(); return; }
      if (matchesKey(data, "ctrl+r")) { void rank(); return; }
      if (matchesKey(data, "escape")) {
        if (listFocused) { searchFocus(); redraw(); }
        else { dispose(); done(savedEver); }
        return;
      }
      if (matchesKey(data, "tab") || (listFocused && (matchesKey(data, "left") || matchesKey(data, "right")))) {
        mode = mode === "az" ? "relevance" : "az"; index = 0; offset = 0; searchFocus(); redraw(); return;
      }
      const items = ordered();
      if (matchesKey(data, "down")) {
        if (!listFocused && items.length) { listFocused = true; input.focused = false; index = 0; }
        else if (listFocused) index = Math.min(Math.max(0, items.length - 1), index + 1);
      } else if (listFocused && matchesKey(data, "up")) index = Math.max(0, index - 1);
      else if (listFocused && matchesKey(data, "space") && items[index]) {
        const name = items[index].name; if (draft.has(name)) draft.delete(name); else draft.add(name);
      } else if (listFocused && matchesKey(data, "return") && items[index]) expanded = expanded === items[index].name ? undefined : items[index].name;
      else if (!listFocused && matchesKey(data, "return")) { void rank(); return; }
      else if (!listFocused) {
        const before = input.getValue();
        if (matchesKey(data, "ctrl+k")) input.setValue(""); else input.handleInput(data);
        const value = input.getValue().replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 4000);
        if (value !== input.getValue()) input.setValue(value);
        if (input.getValue() !== before) { if (loading) cancelRank(); index = 0; offset = 0; message = undefined; }
      }
      redraw();
    },
  };
}
