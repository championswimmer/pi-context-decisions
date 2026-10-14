// Opt-in tool/MCP filtering against the REAL Pi 1.1.0 AgentSession, fully offline: a faux provider answers model
// requests, an in-memory SessionManager records what Pi really persists, and the decision client is injected.
// The declared tool set of every request is computed with pi-ai's public `getCurrentTools(messages)`, which folds the
// transcript's `toolsAdded`/`toolsRemoved` system-message deltas exactly as providers do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import { readDecisionsHistory } from "../src/extension/decisions-history.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import { defaultSettings, defaultToolSettings, saveSettings, type ToolFilterSettings } from "../src/settings.ts";

const schema = { type: "object", properties: {}, additionalProperties: true } as never;
type ToolSpec = { name: string; exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden"; namespace?: { name: string; description?: string }; run?: () => string };
/** Registers fixed test tools the way an ordinary extension does. */
const toolsExtension = (specs: ToolSpec[]) => (pi: ExtensionAPI) => {
  for (const spec of specs) {
    pi.registerTool({ name: spec.name, label: spec.name, description: `Does ${spec.name}`, parameters: schema, exposure: spec.exposure ?? "direct", ...(spec.namespace ? { namespace: spec.namespace } : {}),
      async execute() { return { content: [{ type: "text", text: spec.run?.() ?? `${spec.name} ran` }], details: {} }; } } as never);
  }
};
const CORE = ["read", "bash", "edit", "write"];
const TOOL_CALL = (name: string, args: Record<string, unknown> = {}) => fauxToolCall(name, args as never);

interface Request { declared: string[]; system: { toolsAdded: string[]; toolsRemoved: string[] }[]; text: string[] }
interface Options {
  tools?: Partial<ToolFilterSettings>;
  scores?: Record<string, number>;
  /** Extensions loaded BEFORE ours (registration order is handler order). */
  earlier?: ((pi: ExtensionAPI) => void)[];
  /** Extensions loaded after ours, and builtin-flagged inputs (loaded last, like the CLI's built-ins). */
  later?: InlineExtension[];
  builtin?: InlineExtension[];
  defaultTools?: string[];
  files?: Record<string, string>;
  project?: Record<string, unknown>;
}
async function realPi(t: { after(fn: () => Promise<void>): void }, script: (h: Awaited<ReturnType<typeof realPi>>) => Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "real-pi-tools-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"); await mkdir(agentDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  for (const [name, text] of Object.entries(options.files ?? {})) await writeFile(join(root, name), text);
  if (options.project) { await mkdir(join(root, ".pi"), { recursive: true }); await writeFile(join(root, ".pi", "pi-context-decisions.json"), JSON.stringify({ alwaysAllowed: [], ...options.project })); }
  const settingsPath = join(root, "settings.json");
  const base = defaultSettings();
  await saveSettings({ ...base, backend: { backend: "typesafe", model: "jev-latest" }, relevance: { ...base.relevance, enabled: false },
    tools: { ...defaultToolSettings(), enabled: true, ...options.tools } }, settingsPath);
  const faux = createFauxCore({ provider: "fauxprov", models: [{ id: "faux-1" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false } as never);
  runtime.registerProvider("fauxprov", { baseUrl: "http://faux.invalid", apiKey: "x", api: faux.api, streamSimple: faux.streamSimple,
    models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] } as never);
  const scores = { ...options.scores };
  const decisions: { task: string; names: string[]; raw: string }[] = [];
  const ours = (pi: ExtensionAPI) => registerContextDecisions(pi, { settingsPath, env: {}, report() {},
    createClient: () => createDecisionClient({ id: "pi", model: "fixture", async decide(request) {
      const metadata = (request.state.tools ?? request.state.servers) as Record<string, { name: string }>;
      decisions.push({ task: String(request.state.task), names: Object.values(metadata).map((entry) => entry.name), raw: JSON.stringify(request) });
      return { answers: Object.fromEntries(Object.entries(metadata).map(([id, entry]) => [id, { type: "score", score: scores[entry.name] ?? 0 }])) };
    } }) });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, noSkills: true,
    extensionFactories: [...(options.earlier ?? []), ours, ...(options.later ?? []), ...(options.builtin ?? [])] });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(root);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } } as never);
  if (options.defaultTools) settingsManager.applyOverrides({ defaultTools: options.defaultTools } as never);
  const created = await createAgentSession({ settingsManager, resourceLoader: loader, sessionManager, model: runtime.getModel("fauxprov", "faux-1")!, modelRuntime: runtime, cwd: root } as never);
  t.after(async () => created.session.dispose());
  await created.session.bindExtensions({});
  const requests: Request[] = [];
  const h = { session: created.session as AgentSession, faux, scores, decisions, requests, sessionManager, root,
    /** A faux step: records the declared tool set of the request, then answers. */
    step(answer?: (ctx: { messages: { role: string; content?: unknown }[] }, request: Request) => ReturnType<typeof fauxAssistantMessage>) {
      return (ctx: { messages: { role: string; content?: unknown }[] }) => {
        const messages = ctx.messages as unknown as Parameters<typeof getCurrentTools>[0];
        const system = (ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[]).filter((m) => m.role === "system")
          .map((m) => ({ toolsAdded: (m.toolsAdded ?? []).map((tool) => tool.name), toolsRemoved: (m.toolsRemoved ?? []).map((tool) => tool.name) }));
        const request: Request = { declared: getCurrentTools(messages).map((tool) => tool.name), system, text: ctx.messages.filter((m) => m.role !== "system").map((m) => JSON.stringify(m.content)) };
        requests.push(request);
        return answer ? answer(ctx, request) : fauxAssistantMessage([fauxText("done")]);
      };
    },
  };
  faux.setResponses(script(h));
  return h;
}
type H = Awaited<ReturnType<typeof realPi>>;
const finish = (h: H) => h.step();
const call = (h: H, name: string, args: Record<string, unknown> = {}) => h.step(() => fauxAssistantMessage([TOOL_CALL(name, args)], { stopReason: "toolUse" }));


