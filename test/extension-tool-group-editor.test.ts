// The REAL /decisions command + dialog + tool editor over a Pi-shaped tool inventory: extension groups are named from public sourceInfo,
// header toggles pin whole groups, and both lists are saved together (global settings and project file) without losing unloaded names.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { CommandContext } from "../src/extension/contracts.ts";
import { loadProjectAllowlist, projectAllowlistPath, saveProjectAllowlist } from "../src/project-allowlist.ts";
import { loadSettings, saveSettings } from "../src/settings.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extTool, mcpTool, toolSetup, type ToolHarness } from "./helpers/tool-fixture.ts";
import type { SimToolInfo } from "./helpers/pi-sim.ts";
import { extensionKey } from "../src/apps/tool-inventory.ts";
import { normalizeServerAllowlist } from "../src/apps/allowlist.ts";

const PKG_KEY = extensionKey("@acme/pi-web")!;

const KEY = { tab: "\t", down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", space: " ", save: "\x13" };
const theme = { fg: (_token: unknown, value: string) => value, bg: (_token: unknown, value: string) => value };
const waitFor = async <T,>(read: () => T | undefined | false, label: string): Promise<T> => {
  const deadline = Date.now() + 2000;
  for (;;) { const value = read(); if (value) return value; if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 1)); }
};
const fromExtension = (name: string, path: string, extra: Partial<SimToolInfo["sourceInfo"]> = {}, exposure: SimToolInfo["exposure"] = "direct"): SimToolInfo =>
  ({ ...extTool(name, exposure), sourceInfo: { path, source: "auto", scope: "user", origin: "top-level", ...extra } });
const EXTRA = [
  fromExtension("note_add", "/home/u/.pi/agent/extensions/notes.ts"), fromExtension("note_list", "/home/u/.pi/agent/extensions/notes.ts"),
  fromExtension("web_fetch", "/n/node_modules/@acme/pi-web/dist/index.js", { source: "npm:@acme/pi-web@2.0.0", origin: "package", baseDir: "/n/node_modules/@acme/pi-web", scope: "project" }),
  { name: "loose_tool", description: "no provenance", exposure: "direct" } as SimToolInfo,
  mcpTool("dev-radius", "q", "direct"), mcpTool("docs", "s", "direct"), mcpTool("docs", "t", "codemode"),
  mcpTool("project-server", "q", "direct", { sourceInfo: { source: "sdk", path: "", scope: "project" } }),
];

/** Open the REAL /decisions dialog, switch to the Tools tab and enter one allowlist editor (`tools global`, `mcp project`, ...). */
async function open(h: ToolHarness, target: `${"tools" | "mcp"} ${"global" | "project"}`) {
  const [list, scope] = target.split(" ") as ["tools" | "mcp", "global" | "project"];
  const components: (Component & { dispose?(): void })[] = [];
  const ui = { async select() { return undefined; }, async input() { return undefined; }, notify() {}, setStatus() {},
    async custom(factory: (...a: unknown[]) => unknown) { return new Promise((resolve) => { components.push(factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, resolve) as Component); }); } };
  const ctx = { ...h.ctx, mode: "tui", hasUI: true, ui } as unknown as CommandContext;
  const run = h.sim.command("", ctx);
  const dialog = await waitFor(() => components[0], "dialog");
  const text = () => dialog.render(110).join("\n");
  const until = (pattern: RegExp) => waitFor(() => pattern.test(text()) && text(), `${pattern}\n${text()}`);
  const press = (...keys: string[]) => { for (const key of keys) dialog.handleInput!(key); };
  /** Esc until the whole dialog closes (a focused list needs one extra Esc). */
  const close = async () => { for (let n = 0; n < 5; n++) press(KEY.esc); await run; };
  const to = (pattern: RegExp) => {
    press(KEY.down); for (let n = 0; n < 80; n++) press(KEY.up);
    for (let guard = 0; guard < 80; guard++) { if (text().split("\n").some((line) => /❯/.test(line) && pattern.test(line))) return; press(KEY.down); }
    assert.fail(`cursor never reached ${pattern}\n${text()}`);
  };
  press(KEY.tab); await until(/Always allowed tools · Global/);
  to(new RegExp(`${list === "tools" ? "Always allowed tools" : "Always allowed MCP servers & extensions"} · ${scope === "global" ? "Global" : "Project"}`)); press(KEY.enter);
  return { dialog, run, text, until, press, to, close };
}

