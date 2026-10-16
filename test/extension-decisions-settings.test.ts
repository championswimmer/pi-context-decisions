import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import { pickerEntries } from "../src/extension/commands.ts";
import type { CommandContext, ExtensionHost, ExtensionRegistry } from "../src/extension/contracts.ts";
import { defaultSettings, loadSettings, saveSettings, updateSetting } from "../src/settings.ts";
import { setModel, setSetting } from "./helpers/settings-ui.ts";
import { OPENROUTER_DECISION_MODELS } from "../src/catalog/openrouter-models.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { ui?: boolean; env?: Record<string, string | undefined>; registry?: Partial<ExtensionRegistry> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "decisions-menu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  const messages: string[] = [];
  const dialogs: { title: string; options: string[] }[] = [];
  const picks: (string | undefined | ((choices: string[]) => string | undefined))[] = [];
  const inputs: (string | undefined)[] = [];
  const lookups: string[] = [];
  let inference = 0;
  const models = [{ provider: "custom", id: "local" }, { provider: "openai", id: "gpt-6-luna" }, { provider: "openrouter", id: "typesafe/jev-1.13" }];
  const registry: ExtensionRegistry = {
    getModelsOfType(type, provider) { return type === "classifier" ? models.filter((m) => !provider || m.provider === provider) : []; },
    findOfType(_type, provider, id) { return models.find((m) => m.provider === provider && m.id === id); },
    async getApiKeyForProvider(provider) { lookups.push(provider); return undefined; },
    async classify() { inference++; return { answers: {}, stopReason: "stop" }; },
    isUsingOAuth() { return false; },
    ...options.registry,
  };
  const ctx: CommandContext = { hasUI: options.ui ?? false, mode: options.ui ? "tui" : "print", modelRegistry: registry, ui: {
    async select(title, choices) { dialogs.push({ title, options: choices }); const selected = picks.shift(); return typeof selected === "function" ? selected(choices) : selected; },
    async input() { return inputs.shift(); },
    notify(message) { messages.push(message); }, setStatus() {},
  } };
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const pi: ExtensionHost = { on: (() => () => {}) as ExtensionAPI["on"], registerCommand(name, command) { commands.set(name, command); }, appendEntry() {}, getActiveTools: () => [] };
  registerContextDecisions(pi, { settingsPath: path, env: options.env ?? {}, report(_ctx, message) { messages.push(message); } });
  const command = async (args: string) => commands.get("decisions")!.handler(args, ctx as ExtensionCommandContext);
  const run = (args: string, c: CommandContext) => commands.get("decisions")!.handler(args, c as ExtensionCommandContext);
  /** Settings changes through the RPC menus (the dialog's save path); booleans toggle. */
  const set = (key: string, value?: string) => setSetting(run, ctx, key, value);
  const model = (label: string) => setModel(run, ctx, label);
  const menu = (...choices: (string | undefined | ((options: string[]) => string | undefined))[]) => { picks.push(...choices, "Back", "Done"); return command(""); };
  return { path, messages, dialogs, picks, inputs, lookups, commands, ctx, command, set, model, menu, inference: () => inference };
}

