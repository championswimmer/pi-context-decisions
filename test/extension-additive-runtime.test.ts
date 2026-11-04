// Native skill selection exercised through runtime hooks with a branch-aware Pi stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent, Skill } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext } from "../src/extension/contracts.ts";
import { advertisedSkillNames } from "../src/extension/skill-state.ts";
import { defaultSettings, saveSettings, type RelevanceSettings, type DecisionSettings } from "../src/settings.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";
import { SimSession, simHost, turnEnd } from "./helpers/pi-sim.ts";

const makeSkills = (): Skill[] => Array.from({ length: 6 }, (_, i) => ({
  name: `skill-${i}`, description: `Description ${i}`, filePath: `/private/${i}/SKILL.md`, baseDir: `/private/${i}`,
  sourceInfo: { path: `/private/${i}/SKILL.md`, source: "fixture", scope: "user", origin: "top-level" }, disableModelInvocation: false,
}));
async function setup(t: { after(fn: () => Promise<void>): void }, options: { relevance?: Partial<RelevanceSettings>; decision?: Partial<DecisionSettings>; pins?: string[]; tools?: string[]; unconfigured?: boolean; fail?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-skill-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json"); const base = defaultSettings();
  await saveSettings({ ...base, backend: options.unconfigured ? null : { backend: "pi", provider: "fixture", id: "classifier" }, globalAllowlist: options.pins ?? [], decision: { ...base.decision, ...options.decision }, relevance: { ...base.relevance, minCandidates: 0, maxSkills: 2, ...options.relevance } }, path);
  const sim = simHost(new SimSession(), options.tools);
  const inventory = makeSkills(); const requests: DecisionRequest[] = []; const messages: string[] = [];
  const behavior: { fail: boolean; gate?: Promise<void>; allowlistGate?: Promise<void> } = { fail: !!options.fail };
  registerContextDecisions(sim.pi, { settingsPath: path, env: {}, report(_ctx, message) { messages.push(message); },
    async loadProjectAllowlist() { if (behavior.allowlistGate) await behavior.allowlistGate; return { names: [], tools: [], mcpServers: [], warnings: [] }; },
    createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide(request) {
      requests.push(request); if (behavior.gate) await behavior.gate;
      if (behavior.fail) throw Object.assign(new Error("PRIVATE failure"), { code: "http" });
      const skills = request.state.skills as Record<string, { name: string }>;
      return { answers: Object.fromEntries(Object.entries(skills).map(([id, skill]) => [id, { type: "score", score: 2 - Number(skill.name.slice(6)) * 0.1 }])) };
    } }); } });
  const ctx: CommandContext = { hasUI: false, mode: "print", modelRegistry: { getModelsOfType() { return []; }, findOfType() { return { provider: "fixture", id: "classifier" }; }, async getApiKeyForProvider() { return undefined; }, async classify() { throw new Error("injected"); } }, ui: { async select() { return undefined; }, async input() { return undefined; }, notify() {}, setStatus() {} } };
  const event = (prompt: string): BeforeAgentStartEvent => ({ type: "before_agent_start", prompt, systemPrompt: "unchanged", systemPromptOptions: { cwd: root, skills: [...inventory], selectedTools: [...sim.tools.active], sections: {}, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] } });
  await sim.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const start = async (prompt: string) => { const e = event(prompt); await sim.emit("before_agent_start", e, ctx); return e.systemPromptOptions.skills.map((s) => s.name); };
  const scored = (from = 0) => requests.slice(from).flatMap((request) => Object.values(request.state.skills as Record<string, { name: string }>).map((skill) => skill.name));
  return { sim, ctx, inventory, requests, messages, behavior, start, event, scored, path };
}

test("Pi skills section grows on later prompts, excluding committed skills from scoring", async (t) => {
  const h = await setup(t); assert.deepEqual(await h.start("first"), ["skill-0", "skill-1"]);
  assert.deepEqual(await h.start("second"), ["skill-0", "skill-1", "skill-2", "skill-3"]);
  assert.deepEqual(h.scored(1), ["skill-2", "skill-3", "skill-4", "skill-5"]);
  assert.deepEqual([...advertisedSkillNames(h.sim.session as never)], ["skill-0", "skill-1", "skill-2", "skill-3"]);
  assert.equal(h.sim.session.getBranch().filter((e) => e.type === "custom_message" || e.type === "custom").length, 0);
  assert.doesNotMatch(JSON.stringify(h.requests), /private|SKILL\.md|filePath|baseDir/);
});

test("pins and manual-only skills bypass scoring; unpinning never drops a committed skill", async (t) => {
  const h = await setup(t, { pins: ["skill-5"], relevance: { maxSkills: 1 } }); h.inventory[4].disableModelInvocation = true;
  assert.deepEqual(await h.start("task"), ["skill-0", "skill-4", "skill-5"]);
  assert.ok(!h.scored().includes("skill-4") && !h.scored().includes("skill-5"));
  await saveSettings({ ...defaultSettings(), backend: { backend: "pi", provider: "fixture", id: "classifier" }, relevance: { ...defaultSettings().relevance, minCandidates: 0, maxSkills: 1 } }, h.path);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  assert.deepEqual(await h.start("next"), ["skill-0", "skill-1", "skill-4", "skill-5"]);
});

test("fail-closed retries later; fail-open advertises all", async (t) => {
  const closed = await setup(t, { fail: true }); assert.deepEqual(await closed.start("first"), []);
  assert.doesNotMatch(JSON.stringify(closed.messages), /PRIVATE/); closed.behavior.fail = false;
  assert.deepEqual(await closed.start("retry"), ["skill-0", "skill-1"]);
  const open = await setup(t, { fail: true, decision: { failMode: "open" } });
  assert.equal((await open.start("failed")).length, 6); const calls = open.requests.length;
  assert.equal((await open.start("again")).length, 6); assert.equal(open.requests.length, calls);
});