const reasonRe = /pi-context-decisions tool filtering has not enabled it/;
const sortedDeclared = (r: Request) => [...r.declared].sort();
const lastToolText = (r: Request) => r.text.at(-1) ?? "";

test("R1 real Pi: the first request declares core tools and the chosen tool only, with no add-then-remove churn", async (t) => {
  const h = await realPi(t, (h) => [finish(h)], {
    earlier: [toolsExtension([{ name: "ext_a" }, { name: "ext_b" }, { name: "mcp__srv__x", namespace: { name: "mcp__srv" } }])], scores: { ext_a: 2 } });
  await h.session.prompt("use ext_a");
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].declared, [...CORE, "ext_a"], "core tools and ext_a only: ext_b and the namespaced direct tool are withheld before the first request");
  assert.deepEqual(h.requests[0].system, [{ toolsAdded: [...CORE, "ext_a"], toolsRemoved: [] }],
    "ONE system message declares the final set: our before_agent_start setActiveTools ran before Pi snapshotted declarations (no add-then-remove)");
  assert.deepEqual(h.decisions.map((d) => d.names), [["ext_a", "ext_b", "mcp__srv__x"]], "one decision call scored every external candidate and no internal tool");
  assert.deepEqual(h.session.getActiveToolNames().filter((name) => !CORE.includes(name)), ["ext_a"]);
  const ledger = h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "context-decisions-tools");
  assert.deepEqual(ledger.map((entry) => (entry as { data?: unknown }).data), [{ v: 1, tools: ["ext_a"], withheld: ["ext_b", "mcp__srv__x"], picks: { ext_a: { score: 2, threshold: 0.375 } } }]);
  const history = readDecisionsHistory(h.sessionManager);
  assert.deepEqual(history.batches.map((b) => [b.turn, b.items.tools, b.items.noticeTools]), [[1, ["ext_a"], []]], "availability is recorded without inventing a notice for declared tools");
});

