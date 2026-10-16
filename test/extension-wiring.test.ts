import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advertised, deltaMessages, simHost } from "./helpers/pi-sim.ts";
import { readLedger } from "../src/extension/skill-ledger.ts";
import contextDecisions from "../src/extension.ts";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionDependencies, ExtensionRegistry } from "../src/extension/contracts.ts";
import { pickerEntries } from "../src/extension/commands.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import { DecisionError } from "../src/decision/errors.ts";
import type { DecisionRequest, DecisionResponse } from "../src/decision/types.ts";
import { OPENROUTER_DECISION_MODELS } from "../src/catalog/openrouter-models.ts";
import { setModel, setSetting } from "./helpers/settings-ui.ts";

const host = () => simHost();
function answer(request: DecisionRequest): DecisionResponse {
  return { answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === "score" ? { type: "score", score: id === "s0" ? 2 : 0 } : q.type === "bool" ? { type: "bool", probability: 1 } : { type: "choice", choice: id === "s0" ? "directly_relevant" : "irrelevant" }])), usage: { inputTokens: 3 } };
}
function context(overrides: Partial<ExtensionRegistry> = {}, hasUI = false) {
  const notifications: { text: string; level?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const dialogs: { title: string; options?: string[] }[] = [];
  const selections: (string | undefined | ((options: string[]) => string))[] = [];
  const inputs: (string | undefined)[] = [];
  const classifiers = [{ provider: "custom", id: "nested/model", name: "Custom" }, { provider: "openrouter", id: "typesafe/jev-1.13", name: "Jev" }];
  let calls = 0;
  const registry: ExtensionRegistry = {
    getModelsOfType(type, provider) { return type === "chat" ? [{ provider: "openai", id: "chat" }] : classifiers.filter((model) => !provider || model.provider === provider); },
    findOfType(_type, provider, id) { return classifiers.find((model) => model.provider === provider && model.id === id); },
    async getApiKeyForProvider(provider) { return provider === "custom" ? "FIXTURE-CUSTOM-KEY" : undefined; },
    getProviderAuthStatus(provider) { return { configured: provider === "custom" }; },
    isUsingOAuth() { return false; },
    async classify(_model, request) { calls++; return { answers: answer(request).answers, usage: { input: 3 }, stopReason: "stop" }; },
    ...overrides,
  };
  const ctx: CommandContext = { hasUI, mode: hasUI ? "tui" : "print", modelRegistry: registry,
    ui: {
      async select(title, options) { dialogs.push({ title, options }); const choice = selections.shift(); return typeof choice === "function" ? choice(options) : choice; },
      async input(title) { dialogs.push({ title }); return inputs.shift(); },
      notify(text, level) { notifications.push({ text, level }); },
      setStatus(_key, text) { statuses.push(text); },
    },
  };
  return { ctx, notifications, statuses, dialogs, selections, inputs, calls: () => calls };
}
function event(count = 8) {
  const skills = Array.from({ length: count }, (_, i) => ({ name: `skill-${i}`, description: `Description ${i}`, filePath: `/private/${i}/SKILL.md`, baseDir: `/private/${i}`, sourceInfo: { path: `/private/${i}/SKILL.md`, source: "fixture", scope: "project" as const, origin: "top-level" as const }, disableModelInvocation: false }));
  return { type: "before_agent_start", prompt: "Fixture task", systemPrompt: "unchanged",
    systemPromptOptions: { cwd: "/fixture", skills, selectedTools: ["read", "bash"], sections: { mcp_servers: "untouched" }, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "append", contextFiles: [] },
  } satisfies BeforeAgentStartEvent;
}
async function setup(t: { after(fn: () => Promise<void>): void }, deps: Partial<ExtensionDependencies> = {}, configured = false) {
  const root = await mkdtemp(join(tmpdir(), "context-extension-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  if (configured) await saveSettings({ ...defaultSettings(), backend: { backend: "pi", provider: "custom", id: "nested/model" } }, path);
  const h = host(); const messages: { text: string; level?: string }[] = [];
  registerContextDecisions(h.pi, { settingsPath: path, env: {}, report(_ctx, text, level) { messages.push({ text, level }); }, ...deps });
  return { ...h, path, messages };
}

test("real entry factory registers one command and seven hooks (two for opt-in tool filtering), no custom provider or tools", async () => {
  const h = host(); contextDecisions(h.pi as ExtensionAPI);
  assert.deepEqual([...h.commands.keys()], ["decisions"]);
  assert.equal(h.commands.has("context-decisions"), false);
  assert.deepEqual([...h.handlers.keys()], ["session_start", "session_tree", "session_shutdown", "before_agent_start", "turn_end", "tool_call", "agent_end"]);
  // The dialog owns every setting: only status/history, the paid self-test, read-only listings and the legacy pin list remain as arguments.
  assert.deepEqual((await h.commands.get("decisions")!.getArgumentCompletions!(""))!.map((item) => item.value), ["status", "history", "test", "tools", "mcp", "pin", "unpin"]);
  assert.equal(await h.commands.get("decisions")!.getArgumentCompletions!("mo"), null);
});
test("real Pi context registry is type-compatible without a cast in production", () => {
  // Compiled by npm run typecheck against the installed peer types.
  const verify = (ctx: ExtensionContext) => { const narrow: CommandContext = ctx; return narrow; };
  assert.equal(typeof verify, "function");
});
test("startup defaults perform no auth or inference and do not mutate advertisements", async (t) => {
  const h = await setup(t); const c = context({ getApiKeyForProvider() { throw new Error("Auth must not run"); } }, true);
  await h.emit("session_start", { type: "session_start", reason: "startup" }, c.ctx);
  const e = event(); const original = e.systemPromptOptions.skills;
  await h.emit("before_agent_start", e, c.ctx);
  assert.equal(c.calls(), 0); assert.equal(e.systemPromptOptions.skills, original, "the unchanged inventory keeps Pi's own array"); assert.match(c.statuses[0]!, /select model/);
  assert.deepEqual(deltaMessages(h.session), [], "unconfigured advertises everything through the base: no delta");
  assert.deepEqual([...readLedger(h.session).base].sort(), original.map((skill) => skill.name).sort(), "the branch remembers that every skill was advertised");
  await h.command("", { ...c.ctx, hasUI: false }); assert.match(h.messages.at(-1)!.text, /Context decisions: enabled; not configured/);
});
test("RPC native selection persists, filters through real core, only skills mutate, later handler observes", async (t) => {
  const h = await setup(t); const c = context(); await setModel(h.command, c.ctx, "Pi custom/nested/model");
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "pi", provider: "custom", id: "nested/model" });
  const e = event(); const original = e.systemPromptOptions.skills; const before = { ...e.systemPromptOptions };
  let observed: unknown;
  h.pi.on("before_agent_start", (evt) => { observed = evt.systemPromptOptions.skills; });
  await h.emit("before_agent_start", e, c.ctx);
  assert.equal(c.calls(), 1); assert.equal(observed, e.systemPromptOptions.skills);
  // The system prompt carries only the stable base (no pins); the selection arrives as an append-only delta.
  assert.deepEqual(e.systemPromptOptions.skills, []);
  assert.deepEqual(advertised(h, original, e.systemPromptOptions.skills), ["skill-0"]);
  assert.equal(deltaMessages(h.session).length, 1);
  assert.equal(e.systemPrompt, "unchanged");
  for (const key of Object.keys(before).filter((key) => key !== "skills") as (keyof typeof before)[]) assert.equal(e.systemPromptOptions[key], before[key]);
  await h.command("status", c.ctx); assert.match(h.messages.at(-1)!.text, /filtered, \+1 of 8 candidates, 1 advertised/); assert.match(h.messages.at(-1)!.text, /inputTokens/);
});
test("30-skill hook respects persisted decimal thresholds and batch settings via the RPC settings menus", async (t) => {
  const batches: number[] = [];
  const h = await setup(t, { createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide(request) {
    const metadata = request.state.skills as Record<string, { name: string; description: string }>;
    batches.push(Object.keys(metadata).length);
    assert.doesNotMatch(JSON.stringify(request), /private|filePath|baseDir|sourceInfo/);
    return { answers: Object.fromEntries(Object.entries(metadata).map(([id, skill]) => [id, { type: "score", score: Number(skill.name.slice(6)) % 2 === 0 ? 1.2 : 1.8 }])) };
  } }); } }, true);
  const c = context();
  await setSetting(h.command, c.ctx, "relevance.chunkSize", "5");
  await setSetting(h.command, c.ctx, "relevance.maxSkills", "30");
  await setSetting(h.command, c.ctx, "relevance.threshold", "0.625");
  const e = event(30); const original = e.systemPromptOptions.skills;
  await h.emit("before_agent_start", e, c.ctx);
  assert.deepEqual(batches, [5, 5, 5, 5, 5, 5]);
  assert.deepEqual(advertised(h, original, e.systemPromptOptions.skills), original.filter((_, i) => i % 2 === 1).map((skill) => skill.name));
  assert.equal((await loadSettings(h.path)).settings.relevance.threshold, 0.625);
  await h.command("status", c.ctx); assert.match(h.messages.at(-1)!.text, /threshold 0.625 \(0–1\).*shard 5/s);
  await setSetting(h.command, c.ctx, "relevance.threshold", "1.6");
  assert.equal(h.messages.at(-1)!.level, "error");
  assert.equal((await loadSettings(h.path)).settings.relevance.threshold, 0.625);
});
test("disable, relevance-off, unconfigured, below-minimum and empty prompt make zero calls", async (t) => {
  const h = await setup(t, {}, true); const c = context();
  await setSetting(h.command, c.ctx, "enabled"); const disabled = event(); const original = disabled.systemPromptOptions.skills;
  await h.emit("before_agent_start", disabled, c.ctx); assert.equal(disabled.systemPromptOptions.skills, original);
  assert.deepEqual([...readLedger(h.session).base].sort(), original.map((skill) => skill.name).sort(), "disabled advertises everything and the branch remembers it");
  await setSetting(h.command, c.ctx, "enabled"); await setSetting(h.command, c.ctx, "relevance.enabled"); await h.emit("before_agent_start", event(), c.ctx);
  await setSetting(h.command, c.ctx, "relevance.enabled"); await h.emit("before_agent_start", event(2), c.ctx);
  const empty = event(); empty.prompt = " "; await h.emit("before_agent_start", empty, c.ctx);
  await setModel(h.command, c.ctx, "none"); await h.emit("before_agent_start", event(), c.ctx); assert.equal(c.calls(), 0);
});
test("all static-ten direct IDs are selectable through the RPC model menu, with no ranking/discovery or inference calls", async (t) => {
  const h = await setup(t); const c = context({ async getApiKeyForProvider() { return "FIXTURE-ROUTER-KEY"; } });
  for (const { id } of OPENROUTER_DECISION_MODELS) { await setModel(h.command, c.ctx, `openrouter direct ${id}`); assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "openrouter", model: id }); }
  assert.equal(c.calls(), 0);
});
test("picker restricts router entries, preserves native classifiers, and marks auth/OAuth correctly", async () => {
  let lookups: string[] = [];
  const c = context({
    getModelsOfType(type) { return type === "chat" ? [{ provider: "openai", id: "chat" }] : [{ provider: "openrouter", id: "typesafe/jev-1.13" }, { provider: "openrouter", id: "respan/span-01" }, { provider: "openai", id: "gpt-6-luna" }, { provider: "local", id: "model" }]; },
    isUsingOAuth() { return true; },
    async getApiKeyForProvider(provider) { lookups.push(provider); return provider === "openrouter" ? "FIXTURE-KEY" : undefined; },
  });
  const entries = await pickerEntries(c.ctx, { OPENAI_API_KEY: "FIXTURE-ENV" });
  assert.equal(entries.filter((entry) => entry.selection.backend === "openrouter").length, OPENROUTER_DECISION_MODELS.length);
  assert.ok(!entries.some((entry) => entry.selection.backend === "pi" && entry.selection.id === "respan/span-01"));
  assert.equal(entries.find((entry) => entry.selection.backend === "pi" && entry.selection.provider === "openai")!.authStatus, "missing");
  assert.equal(entries.find((entry) => entry.selection.backend === "openai")!.authStatus, "ok"); assert.ok(!lookups.includes("openai"));
  assert.doesNotMatch(JSON.stringify(entries), /FIXTURE/);
});
test("UI picker uses static entries, supports cancellation and None without writes/inference", async (t) => {
  const h = await setup(t); const c = context({ async getApiKeyForProvider(provider) { return provider === "openrouter" ? "FIXTURE-ROUTER-KEY" : undefined; } }, true); c.selections.push(undefined);
  const modelRow = (options: string[]) => options.find((option) => option.startsWith("Model:"))!;
  c.selections.splice(0, 1, "Advanced", modelRow, undefined, "Back", "Done"); // open the model picker, cancel it
  await h.command("", c.ctx); assert.equal(c.dialogs.length, 5); assert.equal(c.calls(), 0); assert.equal((await loadSettings(h.path)).settings.backend, null);
  c.selections.push("Advanced", modelRow, (options) => options.find((option) => option.includes("openrouter direct typesafe/jev-1.13"))!, "Done");
  await h.command("", c.ctx); assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "openrouter", model: "typesafe/jev-1.13" });
  c.selections.push("Advanced", modelRow, "None (no decision calls)", "Back", "Done"); await h.command("", c.ctx); assert.equal((await loadSettings(h.path)).settings.backend, null);
  assert.ok(c.dialogs[2].options!.every((option) => !option.includes("respan")));
});
test("headless pins work and RPC settings updates persist or fail validation", async (t) => {
  const h = await setup(t); const c = context();
  await setSetting(h.command, c.ctx, "relevance.maxSkills", "2"); await setSetting(h.command, c.ctx, "relevance.failMode", "open");
  await h.command("pin skill-3", c.ctx); await h.command("pin skill-3", c.ctx); assert.deepEqual((await loadSettings(h.path)).settings.relevance.pinned, ["skill-3"]);
  await h.command("unpin skill-3", c.ctx); assert.deepEqual((await loadSettings(h.path)).settings.relevance.pinned, []);
  assert.equal((await loadSettings(h.path)).settings.relevance.maxSkills, 2); assert.equal((await loadSettings(h.path)).settings.relevance.failMode, "open");
  await setSetting(h.command, c.ctx, "relevance.timeoutMs", "300001"); assert.equal(h.messages.at(-1)!.level, "error");
});
test("UI settings dialog validation, cancellation and boolean edit share persisted config", async (t) => {
  const h = await setup(t); const c = context({}, true);
  c.selections.push("Advanced", (options) => options.find((option) => option.startsWith("relevance.chunkSize:"))!, "Back", "Skills", (options) => options.find((option) => option.startsWith("relevance.enabled:"))!, "Back", "Done");
  c.inputs.push("999"); await h.command("", c.ctx);
  assert.ok(h.messages.some((message) => message.level === "error")); assert.equal((await loadSettings(h.path)).settings.relevance.enabled, false);
  c.selections.push(undefined); await h.command("", c.ctx); assert.equal(c.calls(), 0);
});
test("failed persistence does not change in-memory selection or behavior; queue recovers", async (t) => {
  let fail = true;
  const h = await setup(t, { async save(settings, path) { if (fail) throw new Error("SECRET-FIXTURE"); await saveSettings(settings, path); } }, true);
  const c = context(); await setSetting(h.command, c.ctx, "enabled"); assert.equal(h.messages.at(-1)!.text, "Context-decisions operation failed");
  await h.emit("before_agent_start", event(), c.ctx); assert.equal(c.calls(), 1);
  fail = false; await setSetting(h.command, c.ctx, "enabled"); await h.emit("before_agent_start", event(), c.ctx); assert.equal(c.calls(), 1);
});
test("parallel settings updates serialize without dropping other changes", async (t) => {
  const h = await setup(t); const c = context();
  await Promise.all([h.command("pin one", c.ctx), h.command("pin two", c.ctx), setSetting(h.command, c.ctx, "relevance.maxSkills", "3")]);
  const loaded = (await loadSettings(h.path)).settings; assert.deepEqual(loaded.relevance.pinned, ["one", "two"]); assert.equal(loaded.relevance.maxSkills, 3);
});
test("provider failure hides advertisements by default, explicitly configured open retains them", async (t) => {
  const h = await setup(t, { createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide() { throw new Error("SECRET-FIXTURE private prompt"); } }); } }, true);
  const c = context({}, true); const closed = event(); const closedInventory = closed.systemPromptOptions.skills;
  await h.emit("before_agent_start", closed, c.ctx); assert.deepEqual(advertised(h, closedInventory, closed.systemPromptOptions.skills), []);
  assert.match(c.statuses.at(-1)!, /fail-closed.*network/); assert.doesNotMatch(JSON.stringify(h.messages), /SECRET-FIXTURE|private prompt/);
  await setSetting(h.command, c.ctx, "relevance.failMode", "open"); const open = event(); const original = open.systemPromptOptions.skills; await h.emit("before_agent_start", open, c.ctx);
  assert.deepEqual(advertised(h, original, open.systemPromptOptions.skills), original.map((skill) => skill.name), "fail-open adds every remaining skill, once"); assert.match(c.statuses.at(-1)!, /fail-open/);
  assert.equal(deltaMessages(h.session).length, 1);
});
test("malformed decisions and missing current native registry entries fail closed", async (t) => {
  const h = await setup(t, {}, true); const c = context({ async classify() { return { answers: {}, stopReason: "stop" }; } }); const e = event();
  await h.emit("before_agent_start", e, c.ctx); assert.equal(e.systemPromptOptions.skills.length, 0);
  const missing = context({ findOfType() { return undefined; } }); const next = event(); await h.emit("before_agent_start", next, missing.ctx); assert.equal(next.systemPromptOptions.skills.length, 0);
  assert.match(h.messages.at(-1)!.text, /config/);
});
test("stale persisted model produces explicit startup/status error and fail-closed even below gate", async (t) => {
  const h = await setup(t); const c = context({}, true);
  await writeFile(h.path, JSON.stringify({ ...defaultSettings(), backend: { backend: "openrouter", model: "respan/span-01" } }));
  await h.emit("session_start", { type: "session_start", reason: "startup" }, c.ctx); assert.match(h.messages.at(-1)!.text, /outside the checked-in top ten/);
  const e = event(2); await h.emit("before_agent_start", e, c.ctx); assert.equal(e.systemPromptOptions.skills.length, 0); assert.equal(c.calls(), 0);
  await h.command("status", c.ctx); assert.match(h.messages.at(-1)!.text, /Settings error/);
  await setModel(h.command, c.ctx, "Pi custom/nested/model"); const repaired = event(); await h.emit("before_agent_start", repaired, c.ctx); assert.equal(c.calls(), 1);
});
for (const failure of ["invalid-persisted", "missing-native"] as const) {
  for (const [description, prompt] of [
    ["empty prompt", "   "],
    ["argument-free expanded /skill", '<skill name="explicit" location="/private/explicit/SKILL.md">\nPRIVATE-SKILL-BODY\n</skill>'],
  ] as const) test(`${failure} configuration closes ads before ${description} skips without provider calls`, async (t) => {
    const h = await setup(t, {}, failure === "missing-native");
    if (failure === "invalid-persisted") {
      await writeFile(h.path, JSON.stringify({ ...defaultSettings(), backend: { backend: "openrouter", model: "unlisted/fixture" } }));
    } else {
      await saveSettings({ ...defaultSettings(), backend: { backend: "pi", provider: "custom", id: "nested/model" }, relevance: { ...defaultSettings().relevance, failMode: "open", pinned: ["skill-0"] } }, h.path);
    }
    let authCalls = 0;
    const c = context({
      findOfType() { return undefined; },
      async getApiKeyForProvider() { authCalls++; throw new Error("No provider lookup expected"); },
    }, true);
    const e = event(); e.prompt = prompt;
    e.systemPromptOptions.skills[1].disableModelInvocation = true;
    const original = e.systemPromptOptions.skills;
    const options = { ...e.systemPromptOptions };
    await h.emit("before_agent_start", e, c.ctx);
    assert.deepEqual(e.systemPromptOptions.skills, failure === "missing-native" ? [original[0], original[1]] : [original[1]]);
    assert.equal(e.systemPromptOptions.skills[0], failure === "missing-native" ? original[0] : original[1]);
    assert.equal(c.calls(), 0); assert.equal(authCalls, 0);
    assert.match(h.messages.at(-1)!.text, /fail-closed \(config\)/);
    assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE-SKILL-BODY|\/private\/explicit/);
    assert.equal(e.prompt, prompt); assert.equal(e.systemPrompt, "unchanged");
    for (const key of Object.keys(options).filter((key) => key !== "skills") as (keyof typeof options)[]) assert.equal(e.systemPromptOptions[key], options[key]);
    await h.command("status", c.ctx);
    if (failure === "invalid-persisted") assert.match(h.messages.at(-1)!.text, /fail-closed, \+0 of 7 candidates.*\(config\)/);
  });
}
test("whole filter timeout hides ads with timeout status and shutdown cancels ignored signals", async (t) => {
  let started!: () => void; let ready = new Promise<void>((resolve) => { started = resolve; });
  const h = await setup(t, { createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide() { started(); return new Promise(() => {}); } }); } }, true);
  const c = context({}, true); await setSetting(h.command, c.ctx, "relevance.timeoutMs", "5"); const timed = event(); await h.emit("before_agent_start", timed, c.ctx);
  assert.equal(timed.systemPromptOptions.skills.length, 0); assert.match(c.statuses.at(-1)!, /timeout/);
  await setSetting(h.command, c.ctx, "relevance.timeoutMs", "1000"); ready = new Promise((resolve) => { started = resolve; });
  const e = event(); const pending = h.emit("before_agent_start", e, c.ctx); await ready;
  await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, c.ctx); await pending;
  assert.equal(e.systemPromptOptions.skills.length, 0); assert.equal(c.statuses.at(-1), undefined);
});
test("caller abort returns aborted failure, never reports successful selection", async (t) => {
  const h = await setup(t, {}, true); const c = context({}, true); const abort = new AbortController(); abort.abort(); c.ctx.signal = abort.signal;
  const e = event(); await h.emit("before_agent_start", e, c.ctx); assert.equal(c.calls(), 0); assert.match(c.statuses.at(-1)!, /aborted/);
});
test("session reload reads repaired disk settings and clears prior diagnostic state", async (t) => {
  const h = await setup(t, {}, true); const c = context({}, true); await h.emit("before_agent_start", event(), c.ctx);
  await saveSettings({ ...defaultSettings(), enabled: false }, h.path);
  await h.emit("session_start", { type: "session_start", reason: "reload" }, c.ctx); assert.equal(c.statuses.at(-1), "off");
  await h.command("status", c.ctx); assert.doesNotMatch(h.messages.at(-1)!.text, /Last:/);
});
test("synthetic test command is explicit, gated by selection and uses fixed bool state", async (t) => {
  let payload: DecisionRequest | undefined;
  const h = await setup(t, { createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide(request) { payload = request; return answer(request); } }); } });
  const c = context(); await h.command("test", c.ctx); assert.equal(payload, undefined);
  await setModel(h.command, c.ctx, "Pi custom/nested/model"); await h.command("test", c.ctx);
  assert.deepEqual(payload!.state, { task: "Synthetic extension self-test" }); assert.equal(payload!.questions.q.type, "bool"); assert.match(h.messages.at(-1)!.text, /probability 1/);
});
test("shutdown also cancels explicit synthetic calls from idle commands", async (t) => {
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const h = await setup(t, { createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide() { started(); return new Promise(() => {}); } }); } }, true);
  const c = context(); const pending = h.command("test", c.ctx); await ready;
  await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, c.ctx); await pending;
  assert.match(h.messages.at(-1)!.text, /aborted/); assert.ok(!h.messages.some((message) => message.text.includes("Synthetic bool test: probability")));
});
test("direct OpenAI status uses env when OAuth active, never displays tokens", async (t) => {
  const h = await setup(t, { env: { OPENAI_API_KEY: "SECRET-FIXTURE" } });
  const c = context({ isUsingOAuth() { return true; }, getApiKeyForProvider() { throw new Error("OAuth bearer must not resolve"); } });
  await setModel(h.command, c.ctx, "openai direct gpt-6-luna"); await h.command("status", c.ctx);
  assert.match(h.messages.at(-1)!.text, /Credentials: environment/); assert.doesNotMatch(JSON.stringify(h.messages), /SECRET-FIXTURE/);
  assert.equal(JSON.parse(await readFile(h.path, "utf8")).backend.model, "gpt-6-luna");
});
