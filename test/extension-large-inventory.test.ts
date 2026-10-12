import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionHost } from "../src/extension/contracts.ts";
import { defaultSettings } from "../src/settings.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";

function inventory(count: number): BeforeAgentStartEvent {
  const skills = Array.from({ length: count }, (_, i) => ({ name: `skill-${i}`, description: `Skill metadata ${i}`, filePath: `/private/${i}/SKILL.md`, baseDir: `/private/${i}`, sourceInfo: { path: `/private/${i}/SKILL.md`, source: "fixture", scope: "project" as const, origin: "top-level" as const }, disableModelInvocation: false }));
  return { type: "before_agent_start", prompt: "Review fixture metadata", systemPrompt: "unchanged", systemPromptOptions: { cwd: "/fixture", skills, selectedTools: ["read"], sections: { mcp_servers: "unchanged" }, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] } };
}
for (const [count, maxQuestions, expected] of [[400, undefined, [50, 50, 50, 50, 50, 50, 50, 50]], [30, 7, [7, 7, 7, 7, 2]]] as const) {
  test(`actual hook evaluates ${count} skills in parallel, preserving declared client limit ${maxQuestions ?? 50}`, async () => {
    let handler: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown) | undefined;
    const host: ExtensionHost = { on: ((name: string, fn: unknown) => { if (name === "before_agent_start") handler = fn as typeof handler; return () => {}; }) as ExtensionAPI["on"], registerCommand() {} };
    const batches: DecisionRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => { dispatched = resolve; });
    const settings = { ...defaultSettings(), backend: { backend: "pi" as const, provider: "fixture", id: "model" } };
    registerContextDecisions(host, { settingsPath: "unused", env: {}, async load() { return { settings, warnings: [] }; }, report() {}, createClient() {
      return Object.assign(createDecisionClient({ id: "pi", model: "fixture", async decide(request) {
        batches.push(request);
        assert.doesNotMatch(JSON.stringify(request), /filePath|baseDir|sourceInfo|\/private/);
        if (batches.length === expected.length) dispatched();
        await gate;
        const metadata = request.state.skills as Record<string, { name: string; description: string }>;
        return { answers: Object.fromEntries(Object.entries(metadata).map(([id, skill]) => [id, { type: "score", score: Number(skill.name.slice(6)) % 50 === 0 ? 2 : 0 }])) };
      } }), { maxQuestions });
    } });
    const ctx: CommandContext = { hasUI: false, mode: "print", ui: { async select() { return undefined; }, async input() { return undefined; }, notify() {}, setStatus() {} }, modelRegistry: { getModelsOfType() { return []; }, findOfType() { return { provider: "fixture", id: "model" }; }, async getApiKeyForProvider() { return undefined; }, async classify() { throw new Error("Injected client only"); } } };
    const event = inventory(count);
    const original = event.systemPromptOptions.skills;
    const operation = Promise.resolve(handler!(event, ctx as ExtensionContext));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("All scoring batches were not dispatched in parallel")), 200); })]);
      assert.deepEqual(batches.map((request) => Object.keys(request.questions).length), [...expected]);
      assert.equal(batches.reduce((sum, request) => sum + Object.keys(request.questions).length, 0), count);
    } finally { if (timer) clearTimeout(timer); release(); }
    await operation;
    assert.deepEqual(event.systemPromptOptions.skills, original.filter((_, i) => i % 50 === 0));
    assert.equal(event.systemPrompt, "unchanged");
    assert.deepEqual(event.systemPromptOptions.selectedTools, ["read"]);
    assert.deepEqual(event.systemPromptOptions.sections, { mcp_servers: "unchanged" });
  });
}
