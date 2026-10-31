// Offline manager-shaped child: real file-loaded extension, AgentSession and faux chat/classifier providers.
// The sibling manager is deliberately not a test dependency; this pins its Pi 1.1.0 construction contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type ClassifierContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, createSyntheticSourceInfo, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { classifyTools } from "../src/apps/tool-inventory.ts";
import { defaultSettings, saveSettings } from "../src/settings.ts";

const managerNames = ["agent_types", "agent_spawn", "agent_wait", "agent_steer", "agent_status", "agent_update", "agent_pause", "agent_stop", "agent_output"];
for (const mode of ["tools", "mcp"] as const) for (const pinBridge of [false, true]) {
  test(`manager-shaped child: ${mode}, bridge ${pinBridge ? "pinned" : "filtered"}`, { timeout: 20000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "decisions-child-"));
    const agentDir = join(root, "agent"); await mkdir(agentDir);
    const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
    const settings = defaultSettings();
    await saveSettings({ ...settings, backend: { backend: "pi", provider: "child-fixture", id: "decider" },
      tools: { ...settings.tools, enabled: true, mode, allowSubagentInheritedTools: pinBridge, alwaysAllowedTools: managerNames.filter((name) => name !== "agent_wait"),
        alwaysAllowedMcpServers: ["ext__agent_wait"] } }, join(agentDir, "pi-context-decisions", "settings.json"));
    // A startup warning in a real embedded SDK child must remain visible: historical ownership
    // cannot justify suppression. The same warning is deduplicated if startup is repeated.
    const settingsPath = join(agentDir, "pi-context-decisions", "settings.json");
    const legacy = JSON.parse(await readFile(settingsPath, "utf8")); legacy.relevance.mode = "choice";
    await writeFile(settingsPath, JSON.stringify(legacy));
    const stderr: string[] = []; t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args.join(" ")));
    const decisions: ClassifierContext[] = [], executed: string[] = [], events: string[] = [];
    let pendingStarted!: () => void, pendingAborted = false;
    const pending = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const tool = (name: string, exposure: "direct" | "deferred" = "direct"): ToolDefinition => ({
      name, label: name, description: `Does ${name}`, exposure, parameters: { type: "object", properties: {} } as never,
      async execute(_id, _args, _signal, _update, ctx) {
        executed.push(name);
        if (name === "agent_wait" && pinBridge) await ctx.executeTool("parent_bridge", {});
        return { content: [{ type: "text", text: `${name} ran` }], details: undefined };
      },
    });
    const faux = createFauxCore({ provider: "child-fixture", models: [{ id: "chat" }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("child-fixture", { apiKey: "offline-fixture", baseUrl: "http://faux.invalid", api: faux.api, streamSimple: faux.streamSimple,
      classifiers: { "openai-decisions": { async classify(model, context, options) {
        decisions.push(structuredClone(context));
        if (context.state.task === "SHUTDOWN TASK") {
          assert.ok(options?.signal);
          return await new Promise<never>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => { pendingAborted = true; reject(new Error("fixture aborted")); }, { once: true });
            pendingStarted();
          });
        }
        return { provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: Date.now(),
          answers: Object.fromEntries(Object.keys(context.questions).map((id) => [id, { type: "score" as const, score: 0, confidence: 1 }])) };
      } } },
      models: [{ id: "chat", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 },
        { type: "classifier", id: "decider", name: "offline decider", input: ["text"], api: "openai-decisions", contextWindow: 100000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }, { projectTrusted: false });
    let pi!: ExtensionAPI;
    const sourceInfo = createSyntheticSourceInfo("<subagent-inherited-tools>", { source: "sdk" });
    const bridge = tool("parent_bridge", "deferred"), directBridge = tool("parent_direct");
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
      noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionsOverride(base) {
        base.extensions.push({ path: sourceInfo.path, resolvedPath: sourceInfo.path, sourceInfo, handlers: new Map(), tools: new Map([bridge, directBridge].map((definition) => [definition.name, { definition, sourceInfo }])),
          messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() });
        return base;
      },
      extensionFactories: [{ name: "child-probe", factory: (api) => {
        pi = api;
        api.registerTool(tool("optional_child_tool", "deferred"));
        const observe = (event: ExtensionEvent, ctx: ExtensionContext) => {
          assert.equal(ctx.hasUI, false); assert.equal(ctx.mode, "print"); events.push(event.type);
          if (event.type === "before_agent_start") assert.deepEqual(event.systemPromptOptions.skills, []);
        };
        api.on("session_start", observe); api.on("before_agent_start", observe); api.on("turn_end", observe);
        api.on("tool_call", observe); api.on("session_shutdown", observe);
      } }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getExtensions().extensions.some((ext) => ext.commands.has("decisions")), "actual package entry loaded from file despite noExtensions");
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendCustomEntry("pi-subagent:thread:v1", { rootId: "root-fixture", threadPath: "/child", inheritedCount: 0 });
    const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, sessionManager, modelRuntime: runtime,
      model: runtime.getModel("child-fixture", "chat")!, customTools: managerNames.map((name) => tool(name)) });
    t.after(() => session.dispose());
    const errors: unknown[] = []; session.extensionRunner.onError((error) => errors.push(error));
    await session.bindExtensions({ mode: "print" });
    assert.match(stderr.join("\n"), /Choice scoring was removed/, "first failure/warning from a live child is visible");
    const initialReports = stderr.length;
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    assert.equal(stderr.length, initialReports, "repeated automatic warnings from a live child do not flood stderr");
    // Like the manager, restore the child loadout after bind; filtering acts at the next boundary.
    session.setActiveToolsByName(["read", "bash", "edit", "write", ...managerNames, "parent_direct"]);
    const infos = pi.getAllTools();
    for (const name of managerNames) assert.deepEqual(infos.find((info) => info.name === name)!.sourceInfo,
      { path: `<sdk:${name}>`, source: "sdk", scope: "temporary", origin: "top-level", baseDir: undefined });
    // DefaultResourceLoader.applyExtensionSourceInfo normalizes the synthetic path after extensionsOverride.
    assert.deepEqual(infos.find((info) => info.name === "parent_bridge")!.sourceInfo,
      { path: "<subagent-inherited-tools>", source: "subagent-inherited-tools", scope: "temporary", origin: "top-level" });
    const inventory = classifyTools(infos);
    for (const name of managerNames) assert.equal(inventory.byName.get(name)!.group, `ext__${name}`);
    assert.equal(inventory.byName.get("parent_bridge")!.group, "ext__subagent_inherited_tools");
    assert.equal(inventory.byName.get("parent_bridge")!.kind, "extension");
    assert.equal(inventory.byName.get("parent_direct")!.group, "ext__subagent_inherited_tools");
    const requests: { declared: string[]; text: string }[] = [];
    const step = (calls = false) => (ctx: TranscriptContext) => {
      requests.push({ declared: getCurrentTools(ctx.messages).map((tool) => tool.name), text: JSON.stringify(ctx.messages) });
      return calls ? fauxAssistantMessage([fauxToolCall("agent_spawn", {}), fauxToolCall("agent_wait", {})], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")]);
    };
    faux.setResponses([step(true), step()]);
    await session.prompt("CHILD USER TASK", { expandPromptTemplates: false });
    assert.deepEqual(executed.sort(), ["agent_spawn", "agent_wait", ...(pinBridge ? ["parent_bridge"] : [])].sort(), "pinned SDK tools (and pinned nested bridge) execute");
    assert.ok(requests.every((request) => managerNames.every((name) => request.declared.includes(name))));
    assert.equal(requests[0].declared.includes("parent_direct"), pinBridge, "direct bridge is withheld before the first request unless pinned");
    assert.equal(session.getActiveToolNames().includes("parent_direct"), pinBridge);
    assert.equal(decisions.length, 1, "empty skills make no calls; only unpinned tools/groups are scored");
    assert.equal(decisions[0].state.task, "CHILD USER TASK");
    assert.equal(decisions[0].state.skills, undefined);
    const metadata = (decisions[0].state.tools ?? decisions[0].state.servers) as Record<string, { name: string }>;
    assert.deepEqual(Object.values(metadata).map((entry) => entry.name).sort(),
      [mode === "tools" ? "optional_child_tool" : "ext__child_probe", ...(!pinBridge ? (mode === "tools" ? ["parent_bridge", "parent_direct"] : ["ext__subagent_inherited_tools"]) : [])].sort());
    assert.doesNotMatch(JSON.stringify(decisions), /<sdk:|<subagent-inherited-tools>|parameters/);
    const gate = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "parent_bridge", toolCallId: "bridge", input: {} });
    assert.equal(gate?.block ?? false, !pinBridge, "indirect bridge is gated unless globally pinned");
    assert.match(requests[0].text, /Tool availability/, "headless notices reach the model transcript");
    if (pinBridge) assert.match(requests[0].text, /extensions: ext__subagent_inherited_tools/);
    assert.ok(events.includes("session_start") && events.includes("before_agent_start") && events.includes("turn_end") && events.includes("tool_call"));
    // Real SDK dispose does not emit this event; manager explicitly awaits it before invalidating contexts.
    if (!pinBridge) {
      faux.setResponses([step()]);
      const running = session.prompt("SHUTDOWN TASK");
      await pending;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.equal(pendingAborted, true, "manual shutdown cancels the real classifier request before dispose invalidates ctx");
      await running;
    } else {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.equal(events.at(-1), "session_shutdown");
    }
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); // cleanup is idempotent
    assert.deepEqual(errors, []);
    session.dispose();
  });
}
