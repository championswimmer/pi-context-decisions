import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionHost, ExtensionRegistry } from "../src/extension/contracts.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { globalAllowlistPath, loadProjectAllowlist, projectAllowlistPath, saveGlobalAllowlist, saveProjectAllowlist } from "../src/project-allowlist.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = { down: "\x1b[B", enter: "\r", esc: "\x1b" };
async function until(component: Component, pattern: RegExp, width = 120): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const text = component.render(width).join("\n");
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${pattern}; last render:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
function openAllowlistRow(component: Component, row: "global" | "project") {
  const selected = new RegExp(`❯\\s+${row === "global" ? "Global" : "Project"} always-allowed skills`);
  for (let i = 0; i < 15; i++) {
    if (selected.test(component.render(120).join("\n"))) {
      component.handleInput!(keys.enter);
      return;
    }
    component.handleInput!(keys.down);
  }
  assert.fail(`Could not select ${row} allowlist row`);
}
async function saved(component: Component): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!component.render(120).join("\n").includes("Always-allowed skills saved")) {
    if (Date.now() > deadline) assert.fail("Save did not complete before the test interaction closed");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
async function harness(t: { after(fn: () => Promise<void>): void }, configured = false) {
  const root = await mkdtemp(join(tmpdir(), "allowlist-commands-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  await saveSettings({ ...defaultSettings(), backend: configured ? { backend: "typesafe", model: "jev-latest" } : null }, path);
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const requests: DecisionRequest[] = [], messages: string[] = [], overlays: Component[] = [];
  const choices: ((options: string[]) => string | undefined)[] = [];
  let customDriver: ((component: Component) => Promise<void>) | undefined;
  let key: string | undefined = configured ? "FIXTURE_API_KEY" : undefined;
  const pi: ExtensionHost = {
    on: ((name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }) as ExtensionAPI["on"], registerCommand(name, command) { commands.set(name, command); }, appendEntry() {}, getActiveTools: () => [],
    getCommands() { return [
      { name: "skill:alpha", description: "Browser testing", source: "skill", sourceInfo: { path: "/private/global/alpha", source: "fixture", scope: "user", origin: "top-level" } },
      { name: "skill:project-only", description: "Database querying", source: "skill", sourceInfo: { path: "/private/project/skill", source: "fixture", scope: "project", origin: "top-level" } },
    ]; },
  };
  const registry: ExtensionRegistry = {
    getModelsOfType() { return []; }, findOfType() { return undefined; }, async getApiKeyForProvider() { return key; },
    async getProviderAuth(provider) { return provider === "typesafe" && key ? { auth: { apiKey: key }, source: "API key" } : undefined; },
    async classify() { throw new Error("No native classifier selected"); },
  };
  const ctx: CommandContext = { cwd: root, hasUI: false, mode: "print", modelRegistry: registry,
    ui: { async select(_title, options) { return choices.shift()?.(options); }, async input() { return undefined; }, notify() {}, setStatus() {},
      async custom(factory) {
        let settle!: (value: unknown) => void;
        const result = new Promise((resolve) => { settle = resolve; });
        const component = await factory(
          { requestRender() {}, terminal: { rows: 40 } } as Parameters<typeof factory>[0],
          { fg: (_token: unknown, value: string) => value, bg: (_token: unknown, value: string) => value, bold: (value: string) => value } as Parameters<typeof factory>[1],
          getKeybindings() as unknown as Parameters<typeof factory>[2],
          (value) => settle(value),
        );
        overlays.push(component); await customDriver?.(component); component.dispose?.(); settle({ saved: false, values: {}, scope: "global", dirty: false, closedBy: "escape" }); return result as never;
      },
    },
  };
  registerContextDecisions(pi, { settingsPath: path, env: {}, report(_ctx, message) { messages.push(message); },
    createClient() { return createDecisionClient({ id: "typesafe", model: "fixture", async decide(request) {
      requests.push(request); return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "score", score: 1.8 }])) };
    } }); },
  });
  return { root, path, ctx, commands, requests, messages, overlays, choices, setKey(value: string | undefined) { key = value; },
    driver(fn: typeof customDriver) { customDriver = fn; },
    async command(args: string) { await commands.get("decisions")!.handler(args, ctx as ExtensionCommandContext); },
    /** Settings and project files were edited on disk: a reload picks them up. */
    async emitReload() { for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "reload" }, ctx as never); },
  };
}
test("headless status shows allowlist counts; the removed allow/allowlist subcommands change nothing", async (t) => {
  const h = await harness(t);
  await saveGlobalAllowlist(h.path, { skills: ["alpha", "unseen"] }); await saveProjectAllowlist(h.root, ["project-only"]);
  await h.emitReload();
  await h.command("status"); assert.match(h.messages.at(-1)!, /global 2, project 1/);
  for (const args of ["allow global add x", "allow project clear", "allow global list", "allowlist global"]) { await h.command(args); assert.match(h.messages.at(-1)!, /^Use \/decisions status\|history\|test\|tools\|mcp\|pin\|unpin/, args); }
  assert.deepEqual((await loadSettings(h.path)).settings.globalAllowlist, ["alpha", "unseen"]);
  assert.deepEqual((await loadProjectAllowlist(h.root)).names, ["project-only"]); assert.equal(h.overlays.length, 0); assert.deepEqual(h.requests, []);
  const projectFile = JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8")); assert.deepEqual(projectFile, { alwaysAllowed: ["project-only"] });
});
test("global allowlist edits leave invalid settings.json untouched; missing cwd shows n/a; nothing private leaks", async (t) => {
  const h = await harness(t); await writeFile(h.path, "invalid PRIVATE_CONTENT"); h.ctx.hasUI = true; h.ctx.mode = "tui";
  h.driver(async (component) => {
    openAllowlistRow(component, "global");
    await until(component, /Search:/); component.handleInput!(keys.down); component.handleInput!(" "); component.handleInput!("\x13");
    await saved(component);
  });
  await h.command(""); assert.equal(await readFile(h.path, "utf8"), "invalid PRIVATE_CONTENT", "allowlists.json saves never touch settings.json");
  assert.deepEqual(JSON.parse(await readFile(globalAllowlistPath(h.path), "utf8")), { alwaysAllowed: ["alpha"] });
  h.ctx.cwd = undefined;
  h.driver(async (component) => { assert.match(await until(component, /Project always-allowed skills\s+n\/a/), /Project always-allowed skills/); });
  await h.command("");
  assert.ok(h.messages.every((message) => !message.includes("PRIVATE_CONTENT"))); assert.deepEqual(h.requests, []);
});
test("/decisions opens ONE floating dialog hosting Global and Project editors; saves only the current scope", async (t) => {
  const h = await harness(t); h.ctx.hasUI = true; h.ctx.mode = "tui";
  h.driver(async (component) => {
    const main = component.render(100).join("\n");
    assert.match(main, /Global always-allowed skills/); assert.match(main, /Project always-allowed skills/); assert.match(main, /Decision/);
    assert.doesNotMatch(main, /relatedThreshold|chunkSize|Shard size/, "decision tuning lives under the Decision tab");
    openAllowlistRow(component, "global");
    assert.match(await until(component, /\[ \] alpha/), /Global/); assert.doesNotMatch(component.render(120).join("\n"), /\[ \] project-only/);
    component.handleInput!(keys.down); component.handleInput!(" "); component.handleInput!("\x13"); await saved(component);
    component.handleInput!(keys.esc); component.handleInput!(keys.esc); await until(component, /Skill filtering/);
  });
  await h.command(""); assert.equal(h.overlays.length, 1); assert.deepEqual((await loadSettings(h.path)).settings.globalAllowlist, ["alpha"]);
  h.driver(async (component) => {
    await until(component, /Project always-allowed skills\s+0/);
    openAllowlistRow(component, "project");
    await until(component, /project-only/); component.handleInput!(keys.down); component.handleInput!(" "); component.handleInput!("\x13"); await saved(component);
  });
  await h.command(""); assert.equal(h.overlays.length, 2); assert.deepEqual((await loadProjectAllowlist(h.root)).names, ["project-only"]);
  assert.deepEqual(h.requests, []); assert.equal(h.commands.has("context-decisions"), false);
  assert.deepEqual(h.messages, [], "dialog feedback stays inside the dialog, not the transcript");
});
test("RPC cannot open the allowlist editors: the menu says so, opens no overlay and no allow subcommand exists", async (t) => {
  const h = await harness(t); h.ctx.hasUI = true; h.ctx.mode = "rpc";
  h.choices.push((options) => options.find((option) => option.includes("Global always-allowed skills")), () => "Done");
  await h.command(""); assert.match(h.messages.at(-1)!, /allowlist editors need the interactive terminal UI.*allowlists\.json.*pi-context-decisions\.json/s); assert.equal(h.overlays.length, 0);
  assert.equal((await h.commands.get("decisions")!.getArgumentCompletions!("allow")), null);
});
test("explicit topic ranking uses configured decision client even when auto filtering is off; metadata only", async (t) => {
  const h = await harness(t, true); h.ctx.hasUI = true; h.ctx.mode = "tui";
  await saveSettings({ ...defaultSettings(), relevance: { ...defaultSettings().relevance, enabled: false }, decision: { ...defaultSettings().decision, chunkSize: 1, concurrency: 1, maxPromptChars: 6, maxDescriptionChars: 8 }, backend: { backend: "typesafe", model: "jev-latest" } }, h.path); await h.emitReload();
  h.driver(async (component) => {
    openAllowlistRow(component, "global"); await until(component, /Search:/);
    for (const char of "Browser work") component.handleInput!(char); assert.equal(h.requests.length, 0);
    component.handleInput!("\x12"); await until(component, /0.90 relevance/);
    assert.match(component.render(120).join("\n"), /0.90 relevance/);
  });
  await h.command(""); assert.equal(h.requests.length, 1, "only alpha is in global scope"); assert.deepEqual(h.messages, [], "the command must not swallow a driver assertion");
  for (const request of h.requests) {
    assert.equal(Object.keys(request.questions).length, 1);
    assert.ok(Object.values(request.state.skills as Record<string, { description: string }>).every((entry) => entry.description.length === 8));
  }
  const data = JSON.stringify(h.requests); assert.doesNotMatch(data, /\/private\/|filePath|sourceInfo|project-only/); assert.match(data, /topics in the search query/);
  assert.equal(h.requests[0].state.task, "Browse"); assert.equal((await loadSettings(h.path)).settings.relevance.enabled, false);
});
test("missing credential guidance remains inline and local fuzzy works without creating a client", async (t) => {
  const h = await harness(t, true); h.setKey(undefined); h.ctx.hasUI = true; h.ctx.mode = "tui";
  h.driver(async (component) => { openAllowlistRow(component, "global"); await until(component, /Search:/); for (const char of "Browser") component.handleInput!(char); component.handleInput!("\x12"); await tick();
    assert.match(component.render(160).join("\n"), /TYPESAFE_API_KEY/); assert.deepEqual(h.requests, []);
    component.handleInput!("\t"); assert.match(component.render(120).join("\n"), /alpha/); });
  await h.command(""); assert.deepEqual(h.requests, []);
});
