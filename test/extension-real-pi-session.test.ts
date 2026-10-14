// The additive picker against the REAL Pi AgentSession (installed dev dependency), fully offline:
// a faux provider answers model requests, an in-memory SessionManager records what Pi really persists,
// and the decision client is injected. This checks Pi's actual commit order, branch contents,
// context conversion and compaction behavior, which the SimSession stand-in only mirrors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createSyntheticSourceInfo, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory, type Skill } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import { defaultSettings, saveSettings } from "../src/settings.ts";
import { SKILLS_MESSAGE_TYPE } from "../src/extension/skill-ledger.ts";
import { readDecisionsHistory } from "../src/extension/decisions-history.ts";

async function realPi(t: { after(fn: () => Promise<void>): void }, cadence: "prompt" | "tool-round", script: (ctx: { session: () => AgentSession }) => Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], globalAllowlist: string[] = [], earlier?: (pi: Parameters<ExtensionFactory>[0]) => void) {
  const root = await mkdtemp(join(tmpdir(), "real-pi-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"); await mkdir(agentDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const settingsPath = join(root, "settings.json");
  await saveSettings({ ...defaultSettings(), globalAllowlist, backend: { backend: "typesafe", model: "jev-latest" }, relevance: { ...defaultSettings().relevance, minCandidates: 0, maxSkills: 2, cadence } }, settingsPath);
  const skills: Skill[] = Array.from({ length: 6 }, (_, i) => ({ name: `skill-${i}`, description: `Does thing ${i}`, filePath: `/virtual/${i}/SKILL.md`, baseDir: `/virtual/${i}`,
    sourceInfo: createSyntheticSourceInfo(`/virtual/${i}/SKILL.md`, { source: "sdk" }), disableModelInvocation: false }));
  const faux = createFauxCore({ provider: "fauxprov", models: [{ id: "faux-1" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false } as never);
  runtime.registerProvider("fauxprov", { baseUrl: "http://faux.invalid", apiKey: "x", api: faux.api, streamSimple: faux.streamSimple,
    models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] } as never);
  const decisions: { task: string; skills: string[] }[] = [];
  let live: AgentSession | undefined;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, noSkills: true, skillsOverride: () => ({ skills, diagnostics: [] }),
    extensionFactories: [...(earlier ? [earlier as ExtensionFactory] : []), (pi) => registerContextDecisions(pi, { settingsPath, env: {}, report() {},
      createClient: () => createDecisionClient({ id: "pi", model: "fixture", async decide(request) {
        const metadata = request.state.skills as Record<string, { name: string }>;
        decisions.push({ task: String(request.state.task), skills: Object.values(metadata).map((skill) => skill.name) });
        return { answers: Object.fromEntries(Object.entries(metadata).map(([id, skill]) => [id, { type: "score", score: 2 - Number(skill.name.slice(6)) * 0.2 }])) };
      } }) })] });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(root);
  const created = await createAgentSession({ settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } } as never),
    resourceLoader: loader, sessionManager, model: runtime.getModel("fauxprov", "faux-1")!, modelRuntime: runtime, cwd: root } as never);
  live = created.session; t.after(async () => created.session.dispose());
  await created.session.bindExtensions({});
  faux.setResponses(script({ session: () => live! }));
  const contexts: { messages: { role: string; content?: unknown; sections?: Record<string, string> }[] }[] = [];
  const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((block: { text?: string }) => block.text ?? "").join("") : "";
  const branch = () => sessionManager.getBranch().map((entry) => entry.type === "custom_message" ? `delta${JSON.stringify((entry.details as { added: string[] }).added)}${(entry.details as { redelivered: string[] }).redelivered.length ? `+${JSON.stringify((entry.details as { redelivered: string[] }).redelivered)}` : ""}`
    : entry.type === "message" ? entry.message.role : entry.type).filter((name) => !["model_change", "thinking_level_change", "system"].includes(name));
  return { session: created.session, faux, decisions, branch, contexts, text, root, sessionManager, root_: root,
    record: (ctx: unknown) => { contexts.push(ctx as (typeof contexts)[number]); } };
}
const TOOL = () => fauxToolCall("read", { path: "package.json" });

