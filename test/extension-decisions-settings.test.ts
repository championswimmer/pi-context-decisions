import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import { pickerEntries } from "../src/extension/commands.ts";
import type { CommandContext, ExtensionHost, ExtensionRegistry } from "../src/extension/contracts.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
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
  const pi: ExtensionHost = { on: (() => () => {}) as ExtensionAPI["on"], registerCommand(name, command) { commands.set(name, command); } };
  registerContextDecisions(pi, { settingsPath: path, env: options.env ?? {}, report(_ctx, message) { messages.push(message); } });
  const command = async (args: string) => commands.get("decisions")!.handler(args, ctx as ExtensionCommandContext);
  return { path, messages, dialogs, picks, inputs, lookups, commands, ctx, command, inference: () => inference };
}

test("RPC /decisions menu: direct toggle, provider, model; relevance tuning sits under Advanced…", async (t) => {
  const h = await fixture(t, { ui: true });
  h.picks.push((choices) => choices.find((label) => label.startsWith("Context decisions:")), "Advanced…", "Back", "Done");
  await h.command("");
  assert.deepEqual([...h.commands.keys()], ["decisions"]);
  assert.equal(h.commands.has("context-decisions"), false);
  assert.match(h.dialogs[0].title, /settings/);
  assert.ok(h.dialogs[0].options.some((label) => label.startsWith("Provider / execution:")));
  assert.ok(h.dialogs[0].options.some((label) => label.startsWith("Model:")));
  assert.ok(h.dialogs[0].options.includes("Advanced…") && h.dialogs[0].options.includes("Status"));
  assert.equal(h.dialogs[0].options.filter((label) => label.startsWith("relevance.")).length, 0, "main menu carries no relevance knobs");
  const advanced = h.dialogs.find((dialog) => /Advanced/.test(dialog.title))!;
  assert.ok(advanced.options.includes("relevance.chunkSize: 50"));
  assert.ok(advanced.options.includes("relevance.concurrency: 0 (all batches parallel)"));
  assert.ok(advanced.options.every((label) => !label.startsWith("relevance.pinned")));
  assert.equal((await loadSettings(h.path)).settings.enabled, false);
  assert.equal(h.inputs.length, 0); assert.equal(h.inference(), 0);
});
test("RPC /decisions relevance opens Advanced directly and edits validate", async (t) => {
  const h = await fixture(t, { ui: true });
  h.picks.push((choices) => choices.find((label) => label.startsWith("relevance.chunkSize:")), "Back");
  h.inputs.push("25");
  await h.command("relevance");
  assert.match(h.dialogs[0].title, /Advanced/);
  assert.equal((await loadSettings(h.path)).settings.relevance.chunkSize, 25);
});

test("headless enable/disable, batch size and all-parallel settings persist with bounds", async (t) => {
  const h = await fixture(t);
  await h.command("disable"); await h.command("relevance chunkSize 50"); await h.command("relevance concurrency 0");
  await h.command("relevance relatedThreshold 1.25");
  let settings = (await loadSettings(h.path)).settings;
  assert.equal(settings.enabled, false); assert.equal(settings.relevance.chunkSize, 50); assert.equal(settings.relevance.concurrency, 0);
  assert.equal(settings.relevance.relatedThreshold, 1.25);
  await h.command("relevance chunkSize 51"); assert.match(h.messages.at(-1)!, /integer in \[1, 50\]/);
  await h.command("relevance concurrency 33"); assert.match(h.messages.at(-1)!, /integer in \[0, 32\]/);
  await h.command("enable"); settings = (await loadSettings(h.path)).settings; assert.equal(settings.enabled, true);
  await h.command("status"); assert.match(h.messages.at(-1)!, /all batches parallel/); assert.equal(h.inference(), 0);
});

for (const [provider, model, variable] of [
  ["openai", "gpt-6-luna", "OPENAI_API_KEY"],
  ["typesafe", "jev-latest", "TYPESAFE_API_KEY"],
  ["openrouter", "typesafe/jev-1.13", "OPENROUTER_API_KEY"],
] as const) test(`missing ${provider} credentials never persist or enable an unusable selection`, async (t) => {
  const h = await fixture(t);
  await h.command("disable");
  await h.command(`model ${provider} ${model}`);
  const settings = (await loadSettings(h.path)).settings;
  assert.equal(settings.backend, null); assert.equal(settings.enabled, false);
  assert.match(h.messages.at(-1)!, new RegExp(variable)); assert.match(h.messages.at(-1)!, new RegExp(`/login ${provider}`));
  assert.equal(h.inference(), 0);
});

test("missing-key provider labels include all three direct providers and exact setup guidance", async (t) => {
  const h = await fixture(t);
  await h.command("provider");
  for (const provider of ["openai", "openrouter", "typesafe"]) assert.match(h.messages.at(-1)!, new RegExp(`${provider} · direct API \\[missing key\\]`));
  assert.match(h.messages.at(-1)!, /OPENAI_API_KEY/); assert.match(h.messages.at(-1)!, /OPENROUTER_API_KEY/); assert.match(h.messages.at(-1)!, /TYPESAFE_API_KEY/);
  assert.match(h.messages.at(-1)!, /Pi internal classifier pipeline/);
  assert.equal(h.inference(), 0);
});

