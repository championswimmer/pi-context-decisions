// Additive, branch-aware skill advertisement through the REAL runtime hooks, with an offline Pi session stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, type BeforeAgentStartEvent, type Skill } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext } from "../src/extension/contracts.ts";
import { SKILLS_BASE_ENTRY, SKILLS_MESSAGE_TYPE, readLedger } from "../src/extension/skill-ledger.ts";
import { defaultSettings, saveSettings, type ContextDecisionsSettings, type RelevanceSettings } from "../src/settings.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";
import { SimSession, advertised, deltaMessages, simHost, turnEnd } from "./helpers/pi-sim.ts";

const COUNT = 12;
const makeSkills = (count = COUNT): Skill[] => Array.from({ length: count }, (_, i) => ({
  name: `skill-${i}`, description: `Description ${i}`, filePath: `/private/${i}/SKILL.md`, baseDir: `/private/${i}`,
  sourceInfo: { path: `/private/${i}/SKILL.md`, source: "fixture", scope: i === 11 ? "project" as const : "user" as const, origin: "top-level" as const }, disableModelInvocation: false,
}));
/** skill-0 is the best match (2.0), skill-1 1.9 … skill-9 1.1, skill-10 1.0, skill-11 0.9: all pass the default threshold. */
const defaultScore = (name: string) => 2 - Number(name.slice(6)) * 0.1;

interface Options {
  relevance?: Partial<RelevanceSettings>; settings?: Partial<ContextDecisionsSettings>; skills?: Skill[];
  score?: (name: string, task: string) => number; fail?: boolean; hang?: boolean; tools?: string[]; unconfigured?: boolean;
}
async function setup(t: { after(fn: () => Promise<void>): void }, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "additive-runtime-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  const base = defaultSettings();
  await saveSettings({ ...base, backend: options.unconfigured ? null : { backend: "pi", provider: "fixture", id: "classifier" }, ...options.settings,
    relevance: { ...base.relevance, minCandidates: 0, maxSkills: 3, ...options.relevance } }, path);
  const sim = simHost(new SimSession(), options.tools);
  const behavior: { hang: boolean; fail: boolean; gate?: Promise<void>; allowlistGate?: Promise<void> } = { hang: options.hang === true, fail: options.fail === true };
  const requests: DecisionRequest[] = [];
  const messages: string[] = [];
  const signals: AbortSignal[] = [];
  const inventory = options.skills ?? makeSkills();
  registerContextDecisions(sim.pi, { settingsPath: path, env: {}, report(_ctx, message) { messages.push(message); },
    async loadProjectAllowlist() { if (behavior.allowlistGate) await behavior.allowlistGate; return { names: ["skill-11"], tools: [], mcpServers: [], warnings: [] }; }, // skill-11 is the project-scoped fixture skill
    createClient() { return createDecisionClient({ id: "pi", model: "fixture", async decide(request, decide) {
      requests.push(request); if (decide?.signal) signals.push(decide.signal);
      assert.doesNotMatch(JSON.stringify(request), /private|SKILL\.md|filePath|baseDir|sourceInfo|<available_skills>|Additional skills/);
      if (behavior.hang) return new Promise<never>(() => {});
      if (behavior.gate) await behavior.gate; // a backend that ignores cancellation and answers late
      if (behavior.fail) throw Object.assign(new Error("PRIVATE provider failure"), { code: "http" });
      const metadata = request.state.skills as Record<string, { name: string }>;
      return { answers: Object.fromEntries(Object.entries(metadata).map(([id, skill]) => [id, { type: "score", score: (options.score ?? defaultScore)(skill.name, String(request.state.task)) }])), usage: { inputTokens: 2 } };
    } }); } });
  const ctx: CommandContext = { hasUI: false, mode: "print", modelRegistry: { getModelsOfType() { return []; }, findOfType() { return { provider: "fixture", id: "classifier" }; }, async getApiKeyForProvider() { return undefined; }, async classify() { throw new Error("injected"); } },
    ui: { async select() { return undefined; }, async input() { return undefined; }, notify() {}, setStatus() {} } };
  const event = (prompt: string, skills = inventory): BeforeAgentStartEvent => ({ type: "before_agent_start", prompt, systemPrompt: "unchanged",
    systemPromptOptions: { cwd: "/fixture", skills: [...skills], selectedTools: ["read", "bash"], sections: {}, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [] } });
  const scoredNames = (from = 0) => requests.slice(from).flatMap((r) => Object.values(r.state.skills as Record<string, { name: string }>).map((s) => s.name));
  const h = {
    sim, ctx, requests, messages, signals, inventory, path, scoredNames, event, behavior,
    async start(prompt: string, skills = inventory, extra: Record<string, unknown> = {}) {
      const e = { ...event(prompt, skills), ...extra } as BeforeAgentStartEvent;
      await sim.emit("before_agent_start", e, ctx);
      return { e, system: e.systemPromptOptions.skills, shown: () => advertised(sim, skills, e.systemPromptOptions.skills) };
    },
    end: (turn: Parameters<typeof turnEnd>[2] = {}) => turnEnd(sim, ctx, turn),
    async command(args: string) { await sim.command(args, ctx); },
    deltas: () => deltaMessages(sim.session),
    appended: () => sim.appended,
    names: (entry: { details?: unknown }) => (entry.details as { added: string[] }).added,
  };
  await sim.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  return h;
}
const nameList = (...indexes: number[]) => indexes.map((i) => `skill-${i}`);
const TOOL = [{ toolName: "read", content: "TOOL-RESULT-SECRET" }];