const row = (prefix: string) => (options: string[]) => options.find((label) => label.startsWith(prefix));
test("RPC /decisions menu: direct toggle, provider, model; relevance tuning sits under Advanced…", async (t) => {
  const h = await fixture(t, { ui: true });
  await h.menu("Skills", row("relevance.enabled:"), "Back", "Advanced", "Back");
  assert.deepEqual([...h.commands.keys()], ["decisions"]);
  assert.deepEqual(h.dialogs[0].options, ["Skills", "Tools", "Advanced", "Done"]);
  const advanced = h.dialogs.find((dialog) => /Advanced/.test(dialog.title))!;
  assert.ok(advanced.options.some((label) => label.startsWith("Provider / execution:")));
  assert.ok(advanced.options.some((label) => label.startsWith("Model:")));
  assert.ok(advanced.options.includes("decision.chunkSize: 50"));
  assert.ok(advanced.options.includes("decision.concurrency: 0 (all shards parallel)"));
  assert.ok(!advanced.options.some((label) => label.startsWith("relevance.enabled") || label.startsWith("relevance.cadence")));
  assert.equal((await loadSettings(h.path)).settings.relevance.enabled, false);
  assert.equal(h.inputs.length, 0); assert.equal(h.inference(), 0);
});
test("the setter subcommands are gone: each is rejected with the usage line, changes nothing and opens nothing", async (t) => {
  const h = await fixture(t);
  const before = JSON.stringify((await loadSettings(h.path)).settings);
  for (const args of ["settings", "settings enabled false", "relevance", "relevance threshold 0.5", "provider", "provider openai", "model none", "model pi custom local",
    "enable", "disable", "allow global list", "allow project add x", "allowlist global", "tools", "tools on", "tools mode mcp", "tools allow global list", "mcp", "mcp allow global add x", "bogus"]) {
    await h.command(args);
    assert.match(h.messages.at(-1)!, /^Use \/decisions( status\|history\|test\|tools\|mcp\|pin\|unpin|[^]*)/, args);
    assert.equal(JSON.stringify((await loadSettings(h.path)).settings), before, args);
  }
  assert.equal(h.dialogs.length, 0); assert.equal(h.inference(), 0);
  await h.command("tools list extra"); assert.match(h.messages.at(-1)!, /Use \/decisions tools list.*Tools tab/);
  assert.deepEqual((await h.commands.get("decisions")!.getArgumentCompletions!(""))!.map((item) => item.value), ["status", "history", "test", "tools", "mcp", "pin", "unpin"]);
  assert.equal(await h.commands.get("decisions")!.getArgumentCompletions!("al"), null);
});
test("headless /decisions prints the status instead of a menu", async (t) => {
  const h = await fixture(t);
  await h.command(""); assert.match(h.messages.at(-1)!, /Context decisions: not configured/); assert.equal(h.dialogs.length, 0);
});
test("RPC Advanced edits validate and persist; cancelling leaves settings alone", async (t) => {
  const h = await fixture(t, { ui: true });
  h.inputs.push("25", undefined);
  await h.menu("Advanced", row("decision.chunkSize:"), row("decision.chunkSize:"), "Back");
  assert.match(h.dialogs[0].title, /settings/); assert.match(h.dialogs.find((dialog) => /Advanced/.test(dialog.title))!.title, /Advanced/);
  assert.equal((await loadSettings(h.path)).settings.decision.chunkSize, 25);
});

test("RPC enable/disable, batch size and all-parallel settings persist with bounds", async (t) => {
  const h = await fixture(t);
  await h.set("enabled"); await h.set("decision.chunkSize", "50"); await h.set("decision.concurrency", "0");
  await h.set("decision.threshold", "0.625");
  let settings = (await loadSettings(h.path)).settings;
  assert.equal(settings.relevance.enabled, false); assert.equal(settings.decision.chunkSize, 50); assert.equal(settings.decision.concurrency, 0);
  assert.equal(settings.decision.threshold, 0.625);
  await h.set("decision.chunkSize", "51"); assert.match(h.messages.at(-1)!, /integer in \[1, 50\]/);
  await h.set("decision.concurrency", "33"); assert.match(h.messages.at(-1)!, /integer in \[0, 32\]/);
  await h.set("enabled"); settings = (await loadSettings(h.path)).settings; assert.equal(settings.relevance.enabled, true);
  await h.command("status"); assert.match(h.messages.at(-1)!, /all shards parallel/); assert.equal(h.inference(), 0);
});

for (const [provider, model, variable] of [
  ["openai", "gpt-6-luna", "OPENAI_API_KEY"],
  ["typesafe", "jev-latest", "TYPESAFE_API_KEY"],
  ["openrouter", "typesafe/jev-1.13", "OPENROUTER_API_KEY"],
] as const) test(`missing ${provider} credentials never persist or enable an unusable selection`, async (t) => {
  const h = await fixture(t);
  await h.set("enabled");
  await h.model(`${provider} direct ${model}`);
  const settings = (await loadSettings(h.path)).settings;
  assert.equal(settings.backend, null); assert.equal(settings.relevance.enabled, false);
  assert.match(h.messages.at(-1)!, new RegExp(variable)); assert.match(h.messages.at(-1)!, new RegExp(`/login ${provider}`));
  assert.equal(h.inference(), 0);
});