test("the tool editor lists built-ins first, then MCP servers and extensions named from public provenance (package name, file name), then ungrouped tools", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA });
  const e = await open(h, "tools global");
  const text = await e.until(/Built-in tools/);
  assert.match(text, /Always allowed tools · Global/);
  const at = (needle: RegExp) => text.search(needle);
  assert.ok(at(/Built-in tools \(\d+\)/) < at(/▸ dev-radius/) && at(/▸ dev-radius/) < at(/▸ docs/) && at(/▸ docs/) < at(/▸ notes/) && at(/▸ notes/) < at(/loose_tool/), text);
  assert.doesNotMatch(text, /@acme\/pi-web|project-server|web_fetch/); assert.match(text, /notes · Extension · 2 tools/); assert.match(text, /docs · MCP server · 2 tools/);
  assert.doesNotMatch(text, /\/home\/u|node_modules|baseDir|sourceInfo/, "paths never reach the editor");
  await e.close();
});
test("saving writes tool names and group keys together to the global settings, preserving unloaded names and canonicalizing raw server names", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA, tools: { alwaysAllowedTools: ["ghost_tool"], alwaysAllowedMcpServers: ["dev-radius", "ext__gone"] } });
  const e = await open(h, "tools global");
  await e.until(/▸ dev-radius/);
  assert.match(e.text(), /\[x\] ▸ dev-radius/);
  e.to(/▸ notes/); e.press(KEY.space);
  e.to(/▸ docs/); e.press(KEY.enter); e.to(/\bs\b|mcp__docs__s/); e.press(KEY.space);
  assert.match(e.text(), /\[-\] ▾ docs/);
  e.to(/loose_tool/); e.press(KEY.space);
  e.press(KEY.save);
  await waitFor(() => /Always-allowed tools saved/.test(e.text()), "saved");
  const saved = (await loadSettings(h.path)).settings.tools;
  assert.deepEqual(saved.alwaysAllowedTools, ["ghost_tool", "loose_tool", "mcp__docs__s"]);
  assert.deepEqual(saved.alwaysAllowedMcpServers, ["ext__gone", "ext__notes", "mcp__dev_radius"]);
  await e.close();
});
test("the project scope saves both lists in one atomic project-file write and leaves the skill list alone", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA });
  await mkdir(join(h.root, ".pi"), { recursive: true });
  await writeFile(projectAllowlistPath(h.root), JSON.stringify({ alwaysAllowed: ["skill-a"], alwaysAllowedTools: ["old_tool"], alwaysAllowedMcpServers: ["docs"] }));
  const e = await open(h, "tools project");
  await e.until(/▸ @acme\/pi-web/);
  assert.match(e.text(), /\[x\] ▸ docs \(not loaded\)/, "a saved wrong-origin group is preserved as an unloaded row, never a loaded candidate");
  assert.doesNotMatch(e.text(), /▸ notes|▸ dev-radius/);
  e.to(/▸ @acme\/pi-web/); e.press(KEY.space); e.press(KEY.save);
  await waitFor(() => /Always-allowed tools saved/.test(e.text()), "saved");
  const project = await loadProjectAllowlist(h.root);
  assert.deepEqual(project.names, ["skill-a"]); assert.deepEqual(project.tools, ["old_tool"]); assert.deepEqual(project.mcpServers, ["docs", PKG_KEY]);
  await e.close();
});
test("the MCP editor lists servers AND extensions as one flat group list, saved by canonical key", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA, tools: { alwaysAllowedMcpServers: ["docs"] } });
  const e = await open(h, "mcp global");
  const text = await e.until(/\(MCP server\)/);
  assert.match(text, /Always allowed MCP servers & extensions/); assert.match(text, /\[x\] docs \(MCP server\)/); assert.match(text, /\[ \] dev-radius \(MCP server\)/); assert.match(text, /\[ \] notes \(extension\)/); assert.doesNotMatch(text, /@acme\/pi-web|project-server/);
  e.to(/notes \(extension\)/); e.press(KEY.space); e.press(KEY.save);
  await waitFor(() => /saved/.test(e.text()) && !/●/.test(e.text()), "saved");
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, ["ext__notes", "mcp__docs"]);
  await e.close();
});
test("a saved extension group takes effect: all its tools are available in both modes and nothing else is", async (t) => {
  for (const mode of ["tools", "mcp"] as const) {
    const h = await toolSetup(t, { extra: EXTRA, tools: { mode, alwaysAllowedMcpServers: ["ext__notes"] } });
    await h.start("task");
    assert.ok(h.active().includes("note_add") && h.active().includes("note_list"), mode);
    assert.ok(!h.active().includes("web_fetch"), `${mode}: another extension stays withheld`);
    assert.equal(await h.gate("note_list"), undefined);
    assert.match((await h.gate("web_fetch"))!.reason, mode === "mcp" ? /^Extension "@acme\/pi-web" is unavailable/ : /^Tool "web_fetch" is unavailable/);
  }
});
test("settings accept ext__ keys and fold their case, and `tools list`/`mcp list` show the allowlisted extension", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA, tools: { alwaysAllowedMcpServers: ["ext__Notes", PKG_KEY] } });
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, [PKG_KEY, "ext__notes"]);
  await saveProjectAllowlist(h.root, { mcpServers: [PKG_KEY] });
  await h.command("mcp list");
  const report = h.messages.at(-1)!;
  assert.match(report, /extension notes \(ext__notes\) · 2 tools · allowlisted/); assert.match(report, new RegExp(`extension @acme/pi-web \\(${PKG_KEY}\\) · 1 tools · allowlisted`));
  assert.match(report, /1 extension tools expose no usable provenance/);
  await h.command("tools list"); assert.match(h.messages.at(-1)!, /note_add · extension notes · direct · allowlisted/);
  await saveSettings((await loadSettings(h.path)).settings, h.path);
});

