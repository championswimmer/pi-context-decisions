// The nested tool allowlist editor: built-in tools first (locked), then collapsible MCP-server and extension groups with tri-state headers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAllowlistComponent, type AllowlistPickerDeps, type AllowlistTheme } from "../src/extension/allowlist-picker.ts";
import { canonicalServerKey } from "../src/apps/tool-inventory.ts";
import type { RelevanceItem } from "../src/apps/relevance.ts";
import type { ScopedSkill } from "../src/apps/allowlist.ts";

const theme: AllowlistTheme = { fg: (_token, value) => value, bg: (_token, value) => value };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = { down: "\x1b[B", up: "\x1b[A", esc: "\x1b", tab: "\t", rank: "\x12", save: "\x13", enter: "\r", space: " " };
const tool = (name: string, description = ""): ScopedSkill => ({ name, description, scope: "global", disableModelInvocation: false });
const item = (name: string, score: number): RelevanceItem => ({ name, score, normalized: score / 2 });

const TOOLS = ["alpha", "beta", "gamma", "docs_search", "docs_read", "radar_q", "loose_tool"];
const tree = (initialGroups: string[] = []): NonNullable<AllowlistPickerDeps["tree"]> => ({
  internal: [{ name: "read", description: "Read files" }, { name: "bash", description: "Run shell" }],
  groups: [
    { key: "ext__notes", label: "notes", type: "extension", description: "", tools: ["alpha", "beta", "gamma"] },
    { key: "mcp__docs", label: "docs", type: "mcp", description: "", tools: ["docs_search", "docs_read"] },
    { key: "mcp__dev_radius", label: "dev-radius", type: "mcp", description: "", tools: ["radar_q"] },
  ],
  initialGroups,
});
function harness(overrides: Partial<AllowlistPickerDeps> & { groups?: string[] } = {}) {
  const saved: { names: string[]; groups?: string[] }[] = [], closed: boolean[] = [];
  const { groups, ...rest } = overrides;
  const component = createAllowlistComponent({ requestRender() {} }, theme, (value) => closed.push(value), {
    scope: "global", skills: TOOLS.map((name) => tool(name)), initial: [], locationLabel: "fixture/settings.json",
    async save(names, groupNames) { saved.push({ names, ...(groupNames ? { groups: groupNames } : {}) }); },
    noun: "tool", tree: tree(groups), normalize: canonicalServerKey, report() {}, ...rest,
  });
  component.focused = true;
  const press = (...data: string[]) => { for (const key of data) component.handleInput!(key); };
  const type = (value: string) => { for (const char of value) component.handleInput!(char); };
  const lines = (width = 120) => component.render(width);
  const text = (width = 120) => lines(width).join("\n");
  /** Move the list cursor to the row whose text matches. */
  const cursorTo = (pattern: RegExp) => {
    press(keys.down); for (let n = 0; n < 80; n++) press(keys.up);
    for (let guard = 0; guard < 60; guard++) {
      if (lines().some((line) => /❯/.test(line) && pattern.test(line))) return;
      press(keys.down);
    }
    assert.fail(`cursor never reached ${pattern}\n${text()}`);
  };
  return { component, saved, closed, press, type, lines, text, cursorTo };
}
const row = (h: ReturnType<typeof harness>, pattern: RegExp) => h.lines().find((line) => pattern.test(line)) ?? assert.fail(`no row ${pattern}\n${h.text()}`);