test("missing-key provider labels include all three direct providers and exact setup guidance", async (t) => {
  const h = await fixture(t, { ui: true });
  await h.menu("Advanced", row("Provider / execution:"), undefined);
  const providers = h.dialogs.find((dialog) => /provider and execution path/.test(dialog.title))!;
  for (const provider of ["openai", "openrouter", "typesafe"]) assert.match(providers.options.find((label) => label.startsWith(`${provider} · direct API`))!, /missing key/);
  assert.ok(providers.options.some((label) => /Pi internal classifier pipeline/.test(label)));
  assert.equal(h.inference(), 0);
});

test("UI unavailable provider is visibly labelled and rejected before model/persistence", async (t) => {
  const h = await fixture(t, { ui: true });
  await h.menu("Advanced", row("Provider / execution:"), (choices) => choices.find((label) => label.startsWith("openrouter · direct API")));
  assert.match(h.dialogs[2].options.find((label) => label.startsWith("openrouter"))!, /missing key/);
  assert.match(h.messages.at(-1)!, /OPENROUTER_API_KEY.*\/login openrouter/);
  assert.equal(h.dialogs.length, 5, "settings, providers, settings again: no model picker for an unusable provider"); assert.equal((await loadSettings(h.path)).settings.backend, null);
  await h.menu("Advanced", row("Model:"), (choices) => choices.find((label) => label.includes("OpenAI direct")));
  assert.match(h.messages.at(-1)!, /OPENAI_API_KEY/);
  assert.equal((await loadSettings(h.path)).settings.backend, null); assert.equal(h.inference(), 0);
});

test("provider UI separates four core workflows, filters models and does not re-enable filtering", async (t) => {
  const h = await fixture(t, { ui: true, registry: { async getProviderAuth(provider) { return { auth: { apiKey: `FIXTURE-${provider}` }, source: "API key" }; } } });
  await h.set("enabled");
  h.dialogs.length = 0;
  await h.menu("Advanced", row("Provider / execution:"), (choices) => choices.find((label) => label.startsWith("openrouter · direct API")), (choices) => choices.find((label) => label.includes("openrouter direct typesafe/jev-1.13")));
  const providers = h.dialogs.find((dialog) => /provider and execution path/.test(dialog.title))!;
  assert.ok(providers.options.some((label) => label.includes("Pi internal classifier pipeline")));
  assert.ok(providers.options.some((label) => label.startsWith("typesafe · direct API")));
  assert.ok(providers.options.some((label) => label.startsWith("openai · direct API")));
  const models = h.dialogs.find((dialog) => /select model/.test(dialog.title))!;
  assert.equal(models.options.filter((label) => label !== "None (no decision calls)").length, OPENROUTER_DECISION_MODELS.length);
  assert.ok(models.options.every((label) => label === "None (no decision calls)" || label.includes("OpenRouter direct")));
  const settings = (await loadSettings(h.path)).settings;
  assert.deepEqual(settings.backend, { backend: "openrouter", model: "typesafe/jev-1.13" }); assert.equal(settings.relevance.enabled, false);
  assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/); assert.equal(h.inference(), 0);
});

test("Pi API keys precede env and OpenAI source-aware OAuth cannot substitute Codex auth", async (t) => {
  const providers: string[] = [];
  const h = await fixture(t, { env: { OPENAI_API_KEY: "FIXTURE-ENV" }, registry: {
    async getProviderAuth(provider) { providers.push(provider); return { auth: { apiKey: "FIXTURE-OAUTH" }, source: provider === "openai" ? "OAuth" : "API key" }; },
    isUsingOAuth() { return false; },
  } });
  await h.model("openai direct gpt-6-luna"); await h.command("status");
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "openai", model: "gpt-6-luna" });
  assert.match(h.messages.at(-1)!, /Credentials: environment/);
  await h.model("Pi openai/gpt-6-luna"); assert.match(h.messages.at(-1)!, /OpenAI API key, not openai-codex\/ChatGPT OAuth/);
  const entries = await pickerEntries(h.ctx, { OPENAI_API_KEY: "FIXTURE-ENV" });
  assert.equal(entries.find((entry) => entry.selection.backend === "pi" && entry.selection.provider === "openai")!.authStatus, "missing");
  assert.equal(entries.find((entry) => entry.selection.backend === "openai")!.authStatus, "ok");
  assert.ok(!providers.includes("openai-codex")); assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/);
});

