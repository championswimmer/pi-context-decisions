// Optional offline sibling integration (read-only); not part of npm test. Requires its existing dependencies.
// Run: ../pi-subagent-manager/node_modules/.bin/tsx scripts/verify-subagent-manager.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDriverFactory } from "../../pi-subagent-manager/src/orch/runtime.ts";
import { ModelRuntime, ModelRegistry, SessionManager } from "../../pi-subagent-manager/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { defaultSettings, saveSettings } from "../src/settings.ts";

const directory = await mkdtemp(join(tmpdir(), "manager-decisions-"));
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
let driver;
const stderr = [], notifications = [];
const originalError = console.error;
console.error = (...args) => stderr.push(args.join(" "));
try {
  const cwd = join(directory, "workspace"); await mkdir(cwd);
  // Local configured package only: manager discovery skips missing packages, never installs them.
  await writeFile(join(directory, "settings.json"), JSON.stringify({ packages: [fileURLToPath(new URL("../", import.meta.url))] }));
  const settings = defaultSettings();
  await saveSettings({ ...settings, backend: { backend: "pi", provider: "manager-fixture", id: "decider" },
    tools: { ...settings.tools, enabled: true, mode: "mcp", alwaysAllowedMcpServers: ["ext__agent_wait"] } }, join(directory, "pi-context-decisions", "settings.json"));
  // Safe migration warning proves a real v1.1.0 manager receives the report during bind.
  const settingsPath = join(directory, "pi-context-decisions", "settings.json");
  const legacy = JSON.parse(await readFile(settingsPath, "utf8")); legacy.relevance.mode = "choice";
  await writeFile(settingsPath, JSON.stringify(legacy));
  const decisions = [], requests = [], executed = [], events = [];
  const faux = createFauxCore({ provider: "manager-fixture", models: [{ id: "chat" }] });
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  registry.registerProvider("manager-fixture", {
    baseUrl: "http://faux.invalid", api: faux.api, streamSimple: faux.streamSimple,
    classifiers: { "openai-decisions": { async classify(model, context) {
      decisions.push(context);
      return { api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        answers: Object.fromEntries(Object.keys(context.questions).map((id) => [id, { type: "score", score: 0, confidence: 1 }])) };
    } } },
    models: [
      { id: "chat", name: "faux", reasoning: false, input: ["text"], cost, contextWindow: 100000, maxTokens: 4096 },
      { type: "classifier", id: "decider", api: "openai-decisions", name: "faux decider", input: ["text"], cost, contextWindow: 100000 },
    ],
  });
  await runtime.setRuntimeApiKey("manager-fixture", "offline"); await registry.refresh({ allowNetwork: false });
  const model = registry.find("manager-fixture", "chat");
  const ctx = { cwd, sessionManager: SessionManager.create(cwd, join(directory, "root")), modelRegistry: registry,
    model, scopedModels: [{ model }], thinkingLevel: "off", isProjectTrusted: () => false,
    ui: { notify(message, level) { notifications.push({ message, level }); } } };
  const tool = (name) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} },
    async execute() { executed.push(name); return { content: [{ type: "text", text: "ran" }], details: undefined }; } });
  const factory = createDriverFactory(() => ctx, () => "use-current", () => "allowed",
    () => ({ tools: [tool("parent_bridge")], activeNames: ["parent_bridge"] }), () => true);
  const step = (call = false) => (context) => {
    requests.push({ tools: getCurrentTools(context.messages).map((tool) => tool.name) });
    return call ? fauxAssistantMessage([fauxToolCall("agent_wait", {})], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")]);
  };
  faux.setResponses([step(true), step()]);
  driver = await factory({ path: "/root/child", parentPath: "/root",
    type: { name: "worker", description: "offline", systemPrompt: "child", tools: { allow: ["agent_wait", "parent_bridge"] } },
    inherited: [], tools: [tool("agent_wait")], onEvent: (event) => events.push(event), shouldPause: () => false, signal: new AbortController().signal });
  const diagnostics = events.filter((event) => event.kind === "diagnostic");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].diagnostic.source, "pi-context-decisions");
  assert.equal(diagnostics[0].diagnostic.level, "warning");
  assert.match(diagnostics[0].diagnostic.message, /Choice scoring was removed/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Diagnostic from \/root\/child/);
  assert.deepEqual(stderr, [], "hosted diagnostics must not write to the parent's stderr");
  await driver.prompt("REAL MANAGER CHILD TASK");
  assert.deepEqual(executed, ["agent_wait"]);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].state.task, "REAL MANAGER CHILD TASK");
  assert.deepEqual(Object.values(decisions[0].state.servers).map((entry) => entry.name), ["ext__subagent_inherited_tools"]);
  assert.ok(requests[0].tools.includes("agent_wait")); assert.ok(!requests[0].tools.includes("parent_bridge"));
  assert.deepEqual(events.filter((event) => event.kind === "error"), []);
  await driver.dispose(); driver = undefined;
  assert.deepEqual(stderr, []);
  console.log("PASS real createDriverFactory: configured package discovery, v1.1.0 diagnostics in parent UI/events (no stderr), child task classification, pinned agent_wait execution, bridge withheld, shutdown");
} finally {
  try { await driver?.dispose(); }
  finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
