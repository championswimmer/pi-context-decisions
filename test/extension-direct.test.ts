import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { advertised, simHost } from "./helpers/pi-sim.ts";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionRegistry } from "../src/extension/contracts.ts";
import { defaultSettings, saveSettings } from "../src/settings.ts";
import type { BackendSelection } from "../src/core/backends/factory.ts";

for (const [selection, url, provider] of [
  [{ backend: "typesafe", model: "jev-1.13.0" }, "https://api.typesafe.ai/v1/systemone", "typesafe"],
  [{ backend: "openai", model: "gpt-6-luna" }, "https://api.openai.com/v1/decisions", "openai"],
  [{ backend: "gemini", model: "gemini-decision-1" }, "https://generativelanguage.googleapis.com/v1beta/decisions", "google"],
  [{ backend: "openrouter", model: "typesafe/jev-1.14" }, "https://openrouter.ai/api/alpha/decisions", "openrouter"],
  [{ backend: "openrouter", model: "openai/gpt-6-luna-decisions" }, "https://openrouter.ai/api/alpha/decisions", "openrouter"],
] as const) test(`${selection.backend} ${selection.model}: actual hook → factory → auth → codec → mock HTTP → filtered skills`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "extension-direct-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json"); await saveSettings({ ...defaultSettings(), backend: selection satisfies BackendSelection }, path);
  const sim = simHost();
  registerContextDecisions(sim.pi, { settingsPath: path, env: { OPENROUTER_API_KEY: "env-router-fixture", OPENAI_API_KEY: "env-openai-fixture", TYPESAFE_API_KEY: "env-typesafe-fixture", GEMINI_API_KEY: "env-gemini-fixture" }, report() {} });
  const lookups: string[] = [];
  const registry: ExtensionRegistry = {
    async getProviderAuth(id) { lookups.push(id); return { auth: { apiKey: `pi-${id}-fixture` }, source: "stored credential" }; },
    async getApiKeyForProvider() { throw new Error("Use request-time provider auth"); },
    getModelsOfType(type) { return type === "chat" ? [{ provider: "openai-codex", id: "chat" }] : []; },
    findOfType() { return undefined; }, isUsingOAuth() { return false; },
    async classify() { throw new Error("Native must not run for direct"); },
  };
  const ctx: CommandContext = { hasUI: false, mode: "print", modelRegistry: registry, ui: { async input() { throw new Error("No UI"); }, async select() { throw new Error("No UI"); }, notify() { throw new Error("No UI"); }, setStatus() { throw new Error("No UI"); } } };
  const skills = Array.from({ length: 8 }, (_, i) => ({ name: `fixture-${i}`, description: `Metadata ${i}`, filePath: `/SECRET-PATH/${i}`, baseDir: "/SECRET-PATH", disableModelInvocation: false, sourceInfo: { path: "/SECRET-PATH", source: "fixture", scope: "project" as const, origin: "top-level" as const } }));
  const event = { type: "before_agent_start", messageType: "user", prompt: "Fixture task", images: [{ type: "image", data: "SECRET-IMAGE", mimeType: "image/png" }], systemPrompt: "Do not replace", systemPromptOptions: { cwd: "/fixture", skills, selectedTools: ["read"], hiddenTools: [], sections: { mcp_servers: "unchanged" }, toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] } } satisfies BeforeAgentStartEvent;
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (destination, init) => {
    calls++; assert.equal(destination, url); assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), provider === "google" ? null : `Bearer pi-${provider}-fixture`);
    assert.equal(headers.get("x-goog-api-key"), provider === "google" ? "pi-google-fixture" : null);
    assert.doesNotMatch(init!.body as string, /SECRET-PATH|SECRET-IMAGE|mcp_servers/);
    const payload = JSON.parse(init!.body as string); assert.equal(payload.model, selection.model);
    if (provider === "openai") {
      assert.equal(JSON.parse(payload.input).task, "Fixture task");
      assert.equal(payload.questions.length, 8);
      return Response.json({ answers: payload.questions.map((question: { name: string; type: string }) => ({ name: question.name, type: question.type, score: question.name === "s0" ? 2 : 0 })) });
    }
    const state = provider === "google" ? JSON.parse(payload.input) : payload.state;
    assert.equal(state.task, "Fixture task"); assert.equal(Object.keys(payload.questions).length, 8);
    return Response.json({ answers: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "score", score: id === "s0" ? 2 : 0,
      ...(provider === "typesafe" ? { confidence: 1, probabilities: { "0": id === "s0" ? 0 : 1, "1": 0, "2": id === "s0" ? 1 : 0 }, legend: { "0": "Irrelevant", "1": "Related", "2": "Directly relevant" } } : {}),
    }])) });
  };
  try { await sim.emit("before_agent_start", event, ctx); }
  finally { globalThis.fetch = original; }
  assert.equal(calls, 1); assert.deepEqual(lookups, [provider]);
  assert.deepEqual(advertised(sim, skills, event.systemPromptOptions.skills), ["fixture-0"]);
  assert.deepEqual(event.systemPromptOptions.skills.map((skill) => skill.name), ["fixture-0"]);
  const section = sim.session.getBranch().find((entry) => entry.message?.role === "system" && entry.message.sections?.skills)?.message?.sections?.skills;
  assert.match(String(section), /<name>fixture-0<\/name>/); assert.doesNotMatch(String(section), /fixture-1/);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read"]); assert.equal(event.systemPromptOptions.sections.mcp_servers, "unchanged"); assert.equal(event.systemPrompt, "Do not replace");
});