test("round 1 adds the best skills; the system prompt keeps only the stable base and the delta is hidden canonical text", async (t) => {
  const h = await setup(t);
  const first = await h.start("write the thing");
  assert.deepEqual(first.system, [], "no pins: nothing is ever appended to the system prompt skills");
  assert.deepEqual(first.shown(), nameList(0, 1, 2));
  const [delta] = h.deltas();
  assert.equal(delta.display, false); assert.deepEqual(h.names(delta), nameList(0, 1, 2));
  const added = h.inventory.slice(0, 3);
  assert.equal(delta.content, `Additional skills are now available; previously listed skills remain available.\n\n${formatSkillsForPrompt(added, "read").trim()}`);
  assert.match(String(delta.content), /<location>\/private\/0\/SKILL\.md<\/location>/, "canonical locations reach the chat model");
  assert.doesNotMatch(String(delta.content), /skill-3/);
  assert.deepEqual(h.scoredNames(), h.inventory.map((s) => s.name), "all twelve candidates were scored in round 1");
  assert.doesNotMatch(JSON.stringify(h.requests), /SKILL\.md|private/, "locations never enter the decision payload");
});
test("round 2 never scores or re-adds what is already advertised, even for a different prompt", async (t) => {
  const h = await setup(t);
  await h.start("first task");
  const before = h.requests.length;
  const second = await h.start("a different task");
  assert.deepEqual(h.scoredNames(before), nameList(3, 4, 5, 6, 7, 8, 9, 10, 11), "only never-advertised skills are candidates");
  assert.ok(!h.scoredNames(before).some((name) => nameList(0, 1, 2).includes(name)));
  assert.deepEqual(second.shown(), nameList(0, 1, 2, 3, 4, 5), "earlier additions stay advertised; three more are added");
  assert.deepEqual(h.deltas().map(h.names), [nameList(0, 1, 2), nameList(3, 4, 5)]);
  assert.doesNotMatch(String(h.deltas()[1].content), /skill-[012]\b/, "the new delta carries only the new skills");
  assert.deepEqual(second.system, [], "the system prompt skills stay identical (no section patch)");
});
test("maxSkills caps additions per round across shards and counts neither pins nor already-added skills", async (t) => {
  const h = await setup(t, { relevance: { chunkSize: 4, maxSkills: 5 }, settings: { globalAllowlist: ["skill-8"] } });
  const first = await h.start("task");
  assert.deepEqual(h.requests.map((r) => Object.keys(r.questions).length), [4, 4, 3], "shards of four over the eleven non-pinned candidates");
  assert.deepEqual(first.shown(), nameList(0, 1, 2, 3, 4, 8), "five best new skills plus the pin; the cap spans all shards");
  assert.ok(!h.scoredNames().includes("skill-8"), "pins are never scored");
  await h.start("again");
  assert.deepEqual(h.scoredNames(3), nameList(5, 6, 7, 9, 10, 11), "round 2: neither pins nor round-1 additions");
});
test("a stale or aborted round commits nothing: the ledger comes only from committed messages", async (t) => {
  const h = await setup(t, { hang: true, relevance: { timeoutMs: 5000 } });
  const abort = new AbortController(); h.ctx.signal = abort.signal;
  const e = h.event("task");
  const pending = h.sim.emit("before_agent_start", e, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.command("relevance maxSkills 4"); // saving settings supersedes the in-flight round
  await pending;
  assert.deepEqual(h.deltas(), [], "a superseded round appends no delta");
  assert.deepEqual([...readLedger(h.sim.session).added], []);
  assert.ok(h.signals.every((signal) => signal.aborted), "the in-flight decision was cancelled");
});
test("an aborted run adds nothing and a failed round retries cleanly on the next prompt", async (t) => {
  const h = await setup(t);
  const abort = new AbortController(); abort.abort(); h.ctx.signal = abort.signal;
  await h.start("task"); assert.deepEqual(h.deltas(), []); assert.equal(h.requests.length, 0);
  h.ctx.signal = undefined;
  const next = await h.start("task again"); assert.deepEqual(next.shown(), nameList(0, 1, 2), "nothing was lost: those skills were never advertised");
});
test("fail-closed adds nothing and reports a safe code; later prompts may still add", async (t) => {
  const h = await setup(t, { fail: true });
  const first = await h.start("task");
  assert.deepEqual(first.shown(), []); assert.deepEqual(h.deltas(), []);
  assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE/);
  assert.match(h.messages.at(-1)!, /fail-closed \(network\)/);
});
test("explicit fail-open adds every remaining candidate exactly once, then nothing is left to score", async (t) => {
  const h = await setup(t, { fail: true, relevance: { failMode: "open" } });
  const first = await h.start("task");
  assert.deepEqual(first.shown(), h.inventory.map((s) => s.name));
  assert.equal(h.deltas().length, 1);
  const calls = h.requests.length;
  const second = await h.start("task two");
  assert.equal(h.requests.length, calls, "everything is advertised: no candidates, no call");
  assert.equal(h.deltas().length, 1); assert.equal(second.shown().length, COUNT);
});
test("disabled, unconfigured and below-minimum keep everything advertised and the branch remembers it forever", async (t) => {
  const h = await setup(t, { relevance: { minCandidates: 20 } });
  const first = await h.start("task");
  assert.equal(h.requests.length, 0); assert.equal(first.shown().length, COUNT); assert.deepEqual(h.deltas(), []);
  assert.deepEqual([...readLedger(h.sim.session).base].sort(), h.inventory.map((s) => s.name).sort());
  await h.command("relevance minCandidates 0");
  const later = await h.start("task two");
  assert.equal(h.requests.length, 0, "everything was already advertised: filtering later cannot score or drop anything");
  assert.equal(later.shown().length, COUNT); assert.equal(later.system.length, COUNT, "the stable base still lists them all");
});
test("disabled and unconfigured also record exposure; re-enabling never removes skills the model saw", async (t) => {
  for (const mode of ["disabled", "unconfigured"] as const) {
    const h = await setup(t, mode === "unconfigured" ? { unconfigured: true } : {});
    if (mode === "disabled") await h.command("disable");
    const off = await h.start("task");
    assert.equal(off.shown().length, COUNT, mode);
    if (mode === "disabled") await h.command("enable"); else await h.command("model pi fixture classifier");
    const on = await h.start("task two");
    assert.equal(on.shown().length, COUNT, `${mode}: nothing dropped`); assert.equal(h.requests.length, 0);
  }
});
test("an empty or expanded-only prompt makes no picks, does not flip the branch, and keeps the base", async (t) => {
  const h = await setup(t, { settings: { globalAllowlist: ["skill-9"] } });
  for (const prompt of ["   ", '<skill name="x" location="/private/x/SKILL.md">\nBODY\n</skill>']) {
    const run = await h.start(prompt);
    assert.deepEqual(run.shown(), ["skill-9"]); assert.equal(h.requests.length, 0);
  }
  assert.deepEqual([...readLedger(h.sim.session).base], ["skill-9"], "only the pin: the branch was not flipped to full advertisement");
  const real = await h.start("real task"); assert.deepEqual(real.shown(), ["skill-0", "skill-1", "skill-2", "skill-9"]);
});
test("pins join the stable base, bypass threshold/cap/scoring, and allowlist removals never shrink it", async (t) => {
  const h = await setup(t, { settings: { globalAllowlist: ["skill-10"] }, relevance: { maxSkills: 1 } });
  const first = await h.start("task");
  assert.deepEqual(first.system.map((s) => s.name), ["skill-10"]); assert.deepEqual(first.shown(), ["skill-0", "skill-10"]);
  await h.command("pin skill-9");
  const second = await h.start("task two");
  assert.deepEqual(second.system.map((s) => s.name), ["skill-9", "skill-10"]);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  await saveSettings({ ...defaultSettings(), backend: { backend: "pi", provider: "fixture", id: "classifier" }, globalAllowlist: [], relevance: { ...defaultSettings().relevance, minCandidates: 0, maxSkills: 1 } }, h.path);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  const third = await h.start("task three");
  assert.deepEqual(third.system.map((s) => s.name), ["skill-9", "skill-10"], "pins removed from settings stay advertised on this branch");
  assert.ok(!h.scoredNames(2).includes("skill-9") && !h.scoredNames(2).includes("skill-10"));
  assert.deepEqual(h.appended().filter((entry) => entry.customType === SKILLS_BASE_ENTRY).map((entry) => (entry.data as { names: string[] }).names), [["skill-10"], ["skill-9"]], "a base record is appended only when the base grows");
});
test("manual-only skills are never scored or advertised by deltas and keep their place in the system list", async (t) => {
  const skills = makeSkills(); skills[1].disableModelInvocation = true;
  const h = await setup(t, { skills });
  const run = await h.start("task");
  assert.ok(!h.scoredNames().includes("skill-1")); assert.deepEqual(run.shown(), ["skill-0", "skill-2", "skill-3"]);
  assert.deepEqual(run.system.map((s) => s.name), ["skill-1"], "Pi's own manual-only handling is preserved");
  assert.doesNotMatch(String(h.deltas()[0].content), /skill-1\b/);
});
test("compaction summarizes a delta away: the next prompt re-delivers it with ZERO decision calls for it, never re-scoring", async (t) => {
  const h = await setup(t, { relevance: { maxSkills: 2 } });
  await h.start("task one");                      // adds skill-0, skill-1 (summarized away below)
  const keep = h.sim.session.appendMessage("user", "kept after compaction");
  await h.start("task two");                      // adds skill-2, skill-3 (kept)
  h.sim.session.compact(keep.id);
  assert.deepEqual(readLedger(h.sim.session).lost, nameList(0, 1));
  const before = h.requests.length;
  const next = await h.start("task three");
  assert.ok(!h.scoredNames(before).some((name) => ["skill-0", "skill-1", "skill-2", "skill-3"].includes(name)), "restoration never scores added skills");
  const redelivery = h.deltas().at(-1)!;
  assert.deepEqual((redelivery.details as { redelivered: string[] }).redelivered, nameList(0, 1));
  assert.deepEqual(h.names(redelivery), nameList(4, 5), "new additions are reported separately from re-delivered skills");
  assert.match(String(redelivery.content), /skill-0[\s\S]*skill-1/);
  assert.deepEqual(next.shown(), nameList(0, 1, 2, 3, 4, 5));
  assert.deepEqual(readLedger(h.sim.session).lost, []);
});
test("compaction with nothing to add still restores lost skills at the next prompt without any call", async (t) => {
  const h = await setup(t, { relevance: { maxSkills: 12, threshold: 1 } });
  await h.start("t");                          // threshold 1 (raw 2.0): only skill-0 qualifies
  assert.deepEqual(h.deltas().map(h.names), [["skill-0"]]);
  const keep = h.sim.session.appendMessage("user", "kept"); h.sim.session.compact(keep.id);
  const calls = h.requests.length;
  await h.start("t2");
  assert.equal(h.deltas().at(-1)!.details && (h.deltas().at(-1)!.details as { redelivered: string[] }).redelivered[0], "skill-0");
  assert.equal(h.requests.length, calls + 1, "only the unadvertised candidates were scored (cache is per task)");
  assert.ok(!h.scoredNames(calls).includes("skill-0"));
});
test("context edits that remove a delta restore it the same way", async (t) => {
  const h = await setup(t);
  await h.start("task");
  h.sim.session.edit(h.deltas()[0].id, null);
  assert.deepEqual(readLedger(h.sim.session).lost, nameList(0, 1, 2));
  const calls = h.requests.length;
  await h.start("task two");
  assert.ok(!h.scoredNames(calls).some((name) => nameList(0, 1, 2).includes(name)));
  assert.deepEqual((h.deltas().at(-1)!.details as { redelivered: string[] }).redelivered, nameList(0, 1, 2));
});
test("sessions: new starts empty; fork inherits; navigating back makes abandoned additions candidates again; model switch changes nothing", async (t) => {
  const h = await setup(t);
  await h.start("first");
  const forked = h.sim.session.fork();
  h.sim.session = new SimSession();
  const fresh = await h.start("first in new session"); assert.deepEqual(fresh.shown(), nameList(0, 1, 2));
  h.sim.session = forked;
  const calls = h.requests.length;
  const inherited = await h.start("in the fork");
  assert.ok(!h.scoredNames(calls).includes("skill-0"), "the fork inherits the ledger");
  assert.deepEqual(inherited.shown(), nameList(0, 1, 2, 3, 4, 5));
  assert.equal(h.sim.handlers.has("model_select"), false, "no handler: a model switch can neither clear nor rebuild the ledger");
  const root = forked.all.find((entry) => entry.type === "message")!;
  forked.navigate(root.id);
  const back = await h.start("after navigating back");
  assert.deepEqual(back.shown().slice(0, 3), nameList(0, 1, 2), "skills added only on the abandoned path are candidates again");
  await h.sim.emit("session_start", { type: "session_start", reason: "resume" }, h.ctx);
  assert.deepEqual([...readLedger(forked).added].slice(0, 3), nameList(0, 1, 2), "resume derives the same ledger from the branch");
});
test("without read or bash nothing is scored, delivered or recorded; with only bash the delta names bash", async (t) => {
  const none = await setup(t, { tools: ["edit"] });
  const run = await none.start("task");
  assert.equal(none.requests.length, 0); assert.deepEqual(none.deltas(), []); assert.deepEqual(none.appended(), [], "no base record either");
  assert.equal(run.system.length, COUNT, "Pi's own array is untouched (Pi renders no skills section without a reader)");
  const bash = await setup(t, { tools: ["bash"] });
  await bash.start("task");
  assert.match(String(bash.deltas()[0].content), /Use bash to load/);
});
test("a run started by a custom message has no prompt: base and restoration only, no calls", async (t) => {
  const h = await setup(t, { settings: { globalAllowlist: ["skill-9"] } });
  const e = { ...h.event("ignored"), messageType: "custom", prompt: undefined } as unknown as BeforeAgentStartEvent;
  await h.sim.emit("before_agent_start", e, h.ctx);
  assert.equal(h.requests.length, 0); assert.deepEqual(e.systemPromptOptions.skills.map((s) => s.name), ["skill-9"]);
});
test("a delta is only 'added' once Pi persisted it: an uncommitted message leaves the skills as candidates", async (t) => {
  const h = await setup(t);
  const e = h.event("task");
  const results = await Promise.all((h.sim.handlers.get("before_agent_start") ?? []).map((handler) => handler(e, Object.assign(h.ctx, { sessionManager: h.sim.session }) as never)));
  assert.equal((results.at(-1) as { message?: unknown }).message !== undefined, true, "the skill hook returned a message");
  assert.deepEqual([...readLedger(h.sim.session).added], [], "but nothing is recorded until Pi commits it");
  const calls = h.requests.length;
  await h.start("retry");
  assert.ok(h.scoredNames(calls).includes("skill-0"), "still a candidate on the next prompt");
});

