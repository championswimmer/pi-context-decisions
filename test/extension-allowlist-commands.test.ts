import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionHost, ExtensionRegistry } from "../src/extension/contracts.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { loadProjectAllowlist, projectAllowlistPath } from "../src/project-allowlist.ts";
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
/** Main-screen rows in dialog order: toggle, provider, model, global, project, Advanced, Status, Close. */
function openAllowlistRow(component: Component, row: "global" | "project") {
  for (let i = 0; i < (row === "global" ? 3 : 4); i++) component.handleInput!(keys.down);
  component.handleInput!(keys.enter);
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
  const requests: DecisionRequest[] = [], messages: string[] = [], overlays: Component[] = [];
  const choices: ((options: string[]) => string | undefined)[] = [];
  let customDriver: ((component: Component) => Promise<void>) | undefined;
  let key: string | undefined = configured ? "FIXTURE_API_KEY" : undefined;
  const pi: ExtensionHost = {
    on: (() => () => {}) as ExtensionAPI["on"], registerCommand(name, command) { commands.set(name, command); }, appendEntry() {}, getActiveTools: () => [],
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
        const component = await factory({ requestRender() {}, terminal: { rows: 40 } } as Parameters<typeof factory>[0], { fg: (_token: unknown, value: string) => value, bg: (_token: unknown, value: string) => value } as Parameters<typeof factory>[1], {} as Parameters<typeof factory>[2], (value) => settle(value));
        overlays.push(component); await customDriver?.(component); component.dispose?.(); settle("closed"); return result as never;
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
  };
}
test("headless global/project list/add/remove/clear persist separately and status displays counts", async (t) => {
  const h = await harness(t);
  await h.command("allow global add alpha unseen"); await h.command("allow project add project-only");
  assert.deepEqual((await loadSettings(h.path)).settings.globalAllowlist, ["alpha", "unseen"]);
  assert.deepEqual((await loadProjectAllowlist(h.root)).names, ["project-only"]);
  const projectFile = JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8")); assert.deepEqual(projectFile, { alwaysAllowed: ["project-only"] });
  await h.command("allow global list"); assert.match(h.messages.at(-1)!, /global \(2\): alpha, unseen/);
  await h.command("status"); assert.match(h.messages.at(-1)!, /global 2, project 1/);
  await h.command("allow global remove alpha"); assert.deepEqual((await loadSettings(h.path)).settings.globalAllowlist, ["unseen"]);
  await h.command("allow project clear"); assert.deepEqual((await loadProjectAllowlist(h.root)).names, []); assert.deepEqual(h.requests, []);
});
test("global edits refuse to overwrite invalid settings; missing cwd and malformed names are safe errors", async (t) => {
  const h = await harness(t); await writeFile(h.path, "invalid PRIVATE_CONTENT");
  await h.command("allow global add alpha"); assert.match(h.messages.at(-1)!, /Repair settings/); assert.equal(await readFile(h.path, "utf8"), "invalid PRIVATE_CONTENT");
  h.ctx.cwd = undefined; await h.command("allow project list"); assert.match(h.messages.at(-1)!, /working directory/);
  assert.ok(h.messages.every((message) => !message.includes("PRIVATE_CONTENT"))); assert.deepEqual(h.requests, []);
});
test("/decisions settings opens ONE floating dialog hosting Global and Project editors; saves only the current scope", async (t) => {
  const h = await harness(t); h.ctx.hasUI = true; h.ctx.mode = "tui";
  h.driver(async (component) => {
    const main = component.render(100).join("\n");
    assert.match(main, /Always allowed · Global/); assert.match(main, /Always allowed · Project/); assert.match(main, /Advanced…/);
    assert.doesNotMatch(main, /relatedThreshold|chunkSize|Batch size/, "relevance knobs live under Advanced");
    openAllowlistRow(component, "global");
    assert.match(await until(component, /\[ \] alpha/), /Global/); assert.doesNotMatch(component.render(120).join("\n"), /\[ \] project-only/);
    component.handleInput!(keys.down); component.handleInput!(" "); component.handleInput!("\x13"); await saved(component);
    component.handleInput!(keys.esc); component.handleInput!(keys.esc); await until(component, /Context decisions/);
  });
  await h.command("settings"); assert.equal(h.overlays.length, 1); assert.deepEqual((await loadSettings(h.path)).settings.globalAllowlist, ["alpha"]);
  h.driver(async (component) => {
    await until(component, /Always allowed · Project\s+[1-9?…]/);
    openAllowlistRow(component, "project");
    await until(component, /project-only/); component.handleInput!(keys.down); component.handleInput!(" "); component.handleInput!("\x13"); await saved(component);
  });
  await h.command("settings"); assert.equal(h.overlays.length, 2); assert.deepEqual((await loadProjectAllowlist(h.root)).names, ["project-only"]);
  assert.deepEqual(h.requests, []); assert.equal(h.commands.has("context-decisions"), false);
  assert.deepEqual(h.messages, [], "dialog feedback stays inside the dialog, not the transcript");
});
test("RPC allowlist editor is unavailable but text commands remain functional", async (t) => {
  const h = await harness(t); h.ctx.hasUI = true; h.ctx.mode = "rpc";
  await h.command("allowlist global"); assert.match(h.messages.at(-1)!, /terminal UI.*decisions allow/); assert.equal(h.overlays.length, 0);
  await h.command("allow global add alpha"); assert.deepEqual((await loadSettings(h.path)).settings.globalAllowlist, ["alpha"]);
  assert.ok((await h.commands.get("decisions")!.getArgumentCompletions!("allow"))!.some((item) => item.value === "allowlist"));
});
test("explicit topic ranking uses configured decision client even when auto filtering is off; metadata only", async (t) => {
  const h = await harness(t, true); h.ctx.hasUI = true; h.ctx.mode = "tui";
  await h.command("disable");
  h.driver(async (component) => {
    await until(component, /Search:/);
    for (const char of "Browser work") component.handleInput!(char); assert.equal(h.requests.length, 0);
    component.handleInput!("\x12"); await tick(); await tick();
    assert.match(component.render(120).join("\n"), /1.80\/2/);
  });
  await h.command("allowlist global"); assert.equal(h.requests.length, 1);
  const data = JSON.stringify(h.requests); assert.doesNotMatch(data, /\/private\/|filePath|sourceInfo|project-only/); assert.match(data, /topics in the search query/);
  assert.equal(h.requests[0].state.task, "Browser work"); assert.equal((await loadSettings(h.path)).settings.enabled, false);
});
test("missing credential guidance remains inline and local fuzzy works without creating a client", async (t) => {
  const h = await harness(t, true); h.setKey(undefined); h.ctx.hasUI = true; h.ctx.mode = "tui";
  h.driver(async (component) => { await until(component, /Search:/); for (const char of "Browser") component.handleInput!(char); component.handleInput!("\x12"); await tick();
    assert.match(component.render(160).join("\n"), /TYPESAFE_API_KEY/); assert.deepEqual(h.requests, []);
    component.handleInput!("\t"); assert.match(component.render(120).join("\n"), /alpha/); });
  await h.command("allowlist global"); assert.deepEqual(h.requests, []);
});