test("unconfigured and below-minimum advertise all, later filtering cannot drop them", async (t) => {
  for (const opts of [{ unconfigured: true }, { relevance: { minCandidates: 20 } }]) {
    const h = await setup(t, opts); assert.equal((await h.start("first")).length, 6); assert.equal(h.requests.length, 0);
    await saveSettings({ ...defaultSettings(), backend: { backend: "pi", provider: "fixture", id: "classifier" }, relevance: { ...defaultSettings().relevance, minCandidates: 0, maxSkills: 1 } }, h.path);
    await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
    assert.equal((await h.start("second")).length, 6); assert.equal(h.requests.length, 0);
  }
});

test("readerless prompts do not score or commit names; later reader scores normally", async (t) => {
  const h = await setup(t, { tools: [] }); await h.start("without reader");
  assert.equal(h.requests.length, 0); assert.deepEqual([...advertisedSkillNames(h.sim.session as never)], []);
  h.sim.tools.active = ["bash"]; assert.deepEqual(await h.start("with reader"), ["skill-0", "skill-1"]);
});


test("readerless pinned and passthrough skills are not reported as advertised", async (t) => {
  for (const opts of [{ pins: ["skill-5"] }, { unconfigured: true }, { relevance: { minCandidates: 20 } }]) {
    const h = await setup(t, { ...opts, tools: [] }); await h.start("without reader");
    await h.sim.commands.get("decisions")!.handler("status", h.ctx as never);
    assert.match(h.messages.at(-1) ?? "", /Advertised: 0/);
  }
});

test("committed names survive compaction and context edits on reload without redelivery", async (t) => {
  const h = await setup(t); await h.start("first");
  const branch = h.sim.session.getBranch();
  const firstUser = branch.find((entry) => entry.message?.role === "user")!;
  h.sim.session.compact(firstUser.id); h.sim.session.edit(firstUser.id, null);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  const before = h.requests.length; assert.deepEqual(await h.start("after compaction"), ["skill-0", "skill-1", "skill-2", "skill-3"]);
  assert.deepEqual(h.scored(before), ["skill-2", "skill-3", "skill-4", "skill-5"]);
  assert.ok(h.sim.session.getBranch().every((entry) => entry.customType !== "context-decisions-skills"));
});

test("active-branch history controls selection after navigation", async (t) => {
  const h = await setup(t); await h.start("first"); const forkPoint = h.sim.session.leaf!;
  await h.start("second"); h.sim.session.navigate(forkPoint); await h.sim.emit("session_tree", {}, h.ctx);
  const before = h.requests.length; assert.deepEqual(await h.start("alternate"), ["skill-0", "skill-1", "skill-2", "skill-3"]);
  assert.deepEqual(h.scored(before), ["skill-2", "skill-3", "skill-4", "skill-5"]);
});

test("late classifier completion after cancellation cannot add new skills", async (t) => {
  const h = await setup(t); let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const abort = new AbortController(); h.ctx.signal = abort.signal; const e = h.event("task");
  const pending = h.sim.emit("before_agent_start", e, h.ctx);
  while (!h.requests.length) await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort(); release(); await pending;
  assert.deepEqual(e.systemPromptOptions.skills, []); assert.deepEqual([...advertisedSkillNames(h.sim.session as never)], []);
});

test("turn boundaries no longer score or emit skill messages", async (t) => {
  const h = await setup(t); await h.start("task"); const calls = h.requests.length;
  await turnEnd(h.sim, h.ctx, { toolResults: [{ toolName: "read" }] });
  assert.equal(h.requests.length, calls); assert.ok(h.sim.session.getBranch().every((e) => e.customType !== "context-decisions-skills"));
});


test("retains committed skill metadata and order despite inventory changes", async (t) => {
  const h = await setup(t, { relevance: { maxSkills: 1 } });
  await h.start("first");
  const original = h.inventory.shift()!; original.description = "Changed object";
  // A separately reloaded inventory object must not replace the committed reference.
  h.inventory.unshift({ ...original, description: "Reloaded description" });
  await h.start("second");
  const sections = h.sim.session.getBranch().filter((e) => e.message?.role === "system");
  assert.match(sections.at(-1)?.message?.sections?.skills ?? "", /Description 0/);
  assert.doesNotMatch(sections.at(-1)?.message?.sections?.skills ?? "", /Reloaded description/);
  h.inventory.shift(); await h.start("third");
  assert.ok(advertisedSkillNames(h.sim.session as never).has("skill-0"));
});

test("unreadable branch fails closed without rejecting the tool pass", async (t) => {
  const h = await setup(t); h.sim.session.getBranch = () => { throw new Error("PRIVATE branch"); };
  const e = h.event("task"); await h.sim.handlers.get("before_agent_start")![0](e, { ...h.ctx, sessionManager: h.sim.session } as never);
  assert.deepEqual(e.systemPromptOptions.skills, []); assert.equal(h.requests.length, 0);
});

test("only bounded previous final reply is supplied to next prompt scoring", async (t) => {
  const h = await setup(t); await h.start("first");
  const assistant = h.sim.session.appendMessage("assistant", [{ type: "thinking", thinking: "SECRET_THINKING" }, { type: "text", text: "visible".repeat(1000) }]); assistant.message!.stopReason = "stop";
  await h.start("next");
  const state = h.requests.at(-1)!.state;
  assert.equal((state.previousReply as { text: string }).text.length, 2000);
  assert.doesNotMatch(JSON.stringify(state), /SECRET_THINKING/);
});