test("turn_end, prompt cadence: tool results alone trigger no decision call, no entry and never a continuation", async (t) => {
  const h = await setup(t);
  await h.start("task");
  const calls = h.requests.length;
  const result = await h.end({ toolResults: TOOL });
  assert.equal(h.requests.length, calls); assert.deepEqual(result.drafts, []); assert.equal(result.continued, false);
  assert.equal(h.deltas().length, 1);
});
test("turn_end ignores aborted/errored turns, final turns and runs without a user task", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round" } });
  await h.start("task");
  const calls = h.requests.length;
  for (const turn of [{ outcome: "aborted" as const }, { outcome: "error" as const }, { canContinue: false }]) {
    assert.deepEqual((await h.end({ toolResults: TOOL, ...turn })).drafts, [], JSON.stringify(turn));
  }
  assert.equal(h.requests.length, calls);
  const fresh = await setup(t, { relevance: { cadence: "tool-round" } });
  assert.deepEqual((await fresh.end({ toolResults: TOOL })).drafts, [], "no prompt has been seen: no task, no pick");
  assert.equal(fresh.requests.length, 0);
});
test("queued steering/follow-up user text is picked at turn_end from THAT text; the same message is never picked twice", async (t) => {
  const h = await setup(t, { score: (name, task) => /kubernetes/i.test(task) ? (name === "skill-7" ? 2 : 0) : defaultScore(name), relevance: { maxSkills: 2 } });
  await h.start("initial task");
  const queued = { role: "user", content: [{ type: "text", text: "Now deploy to Kubernetes" }], timestamp: 42 };
  const calls = h.requests.length;
  const first = await h.end({ toolResults: TOOL, pendingMessages: [queued] });
  assert.equal(h.requests.length, calls + 1); assert.equal(h.requests.at(-1)!.state.task, "Now deploy to Kubernetes");
  assert.equal(first.drafts.length, 1); assert.deepEqual((first.drafts[0].details as { added: string[] }).added, ["skill-7"]);
  assert.equal(first.drafts[0].customType, SKILLS_MESSAGE_TYPE); assert.equal(first.drafts[0].display, false); assert.equal(first.continued, false);
  assert.ok(!h.scoredNames(calls).some((name) => nameList(0, 1).includes(name)), "round-1 additions are not re-scored");
  const again = await h.end({ toolResults: TOOL, pendingMessages: [queued] });
  assert.equal(h.requests.length, calls + 1, "no second pass for the same queued message"); assert.deepEqual(again.drafts, []);
  const custom = { role: "custom", content: "not user text", timestamp: 43 };
  assert.deepEqual((await h.end({ pendingMessages: [custom, { role: "assistant", content: "assistant text" }] })).drafts, []);
  assert.equal(h.requests.length, calls + 1, "only user text is ever used as a task");
});
test("tool-round cadence adds the next-best skills for the SAME task from cached scores: no extra call, no tool data sent", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round", maxSkills: 2 } });
  await h.start("write the thing");
  assert.equal(h.requests.length, 1);
  const secret = [{ toolName: "bash", content: "TOOL-RESULT-SECRET", arguments: { command: "SECRET-ARG" } }];
  const round1 = await h.end({ toolResults: secret });
  assert.deepEqual(round1.drafts.map((d) => (d.details as { added: string[] }).added), [nameList(2, 3)], "the next two best, after the prompt round's skill-0, skill-1");
  assert.equal(h.requests.length, 1, "cached scores: zero extra decision calls");
  const round2 = await h.end({ toolResults: secret });
  assert.deepEqual(round2.drafts.map((d) => (d.details as { added: string[] }).added), [nameList(4, 5)]);
  assert.equal(h.requests.length, 1); assert.equal(round2.continued, false);
  assert.doesNotMatch(JSON.stringify(h.requests), /TOOL-RESULT-SECRET|SECRET-ARG|assistant|bash/);
  assert.deepEqual(advertised(h.sim, h.inventory, []), nameList(0, 1, 2, 3, 4, 5));
});
test("tool-round stops when nothing qualifies and does not keep calling the decision model", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round", maxSkills: 12, threshold: 0.5 }, score: (name) => name === "skill-0" ? 2 : name === "skill-1" ? 1.2 : 0.2 });
  await h.start("task");
  assert.deepEqual(h.deltas().map(h.names), [["skill-0", "skill-1"]]);
  for (let round = 0; round < 3; round++) assert.deepEqual((await h.end({ toolResults: TOOL })).drafts, []);
  assert.equal(h.requests.length, 1, "rejected skills are re-scored only when the task changes");
});
test("tool-round after a failed round does not hammer the backend; a new prompt retries", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round" }, fail: true });
  await h.start("task");
  const calls = h.requests.length;
  for (let i = 0; i < 3; i++) await h.end({ toolResults: TOOL });
  assert.equal(h.requests.length, calls, "the failed task is not retried every round");
  await h.start("next prompt"); assert.equal(h.requests.length, calls + 1);
});
test("turn_end never starts while another pass is still running, and a settings save makes it stale", async (t) => {
  const h = await setup(t, { hang: true, relevance: { timeoutMs: 5000, cadence: "tool-round" } });
  const pending = h.start("task");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual((await h.end({ toolResults: TOOL })).drafts, [], "busy: no duplicate pass");
  assert.equal(h.requests.length, 1);
  await h.command("relevance maxSkills 5"); await pending;
  assert.deepEqual(h.deltas(), []);
});
test("a stale turn_end round (settings saved mid-pass) commits no entry and records nothing", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round", timeoutMs: 5000 } });
  await h.start("first task");
  h.behavior.hang = true;
  const pending = h.end({ toolResults: TOOL, pendingMessages: [{ role: "user", content: "second task", timestamp: 7 }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.requests.length, 2, "the queued task started a pass");
  await h.command("relevance threshold 0.4");
  const result = await pending;
  assert.deepEqual(result.drafts, []); assert.deepEqual(h.deltas().map(h.names), [nameList(0, 1, 2)], "only the committed prompt round is on the branch");
  assert.ok(h.signals.at(-1)!.aborted, "the superseded decision was cancelled");
});
test("nothing but name/description and the latest bounded user task is ever sent, in every cadence", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round", maxPromptChars: 12 } });
  await h.start("SECRET-FIRST-LONG-PROMPT-TEXT");
  await h.end({ toolResults: TOOL, pendingMessages: [{ role: "user", content: "QUEUED-USER-TASK-LONGER", timestamp: 1 }] });
  await h.end({ toolResults: [{ toolName: "read", content: "TOOL-OUTPUT" }] });
  for (const request of h.requests) {
    assert.deepEqual(Object.keys(request.state).sort(), ["skills", "task"]);
    assert.ok(String(request.state.task).length <= 12);
    for (const entry of Object.values(request.state.skills as Record<string, object>)) assert.deepEqual(Object.keys(entry).sort(), ["description", "name"]);
  }
  assert.doesNotMatch(JSON.stringify(h.requests), /TOOL-OUTPUT|assistant|SKILL\.md|private/);
});
test("turn_end re-delivers skills lost to compaction mid-run, without scoring and without continuing the loop", async (t) => {
  const h = await setup(t);
  await h.start("task");
  const keep = h.sim.session.appendMessage("user", "kept"); h.sim.session.compact(keep.id);
  const calls = h.requests.length;
  const result = await h.end({ toolResults: TOOL });
  assert.equal(h.requests.length, calls); assert.equal(result.continued, false);
  assert.deepEqual((result.drafts[0].details as { redelivered: string[] }).redelivered, nameList(0, 1, 2));
  assert.deepEqual(readLedger(h.sim.session).lost, []);
});
test("a late answer from a backend that ignores cancellation is stale after a settings save: no message, no entry, no ledger change", async (t) => {
  for (const boundary of ["prompt", "turn_end"] as const) {
    const h = await setup(t, { relevance: { cadence: "tool-round", timeoutMs: 5000 } });
    let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = boundary === "prompt" ? h.start("task") : (async () => { h.behavior.gate = undefined; await h.start("first"); h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
      return h.end({ toolResults: TOOL, pendingMessages: [{ role: "user", content: "queued", timestamp: 9 }] }); })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.command("relevance maxSkills 5");   // supersedes the pass; the stubborn backend still answers
    release(); const outcome = await pending;
    const committed = h.deltas().map(h.names);
    assert.deepEqual(committed, boundary === "prompt" ? [] : [nameList(0, 1, 2)], `${boundary}: the superseded round committed nothing`);
    if (boundary === "turn_end") assert.deepEqual((outcome as { drafts: unknown[] }).drafts, []);
  }
});
test("below the minimum inventory every skill stays advertised even for an empty prompt, and the branch remembers it", async (t) => {
  const h = await setup(t, { relevance: { minCandidates: 20 } });
  const run = await h.start("   ");
  assert.equal(run.shown().length, COUNT); assert.equal(h.requests.length, 0);
  assert.equal(readLedger(h.sim.session).base.size, COUNT);
});
test("the hook set is session_start/session_tree/session_shutdown/before_agent_start/turn_end plus tool_call/agent_end for opt-in tool filtering; no model_select or compaction handler is needed", async (t) => {
  const h = await setup(t);
  assert.deepEqual([...h.sim.handlers.keys()].sort(), ["agent_end", "before_agent_start", "session_shutdown", "session_start", "session_tree", "tool_call", "turn_end"]);
});