test("real Pi, prompt cadence: the delta is persisted right after the user message and reaches the model as user-role text", async (t) => {
  let h!: Awaited<ReturnType<typeof realPi>>;
  h = await realPi(t, "prompt", () => [(ctx) => { h.record(ctx); return fauxAssistantMessage([TOOL()], { stopReason: "toolUse" }); }, (ctx) => { h.record(ctx); return fauxAssistantMessage([fauxText("done")]); }]);
  await h.session.prompt("write something about thing 0");
  assert.deepEqual(h.branch(), ["user", 'delta["skill-0","skill-1"]', "assistant", "toolResult", "assistant"]);
  assert.deepEqual(h.decisions.map((d) => d.skills.length), [6]);
  for (const ctx of h.contexts) {
    const system = ctx.messages.filter((m) => m.role === "system");
    assert.ok(system.every((m) => !/skill-0|skill-1/.test(JSON.stringify(m))), "the system prompt never carries the added skills");
    const users = ctx.messages.filter((m) => m.role === "user").map(h.text);
    assert.match(users[1], /^Additional skills are now available; previously listed skills remain available\./);
    assert.match(users[1], /<name>skill-0<\/name>[\s\S]*<name>skill-1<\/name>/); assert.doesNotMatch(users[1], /skill-2/);
  }
  assert.equal(h.contexts.length, 2, "a tool round happened but no extra model request was created by the extension");
});
test("real Pi, tool-round cadence: the next-best skills arrive between the tool result and the next request with no extra decision call", async (t) => {
  let h!: Awaited<ReturnType<typeof realPi>>;
  h = await realPi(t, "tool-round", () => [(ctx) => { h.record(ctx); return fauxAssistantMessage([TOOL()], { stopReason: "toolUse" }); }, (ctx) => { h.record(ctx); return fauxAssistantMessage([fauxText("done")]); }]);
  await h.session.prompt("write something about thing 0");
  assert.deepEqual(h.branch(), ["user", 'delta["skill-0","skill-1"]', "assistant", "toolResult", 'delta["skill-2","skill-3"]', "assistant"]);
  assert.equal(h.decisions.length, 1, "cached scores: the tool round made no decision call");
  const second = h.contexts[1].messages.filter((m) => m.role === "user").map(h.text);
  assert.match(second.at(-1)!, /<name>skill-2<\/name>[\s\S]*<name>skill-3<\/name>/);
  assert.equal(h.faux.state.callCount, 2);
  const history = readDecisionsHistory(h.sessionManager);
  assert.deepEqual(history.batches.map((b) => [b.turn, b.items.skills]), [[1, ["skill-0", "skill-1"]], [2, ["skill-2", "skill-3"]]], "history follows real Pi commit boundaries");
});
test("real Pi: steering text queued during a run is picked at turn_end from that text, over the remaining candidates only", async (t) => {
  let h!: Awaited<ReturnType<typeof realPi>>;
  h = await realPi(t, "prompt", ({ session }) => [(ctx) => { h.record(ctx); void session().steer("steer text about thing 5"); return fauxAssistantMessage([TOOL()], { stopReason: "toolUse" }); },
    (ctx) => { h.record(ctx); return fauxAssistantMessage([fauxText("done")]); }]);
  await h.session.prompt("write something about thing 0");
  assert.deepEqual(h.branch(), ["user", 'delta["skill-0","skill-1"]', "assistant", "toolResult", 'delta["skill-2","skill-3"]', "user", "assistant"],
    "the delta is committed before Pi injects the steering message");
  assert.deepEqual(h.decisions, [
    { task: "write something about thing 0", skills: ["skill-0", "skill-1", "skill-2", "skill-3", "skill-4", "skill-5"] },
    { task: "steer text about thing 5", skills: ["skill-2", "skill-3", "skill-4", "skill-5"] },
  ]);
});
test("real Pi: after compaction, lost deltas are re-delivered at the next prompt without scoring them", async (t) => {
  let h!: Awaited<ReturnType<typeof realPi>>;
  // Compaction issues its own summarization requests; answer those separately from chat turns.
  const reply = (ctx: { messages: { role: string; content?: unknown }[] }) => {
    const user = ctx.messages.filter((m) => m.role === "user").map(h.text).join("\n");
    if (/<conversation>|# Conversation/.test(user) && !/second, different task/.test(user)) return fauxAssistantMessage([fauxText("## Goal\nSUMMARY")]);
    h.record(ctx); return fauxAssistantMessage([fauxText("answer")]);
  };
  h = await realPi(t, "prompt", () => Array.from({ length: 8 }, () => reply as never));
  await h.session.prompt("write something about thing 0");
  await h.session.compact();
  assert.equal(h.branch().at(-1), "compaction");
  await h.session.prompt("a second, different task about thing 4");
  assert.deepEqual(h.decisions.at(-1), { task: "a second, different task about thing 4", skills: ["skill-2", "skill-3", "skill-4", "skill-5"] }, "added skills are not re-scored");
  assert.equal(h.branch().at(-2), 'delta["skill-2","skill-3"]+["skill-0","skill-1"]', "new additions and re-delivery in one delta, kept separate in details");
  const last = h.contexts.at(-1)!.messages.filter((m) => m.role === "user").map(h.text);
  assert.match(last.at(-1)!, /<name>skill-2<\/name>[\s\S]*<name>skill-3<\/name>[\s\S]*<name>skill-0<\/name>[\s\S]*<name>skill-1<\/name>/, "new skills first, then the re-delivered ones, in one canonical block");
  assert.equal(SKILLS_MESSAGE_TYPE, "context-decisions-skills");
});
test("real Pi: an always-allowed skill is the stable system-prompt base, recorded once, never scored, and survives allowlist removal", async (t) => {
  let h!: Awaited<ReturnType<typeof realPi>>;
  h = await realPi(t, "prompt", () => Array.from({ length: 4 }, () => ((ctx: never) => { h.record(ctx); return fauxAssistantMessage([fauxText("ok")]); }) as never), ["skill-5"]);
  await h.session.prompt("write something about thing 0");
  assert.deepEqual(h.branch(), ["custom", "user", 'delta["skill-0","skill-1"]', "assistant"], "one base record, then the user message, then the delta");
  assert.deepEqual(h.decisions[0].skills, ["skill-0", "skill-1", "skill-2", "skill-3", "skill-4"], "the pin is never scored");
  const history = readDecisionsHistory(h.sessionManager);
  assert.equal(history.batches.length, 1, "base record before user and delta after user form ONE batch");
  assert.deepEqual(history.batches[0].items.pinned, ["skill-5"], "history confirms the pinned/allowlisted base in the actual Pi system section");
  assert.equal(history.batches[0].marks?.pinned?.get("skill-5"), "pinned/allowlisted", "a pin is never shown with a number");
  assert.deepEqual(history.batches[0].items.base, []);
  assert.deepEqual(history.batches[0].items.skills, ["skill-0", "skill-1"]);
  const system = JSON.stringify(h.contexts[0].messages.filter((m) => m.role === "system"));
  assert.match(system, /<name>skill-5<\/name>/); assert.doesNotMatch(system, /skill-0/);
  await h.session.prompt("another task");
  assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "custom").length, 1, "the base record is appended only when the base grows");
  const second = JSON.stringify(h.contexts[1].messages.filter((m) => m.role === "system"));
  assert.match(second, /skill-5/);
});
test("real Pi: our turn_end draft does not erase another extension's boundary draft (emitBoundary replaces accumulated entries)", async (t) => {
  let h!: Awaited<ReturnType<typeof realPi>>;
  h = await realPi(t, "tool-round", () => [(ctx) => { h.record(ctx); return fauxAssistantMessage([TOOL()], { stopReason: "toolUse" }); }, (ctx) => { h.record(ctx); return fauxAssistantMessage([fauxText("done")]); }], [],
    (pi) => { pi.on("turn_end", (event) => event.toolResults.length ? { entries: [...event.entries, { type: "custom", customType: "earlier-extension", data: { kept: true } }] } : undefined); });
  await h.session.prompt("write something about thing 0");
  const entries = h.sessionManager.getBranch();
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "earlier-extension").length, 1, "the earlier extension's draft is committed");
  assert.deepEqual(entries.filter((entry) => entry.type === "custom_message").map((entry) => (entry.details as { added: string[] }).added), [["skill-0", "skill-1"], ["skill-2", "skill-3"]], "and so is ours");
});