test("R2 real Pi: a tool registered during the first tool execution is reconciled at turn_end and reaches the SECOND request of the same run", async (t) => {
  let register!: () => void;
  const spawner = (pi: ExtensionAPI) => {
    toolsExtension([{ name: "spawner" }])(pi);
    register = () => toolsExtension([{ name: "late_hi" }, { name: "late_lo" }])(pi);
  };
  const h = await realPi(t, (h) => [
    h.step(() => { register(); return fauxAssistantMessage([TOOL_CALL("spawner")], { stopReason: "toolUse" }); }),
    finish(h),
  ], { earlier: [spawner], scores: { spawner: 2, late_hi: 2, late_lo: 0.1 } });
  // `register` runs inside the model step, i.e. after the first request was built but before the tool round ends.
  await h.session.prompt("use spawner");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0].declared, [...CORE, "spawner"]);
  assert.deepEqual(h.requests[1].declared, [...CORE, "spawner", "late_hi"], "high-scoring late tool declared; the low-scoring one withheld at turn_end");
  assert.ok(!h.requests[1].system.some((m) => m.toolsAdded.includes("late_lo")), "the withheld late tool was never declared to the model: no add-then-remove churn");
  assert.deepEqual(h.decisions.map((d) => d.names), [["spawner"], ["late_hi", "late_lo"]], "a catch-up round scored only the late tools");
});

const lateRegistrar = (...specs: ToolSpec[]) => (pi: ExtensionAPI) => {
  let done = false;
  pi.on("before_agent_start", () => { if (!done) { done = true; toolsExtension(specs)(pi); } });
  return undefined;
};
test("R2b real Pi (decides the first-prompt gap): a tool registered after our before_agent_start but before the first request", async (t) => {
  const h = await realPi(t, (h) => [
    h.step(() => fauxAssistantMessage([TOOL_CALL("read", { path: "a.txt" })], { stopReason: "toolUse" })),
    finish(h),
  ], { earlier: [toolsExtension([{ name: "anchor_tool" }])], later: [lateRegistrar({ name: "gap_tool" })], scores: { anchor_tool: 2, gap_tool: 0.1 }, files: { "a.txt": "hello" } });
  await h.session.prompt("task");
  // OBSERVED on Pi 1.1.0: a direct tool registered by a LATER before_agent_start handler is auto-activated by Pi and IS declared in the
  // first request, because our handler already ran and never saw it. That is the documented "first-prompt gap". Our turn_end then scores
  // it and withholds it before the SECOND request; calls to it are blocked in the meantime. (No `turn_start` reconciliation exists, and
  // the first request's declarations were already fixed, so none could close the gap.)
  assert.deepEqual(h.requests[0].declared, [...CORE, "anchor_tool", "gap_tool"], "gap: the late tool is declared in the first request");
  assert.deepEqual(h.requests[1].declared, [...CORE, "anchor_tool"], "turn_end reconciliation withholds it before the next request");
  assert.deepEqual(h.requests[1].system.at(-1), { toolsAdded: [], toolsRemoved: ["gap_tool"] }, "expressed as a real transcript removal delta");
  assert.deepEqual(h.decisions.map((d) => d.names), [["anchor_tool"], ["gap_tool"]]);
  const blocked = await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "gap_tool", toolCallId: "g1", input: {} } as never);
  assert.match(blocked?.reason ?? "", reasonRe, "calls to it are blocked while it is unavailable");
});
test("R2c real Pi: a session with NO external tool at the first prompt still filters tools that register later (not 'enabled mid-session')", async (t) => {
  // Regression guard for a first-prompt corner: with nothing to record at the first boundary, a later turn_end must not mistake the
  // branch for one where filtering was switched on mid-conversation and record every late tool as already seen.
  const h = await realPi(t, (h) => [
    h.step(() => fauxAssistantMessage([TOOL_CALL("read", { path: "a.txt" })], { stopReason: "toolUse" })),
    finish(h),
  ], { later: [lateRegistrar({ name: "gap_tool" })], scores: { gap_tool: 0.1 }, files: { "a.txt": "hello" } });
  await h.session.prompt("task");
  assert.deepEqual(h.decisions.map((d) => d.names), [["gap_tool"]], "the late tool was scored");
  assert.deepEqual(h.requests[1].declared, CORE, "and withheld because it scored below the threshold");
});

