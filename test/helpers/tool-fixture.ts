// Offline fixture for tool/MCP filtering tests: the sim host, a scripted decision client, and a Pi-shaped tool inventory.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../../src/extension/runtime.ts";
import type { CommandContext } from "../../src/extension/contracts.ts";
import { createDecisionClient } from "../../src/decision/api.ts";
import type { DecisionRequest } from "../../src/decision/types.ts";
import { defaultSettings, defaultToolSettings, saveSettings, type ContextDecisionsSettings, type ToolFilterSettings } from "../../src/settings.ts";
import { SimSession, builtinSource, extensionSource, simHost, turnEnd, type SimToolInfo } from "./pi-sim.ts";

/** Pi's built-in MCP manager: server tools carry built-in provenance AND an `mcp__` namespace; resource tools carry no namespace. */
export const mcpTool = (server: string, name: string, exposure: SimToolInfo["exposure"] = "codemode", extra: Partial<SimToolInfo> = {}): SimToolInfo => ({
  name: `mcp__${server.replace(/-/g, "_")}__${name}`, description: `${name} on ${server}`, exposure, sourceInfo: builtinSource("mcp"),
  namespace: { name: `mcp__${server.replace(/-/g, "_")}`, description: `${server} server`, aliases: [server], instructions: "SECRET-INSTRUCTIONS" }, parameters: { type: "object", properties: { secret: { description: "SECRET-SCHEMA" } } }, ...extra,
});
export const resourceTools = (): SimToolInfo[] => ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].map((name) => ({ name, description: name, sourceInfo: builtinSource("mcp"), exposure: "direct" as const }));
export const extTool = (name: string, exposure: SimToolInfo["exposure"] = "direct", extra: Partial<SimToolInfo> = {}): SimToolInfo =>
  ({ name, description: `Does ${name}`, exposure, sourceInfo: extensionSource(name), ...extra });

export interface ToolOptions {
  tools?: Partial<ToolFilterSettings>; settings?: Partial<ContextDecisionsSettings>; skills?: boolean; unconfigured?: boolean;
  /** Score by candidate name (tool name, or `mcp__x` namespace key in mcp mode). Default 0. */
  scores?: Record<string, number>; fail?: boolean; hang?: boolean;
  extra?: SimToolInfo[];
  /** Reuse a session (a simulated reload/resume): the ledger is derived from its branch. */
  session?: SimSession;
  /** Test seam for the project allowlist read (defaults to the real file read). */
  loadProjectAllowlist?: NonNullable<Parameters<typeof registerContextDecisions>[1]["loadProjectAllowlist"]>;
}
export async function toolSetup(t: { after(fn: () => Promise<void>): void }, options: ToolOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "tool-filter-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  const base = defaultSettings();
  const settings: ContextDecisionsSettings = { ...base, backend: options.unconfigured ? null : { backend: "pi", provider: "fixture", id: "classifier" }, ...options.settings,
    relevance: { ...base.relevance, enabled: options.skills === true, minCandidates: 0, ...options.settings?.relevance },
    tools: { ...defaultToolSettings(), enabled: true, ...options.tools } };
  await saveSettings(settings, path);
  const sim = simHost(options.session ?? new SimSession());
  for (const info of options.extra ?? []) sim.registerTool(info);
  const behavior = { fail: options.fail === true, hang: options.hang === true, gate: undefined as Promise<void> | undefined, inflight: 0, peak: 0 };
  const requests: DecisionRequest[] = [];
  const messages: string[] = [];
  const scores = { ...options.scores };
  registerContextDecisions(sim.pi, { settingsPath: path, env: {}, report(_ctx, message) { messages.push(message); }, ...(options.loadProjectAllowlist ? { loadProjectAllowlist: options.loadProjectAllowlist } : {}),
    createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide(request) {
      requests.push(request);
      behavior.inflight++; behavior.peak = Math.max(behavior.peak, behavior.inflight);
      try {
        const text = JSON.stringify(request);
        assert.doesNotMatch(text, /SECRET|\/ext\/|builtin:|sourceInfo|"parameters"|"annotations"|"namespace"|filePath/);
        if (behavior.hang) return await new Promise<never>(() => {});
        if (behavior.gate) await behavior.gate;
        if (behavior.fail) throw Object.assign(new Error("PRIVATE provider failure"), { code: "http" });
        const metadata = (request.state.tools ?? request.state.servers ?? request.state.skills) as Record<string, { name: string }>;
        return { answers: Object.fromEntries(Object.entries(metadata).map(([id, entry]) => [id, { type: "score", score: scores[entry.name] ?? 0 }])), usage: { inputTokens: 2 } };
      } finally { behavior.inflight--; }
    } }); } });
  const ctx: CommandContext = { cwd: root, hasUI: false, mode: "print", modelRegistry: { getModelsOfType() { return []; }, findOfType() { return { provider: "fixture", id: "classifier" }; }, async getApiKeyForProvider() { return undefined; }, async classify() { throw new Error("injected"); } },
    ui: { async select() { return undefined; }, async input() { return undefined; }, notify() {}, setStatus() {} } };
  const skillList: unknown[] = [];
  const event = (prompt: string, extra: Record<string, unknown> = {}) => ({ type: "before_agent_start", prompt, systemPrompt: "unchanged",
    systemPromptOptions: { cwd: root, skills: [...skillList], selectedTools: ["read", "bash"], sections: {}, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] }, ...extra } as unknown as BeforeAgentStartEvent);
  const h = {
    sim, ctx, root, path, requests, messages, scores, behavior, settings, skillList,
    event,
    async start(prompt: string, extra: Record<string, unknown> = {}) { const e = event(prompt, extra); const results = await sim.emit("before_agent_start", e, ctx); return { e, results }; },
    end: (options: Parameters<typeof turnEnd>[2] = {}) => turnEnd(sim, ctx, options),
    async agentEnd() { await sim.emit("agent_end", { type: "agent_end", messages: [] }, ctx); },
    gate: (name: string, input: unknown = {}, eventExtra?: Record<string, unknown>) => sim.toolCall(name, input, ctx, eventExtra),
    async command(args: string) { await sim.command(args, ctx); },
    ledger: () => sim.session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "context-decisions-tools").map((entry) => entry.data as Record<string, string[] | string>),
    notices: () => sim.session.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "context-decisions-tools-notice"),
    /** Names scored by decision call N onwards. */
    scored: (from = 0) => requests.slice(from).flatMap((request) => Object.values((request.state.tools ?? request.state.servers) as Record<string, { name: string }>).map((entry) => entry.name)),
    active: () => [...sim.tools.active],
  };
  await sim.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  return h;
}
export type ToolHarness = Awaited<ReturnType<typeof toolSetup>>;
export const CORE = ["read", "bash"];