test("built-in tools come first (collapsed, locked), then MCP servers, then extensions, then ungrouped tools; groups start collapsed", () => {
  const h = harness();
  const text = h.text();
  const at = (needle: RegExp) => text.search(needle);
  assert.ok(at(/\[x\] ▸ Built-in tools \(2\)/) >= 0, text);
  assert.ok(at(/Built-in tools/) < at(/\[ \] ▸ dev-radius/) && at(/\[ \] ▸ dev-radius/) < at(/\[ \] ▸ docs/) && at(/\[ \] ▸ docs/) < at(/\[ \] ▸ notes/) && at(/\[ \] ▸ notes/) < at(/loose_tool/), "section order");
  assert.match(text, /MCP server · 2 tools/); assert.match(text, /Extension · 3 tools/);
  assert.doesNotMatch(text, /docs_search|alpha|\bread\b.*Read files/, "children and built-ins are hidden until expanded");
  h.component.dispose();
});
test("Enter expands and collapses a group or the built-in section; children are indented and individually selectable", () => {
  const h = harness();
  h.cursorTo(/Built-in tools/); h.press(keys.enter);
  assert.match(h.text(), /▾ Built-in tools/); assert.match(h.text(), /\[x\] read/); assert.match(h.text(), /\[x\] bash/);
  h.press(keys.enter); assert.doesNotMatch(h.text(), /\[x\] read/);
  h.cursorTo(/▸ notes/); h.press(keys.enter);
  assert.match(row(h, /▾ notes/), /\[ \]/); assert.match(h.text(), /^.{0,4}\s{2}\[ \] alpha/m);
  h.press(keys.enter); assert.doesNotMatch(h.text(), /\balpha\b/);
  h.component.dispose();
});
test("built-in tools are locked: Space explains and changes nothing, and they are never saved", async () => {
  const h = harness();
  h.cursorTo(/Built-in tools/); h.press(keys.space);
  assert.match(h.text(), /always available/); assert.doesNotMatch(h.text(), /●/);
  h.press(keys.enter, keys.down, keys.space); assert.match(h.text(), /\[x\] read/);
  h.press(keys.save); await tick(); assert.deepEqual(h.saved, [{ names: [], groups: [] }], "saving writes exactly what was saved before: no built-in name appears");
  h.component.dispose();
});
test("a group header selects and clears the whole group by pinning its key; the three states are [ ] [-] [x]", async () => {
  const h = harness();
  h.cursorTo(/▸ notes/); h.press(keys.space);
  assert.match(row(h, /notes/), /\[x\]/); assert.match(h.text(), /Global ●/);
  h.press(keys.enter); for (const name of ["alpha", "beta", "gamma"]) assert.match(row(h, new RegExp(`\\b${name}\\b`)), /\[x\]/, "every member shows selected");
  h.cursorTo(/notes/); h.press(keys.space);
  assert.match(row(h, /notes/), /\[ \]/); for (const name of ["alpha", "beta", "gamma"]) assert.match(row(h, new RegExp(`\\b${name}\\b`)), /\[ \]/);
  // Partial: one child -> [-]; header toggle from [-] selects ALL; again clears all.
  h.cursorTo(/\balpha\b/); h.press(keys.space);
  assert.match(row(h, /notes/), /\[-\]/); assert.match(row(h, /\balpha\b/), /\[x\]/); assert.match(row(h, /\bbeta\b/), /\[ \]/);
  h.cursorTo(/notes/); h.press(keys.space); assert.match(row(h, /notes/), /\[x\]/);
  h.press(keys.save); await tick();
  assert.deepEqual(h.saved, [{ names: [], groups: ["ext__notes"] }], "a header pin is the group key alone; the child picks it replaced are dropped");
  h.cursorTo(/notes/); h.press(keys.space); h.press(keys.save); await tick();
  assert.deepEqual(h.saved.at(-1), { names: [], groups: [] });
  h.component.dispose();
});
test("individually selecting every child shows [x] but stays a list of tool names (no silent promotion to a group pin)", async () => {
  const h = harness();
  h.cursorTo(/▸ docs/); h.press(keys.enter);
  h.cursorTo(/docs_read/); h.press(keys.space);
  assert.match(row(h, /▾ docs/), /\[-\]/);
  h.cursorTo(/docs_search/); h.press(keys.space);
  assert.match(row(h, /▾ docs/), /\[x\]/);
  h.press(keys.save); await tick();
  assert.deepEqual(h.saved, [{ names: ["docs_read", "docs_search"], groups: [] }]);
  h.component.dispose();
});
test("unchecking one child of a pinned group replaces the pin by its other members; checking it again restores the child only", async () => {
  const h = harness({ groups: ["mcp__docs"] });
  assert.match(row(h, /docs/), /\[x\]/);
  h.cursorTo(/▸ docs/); h.press(keys.enter); h.cursorTo(/docs_read/); h.press(keys.space);
  assert.match(row(h, /▾ docs/), /\[-\]/); assert.match(row(h, /docs_read/), /\[ \]/); assert.match(row(h, /docs_search/), /\[x\]/);
  h.press(keys.save); await tick();
  assert.deepEqual(h.saved, [{ names: ["docs_search"], groups: [] }], "late tools of the server are no longer covered once the pin is gone");
  h.press(keys.space); assert.match(row(h, /▾ docs/), /\[x\]/);
  h.press(keys.save); await tick();
  assert.deepEqual(h.saved.at(-1), { names: ["docs_read", "docs_search"], groups: [] });
  h.component.dispose();
});
test("saved lists seed the tri-state: tool names show [-], raw server names fold to canonical keys and are saved canonical", async () => {
  const h = harness({ initial: ["alpha", "ghost_tool"], groups: ["dev-radius", "ext__gone", "mcp__never_loaded"] });
  assert.match(row(h, /notes/), /\[-\]/); assert.match(row(h, /dev-radius/), /\[x\]/, "`dev-radius` is the loaded server mcp__dev_radius");
  assert.match(row(h, /ext__gone \(not loaded\)/), /\[x\]/); assert.match(row(h, /ghost_tool \(not loaded\)/), /\[x\]/);
  assert.doesNotMatch(h.text(), /Global ●/, "folding raw entries is not a change");
  h.press(keys.save); await tick();
  assert.deepEqual(h.saved, [{ names: ["alpha", "ghost_tool"], groups: ["ext__gone", "mcp__dev_radius", "mcp__never_loaded"] }], "unloaded tool names and group keys are preserved");
  h.component.dispose();
});
test("unloaded group keys stay removable and removing one never affects the others", async () => {
  const h = harness({ groups: ["ext__gone", "mcp__docs"] });
  h.cursorTo(/ext__gone/); h.press(keys.space); h.press(keys.save); await tick();
  assert.deepEqual(h.saved, [{ names: [], groups: ["mcp__docs"] }]);
  h.component.dispose();
});
test("group-only changes are unsaved changes: Esc discards them, and the dirty marker clears after a save", async () => {
  const h = harness();
  h.cursorTo(/notes/); h.press(keys.space); assert.match(h.text(), /Global ●/);
  h.press(keys.esc, keys.esc); assert.deepEqual(h.closed, [false]); assert.deepEqual(h.saved, []);
  const k = harness(); k.cursorTo(/notes/); k.press(keys.space, keys.save); await tick(); assert.doesNotMatch(k.text(), /Global ●/);
  k.press(keys.esc, keys.esc); assert.deepEqual(k.closed, [true]);
});
test("search auto-expands matching groups: a child match shows its header and only matching children, a header match shows all children", () => {
  const h = harness();
  h.type("docs_read");
  assert.match(h.text(), /▾ docs/); assert.match(h.text(), /docs_read/); assert.doesNotMatch(h.text(), /docs_search|notes|dev-radius|loose_tool/);
  h.press("\x0b"); h.type("notes");
  for (const name of ["alpha", "beta", "gamma"]) assert.match(h.text(), new RegExp(`\\b${name}\\b`));
  h.press("\x0b"); h.type("zzzzqq"); assert.match(h.text(), /No matching tools/);
  h.press("\x0b"); h.type("read");
  assert.match(h.text(), /▾ Built-in tools/, "built-in tools are searchable too");
  h.component.dispose();
});
test("relevance ranking sends only the external tools, orders groups by their best child, and shows scores", async () => {
  const seen: string[][] = [];
  const h = harness({ rank: async (_query, skills) => { seen.push(skills.map((s) => s.name)); return skills.map((s) => item(s.name, s.name === "radar_q" ? 2 : s.name === "docs_read" ? 1 : 0)); } });
  h.type("radar"); h.press(keys.rank); await tick();
  assert.deepEqual(seen, [TOOLS], "no group keys, no built-in tools");
  const text = h.text();
  assert.ok(text.indexOf("dev-radius") < text.indexOf("docs") && text.indexOf("docs") < text.indexOf("notes"), text);
  assert.match(row(h, /dev-radius/), /1.00 relevance/); assert.match(row(h, /▸ docs/), /0.50 relevance/);
  h.press(keys.tab); assert.doesNotMatch(h.text(), /relevance/, "back to A-Z");
  h.component.dispose();
});
test("labels and descriptions are sanitized and every line fits 30/40/80 columns, expanded or not", () => {
  const evil = "bad\x1b[31m\x1b]8;;https://evil\x07\n界😀";
  const h = harness({ skills: [tool(`t_${evil}`, evil)], tree: { internal: [{ name: evil, description: evil }], groups: [{ key: "ext__x", label: evil, type: "extension", description: evil, tools: [`t_${evil}`] }], initialGroups: [] } });
  h.press(keys.down, keys.enter, keys.down, keys.down, keys.enter, keys.down, keys.enter);
  for (const width of [30, 40, 80]) for (const line of h.lines(width)) { assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`); assert.doesNotMatch(line, /\x1b\[31m|\x1b\]8/); }
  h.component.dispose();
});
test("a host height cap is honoured with many expanded groups and the selected row stays visible", () => {
  const many = Array.from({ length: 40 }, (_, g) => ({ key: `ext__g${g}`, label: `group${String(g).padStart(2, "0")}`, type: "extension" as const, description: "", tools: [`g${g}_a`, `g${g}_b`] }));
  const skills = many.flatMap((group) => group.tools.map((name) => tool(name, "long description ".repeat(30))));
  for (const cap of [30, 12, 8, 5, 3, 1]) {
    const component = createAllowlistComponent({ requestRender() {} }, theme, () => {}, { scope: "global", skills, initial: [], locationLabel: "settings.json", async save() {}, report() {}, maxRows: () => cap,
      tree: { internal: [], groups: many, initialGroups: [] } });
    component.focused = true;
    component.handleInput!(keys.down);
    for (let n = 0; n < 15; n++) { component.handleInput!(keys.enter); component.handleInput!(keys.down); component.handleInput!(keys.down); }
    const lines = component.render(80);
    assert.ok(lines.length <= cap, `${lines.length} lines exceed maxRows ${cap}`);
    if (cap >= 8) assert.match(lines.join("\n"), /❯/);
    component.dispose();
  }
});
test("a failed save keeps the draft dirty and shows only a safe code", async () => {
  const h = harness({ save: async () => { throw new Error("SECRET_PATH"); } });
  h.cursorTo(/notes/); h.press(keys.space, keys.save); await tick();
  assert.match(h.text(), /operation-failed/); assert.doesNotMatch(h.text(), /SECRET_PATH/); assert.match(h.text(), /Global ●/);
  h.component.dispose();
});
test("regression: an unloaded group row stays after it is deselected, so it can be reselected in the same draft, and across save and search", async () => {
  const h = harness({ groups: ["ext__gone", "mcp__docs"] });
  h.cursorTo(/ext__gone/); h.press(keys.space);
  assert.match(row(h, /ext__gone \(not loaded\)/), /\[ \]/, "the row is still listed, unchecked");
  assert.match(h.text(), /Global ●/);
  h.press(keys.space); assert.match(row(h, /ext__gone \(not loaded\)/), /\[x\]/); assert.doesNotMatch(h.text(), /Global ●/, "back to the saved state");
  h.press(keys.space, keys.save); await tick();
  assert.deepEqual(h.saved, [{ names: [], groups: ["mcp__docs"] }]);
  assert.match(row(h, /ext__gone \(not loaded\)/), /\[ \]/, "still listed after the save");
  h.press(keys.space, keys.save); await tick();
  assert.deepEqual(h.saved.at(-1), { names: [], groups: ["ext__gone", "mcp__docs"] }, "reselected and saved again");
  h.press(keys.esc); h.type("gone"); assert.match(row(h, /ext__gone \(not loaded\)/), /\[x\]/);
  h.component.dispose();
});
test("regression: unloaded group rows keep a stable inventory (not affected by loaded groups or other toggles)", () => {
  const h = harness({ groups: ["ext__gone", "mcp__other_gone"] });
  h.cursorTo(/notes/); h.press(keys.space, keys.space);
  h.cursorTo(/ext__gone/); h.press(keys.space); h.cursorTo(/mcp__other_gone/); h.press(keys.space);
  assert.match(h.text(), /ext__gone \(not loaded\)/); assert.match(h.text(), /mcp__other_gone \(not loaded\)/);
  assert.match(row(h, /ext__gone/), /\[ \]/); assert.match(row(h, /mcp__other_gone/), /\[ \]/);
  h.component.dispose();
});