test("regression: `@acme/pi-web` and `acme-pi-web` are two extensions with two keys; allowlisting one never enables the other", async (t) => {
  const twin = fromExtension("twin_tool", "/home/u/.pi/agent/extensions/acme-pi-web.ts");
  const h = await toolSetup(t, { extra: [EXTRA[2]!, twin], tools: { mode: "mcp" } });
  await saveProjectAllowlist(h.root, { mcpServers: [PKG_KEY] });
  await h.start("task");
  assert.ok(h.active().includes("web_fetch")); assert.ok(!h.active().includes("twin_tool"), "the same-looking slug is a different extension");
  assert.match((await h.gate("twin_tool"))!.reason, /^Extension "acme-pi-web" is unavailable/);
  assert.notEqual(PKG_KEY, "ext__acme_pi_web");
});
test("regression: a non-ASCII extension is a real group that mcp mode filters, shown by its name and saved by its key", async (t) => {
  const key = extensionKey("笔记")!;
  const h = await toolSetup(t, { extra: [fromExtension("note_zh", "/home/u/.pi/agent/extensions/笔记.ts"), EXTRA[0]!], tools: { mode: "mcp" } });
  await h.start("task");
  assert.ok(!h.active().includes("note_zh"), "no longer escapes filtering"); assert.match((await h.gate("note_zh"))!.reason, /^Extension "笔记" is unavailable.*Tools tab/);
  const e = await open(h, "mcp global");
  await e.until(/笔记 \(extension\)/);
  e.to(/笔记 \(extension\)/); e.press(KEY.space, KEY.save);
  await waitFor(() => /saved/.test(e.text()) && !/●/.test(e.text()), "saved");
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, [key]);
  await e.close();
  assert.equal(await h.gate("note_zh"), undefined);
});
test("regression: a LOADED 64-character server name round-trips through both editors, the project file and the settings without failing unrelated saves", async (t) => {
  const full = "x".repeat(64), canonical = `mcp__${full}`;
  const h = await toolSetup(t, { extra: [EXTRA[0]!, mcpTool(full, "q", "direct")], tools: { alwaysAllowedMcpServers: [full] } });
  await mkdir(join(h.root, ".pi"), { recursive: true });
  await writeFile(projectAllowlistPath(h.root), JSON.stringify({ alwaysAllowed: [], alwaysAllowedMcpServers: [full] }));
  // The canonical key of a valid raw name is valid and is the same server (never duplicated).
  assert.deepEqual(normalizeServerAllowlist([full, canonical]), [full]);
  // Tool editor: the loaded server seeds as a canonical 69-character key; an unrelated pick saves.
  const e = await open(h, "tools global");
  await e.until(/▸ x{64}/);
  assert.match(e.text(), /\[x\] ▸ x{64}/);
  e.to(/▸ notes/); e.press(KEY.space, KEY.save);
  await waitFor(() => /Always-allowed tools saved/.test(e.text()), "tool editor saved");
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, [canonical, "ext__notes"].sort());
  await e.close();
  // MCP editor (global and project).
  const g = await open(h, "mcp global");
  await g.until(/x{64} \(MCP server\)/);
  g.to(/notes \(extension\)/); g.press(KEY.space, KEY.save);
  await waitFor(() => /saved/.test(g.text()) && !/●/.test(g.text()), "mcp editor saved");
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, [canonical]);
  await g.close();
  // A host exposing project provenance makes the server and extension project-only candidates.
  for (const name of ["note_add", `mcp__${full}__q`]) {
    const at = h.sim.registry.findIndex((tool) => tool.name === name), info = h.sim.registry[at];
    h.sim.registry[at] = { ...info, sourceInfo: { ...info.sourceInfo!, ...(info.namespace ? { source: "sdk", path: "" } : {}), scope: "project" } };
  }
  const p = await open(h, "mcp project");
  await p.until(/x{64} \(MCP server\)/);
  p.to(/notes \(extension\)/); p.press(KEY.space, KEY.save);
  await waitFor(() => /saved/.test(p.text()) && !/●/.test(p.text()), "project saved");
  assert.deepEqual((await loadProjectAllowlist(h.root)).mcpServers, [canonical, "ext__notes"].sort());
  await p.close();
  // The effective policy still treats the canonical entry as that server.
  await h.start("task"); assert.ok(h.active().includes(`mcp__${full}__q`));
});