test("turn_end keeps every earlier extension's boundary draft: Pi REPLACES accumulated entries with the returned ones", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round" } });
  await h.start("write the thing");
  const earlier = [
    { type: "custom", customType: "other-ext", data: { keep: true } },
    { type: "context_edit", targetId: "e1", replacement: null },
    { type: "custom_message", customType: "other-msg", content: "from another extension", display: true },
  ];
  const result = await h.end({ toolResults: TOOL, priorEntries: earlier });
  assert.deepEqual(result.all.slice(0, 3), earlier, "earlier drafts survive, in order");
  assert.equal(result.all.length, 4); assert.equal((result.all[3] as { customType: string }).customType, SKILLS_MESSAGE_TYPE);
  assert.equal(h.sim.session.getBranch().filter((e) => e.customType === "other-msg").length, 1, "the other extension's message is committed too");
  // With nothing to add the handler must not touch the accumulated entries at all.
  const quiet = await h.end({ toolResults: TOOL, priorEntries: earlier });
  assert.deepEqual(quiet.all.slice(0, 3), earlier);
  assert.ok(quiet.all.length <= 4);
});
test("cached scores never bypass cancellation: an aborted round returns nothing at either boundary, including re-delivery", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round" } });
  await h.start("write the thing");                    // warms the score cache
  const abort = new AbortController(); abort.abort(); h.ctx.signal = abort.signal;
  const calls = h.requests.length;
  const turn = await h.end({ toolResults: TOOL });
  assert.deepEqual(turn.all, [], "turn_end: cached next-best skills are not returned while aborted");
  const keep = h.sim.session.appendMessage("user", "kept"); h.sim.session.compact(keep.id);
  const lost = await h.end({ toolResults: TOOL });
  assert.deepEqual(lost.all, [], "turn_end: re-delivery is cancelled too");
  const before = h.deltas().length;
  await h.start("write the thing");                    // same task, warmed cache, aborted signal
  assert.equal(h.deltas().length, before, "before_agent_start: no message while aborted");
  assert.equal(h.requests.length, calls);
  h.ctx.signal = undefined;
  const ok = await h.end({ toolResults: TOOL });
  assert.equal(ok.drafts.length, 1, "the same round succeeds once not aborted");
});
test("session_tree during a pending pass aborts it; a stale completion applies the CURRENT branch's base and records nothing", async (t) => {
  const h = await setup(t, { settings: { globalAllowlist: ["skill-9"] }, relevance: { timeoutMs: 5000 } });
  h.behavior.gate = new Promise<void>(() => {});
  h.sim.session.appendCustom(SKILLS_BASE_ENTRY, { v: 1, names: ["skill-5"] }); // only the OLD branch advertised skill-5
  const old = h.event("task on the old branch");
  const pending = h.sim.emit("before_agent_start", old, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(readLedger(h.sim.session).base.has("skill-9"), "the old branch recorded its pin before scoring");
  const other = new SimSession();                         // navigate to a branch that never saw the pin
  h.sim.session = other;
  await h.sim.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "x" }, h.ctx);
  await pending;
  assert.deepEqual(h.deltas(), []); assert.deepEqual([...readLedger(other).added], []);
  assert.deepEqual(other.getBranch().filter((e) => e.type === "custom"), [], "nothing from the stale pass leaked onto the new branch");
  assert.ok(h.signals.at(-1)!.aborted);
  assert.deepEqual(old.systemPromptOptions.skills.map((s) => s.name), ["skill-9"], "the stale pass shows the always-allowed base, not the OLD branch's skill-5");
  h.behavior.gate = undefined;
  const next = await h.start("task on the new branch");
  assert.deepEqual(next.shown(), ["skill-0", "skill-1", "skill-2", "skill-9"], "the new branch scores normally");
});
test("session_tree clears transient task state: no tool-round pick from the previous branch's task", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round" } });
  await h.start("task A");
  await h.sim.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "x" }, h.ctx);
  const calls = h.requests.length;
  assert.deepEqual((await h.end({ toolResults: TOOL })).drafts, []);
  assert.equal(h.requests.length, calls);
});
test("no read/bash: nothing is recorded as exposed (Pi omits the section), so a later run with a reader still scores everything", async (t) => {
  for (const mode of ["unconfigured", "disabled", "below-minimum"] as const) {
    const h = await setup(t, { tools: ["edit"], ...(mode === "unconfigured" ? { unconfigured: true } : {}), ...(mode === "below-minimum" ? { relevance: { minCandidates: 20 } } : {}), settings: { globalAllowlist: ["skill-9"] } });
    if (mode === "disabled") await h.command("disable");
    const blind = await h.start("task");
    assert.deepEqual(h.appended(), [], `${mode}: no base record without a reader`);
    assert.equal(blind.system.length, COUNT, `${mode}: Pi's array is left alone`);
    assert.equal(h.requests.length, 0);
    h.sim.tools.active = ["read", "bash"];
    if (mode === "disabled") await h.command("enable");
    if (mode === "unconfigured") {
      await saveSettings({ ...defaultSettings(), globalAllowlist: ["skill-9"], backend: { backend: "pi", provider: "fixture", id: "classifier" }, relevance: { ...defaultSettings().relevance, minCandidates: 0, maxSkills: 3 } }, h.path);
      await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
    }
    if (mode === "below-minimum") await h.command("relevance minCandidates 0");
    const sighted = await h.start("task again");
    assert.ok(h.requests.length >= 1, `${mode}: scoring happens once a reader exists`);
    assert.deepEqual(sighted.shown(), ["skill-0", "skill-1", "skill-2", "skill-9"], mode);
  }
});

