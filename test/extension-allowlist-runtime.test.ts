import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionHost } from "../src/extension/contracts.ts";
import { defaultSettings } from "../src/settings.ts";
import { saveProjectAllowlist, projectAllowlistPath } from "../src/project-allowlist.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";

const skills = () => [
  { name: "global", description: "Global metadata", sourceInfo: { path: "/private/global", source: "fixture", scope: "user" as const, origin: "top-level" as const }, filePath: "/private/global", baseDir: "/private", disableModelInvocation: false },
  { name: "project", description: "Project metadata", sourceInfo: { path: "/private/project", source: "fixture", scope: "project" as const, origin: "top-level" as const }, filePath: "/private/project", baseDir: "/private", disableModelInvocation: false },
  { name: "other", description: "Other metadata", sourceInfo: { path: "/private/other", source: "fixture", scope: "project" as const, origin: "top-level" as const }, filePath: "/private/other", baseDir: "/private", disableModelInvocation: false },
  { name: "manual", description: "Manual metadata", sourceInfo: { path: "/private/manual", source: "fixture", scope: "project" as const, origin: "top-level" as const }, filePath: "/private/manual", baseDir: "/private", disableModelInvocation: true },
];
function event(): BeforeAgentStartEvent {
  return { type: "before_agent_start", prompt: "task", systemPrompt: "untouched", systemPromptOptions: { cwd: "/fixture", skills: skills(), selectedTools: [], sections: {}, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] } };
}
async function setup(t: { after(fn: () => Promise<void>): void }, outcome: "ok" | "failure" | "config" | "pending" = "ok") {
  const cwd = await mkdtemp(join(tmpdir(), "allowlist-runtime-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const messages: string[] = [], requests: DecisionRequest[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  const pi: ExtensionHost = { on: ((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
    const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {};
  }) as ExtensionAPI["on"], registerCommand(name, command) { commands.set(name, command); },
    getCommands() { return [{ name: "skill:fallback-only", description: "Fallback metadata", source: "skill", sourceInfo: { path: "/private/fallback", source: "fixture", scope: "project", origin: "top-level" } }]; },
  };
  const settings = defaultSettings(); settings.globalAllowlist = ["global"];
  settings.backend = { backend: "pi", provider: "fixture", id: "classifier" }; settings.relevance.minCandidates = 0; settings.relevance.maxSkills = 0;
  const ctx: CommandContext = { cwd, hasUI: false, mode: "print", modelRegistry: {
    findOfType() { return outcome === "config" ? undefined : { provider: "fixture", id: "classifier" }; },
    getModelsOfType() { return []; }, async getApiKeyForProvider() { return "fixture-key"; }, async classify() { throw new Error("not reached"); },
  }, ui: { async select() { return undefined; }, async input() { return undefined; }, notify() {}, setStatus() {} } };
  registerContextDecisions(pi, { settingsPath: join(cwd, "settings.json"),
    async load() { return { settings: structuredClone(settings), warnings: [] }; }, async save(next) { Object.assign(settings, next); },
    createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide(request, options) {
      requests.push(request); assert.doesNotMatch(JSON.stringify(request), /private|filePath|sourceInfo|baseDir/);
      if (outcome === "pending") {
        options?.signal?.addEventListener("abort", () => { cancelled = true; }, { once: true });
        started(); return new Promise<never>(() => {});
      }
      if (outcome === "failure") throw new Error("PRIVATE_PROVIDER_ERROR");
      return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "score", score: 0 }])) };
    } }); }, report(_ctx, message) { messages.push(message); },
  });
  return { cwd, ctx, settings, requests, messages, ready, cancelled: () => cancelled,
    async editor(scope: "global" | "project") {
      let rendered = "";
      ctx.hasUI = true; ctx.mode = "tui";
      ctx.ui.custom = async (factory) => {
        const component = await factory({ requestRender() {} } as Parameters<typeof factory>[0], { fg: (_token: unknown, text: string) => text, bg: (_token: unknown, text: string) => text } as Parameters<typeof factory>[1], {} as Parameters<typeof factory>[2], () => {});
        rendered = component.render(120).join("\n"); component.dispose?.(); return false as never;
      };
      await commands.get("decisions")!.handler(`allowlist ${scope}`, ctx as ExtensionCommandContext);
      return rendered;
    },
    async emit(name: string, value: unknown) { for (const handler of handlers.get(name) ?? []) await handler(value, ctx as ExtensionContext); },
    async command(text: string) { await commands.get("decisions")!.handler(text, ctx as ExtensionCommandContext); },
  };
}
for (const outcome of ["ok", "failure", "config"] as const) test(`scoped always-included skills survive ${outcome}, consume no cap and never score`, async (t) => {
  const h = await setup(t, outcome); await saveProjectAllowlist(h.cwd, ["project"]);
  const e = event(), original = e.systemPromptOptions.skills;
  await h.emit("before_agent_start", e);
  assert.deepEqual(e.systemPromptOptions.skills, [original[0], original[1], original[3]]);
  assert.equal(e.systemPromptOptions.skills[0], original[0]);
  if (outcome !== "config") { assert.equal(h.requests.length, 1); assert.deepEqual(Object.values(h.requests[0].state.skills as Record<string, { name: string }>).map((s) => s.name), ["other"]); }
  else assert.equal(h.requests.length, 0);
});
test("wrong-scope names do not pin and project lists follow changed cwd rather than stale caches", async (t) => {
  const h = await setup(t); h.settings.globalAllowlist = ["project"];
  await saveProjectAllowlist(h.cwd, ["global"]);
  const wrong = event(), original = wrong.systemPromptOptions.skills; await h.emit("before_agent_start", wrong);
  assert.deepEqual(wrong.systemPromptOptions.skills, [original[3]]);
  await saveProjectAllowlist(h.cwd, ["project"]);
  const allowed = event(); await h.emit("before_agent_start", allowed); assert.deepEqual(allowed.systemPromptOptions.skills.map((s) => s.name), ["project", "manual"]);
  const otherCwd = join(h.cwd, "other-cwd"); await mkdir(otherCwd); h.ctx.cwd = otherCwd;
  const other = event(); await h.emit("before_agent_start", other); assert.deepEqual(other.systemPromptOptions.skills.map((s) => s.name), ["manual"]);
});
test("malformed project list warns once and continues scoring closed instead of revealing inventory", async (t) => {
  const h = await setup(t); await mkdir(join(h.cwd, ".pi")); await writeFile(projectAllowlistPath(h.cwd), "PRIVATE_INVALID_JSON");
  for (let i = 0; i < 2; i++) {
    const e = event(); await h.emit("before_agent_start", e); assert.deepEqual(e.systemPromptOptions.skills.map((s) => s.name), ["global", "manual"]);
  }
  assert.equal(h.requests.length, 2); assert.equal(h.messages.filter((m) => m.includes("project skill allowlist")).length, 1);
  assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE_INVALID_JSON|PRIVATE_PROVIDER_ERROR/);
});
test("inventory snapshot precedes filtering even while disabled, then reload falls back to current commands", async (t) => {
  const h = await setup(t);
  assert.match(await h.editor("project"), /fallback-only/);
  assert.doesNotMatch(await h.editor("project"), /private/);
  const e = event(); await h.emit("before_agent_start", e);
  assert.ok(!e.systemPromptOptions.skills.some((skill) => skill.name === "other"));
  const filteredSnapshot = await h.editor("project");
  assert.match(filteredSnapshot, /other/); assert.doesNotMatch(filteredSnapshot, /fallback-only|private/);
  await h.command("disable");
  const disabled = event(); disabled.systemPromptOptions.skills[2].name = "new-project-skill";
  await h.emit("before_agent_start", disabled);
  assert.match(await h.editor("project"), /new-project-skill/);
  await h.emit("session_start", { type: "session_start", reason: "reload" });
  assert.match(await h.editor("project"), /fallback-only/);
  assert.doesNotMatch(await h.editor("project"), /new-project-skill/);
});
test("project allowlist saves cancel an active decision and the next task uses the new list", async (t) => {
  // Cancellation of project writes uses the same operation registry as settings changes.
  const h = await setup(t, "pending"); await saveProjectAllowlist(h.cwd, ["project"]);
  const interrupted = event(); const pending = h.emit("before_agent_start", interrupted); await h.ready;
  await h.command("allow project add other"); await pending;
  assert.equal(h.cancelled(), true);
  assert.deepEqual(interrupted.systemPromptOptions.skills.map((s) => s.name), ["global", "project", "manual"]);
  const e = event(); await h.emit("before_agent_start", e);
  assert.deepEqual(e.systemPromptOptions.skills.map((s) => s.name), ["global", "project", "other", "manual"]);
  assert.equal(h.requests.length, 1, "all candidates now always included, so no further endpoint call");
});
test("legacy unscoped pins remain always included and are omitted from scoring", async (t) => {
  const h = await setup(t); h.settings.globalAllowlist = []; h.settings.relevance.pinned = ["project"];
  const e = event(); await h.emit("before_agent_start", e);
  assert.deepEqual(e.systemPromptOptions.skills.map((s) => s.name), ["project", "manual"]);
  assert.doesNotMatch(JSON.stringify(h.requests), /Project metadata/);
});