test("project tool and MCP editors contain only public project-origin candidates, with isolated saves", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA });
  const globalBefore = (await loadSettings(h.path)).settings;
  const tool = await open(h, "tools project");
  const text = await tool.until(/▸ @acme\/pi-web/);
  assert.match(text, /▸ project-server/); assert.doesNotMatch(text, /▸ notes|▸ docs|▸ dev-radius|loose_tool/);
  tool.to(/▸ @acme\/pi-web/); tool.press(KEY.enter);
  assert.match(tool.text(), /web_fetch/);
  tool.to(/web_fetch/); tool.press(KEY.space, KEY.save);
  await waitFor(() => /Always-allowed tools saved/.test(tool.text()), "saved");
  await tool.close();
  const group = await open(h, "mcp project");
  const flat = await group.until(/project-server \(MCP server\)/);
  assert.match(flat, /@acme\/pi-web \(extension\)/); assert.doesNotMatch(flat, /notes \(extension\)|docs \(MCP server\)|dev-radius/);
  group.to(/project-server \(MCP server\)/); group.press(KEY.space, KEY.save);
  await waitFor(() => /saved/.test(group.text()) && !/●/.test(group.text()), "saved");
  await group.close();
  assert.deepEqual((await loadProjectAllowlist(h.root)).tools, ["web_fetch"]);
  assert.deepEqual((await loadProjectAllowlist(h.root)).mcpServers, ["mcp__project_server"]);
  assert.deepEqual((await loadSettings(h.path)).settings, globalBefore, "project saves never touch the global settings");
});
test("wrong-origin saved names remain stable unloaded rows, not selectable loaded candidates", async (t) => {
  const h = await toolSetup(t, { extra: EXTRA, tools: { alwaysAllowedTools: ["web_fetch"], alwaysAllowedMcpServers: [PKG_KEY] } });
  const e = await open(h, "tools global");
  await e.until(/web_fetch \(not loaded\)/);
  assert.ok(e.text().includes(`${PKG_KEY} (not loaded)`));
  assert.doesNotMatch(e.text(), /▸ @acme\/pi-web/);
  e.to(/▸ notes/); e.press(KEY.space, KEY.save);
  await waitFor(() => /Always-allowed tools saved/.test(e.text()), "saved");
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedTools, ["web_fetch"]);
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, [PKG_KEY, "ext__notes"]);
  await e.close();
});

test("mixed-origin extension groups are not group candidates; each tool remains selectable only in its own scope", async (t) => {
  const h = await toolSetup(t, { extra: [...EXTRA, fromExtension("project_note", "/work/.pi/extensions/notes.ts", { scope: "project" })] });
  for (const scope of ["global", "project"] as const) {
    const e = await open(h, `tools ${scope}`);
    await e.until(new RegExp(scope === "global" ? "note_add" : "project_note"));
    assert.doesNotMatch(e.text(), /▸ notes/);
    assert.doesNotMatch(e.text(), new RegExp(scope === "global" ? "project_note" : "note_add|note_list"));
    await e.close();
    const flat = await open(h, `mcp ${scope}`);
    await flat.until(/Search:/);
    assert.doesNotMatch(flat.text(), /notes \(extension\)|ext__notes/);
    await flat.close();
  }
});