/**
 * Real Pi built-in extensions, loaded like the CLI loads them: builtin-flagged inputs get `builtin:<name>` provenance. The MCP server is an
 * in-memory JSON-RPC peer on pi-mcp's own `testing` transport (already installed as a dependency of pi-coding-agent): no process, no network.
 */
function fakeMcp(servers: Record<string, { tools: string[]; exposure?: "codemode" | "direct" | "deferred"; resources?: boolean; connectDelayMs?: number }>) {
  const calls: { server: string; tool: string }[] = [];
  const entries = Object.entries(servers).map(([name, config]) => ({ name, config: { command: "fake", exposure: config.exposure ?? "codemode" }, source: "fixture", scope: "global" as const }));
  const createTransport = (entry: { name: string }) => {
    const { client, server } = createInMemoryTransportPair();
    const spec = servers[entry.name];
    void server.start().then(() => server.onMessage((message) => {
      const request = message as { id?: number | string; method?: string; params?: { name?: string } };
      if (request.id === undefined || request.method === undefined) return;
      const reply = (result: unknown) => {
        const send = () => void server.send({ jsonrpc: "2.0", id: request.id!, result } as never);
        if (request.method === "initialize" && spec.connectDelayMs) setTimeout(send, spec.connectDelayMs); else send();
      };
      if (request.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {}, ...(spec.resources ? { resources: {} } : {}) }, serverInfo: { name: entry.name, version: "1.0.0" }, instructions: "SECRET-SERVER-INSTRUCTIONS" });
      else if (request.method === "tools/list") reply({ tools: spec.tools.map((name) => ({ name, description: `${name} of ${entry.name}`, inputSchema: { type: "object", properties: { secret: { type: "string", description: "SECRET-SCHEMA" } } } })) });
      else if (request.method === "tools/call") { calls.push({ server: entry.name, tool: request.params!.name! }); reply({ content: [{ type: "text", text: `ran ${entry.name}/${request.params!.name}` }] }); }
      else if (request.method === "resources/list" || request.method === "resources/templates/list") reply({ resources: [], resourceTemplates: [] });
      else void server.send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "no" } } as never);
    }));
    return client;
  };
  const builtins = (): InlineExtension[] => [
    { name: "codemode", factory: createCodemodeExtension({ mode: "on" }), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension({ loadConfig: () => ({ servers: entries as never, errors: [] }), createTransport: createTransport as never, startupWaitMs: 50, logPath: join(tmpdir(), "pi-ctx-tools-mcp.log") }), builtin: true, replaceable: true },
  ];
  return { calls, builtins };
}
/** Captures `pi` so a test can read the live registry (`getAllTools`) while a session runs. */
function probe() {
  const box: { pi?: ExtensionAPI; selected: unknown[]; registeredAtStart: string[][] } = { selected: [], registeredAtStart: [] };
  return { box, extension: (pi: ExtensionAPI) => {
    box.pi = pi;
    pi.on("before_agent_start", (event) => { box.selected.push([...event.systemPromptOptions.selectedTools ?? []]); box.registeredAtStart.push(pi.getAllTools().map((tool) => tool.name)); });
  } };
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting for ${what}`);
}
const script = (code: string) => fauxAssistantMessage([TOOL_CALL("codemode", { code })], { stopReason: "toolUse" });

test("R3 real Pi + REAL built-in MCP/codemode: provenance, namespace and exposure are as classified; internal tools are never withheld", async (t) => {
  const mcp = fakeMcp({ "dev-radius": { tools: ["search"] } });
  const p = probe();
  const h = await realPi(t, (h) => [finish(h)], { earlier: [p.extension], builtin: mcp.builtins(), tools: { mode: "mcp" } });
  await until(() => p.box.pi!.getAllTools().some((tool) => tool.name === "mcp__dev_radius__search"), "the MCP server to connect");
  const info = p.box.pi!.getAllTools().find((tool) => tool.name === "mcp__dev_radius__search")!;
  assert.equal(info.sourceInfo.path, "builtin:mcp", "the real MCP manager's tools carry built-in provenance AND are external MCP tools");
  assert.equal(info.sourceInfo.source, "builtin");
  assert.equal(info.namespace?.name, "mcp__dev_radius", "hyphens fold to underscores in the canonical namespace");
  // HOST FACT (contradicts the plan's assumption): an MCP server configured with the default `codemode` exposure registers its tools with
  // ToolInfo.exposure "deferred" (the tools are only reachable from codemode scripts), and the public ToolNamespace has NO `aliases` field.
  assert.equal(info.exposure, "deferred");
  assert.equal((info.namespace as { aliases?: unknown } | undefined)?.aliases, undefined);
  const codemode = p.box.pi!.getAllTools().find((tool) => tool.name === "codemode");
  assert.equal(codemode?.sourceInfo.path, "builtin:codemode", "codemode itself is internal by provenance");
  await h.session.prompt("find things with the radar");
  assert.ok(h.requests[0].declared.includes("codemode"), "codemode (activated by MCP) stays declared: never withheld");
  assert.equal(h.decisions.length, 1);
  assert.deepEqual(h.decisions[0].names, ["mcp__dev_radius"], "mcp mode scores the namespace, not individual tools or internal tools");
  assert.match(h.decisions[0].raw, /Tools: mcp__dev_radius__search/);
  assert.doesNotMatch(h.decisions.map((d) => d.raw).join(), /SECRET|builtin:|inputSchema/, "schemas, server instructions and provenance never reach the decision model");
  const payload = JSON.parse(h.decisions[0].raw) as { state: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(payload.state).sort(), ["servers", "task"]);
  assert.deepEqual(Object.keys(payload.state.servers.m0 as object).sort(), ["description", "name"]);
});
test("R3 real Pi gate on NESTED calls: a codemode script's call to an unavailable MCP server is blocked; allowlisting the server lets it through", async (t) => {
  const run = (code: string) => (h: H) => [
    h.step(() => script(code)),
    finish(h),
  ];
  const code = `const out = {};
try { out.mcp = await tools.mcp__dev_radius__search({}); } catch (e) { out.blocked = String(e.message ?? e); }
out.read = await tools.read({ path: "a.txt" });
return JSON.stringify(out);`;
  // Server NOT available: scored 0, so the nested MCP call is blocked (script observes our reason) while read keeps working.
  const blockedMcp = fakeMcp({ "dev-radius": { tools: ["search"] } });
  const p = probe();
  const blocked = await realPi(t, run(code), { earlier: [p.extension], builtin: blockedMcp.builtins(), tools: { mode: "mcp" }, files: { "a.txt": "FILE-CONTENTS" } });
  await until(() => p.box.pi!.getAllTools().some((tool) => tool.name === "mcp__dev_radius__search"), "the MCP server to connect");
  await blocked.session.prompt("find things");
  const result = lastToolText(blocked.requests[1]);
  assert.match(result, /Script completed/);
  // The namespace carries no alias, so the server label is the canonical key tail (`dev_radius`); `-`/`_` fold for allowlists.
  assert.match(result, /MCP server .{1,8}dev_radius.{1,8} is unavailable: pi-context-decisions tool filtering has not enabled it/, "the script sees our block reason (names the server)");
  assert.match(result, /FILE-CONTENTS/, "an internal tool called from the same script still works");
  assert.deepEqual(blockedMcp.calls, [], "the MCP server never received the call");
  // Allowlisted (project file, with `-`/`_` folding): the same script's nested call goes through and the server runs it.
  const allowedMcp = fakeMcp({ "dev-radius": { tools: ["search"] } });
  const q = probe();
  const allowed = await realPi(t, run(code), { earlier: [q.extension], builtin: allowedMcp.builtins(), tools: { mode: "mcp" }, project: { alwaysAllowedMcpServers: ["dev_radius"] }, files: { "a.txt": "FILE-CONTENTS" } });
  await until(() => q.box.pi!.getAllTools().some((tool) => tool.name === "mcp__dev_radius__search"), "the MCP server to connect");
  await allowed.session.prompt("find things");
  assert.match(lastToolText(allowed.requests[1]), /ran dev-radius\/search/);
  assert.doesNotMatch(lastToolText(allowed.requests[1]), /unavailable/);
  assert.deepEqual(allowedMcp.calls, [{ server: "dev-radius", tool: "search" }]);
  assert.equal(allowed.decisions.length, 0, "an allowlisted server is never scored");
});
test("R3 real Pi lazy gate: an MCP server that connects AFTER the first boundary is scored once when a script first calls it", async (t) => {
  const mcp = fakeMcp({ srv: { tools: ["x"], connectDelayMs: 60 } });
  const code = `try { return JSON.stringify(await tools.mcp__srv__x({})); } catch (e) { return "BLOCKED " + e.message; }`;
  const p = probe();
  const h = await realPi(t, (h) => [h.step(() => script(code)), finish(h)], { earlier: [p.extension], builtin: mcp.builtins(), tools: { mode: "mcp" }, scores: { mcp__srv: 2 } });
  await h.session.prompt("use the srv server");
  assert.ok(!p.box.registeredAtStart[0].includes("mcp__srv__x"), "precondition: the server had not registered its tools when the first boundary ran");
  // The codemode script waits for the server it names, so the namespace registers while the script runs: it was not part of the first
  // boundary's inventory and is scored (once) by the gate, then allowed because it qualifies.
  assert.deepEqual(h.decisions.map((d) => d.names), [["mcp__srv"]]);
  assert.match(lastToolText(h.requests[1]), /ran srv\/x/);
  assert.deepEqual(mcp.calls, [{ server: "srv", tool: "x" }]);
});

test("real Pi, deferred MCP server + tools mode: tool_search stays declared (internal); individual MCP tools are decided one by one and gated", async (t) => {
  const mcp = fakeMcp({ srv: { tools: ["a", "b"], exposure: "deferred" } });
  const p = probe();
  const h = await realPi(t, (h) => [finish(h)], { earlier: [p.extension], builtin: mcp.builtins(), tools: { mode: "tools" }, scores: { mcp__srv__a: 2, mcp__srv__b: 0 } });
  await until(() => p.box.pi!.getAllTools().some((tool) => tool.name === "mcp__srv__b"), "the MCP server to connect");
  await h.session.prompt("use a");
  assert.ok(h.requests[0].declared.includes("tool_search"), "tool_search (built-in provenance) is never withheld");
  assert.deepEqual(h.decisions.map((d) => d.names), [["mcp__srv__a", "mcp__srv__b"]], "internal tools (codemode, tool_search, resource tools) are not candidates");
  const allowed = await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "mcp__srv__a", toolCallId: "a", input: {} } as never);
  const blocked = await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "mcp__srv__b", toolCallId: "b", input: {} } as never);
  assert.equal(allowed, undefined);
  assert.match(blocked?.reason ?? "", reasonRe, "a sibling tool of the same server is blocked in tools mode");
});

test("R5 real Pi branch: navigating the tree back to before an addition restores that branch's availability; the later branch's addition does not leak", async (t) => {
  const h = await realPi(t, (h) => [finish(h), finish(h), finish(h)], {
    earlier: [toolsExtension([{ name: "ext_a" }, { name: "ext_b" }])], scores: { ext_a: 2, ext_b: 0 } });
  await h.session.prompt("first: use ext_a");
  const afterFirst = h.sessionManager.getBranch().filter((entry) => entry.type === "message").at(-1)!;
  h.scores.ext_b = 2;
  await h.session.prompt("second: now use ext_b");
  assert.deepEqual(h.requests[1].declared, [...CORE, "ext_a", "ext_b"], "the second prompt added ext_b (restored: it was withheld by us)");
  assert.equal(await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "ext_b", toolCallId: "x", input: {} } as never), undefined);
  // Back to the end of the first turn: the second branch's ledger entry is no longer on the active path.
  h.scores.ext_b = 0;
  await h.session.navigateTree(afterFirst.id);
  assert.deepEqual(h.session.getActiveToolNames().filter((name) => !CORE.includes(name)), ["ext_a"], "Pi restored the branch's own loadout from the transcript");
  const blocked = await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "ext_b", toolCallId: "y", input: {} } as never);
  assert.match(blocked?.reason ?? "", reasonRe, "the gate reads the NEW branch's ledger: ext_b is unavailable there");
  await h.session.prompt("third: unrelated");
  assert.deepEqual(h.requests[2].declared, [...CORE, "ext_a"], "the next request excludes the tool added on the abandoned branch");
  assert.deepEqual(h.decisions.at(-1)!.names, ["ext_b"], "and ext_b is a candidate again on this branch");
});

test("R6 real Pi interop: an earlier extension's activation of a built-in tool survives; our extension never edits selectedTools or sections", async (t) => {
  const snapshots: { who: string; selectedTools: string[]; sections: string }[] = [];
  const observer = (who: string) => (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      snapshots.push({ who, selectedTools: [...(event.systemPromptOptions.selectedTools ?? [])], sections: JSON.stringify(event.systemPromptOptions.sections ?? {}) });
    });
  };
  // An earlier extension activates a built-in tool that Pi registers inactive (setActiveTools is the public way to do it).
  const activator = (pi: ExtensionAPI) => pi.on("session_start", () => { pi.setActiveTools([...pi.getActiveTools(), "tool_search"]); });
  const mcp = fakeMcp({});
  const h = await realPi(t, (h) => [finish(h)], { earlier: [observer("before"), activator, toolsExtension([{ name: "ext_a" }, { name: "ext_b" }])], later: [observer("after")], builtin: mcp.builtins(), scores: { ext_a: 2 } });
  await h.session.prompt("use ext_a");
  assert.ok(h.requests[0].declared.includes("tool_search"), "the other extension's activation of a built-in tool is kept (internal tools are never withheld or re-set)");
  assert.ok(!h.requests[0].declared.includes("ext_b") && h.requests[0].declared.includes("ext_a"), "while the undecided external tool is withheld");
  assert.equal(snapshots.length, 2);
  const [before, after] = snapshots;
  assert.equal(before.who, "before");
  assert.ok(before.selectedTools.includes("ext_b"), "precondition: ext_b was still selected when the earlier observer ran");
  assert.deepEqual(after.selectedTools, before.selectedTools, "our handler left event.systemPromptOptions.selectedTools exactly as it found it (an explicit edit would override other extensions' setActiveTools)");
  assert.equal(after.sections, before.sections, "and left the prompt sections alone");
});

test("SDK embedding (host fact): codemode added as a PLAIN factory has inline provenance, so it is an external tool and is filtered like any other", async (t) => {
  // The official SDK example adds createCodemodeExtension() to extensionFactories. Without the `builtin` flag the CLI uses, Pi gives its tools
  // `<inline:...>` provenance, which this extension cannot distinguish from a user extension. This documents (and pins) that limitation:
  // internal-always-allowed is by provenance only, so SDK embedders must pass `{ builtin: true }` inputs or allowlist `codemode`.
  const p = probe();
  const h = await realPi(t, (h) => [finish(h)], { earlier: [p.extension], later: [createCodemodeExtension({ mode: "on" })], defaultTools: ["+codemode"], scores: {} });
  const info = p.box.pi!.getAllTools().find((tool) => tool.name === "codemode")!;
  assert.notEqual(info.sourceInfo.source, "builtin");
  assert.match(info.sourceInfo.path, /^<inline/);
  await h.session.prompt("task");
  assert.ok(!h.requests[0].declared.includes("codemode"), "withheld: not recognized as internal");
  assert.deepEqual(h.decisions.map((d) => d.names), [["codemode"]]);
  // The documented remedy: allowlist it.
  const kept = await realPi(t, (h) => [finish(h)], { later: [createCodemodeExtension({ mode: "on" })], defaultTools: ["+codemode"], tools: { alwaysAllowedTools: ["codemode"] } });
  await kept.session.prompt("task");
  assert.ok(kept.requests[0].declared.includes("codemode"));
});