test("all direct and native provider choices require available keys, are atomic and inference-free", async (t) => {
  const h = await fixture(t, { registry: { async getProviderAuth(provider) { return { auth: { apiKey: `FIXTURE-${provider}` }, source: "API key" }; } } });
  for (const [label, selection] of [
    ["typesafe direct jev-latest", { backend: "typesafe", model: "jev-latest" }],
    ["openai direct gpt-6-luna", { backend: "openai", model: "gpt-6-luna" }],
    ["openrouter direct typesafe/jev-1.13", { backend: "openrouter", model: "typesafe/jev-1.13" }],
    ["Pi custom/local", { backend: "pi", provider: "custom", id: "local" }],
  ] as const) {
    await h.model(label); assert.deepEqual((await loadSettings(h.path)).settings.backend, selection);
  }
  await h.model("none"); assert.equal((await loadSettings(h.path)).settings.backend, null);
  assert.equal(h.inference(), 0); assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/);
});

test("request-time Pi key is honoured when the cached OAuth inventory is empty or stale", async (t) => {
  const h = await fixture(t, { registry: { async getProviderAuth() { return { auth: { apiKey: "FIXTURE-PI" }, source: "API key" }; }, isUsingOAuth() { return true; } } });
  await h.model("openai direct gpt-6-luna"); await h.command("status");
  assert.match(h.messages.at(-1)!, /Credentials: Pi-resolved/);
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "openai", model: "gpt-6-luna" });
  assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/);
});

test("RPC Advanced edits shared tuning while Skills owns cadence; cadence is a select, not free text, and legacy keys are refused", async (t) => {
  const h = await fixture(t, { ui: true });
  h.inputs.push("0.625");
  await h.menu("Advanced", row("decision.threshold:"), "Back", "Skills", row("relevance.cadence:"), row("tool-round"), "Back");
  const advanced = h.dialogs.find((dialog) => /Advanced/.test(dialog.title))!.options;
  assert.deepEqual(advanced.slice(2, 5).map((label) => label.split(":")[0]), ["decision.threshold", "decision.chunkSize", "relevance.maxSkills"]);
  assert.ok(advanced.includes("decision.threshold: 0.375")); assert.ok(!advanced.some((label) => label.startsWith("relevance.cadence")));
  const settings = (await loadSettings(h.path)).settings;
  assert.equal(settings.decision.threshold, 0.625); assert.equal(settings.relevance.cadence, "tool-round");
  assert.ok(h.dialogs.some((dialog) => /Run picker/.test(dialog.title) && dialog.options.some((option) => option.startsWith("prompt")) && dialog.options.some((option) => option.startsWith("tool-round"))));
  // Legacy keys exist only as load-time migration inputs; the shared validator refuses them as settings.
  for (const legacy of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.throws(() => updateSetting(defaultSettings(), `relevance.${legacy}`, "1"), /Removed setting.*threshold/, legacy);
  await h.set("relevance.cadence", "every-token"); assert.equal((await loadSettings(h.path)).settings.relevance.cadence, "tool-round", "no option matches: nothing changes");
  await h.set("relevance.maxSkills", "3"); await h.set("decision.chunkSize", "10");
  assert.equal((await loadSettings(h.path)).settings.relevance.maxSkills, 3); assert.equal((await loadSettings(h.path)).settings.decision.chunkSize, 10);
  await h.command("status"); assert.match(h.messages.at(-1)!, /Skills: on · picker tool-round · max 3 added per round/);
  assert.match(h.messages.at(-1)!, /Shared tuning \(Advanced\): threshold 0.625 \(0–1\)/);
});
