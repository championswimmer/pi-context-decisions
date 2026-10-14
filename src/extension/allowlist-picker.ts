import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, fuzzyFilter, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { AllowlistScope, ScopedSkill } from "../apps/allowlist.ts";
import type { RelevanceItem } from "../apps/relevance.ts";

export interface AllowlistPickerDeps {
  scope: AllowlistScope;
  skills: ScopedSkill[];
  initial: readonly string[];
  locationLabel: string;
  /** `groups` is passed only by the nested tool editor (`tree`): the canonical group keys (MCP servers and extensions) edited together with `names`. */
  save(names: string[], groups?: string[]): Promise<void>;
  /** What the list holds; drives labels and messages. Defaults to `skill`. Tool and group items are passed with `scope` set to this list's scope. */
  noun?: "skill" | "tool" | "MCP server" | "MCP server or extension";
  /** Title override (for example "Always allowed MCP servers & extensions"). */
  heading?: string;
  /** Folds raw group entries (`dev-radius`) to canonical keys so saved entries match their rows: applied to `initial`, or to `tree.initialGroups` in the nested editor. */
  normalize?: (name: string) => string;
  /** Nested tool editor: built-in tools first (locked), then collapsible MCP-server and extension groups, then ungrouped tools. */
  tree?: AllowlistTree;
  rank?: (query: string, skills: ScopedSkill[], signal: AbortSignal) => Promise<RelevanceItem[]>;
  unavailable?: string;
  rankLabel?: string;
  /** Embedding hosts (the settings dialog) cap the rendered height here instead of Pi's 80% default. */
  maxRows?: () => number;
  report(message: string, level?: "info" | "warning" | "error"): void;
}
export interface AllowlistTreeGroup { key: string; label: string; type: "mcp" | "extension"; description: string; tools: readonly string[] }
export interface AllowlistTree {
  /** Pi's built-in tools: always available, shown locked so the list is complete. */
  internal: readonly { name: string; description: string }[];
  groups: readonly AllowlistTreeGroup[];
  /** The saved group list (raw entries are folded with `normalize`); entries without a loaded group are kept untouched. */
  initialGroups: readonly string[];
}
export type AllowlistTheme = Pick<Theme, "fg" | "bg">;
interface Row { name: string; label: string; description: string; loaded: boolean }
/** One visible line. `key` is the tool name or group key (`internal` for the built-in section header). */
interface Entry { kind: "tool" | "group" | "internal-head" | "internal"; key: string; label: string; description: string; loaded: boolean; depth: 0 | 1; group?: string }
type Check = "all" | "some" | "none";
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
  const fold = deps.normalize ?? ((name: string) => name);
  const tree = deps.tree;
  const rows: Row[] = skills.map(({ name, description, label }) => ({ name, label: label ?? name, description, loaded: true }));
  // In the nested editor `initial` is the TOOL list (names kept as saved); `normalize` folds only the group entries.
  const initial = [...new Set(deps.initial.map((name) => tree ? name : fold(name)))];
  for (const name of initial) if (!names.has(name)) { names.add(name); rows.push({ name, label: name, description: "Not currently loaded; removing it does not affect other saved names.", loaded: false }); }
  rows.sort((a, b) => compare(a.label, b.label) || compare(a.name, b.name));
  const draft = new Set(initial);
  let savedNames = new Set(draft);
  // Nested editor: group membership comes from Pi's public provenance (tool -> its MCP server or extension), never from tool names.
  const groupInfo = new Map<string, AllowlistTreeGroup>((tree?.groups ?? []).map((group) => [group.key, { ...group, tools: [...group.tools] }]));
  const groupOf = new Map<string, string>();
  for (const group of groupInfo.values()) for (const tool of group.tools) groupOf.set(tool, group.key);
  const draftGroups = new Set<string>((tree?.initialGroups ?? []).map((entry) => { const key = fold(entry); return groupInfo.has(key) ? key : entry; }));
  let savedGroups = new Set(draftGroups);
  // Saved group entries with no loaded group are a STABLE inventory of rows: a row never disappears when it is deselected (it could not be reselected
  // in this draft). The checkbox is `draftGroups` alone.
  const unloadedGroups = [...draftGroups].filter((key) => !groupInfo.has(key)).sort(compare);
  const open = new Set<string>();
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
  const noun = deps.noun ?? "skill";
  const nouns = noun === "MCP server or extension" ? "MCP servers or extensions" : `${noun}s`;
  const input = new Input({ prompt: "Search: ", placeholder: `${tree ? "tool, server or extension" : noun} name or description` });
  const redraw = () => { if (!closed) tui.requestRender(); };
  const differs = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size !== b.size || [...a].some((name) => !b.has(name));
  const dirty = () => differs(draft, savedNames) || differs(draftGroups, savedGroups);
  const groupCheck = (key: string): Check => {
    const group = groupInfo.get(key);
    if (draftGroups.has(key)) return "all";
    const count = group ? group.tools.filter((tool) => draft.has(tool)).length : 0;
    return !group || count === 0 ? "none" : count === group.tools.length ? "all" : "some";
  };
  const toolChecked = (name: string) => draft.has(name) || (groupOf.has(name) && draftGroups.has(groupOf.get(name)!));
  /** A group header selects or clears the whole group: a pin on the group key (late-registered tools included), replacing individual picks. */
  const toggleGroup = (key: string) => {
    const group = groupInfo.get(key);
    const clear = groupCheck(key) === "all";
    for (const tool of group?.tools ?? []) draft.delete(tool);
    if (clear) draftGroups.delete(key); else draftGroups.add(key);
  };
  const toggleTool = (name: string) => {
    const key = groupOf.get(name);
    if (!toolChecked(name)) { draft.add(name); return; }
    if (key && draftGroups.has(key)) {
      // Unchecking one member of a pinned group: the pin is replaced by its other members, so nothing else changes.
      draftGroups.delete(key);
      for (const tool of groupInfo.get(key)!.tools) if (tool !== name) draft.add(tool);
    }
    draft.delete(name);
  };
  const searchFocus = () => { listFocused = false; input.focused = focused; };
  const cancelRank = () => { generation++; abort?.abort(); abort = undefined; loading = false; };
  const matcher = (query: string) => {
    const hits = new Set(fuzzyFilter(rows, query, (row) => `${display(row.label)} ${display(row.name)} ${display(row.description)}`));
    return (row: Row) => hits.has(row);
  };
  const entries = (): Entry[] => {
    const query = mode === "az" ? input.getValue().trim() : "";
    const matches = query ? matcher(query) : () => true;
    const bySearch = (list: Row[]) => mode === "relevance" ? [...list].sort((a, b) => (scores.get(b.name)?.score ?? -1) - (scores.get(a.name)?.score ?? -1) || compare(a.label, b.label)) : list.filter(matches);
    const toEntry = (row: Row, depth: 0 | 1, group?: string): Entry => ({ kind: "tool", key: row.name, label: row.label, description: row.description, loaded: row.loaded, depth, ...(group ? { group } : {}) });
    if (!tree) return bySearch(rows).map((row) => toEntry(row, 0));
    const out: Entry[] = [];
    const byName = new Map(rows.map((row) => [row.name, row]));
    const search = (text: string) => !query || fuzzyFilter([text], query, (value) => value).length > 0;
    // Built-in tools first: always available, so locked (never selectable).
    const internal = tree.internal.filter((tool) => search(`${display(tool.name)} ${display(tool.description)}`));
    if (internal.length) {
      out.push({ kind: "internal-head", key: "internal", label: `Built-in tools (${tree.internal.length})`, description: "Pi's own tools are always available and never filtered.", loaded: true, depth: 0 });
      if (query || open.has("internal")) for (const tool of internal) out.push({ kind: "internal", key: tool.name, label: tool.name, description: tool.description, loaded: true, depth: 1 });
    }
    const best = (group: AllowlistTreeGroup) => Math.max(-1, ...group.tools.map((tool) => scores.get(tool)?.score ?? -1));
    const listed = [...groupInfo.values()].sort((a, b) => a.type === b.type ? compare(a.label, b.label) || compare(a.key, b.key) : a.type === "mcp" ? -1 : 1);
    if (mode === "relevance") listed.sort((a, b) => best(b) - best(a) || compare(a.label, b.label));
    for (const group of listed) {
      const children = group.tools.map((tool) => byName.get(tool)).filter((row): row is Row => !!row);
      const header = search(`${display(group.label)} ${display(group.key)} ${display(group.description)}`);
      const visible = header ? children : bySearch(children);
      if (!header && !visible.length) continue;
      out.push({ kind: "group", key: group.key, label: group.label, description: `${group.type === "mcp" ? "MCP server" : "Extension"} · ${group.tools.length} tools${group.description ? ` · ${group.description}` : ""}`, loaded: true, depth: 0 });
      if (query || open.has(group.key)) for (const row of mode === "relevance" ? bySearch(children) : visible) out.push(toEntry(row, 1, group.key));
    }
    for (const key of unloadedGroups) if (search(display(key))) out.push({ kind: "group", key, label: key, description: "Not currently loaded; removing it does not affect other saved names.", loaded: false, depth: 0 });
    for (const row of bySearch(rows.filter((candidate) => !groupOf.has(candidate.name)))) out.push(toEntry(row, 0));
    return out;
  };
  const dispose = () => { if (!closed) { closed = true; cancelRank(); input.focused = false; } };
  const rank = async () => {
    cancelRank(); mode = "relevance"; message = undefined;
    const query = input.getValue().trim();
    if (!query) { message = "Type a search term to rank"; redraw(); return; }
    if (!deps.rank) { message = deps.unavailable ?? "Select a decision model in /decisions to enable ranking"; redraw(); return; }
    if (!skills.length) { message = `No loaded ${nouns} in this scope to rank`; redraw(); return; }
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
    saving = true; message = undefined; const snapshot = [...draft].sort(compare); const groupSnapshot = [...draftGroups].sort(compare); redraw();
    try {
      await (tree ? deps.save(snapshot, groupSnapshot) : deps.save(snapshot));
      if (closed) return;
      savedNames = new Set(snapshot); savedGroups = new Set(groupSnapshot); savedEver = true; message = `Always-allowed ${tree ? "tools" : nouns} saved`;
      deps.report(`Always-allowed ${deps.scope} list saved (${snapshot.length + groupSnapshot.length})`);
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
      const items = entries(); index = Math.min(index, Math.max(0, items.length - 1));
      const tab = (text: string, active: boolean) => active ? theme.bg("selectedBg", theme.fg("text", ` ${text} `)) : ` ${text} `;
      const title = theme.fg("accent", `${deps.heading ?? `Always allowed${noun === "skill" ? "" : ` ${nouns}`}`} · ${deps.scope === "global" ? "Global" : "Project"}${dirty() ? " ●" : ""}`);
      const selected = tree ? `${draft.size} tools · ${draftGroups.size} groups selected` : `${draft.size} selected`;
      const tabs = `${tab("A-Z", mode === "az")} ${tab("Relevance", mode === "relevance")}${loading ? " ranking…" : ""}${saving ? " saving…" : ""}`;
      const state = message ?? (mode === "relevance" && rankedQuery !== undefined && rankedQuery !== input.getValue().trim()
        ? "stale — Ctrl+R to re-rank" : deps.unavailable ?? deps.rankLabel ?? "Ranking unavailable");
      let headers = [title,
        deps.scope === "global" ? "Global: applies to all projects" : "Project: applies to this working directory only",
        `Saved in ${display(deps.locationLabel, 1000)}`,
        tabs,
        `${selected} · ${items.length} results · always included, not a restriction list`,
        ...wrapTextWithAnsi(display(deps.rankLabel ?? deps.unavailable ?? "Ranking unavailable"), w).slice(0, 6),
        mode === "az" ? "A-Z: local fuzzy name/description search (no calls)" : rankedQuery !== undefined && rankedQuery !== input.getValue().trim()
          ? "stale — Ctrl+R to re-rank" : `Relevance: Ctrl+R explicitly ranks all scoped ${tree ? "tools" : nouns} (paid call)`,
        ...input.render(w), ...(message ? wrapTextWithAnsi(display(message), w).slice(0, 6).map((line) => theme.fg("warning", line)) : [])];
      let footer = [`${Math.min(index + 1, items.length)}/${items.length}`, `Type search · ↓ list · ↑↓ move · Space toggle · Enter ${tree ? "expand/description" : "description"}`,
        "Ctrl+S save · Ctrl+R rank · Tab tabs · Ctrl+K clear",
        "Esc search / Esc close (discard unsaved changes)"];
      // An embedding host supplies its own budget. Otherwise Pi clips custom overlays to
      // floor(80% of terminal rows); read the public terminal size on each render so
      // resizing cannot hide focus or save help.
      const terminalRows = tui.terminal?.rows;
      const hostRows = deps.maxRows?.();
      const height = hostRows !== undefined && Number.isFinite(hostRows) ? Math.max(1, Math.floor(hostRows))
        : terminalRows === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(terminalRows * 0.8));
      // Compact too when the full layout would leave a nested list fewer than four rows to show (groups need room to be usable).
      if (headers.length + footer.length + 1 > height || (tree && height - headers.length - footer.length < 5)) {
        footer = height >= 8 ? ["Ctrl+S save · Space toggle · Enter info", "Tab tabs · Ctrl+R rank · Esc close"] : ["Ctrl+S save · Esc close"];
        headers = [title, `${tabs} · ${selected} · ${Math.min(index + 1, items.length)}/${items.length}`, ...input.render(w), theme.fg("warning", display(state))];
        // Compact low-priority details before sacrificing search, focus or save.
        while (headers.length + footer.length + 1 > height && headers.length > 1) {
          if (headers.length > 3) headers.pop();
          else headers.shift();
        }
        if (headers.length + footer.length + 1 > height) headers = [];
        if (footer.length + 1 > height) footer = [];
      }
      const bodyBudget = Math.max(1, height - headers.length - footer.length);
      const box = (check: Check | "locked") => check === "all" || check === "locked" ? "[x]" : check === "some" ? "[-]" : "[ ]";
      const block = (i: number): string[] => {
        const row = items[i]; const item = row.kind === "tool" ? scores.get(row.key) : undefined;
        const at = listFocused && i === index;
        const check: Check | "locked" = row.kind === "tool" ? (toolChecked(row.key) ? "all" : "none") : row.kind === "group" ? groupCheck(row.key) : "locked";
        const fold = row.kind === "group" || row.kind === "internal-head" ? `${(row.kind === "group" ? open.has(row.key) : open.has("internal")) || input.getValue().trim() && mode === "az" ? "▾" : "▸"} ` : "";
        const score = mode === "relevance" ? (item?.normalized ?? (row.kind === "group" ? Math.max(0, ...(groupInfo.get(row.key)?.tools ?? []).map((tool) => scores.get(tool)?.normalized ?? 0)) || undefined : undefined)) : undefined;
        const line = `${at ? "❯" : " "} ${row.depth ? "  " : ""}${box(check)} ${fold}${display(row.label, 128)}${row.loaded ? "" : " (not loaded)"}${row.kind === "group" && row.loaded ? ` · ${display(row.description, 200).split(" · ").slice(0, 2).join(" · ")}` : ""}${row.kind === "internal-head" ? " · always available" : ""}${score !== undefined ? ` · ${score.toFixed(2)} relevance` : ""}`;
        const dim = row.kind === "internal" || row.kind === "internal-head";
        return [at ? theme.fg("accent", line) : dim ? theme.fg("muted", line) : line,
          ...(expanded === row.key && row.kind !== "group" && row.kind !== "internal-head" ? wrapTextWithAnsi(display(row.description), Math.max(1, w - 4)).slice(0, Math.min(3, bodyBudget - 1)).map((line) => `  • ${line}`) : [])];
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
      if (!items.length) body.push(`No matching ${tree ? "tools" : nouns}`);
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
      const items = entries();
      if (matchesKey(data, "down")) {
        if (!listFocused && items.length) { listFocused = true; input.focused = false; index = 0; }
        else if (listFocused) index = Math.min(Math.max(0, items.length - 1), index + 1);
      } else if (listFocused && matchesKey(data, "up")) index = Math.max(0, index - 1);
      else if (listFocused && matchesKey(data, "space") && items[index]) {
        const row = items[index];
        if (row.kind === "tool") toggleTool(row.key);
        else if (row.kind === "group") toggleGroup(row.key);
        else message = "Built-in tools are always available";
      } else if (listFocused && matchesKey(data, "return") && items[index]) {
        const row = items[index];
        const section = row.kind === "group" ? row.key : row.kind === "internal-head" ? "internal" : undefined;
        if (section !== undefined) { if (open.has(section)) open.delete(section); else open.add(section); }
        else expanded = expanded === row.key ? undefined : row.key;
      }
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