test("UI unavailable provider is visibly labelled and rejected before model/persistence", async (t) => {
  const h = await fixture(t, { ui: true });
  h.picks.push((choices) => choices.find((label) => label.startsWith("openrouter · direct API")));
  await h.command("provider");
  assert.match(h.dialogs[0].options.find((label) => label.startsWith("openrouter"))!, /missing key/);
  assert.match(h.messages.at(-1)!, /OPENROUTER_API_KEY.*\/login openrouter/);
  assert.equal(h.dialogs.length, 1); assert.equal((await loadSettings(h.path)).settings.backend, null);
  h.picks.push((choices) => choices.find((label) => label.includes("OpenAI direct")));
  await h.command("model"); assert.match(h.messages.at(-1)!, /OPENAI_API_KEY/);
  assert.equal((await loadSettings(h.path)).settings.backend, null); assert.equal(h.inference(), 0);
});

test("provider UI separates four core workflows, filters models and does not re-enable filtering", async (t) => {
  const h = await fixture(t, { ui: true, registry: { async getProviderAuth(provider) { return { auth: { apiKey: `FIXTURE-${provider}` }, source: "API key" }; } } });
  await h.command("disable");
  h.picks.push((choices) => choices.find((label) => label.startsWith("openrouter · direct API")), (choices) => choices.find((label) => label.includes("openrouter direct typesafe/jev-1.13")));
  await h.command("provider");
  assert.ok(h.dialogs[0].options.some((label) => label.includes("Pi internal classifier pipeline")));
  assert.ok(h.dialogs[0].options.some((label) => label.startsWith("typesafe · direct API")));
  assert.ok(h.dialogs[0].options.some((label) => label.startsWith("openai · direct API")));
  assert.equal(h.dialogs[1].options.filter((label) => label !== "None (no decision calls)").length, OPENROUTER_DECISION_MODELS.length);
  assert.ok(h.dialogs[1].options.every((label) => label === "None (no decision calls)" || label.includes("OpenRouter direct")));
  const settings = (await loadSettings(h.path)).settings;
  assert.deepEqual(settings.backend, { backend: "openrouter", model: "typesafe/jev-1.13" }); assert.equal(settings.enabled, false);
  assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/); assert.equal(h.inference(), 0);
});

test("Pi API keys precede env and OpenAI source-aware OAuth cannot substitute Codex auth", async (t) => {
  const providers: string[] = [];
  const h = await fixture(t, { env: { OPENAI_API_KEY: "FIXTURE-ENV" }, registry: {
    async getProviderAuth(provider) { providers.push(provider); return { auth: { apiKey: "FIXTURE-OAUTH" }, source: provider === "openai" ? "OAuth" : "API key" }; },
    isUsingOAuth() { return false; },
  } });
  await h.command("provider openai"); await h.command("status");
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "openai", model: "gpt-6-luna" });
  assert.match(h.messages.at(-1)!, /Credentials: environment/);
  await h.command("model pi openai gpt-6-luna"); assert.match(h.messages.at(-1)!, /OpenAI API key, not openai-codex\/ChatGPT OAuth/);
  const entries = await pickerEntries(h.ctx, { OPENAI_API_KEY: "FIXTURE-ENV" });
  assert.equal(entries.find((entry) => entry.selection.backend === "pi" && entry.selection.provider === "openai")!.authStatus, "missing");
  assert.equal(entries.find((entry) => entry.selection.backend === "openai")!.authStatus, "ok");
  assert.ok(!providers.includes("openai-codex")); assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/);
});

test("all direct and native provider headless choices require available keys, are atomic and inference-free", async (t) => {
  const h = await fixture(t, { registry: { async getProviderAuth(provider) { return { auth: { apiKey: `FIXTURE-${provider}` }, source: "API key" }; } } });
  for (const [args, selection] of [
    ["provider typesafe", { backend: "typesafe", model: "jev-latest" }],
    ["provider openai", { backend: "openai", model: "gpt-6-luna" }],
    ["provider openrouter typesafe/jev-1.13", { backend: "openrouter", model: "typesafe/jev-1.13" }],
    ["provider pi custom local", { backend: "pi", provider: "custom", id: "local" }],
  ] as const) {
    await h.command(args); assert.deepEqual((await loadSettings(h.path)).settings.backend, selection);
  }
  await h.command("model pi missing unavailable"); assert.match(h.messages.at(-1)!, /not registered/);
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "pi", provider: "custom", id: "local" });
  await h.command("model none"); assert.equal((await loadSettings(h.path)).settings.backend, null);
  assert.equal(h.inference(), 0); assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/);
});

test("request-time Pi key is honoured when the cached OAuth inventory is empty or stale", async (t) => {
  const h = await fixture(t, { registry: { async getProviderAuth() { return { auth: { apiKey: "FIXTURE-PI" }, source: "API key" }; }, isUsingOAuth() { return true; } } });
  await h.command("model openai"); await h.command("status");
  assert.match(h.messages.at(-1)!, /Credentials: Pi-resolved/);
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "openai", model: "gpt-6-luna" });
  assert.doesNotMatch(JSON.stringify(h.messages), /FIXTURE/);
});
