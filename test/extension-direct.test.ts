import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { advertised, deltaMessages, simHost } from "./helpers/pi-sim.ts";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionRegistry } from "../src/extension/contracts.ts";
import { defaultSettings, saveSettings } from "../src/settings.ts";
import type { BackendSelection } from "../src/core/backends/factory.ts";

for (const [selection, url, provider] of [
  [{ backend: "typesafe", model: "jev-1.13.0" }, "https://api.typesafe.ai/v1/systemone", "typesafe"],
  [{ backend: "openai", model: "gpt-6-luna" }, "https://api.openai.com/v1/decisions", "openai"],
  [{ backend: "openrouter", model: "typesafe/jev-1.13" }, "https://openrouter.ai/api/alpha/decisions", "openrouter"],
] as const) test(`${provider} actual hook → factory → auth → codec → mock HTTP → filtered skills`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "extension-direct-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json"); await saveSettings({ ...defaultSettings(), backend: selection satisfies BackendSelection }, path);
  const sim = simHost();
  registerContextDecisions(sim.pi, { settingsPath: path, env: { OPENROUTER_API_KEY: "env-fixture", OPENAI_API_KEY: "env-fixture", TYPESAFE_API_KEY: "env-fixture" }, report() {} });
  const lookups: string[] = [];
  const registry: ExtensionRegistry = { async getApiKeyForProvider(id) { lookups.push(id); return "pi-fixture"; }, getModelsOfType(type) { return type === "chat" ? [{ provider: "openai", id: "chat" }] : []; }, findOfType() { return undefined; }, isUsingOAuth() { return false; }, async classify() { throw new Error("Native must not run for direct"); } };
  const ctx: CommandContext = { hasUI: false, mode: "print", modelRegistry: registry, ui: { async input() { throw new Error("No UI"); }, async select() { throw new Error("No UI"); }, notify() { throw new Error("No UI"); }, setStatus() { throw new Error("No UI"); } } };
  const skills = Array.from({ length: 8 }, (_, i) => ({ name: `fixture-${i}`, description: `Metadata ${i}`, filePath: `/SECRET-PATH/${i}`, baseDir: "/SECRET-PATH", disableModelInvocation: false, sourceInfo: { path: "/SECRET-PATH", source: "fixture", scope: "project" as const, origin: "top-level" as const } }));
  const event = { type: "before_agent_start", prompt: "Fixture task", images: [{ type: "image", data: "SECRET-IMAGE", mimeType: "image/png" }], systemPrompt: "Do not replace", systemPromptOptions: { cwd: "/fixture", skills, selectedTools: ["read"], hiddenTools: [], sections: { mcp_servers: "unchanged" }, toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] } } satisfies BeforeAgentStartEvent;
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (destination, init) => {
    calls++; assert.equal(destination, url); assert.equal(init?.method, "POST"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer pi-fixture");
    assert.doesNotMatch(init!.body as string, /SECRET-PATH|SECRET-IMAGE|mcp_servers/);
    const payload = JSON.parse(init!.body as string); assert.equal(payload.model, selection.model);
    if (provider === "openai") {
      assert.equal(JSON.parse(payload.input).task, "Fixture task");
      assert.equal(payload.questions.length, 8);
      return Response.json({ answers: payload.questions.map((question: { name: string; type: string }) => ({ name: question.name, type: question.type, score: question.name === "s0" ? 2 : 0 })) });
    }
    assert.equal(payload.state.task, "Fixture task"); assert.equal(Object.keys(payload.questions).length, 8);
    return Response.json({ answers: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "score", score: id === "s0" ? 2 : 0,
      ...(provider === "typesafe" ? { confidence: 1, probabilities: { "0": id === "s0" ? 0 : 1, "1": 0, "2": id === "s0" ? 1 : 0 }, legend: { "0": "Irrelevant", "1": "Related", "2": "Directly relevant" } } : {}),
    }])) });
  };
  try { await sim.emit("before_agent_start", event, ctx); }
  finally { globalThis.fetch = original; }
  assert.equal(calls, 1); assert.deepEqual(lookups, [provider]);
  assert.deepEqual(advertised(sim, skills, event.systemPromptOptions.skills), ["fixture-0"]); assert.deepEqual(event.systemPromptOptions.skills, []);
  const [delta] = deltaMessages(sim.session); assert.match(String(delta.content), /<name>fixture-0<\/name>/); assert.doesNotMatch(String(delta.content), /fixture-1/);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read"]); assert.equal(event.systemPromptOptions.sections.mcp_servers, "unchanged"); assert.equal(event.systemPrompt, "Do not replace");
});