test("navigating the session tree while the project allowlist is being read writes no base to the new branch and scores nothing", async (t) => {
  const h = await setup(t);
  h.ctx.cwd = "/fixture";
  let release!: () => void; h.behavior.allowlistGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = h.start("task");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const other = new SimSession(); h.sim.session = other;
  await h.sim.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "x" }, h.ctx);
  release(); const run = await pending;
  assert.deepEqual(h.appended(), [], "no base record from the superseded callback");
  assert.deepEqual(other.getBranch().filter((entry) => entry.type === "custom"), []);
  assert.equal(h.requests.length, 0); assert.deepEqual(h.deltas(), []);
  assert.deepEqual(run.system.map((skill) => skill.name), ["skill-11"], "only the always-allowed skill is applied, from the current branch's base");
  h.behavior.allowlistGate = undefined;
  const next = await h.start("task on the new branch");
  assert.deepEqual(next.shown(), ["skill-0", "skill-1", "skill-2", "skill-11"]);
  assert.equal(h.appended().length, 1, "the real pass records the pin once");
});
test("settings saved or the run aborted while the allowlist is being read: no base is recorded for the dead pass", async (t) => {
  for (const cause of ["settings", "abort"] as const) {
    const h = await setup(t);
    h.ctx.cwd = "/fixture";
    const abort = new AbortController(); if (cause === "abort") h.ctx.signal = abort.signal;
    let release!: () => void; h.behavior.allowlistGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = h.start("task");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (cause === "settings") await h.command("relevance maxSkills 5"); else abort.abort();
    release(); await pending;
    assert.deepEqual(h.appended(), [], cause); assert.equal(h.requests.length, 0, cause); assert.deepEqual(h.deltas(), [], cause);
  }
});
test("turn_end: navigating while the allowlist is read scores nothing and returns no entry", async (t) => {
  const h = await setup(t, { relevance: { cadence: "tool-round" } });
  await h.start("task");
  h.ctx.cwd = "/fixture";
  const calls = h.requests.length;
  let release!: () => void; h.behavior.allowlistGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = h.end({ toolResults: TOOL });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.sim.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "x" }, h.ctx);
  release(); const result = await pending;
  assert.deepEqual(result.all, []); assert.equal(h.requests.length, calls);
});
