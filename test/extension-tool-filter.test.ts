// Opt-in tool/MCP filtering through the REAL runtime hooks, with the offline Pi session stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectAllowlistPath } from "../src/project-allowlist.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { CORE, extTool, mcpTool, resourceTools, toolSetup } from "./helpers/tool-fixture.ts";
import { builtinSource, extensionSource, type SimToolInfo } from "./helpers/pi-sim.ts";

const A = extTool("ext_a"), B = extTool("ext_b"), C = extTool("ext_c");
const BLOCKED = /^Tool "(\w+)" is unavailable: pi-context-decisions tool filtering has not enabled it/;

test("off by default: no tool APIs are called, nothing is written, every call passes and skills behave as before", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false }, extra: [A, B, mcpTool("srv", "x")], scores: { ext_a: 2 } });
  await h.start("write the thing"); await h.end({ toolResults: [{}] }); await h.agentEnd();
  assert.deepEqual(h.sim.calls, { getAllTools: 0, setActiveTools: 0 });
  assert.deepEqual(h.sim.appended, []); assert.equal(h.requests.length, 0);
  assert.equal(await h.gate("ext_b"), undefined); assert.equal(await h.gate("mcp__srv__x"), undefined);
  assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"]);
  assert.deepEqual(h.sim.calls, { getAllTools: 0, setActiveTools: 0 }, "the gate exits before touching the registry");
});
test("tool filtering has its own switch: skills on + tools off makes no tool calls; tools on + skills off still scores tools", async (t) => {
  const off = await toolSetup(t, { tools: { enabled: false }, skills: true, extra: [A], scores: { ext_a: 2 } });
  await off.start("task"); assert.equal(off.sim.calls.getAllTools, 0);
  const on = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2 } });
  await on.start("task"); assert.deepEqual(on.scored(), ["ext_a", "ext_b"]);
  assert.equal((await loadSettings(on.path)).settings.relevance.enabled, false);
});
test("tools mode, prompt cadence: withholds undecided declared tools before the first request, records the ledger and gates calls", async (t) => {
  const h = await toolSetup(t, { extra: [A, B, C], scores: { ext_a: 2, ext_b: 0.1 } });
  const { e } = await h.start("use ext_a please");
  assert.deepEqual(h.active(), [...CORE, "ext_a"], "internal tools untouched, undecided external tools removed, order preserved");
  assert.equal(h.sim.calls.setActiveTools, 1);
  assert.deepEqual(h.ledger(), [{ v: 1, tools: ["ext_a"], withheld: ["ext_b", "ext_c"], picks: { ext_a: { score: 2, threshold: 0.375 } } }]);
  assert.deepEqual(e.systemPromptOptions.selectedTools, ["read", "bash"], "selectedTools is never edited");
  assert.deepEqual(e.systemPromptOptions.sections, {});
  assert.deepEqual(await h.gate("ext_b"), { block: true, reason: h.gate && (await h.gate("ext_b"))!.reason });
  assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
  assert.ok((await h.gate("ext_b"))!.reason.length <= 300);
  for (const name of ["read", "bash", "ext_a", "nonexistent_tool"]) assert.equal(await h.gate(name), undefined, name);
  // Second prompt: only the remaining candidates are scored, and a qualifying one is restored.
  h.scores.ext_b = 1.5;
  const calls = h.requests.length;
  await h.start("now use ext_b");
  assert.deepEqual(h.scored(calls), ["ext_b", "ext_c"]);
  assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"]);
  assert.deepEqual(h.ledger().at(-1), { v: 1, tools: ["ext_b"], released: ["ext_b"], picks: { ext_b: { score: 1.5, threshold: 0.375 } } });
  assert.equal(await h.gate("ext_b"), undefined); assert.match((await h.gate("ext_c"))!.reason, BLOCKED);
});
test("maxAdded caps new additions per round, ranked across candidates; the threshold is inclusive", async (t) => {
  const h = await toolSetup(t, { tools: { maxAdded: 1 }, decision: { threshold: 0.5 }, extra: [A, B, C], scores: { ext_a: 1, ext_b: 1.5, ext_c: 0.99 } });
  await h.start("task");
  assert.deepEqual(h.ledger()[0].tools, ["ext_b"], "best first, capped; ext_a (1.0 = 2 × 0.5) qualifies but lost to the cap; ext_c is below");
  await h.start("task again");
  assert.deepEqual(h.ledger().at(-1)?.tools, ["ext_a"], "cached scores: the next-best qualifying tool arrives next round");
});
test("mcp mode: MCP servers AND extensions are the candidates; adding a group enables all its tools, late members included", async (t) => {
  const h = await toolSetup(t, { tools: { mode: "mcp" }, extra: [A, mcpTool("dev-radius", "q", "direct"), mcpTool("dev-radius", "r", "codemode"), mcpTool("docs", "s", "direct")], scores: { mcp__dev_radius: 2 } });
  await h.start("search the radar");
  assert.deepEqual(h.scored(), ["ext__ext_a", "mcp__dev_radius", "mcp__docs"]);
  const request = JSON.stringify(h.requests[0]);
  assert.match(request, /Tools: mcp__dev_radius__q, mcp__dev_radius__r/, "namespace candidate lists its tool names");
  assert.match(request, /Extension ext_a\. Tools: ext_a/, "an extension is a candidate exactly like a server: its name and its tool names");
  assert.deepEqual(h.active(), [...CORE, "mcp__dev_radius__q"], "the declared tools of the unselected server and extension are withheld");
  assert.equal(await h.gate("mcp__dev_radius__r"), undefined);
  assert.match((await h.gate("ext_a"))!.reason, /^Extension "ext_a" is unavailable: .* \/decisions Tool picker tab \(Always allowed MCP servers & extensions\)\./);
  const blocked = await h.gate("mcp__docs__s");
  assert.match(blocked!.reason, /^MCP server "docs" is unavailable/);
  h.sim.registerTool(mcpTool("dev-radius", "late", "direct"));
  await h.end({ toolResults: [{}] });
  assert.ok(h.active().includes("mcp__dev_radius__late"), "a late member of an available namespace needs no scoring");
  assert.equal(await h.gate("mcp__dev_radius__late"), undefined);
  // Switching to tools mode keeps everything that was available.
  await h.set("tools.mode", "tools");
  await h.start("again");
  assert.equal(await h.gate("mcp__dev_radius__r"), undefined); assert.match((await h.gate("ext_a"))!.reason, BLOCKED);
});
test("mcp mode: scoring an extension adds ALL its tools (late ones too); a tool with no provenance is never filtered", async (t) => {
  const loose: SimToolInfo = { name: "loose", description: "no provenance", exposure: "direct" };
  const one = { ...extTool("plug_one"), sourceInfo: { ...extensionSource("plug"), path: "/ext/plug.ts" } }, two = { ...extTool("plug_two", "codemode"), sourceInfo: { ...extensionSource("plug"), path: "/ext/plug.ts" } };
  const h = await toolSetup(t, { tools: { mode: "mcp" }, extra: [one, two, A, loose, extTool("lazy_x", "codemode")], scores: { ext__plug: 2 } });
  await h.start("use plug");
  assert.deepEqual(h.scored(), ["ext__plug", "ext__ext_a", "ext__lazy_x"], "one candidate per extension, none for the provenance-less tool");
  assert.deepEqual(h.active(), [...CORE, "plug_one", "loose"], "ext_a is withheld; the plug extension and the provenance-less tool stay");
  assert.equal(await h.gate("plug_two"), undefined); assert.equal(await h.gate("loose"), undefined);
  assert.deepEqual(h.ledger()[0].groups, ["ext__plug"]); assert.deepEqual(h.ledger()[0].tools, ["loose"], "only the ungrouped tool is recorded one by one");
  h.sim.registerTool({ ...extTool("plug_three"), sourceInfo: { ...extensionSource("plug"), path: "/ext/plug.ts" } });
  await h.end({ toolResults: [{}] });
  assert.ok(h.active().includes("plug_three"), "a late member of an available extension needs no scoring");
  assert.deepEqual(noticeText(h.notices()[0]).match(/extensions: ([\w_, ]+)\./)?.[1], "ext__plug", "the notice names the extension by its canonical key, never a path");
  assert.doesNotMatch(JSON.stringify(h.requests), /\/ext\/|sourceInfo/);
});
const projectFile = async (root: string, body: Record<string, unknown>) => { await mkdir(join(root, ".pi"), { recursive: true }); await writeFile(projectAllowlistPath(root), JSON.stringify({ alwaysAllowed: [], ...body })); };

test("allowlists (global tool, project server): pins are never scored, are recorded as base and survive allowlist removal and failed rounds", async (t) => {
  const h = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_a"] }, fail: true, extra: [A, B, mcpTool("docs", "s", "codemode"), mcpTool("dev-radius", "q", "codemode")] });
  await projectFile(h.root, { alwaysAllowedMcpServers: ["docs"] });
  await h.start("task");
  assert.deepEqual(h.scored(), ["ext_b", "mcp__dev_radius__q"], "an allowlisted tool and every tool of an allowlisted server skip scoring");
  assert.equal(h.ledger()[0].errorCode, undefined);
  assert.deepEqual(h.ledger()[0].tools, ["ext_a"]); assert.deepEqual(h.ledger()[0].groups, ["mcp__docs"]);
  assert.deepEqual(h.ledger()[0].allowlisted, ["ext_a", "mcp__docs"], "allowlist grants are recorded as allowlisted, never with a pick");
  assert.equal(h.ledger()[0].picks, undefined);
  assert.equal(await h.gate("mcp__docs__s"), undefined); assert.equal(await h.gate("ext_a"), undefined);
  assert.match((await h.gate("ext_b"))!.reason, BLOCKED, "the failed round (fail-closed) added nothing else");
  // Remove every allowlist entry: availability never shrinks.
  await saveSettings({ ...(await loadSettings(h.path)).settings, tools: { ...h.settings.tools, alwaysAllowedTools: [] } }, h.path);
  await projectFile(h.root, {});
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  assert.equal(await h.gate("mcp__docs__s"), undefined); assert.equal(await h.gate("ext_a"), undefined);
});
test("mcp mode: allowlisting ONE tool of a namespace promotes the whole namespace, so a server is never half-on", async (t) => {
  const h = await toolSetup(t, { tools: { mode: "mcp", alwaysAllowedTools: ["mcp__dev_radius__q"] }, extra: [mcpTool("dev-radius", "q", "direct"), mcpTool("dev-radius", "r", "codemode"), mcpTool("docs", "s", "direct")] });
  await h.start("task");
  assert.deepEqual(h.scored(), ["mcp__docs"], "the promoted namespace is not a candidate");
  assert.equal(await h.gate("mcp__dev_radius__r"), undefined, "a sibling of the allowlisted tool is available too");
  assert.deepEqual(h.ledger()[0].groups, ["mcp__dev_radius"]);
  assert.ok(h.active().includes("mcp__dev_radius__q") && !h.active().includes("mcp__docs__s"));
});
test("tools mode: a server allowlist accepts `-` or `_` spelling and the canonical namespace key", async (t) => {
  for (const entry of ["dev-radius", "dev_radius", "mcp__dev_radius"]) {
    const h = await toolSetup(t, { tools: { alwaysAllowedMcpServers: [entry] }, extra: [mcpTool("dev-radius", "q", "codemode")] });
    await h.start("task");
    assert.deepEqual(h.scored(), [], entry); assert.equal(await h.gate("mcp__dev_radius__q"), undefined, entry);
  }
});
test("provenance, not names: an extension tool named like a core tool is external; built-in provenance is internal; SDK tools are external", async (t) => {
  const spoof = extTool("read", "direct", { reachesTools: true } as never);
  const h = await toolSetup(t, { extra: [spoof, extTool("sdk_tool", "direct", { sourceInfo: { path: "<sdk:sdk_tool>", source: "sdk" } }), { name: "no_provenance", exposure: "direct" }, { name: "builtin_extra", exposure: "direct", sourceInfo: builtinSource("codemode") }] });
  await h.start("task");
  // The registry holds the REAL read first (built-in provenance); duplicates are ignored, first wins, so `read` stays internal.
  assert.deepEqual(h.scored(), ["sdk_tool", "no_provenance"], "SDK and provenance-less tools are candidates; built-in provenance is never scored");
  assert.equal(await h.gate("builtin_extra"), undefined);
  assert.match((await h.gate("no_provenance"))!.reason, BLOCKED);
  // A replacement without the real built-in registered: the extension's `read` is just an external tool.
  const alone = await toolSetup(t);
  alone.sim.registry.splice(0, 1, extTool("read", "direct", { reachesTools: true } as never));
  await alone.start("task");
  assert.deepEqual(alone.scored(), ["read"]); assert.match((await alone.gate("read"))!.reason, BLOCKED);
});
test("cadence initial: one pick from the first user prompt; later prompts and reloads never re-pick; late tools are scored against the FIRST task only", async (t) => {
  const h = await toolSetup(t, { tools: { cadence: "initial", maxAdded: 1 }, extra: [A, B, C], scores: { ext_a: 2, ext_b: 1.5, ext_c: 1.5 } });
  await h.start("", { messageType: "custom" });
  assert.equal(h.requests.length, 0, "a custom-message run supplies no task: nothing is scored and no initial task is recorded");
  assert.deepEqual(h.active(), CORE, "everything undecided is withheld until the first user prompt");
  await h.start("first task");
  assert.deepEqual(h.scored(), ["ext_a", "ext_b", "ext_c"]);
  assert.equal(h.ledger().at(-1)?.initialTask, "first task"); assert.deepEqual(h.ledger().at(-1)?.considered, ["ext_a", "ext_b", "ext_c"]);
  const calls = h.requests.length;
  await h.start("a completely different second task");
  await h.end({ toolResults: [{}], pendingMessages: [{ role: "user", content: "steering text", timestamp: 5 }] });
  assert.equal(h.requests.length, calls, "initial: no new-task round on later prompts, steering text or tool rounds, and capped-out candidates are not re-picked");
  assert.equal(await h.gate("ext_a"), undefined); assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
  // A simulated reload (fresh runtime, same branch) reads initialTask and considered from the ledger.
  const late = extTool("ext_late");
  const reloaded = await toolSetup(t, { session: h.sim.session, tools: { cadence: "initial", maxAdded: 1 }, extra: [A, B, C, late], scores: { ext_late: 2, ext_b: 2 } });
  reloaded.sim.tools.active = [...CORE, "ext_a", "ext_late"];
  await reloaded.start("yet another prompt");
  assert.deepEqual(reloaded.scored(), ["ext_late"], "only the candidate that did not exist at the initial pick is scored; nothing is re-picked after a reload");
  assert.equal(reloaded.requests[0].state.task, "first task", "scored against the initial task, not the new prompt");
  assert.equal(await reloaded.gate("ext_late"), undefined); assert.match((await reloaded.gate("ext_b"))!.reason, BLOCKED);
});
test("cadence initial: a failed initial pick records nothing, so the next user prompt retries it", async (t) => {
  const h = await toolSetup(t, { tools: { cadence: "initial" }, extra: [A], fail: true });
  await h.start("first");
  assert.equal(h.ledger().at(-1)?.initialTask, undefined);
  h.behavior.fail = false; h.scores.ext_a = 2;
  await h.start("second");
  assert.equal(h.requests.at(-1)!.state.task, "second"); assert.equal(h.ledger().at(-1)?.initialTask, "second");
  assert.equal(await h.gate("ext_a"), undefined);
});
test("cadence tool-round: next-best candidates arrive after a completed tool round from cached scores; aborted and assistant-only turns do nothing", async (t) => {
  const h = await toolSetup(t, { tools: { cadence: "tool-round", maxAdded: 1 }, extra: [A, B, C], scores: { ext_a: 2, ext_b: 1.5, ext_c: 1 } });
  await h.start("task");
  assert.deepEqual(h.ledger().at(-1)?.tools, ["ext_a"]);
  const calls = h.requests.length;
  await h.end(); await h.end({ outcome: "aborted", toolResults: [{}] }); await h.end({ canContinue: false, toolResults: [{}] });
  assert.equal(h.ledger().length, 1, "assistant-only, aborted and final turns trigger nothing");
  await h.end({ toolResults: [{}] });
  assert.deepEqual(h.ledger().at(-1)?.tools, ["ext_b"]); assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"]);
  await h.end({ toolResults: [{}] });
  assert.deepEqual(h.ledger().at(-1)?.tools, ["ext_c"]);
  assert.equal(h.requests.length, calls, "no extra decision call for the same task");
});
test("cadence prompt: queued steering text is a new task for the remaining candidates; prompt cadence ignores tool results alone", async (t) => {
  const h = await toolSetup(t, { tools: { maxAdded: 1 }, extra: [A, B], scores: { ext_a: 2 } });
  await h.start("task one");
  const calls = h.requests.length;
  await h.end({ toolResults: [{}] });
  assert.equal(h.requests.length, calls, "tool results alone make no call in prompt cadence");
  h.scores.ext_b = 2;
  await h.end({ pendingMessages: [{ role: "assistant", content: "NOT-A-TASK" }, { role: "user", content: "steer toward b", timestamp: 7 }] });
  assert.equal(h.requests.at(-1)!.state.task, "steer toward b"); assert.deepEqual(h.scored(calls), ["ext_b"]);
  assert.ok(!JSON.stringify(h.requests).includes("NOT-A-TASK"));
  await h.end({ pendingMessages: [{ role: "user", content: "steer toward b", timestamp: 7 }] });
  assert.equal(h.requests.length, calls + 1, "the same queued message is not scored twice");
});
test("turn_end keeps earlier drafts, appends ours, and writes nothing when nothing changed", async (t) => {
  const h = await toolSetup(t, { extra: [A], scores: { ext_a: 2 } });
  await h.start("task");
  const setCalls = h.sim.calls.setActiveTools;
  assert.deepEqual((await h.end({ toolResults: [{}] })).all, [], "a quiet boundary makes no draft and no setActiveTools call");
  h.sim.registerTool(extTool("ext_late")); h.scores.ext_late = 2;
  const prior = { type: "custom", customType: "other-extension", data: { keep: true } };
  const { all } = await h.end({ priorEntries: [prior] });
  assert.deepEqual(all[0], prior); assert.deepEqual((all[1] as { data: unknown }).data, { v: 1, tools: ["ext_late"], picks: { ext_late: { score: 2, threshold: 0.375 } } });
  assert.equal(h.sim.calls.setActiveTools, setCalls, "an addition changes no declaration");
});
test("other extensions keep their activations: only candidates are withheld and only tools we withheld are restored", async (t) => {
  const h = await toolSetup(t, { extra: [A, B, { name: "hidden_one", exposure: "hidden" }, extTool("lazy_tool", "codemode")], scores: { ext_a: 2 } });
  h.sim.registry.push({ name: "other_internal", exposure: "direct", sourceInfo: builtinSource("other") }); h.sim.tools.active.push("other_internal");
  h.sim.tools.active = h.sim.tools.active.filter((name) => name !== "ext_b"); // another extension deactivated ext_b before us
  await h.start("task");
  assert.deepEqual(h.active(), [...CORE, "ext_a", "other_internal"]);
  assert.equal(h.ledger()[0].withheld, undefined, "ext_b was never active, so it is not recorded as withheld by us");
  h.scores.ext_b = 2; await h.start("again");
  assert.ok(!h.active().includes("ext_b"), "we never re-activate what we did not withhold");
  assert.ok(!h.active().includes("lazy_tool"), "non-declarable tools are never activated by us");
});
test("late tools: a tool registered mid-run is scored at turn_end (kept or withheld); a lazy gate score is shared by parallel calls and flushed later", async (t) => {
  const h = await toolSetup(t, { extra: [A], scores: { ext_a: 2, ext_late: 0.1, ext_late2: 2 } });
  await h.start("task");
  h.sim.registerTool(extTool("ext_late")); h.sim.registerTool(extTool("ext_late2"));
  await h.end({ toolResults: [{}] });
  assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_late2"]); assert.deepEqual(h.scored(1), ["ext_late", "ext_late2"]);
  // A codemode MCP tool that registers while a call is racing in: ONE shared decision call.
  h.sim.registerTool(mcpTool("srv", "x", "codemode")); h.scores.mcp__srv__x = 2;
  let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const calls = h.requests.length;
  const racing = Promise.all([h.gate("mcp__srv__x"), h.gate("mcp__srv__x"), h.gate("mcp__srv__x")]);
  while (h.requests.length === calls) await new Promise((resolve) => setTimeout(resolve, 1));
  release(); assert.deepEqual(await racing, [undefined, undefined, undefined]);
  assert.equal(h.requests.length, calls + 1, "single-flight: three parallel calls, one decision call"); assert.deepEqual(h.scored(calls), ["mcp__srv__x"]);
  await h.agentEnd();
  assert.deepEqual(h.ledger().at(-1)?.tools, ["mcp__srv__x"], "the lazy addition is flushed by agent_end when no turn_end did");
  // A rejected or failed candidate is blocked without any further call.
  h.behavior.gate = undefined;
  h.sim.registerTool(mcpTool("srv", "y", "codemode")); h.scores.mcp__srv__y = 0;
  const before = h.requests.length;
  assert.match((await h.gate("mcp__srv__y"))!.reason, BLOCKED); assert.match((await h.gate("mcp__srv__y"))!.reason, BLOCKED);
  assert.equal(h.requests.length, before + 1, "scored once; the cached rejection answers later calls");
});
test("failure: a failed round adds nothing and never fails open for config errors; failMode open adds the remainder; the gate still blocks", async (t) => {
  const h = await toolSetup(t, { extra: [A, B], fail: true });
  await h.start("task");
  assert.deepEqual(h.active(), CORE); assert.match((await h.gate("ext_a"))!.reason, BLOCKED);
  const calls = h.requests.length;
  assert.match((await h.gate("ext_a"))!.reason, BLOCKED); assert.equal(h.requests.length, calls, "failedKey: no repeated calls for the same task");
  const open = await toolSetup(t, { decision: { failMode: "open" }, extra: [A, B], fail: true });
  await open.start("task");
  assert.deepEqual(open.active(), [...CORE, "ext_a", "ext_b"]);
  const config = await toolSetup(t, { decision: { failMode: "open" }, extra: [A] });
  config.ctx.modelRegistry.findOfType = () => undefined; // the selected classifier is not registered: a config error
  await config.start("task");
  assert.deepEqual(config.active(), CORE, "a config error never fails open");
  assert.match((await config.gate("ext_a"))!.reason, BLOCKED); assert.equal(config.requests.length, 0);
});
test("unconfigured or below the minimum: nothing is scored, everything stays available and the branch remembers it", async (t) => {
  const none = await toolSetup(t, { unconfigured: true, extra: [A, B] });
  await none.start("task");
  assert.equal(none.requests.length, 0); assert.deepEqual(none.active(), [...CORE, "ext_a", "ext_b"]);
  assert.deepEqual(none.ledger()[0].tools, ["ext_a", "ext_b"]); assert.equal(await none.gate("ext_b"), undefined);
  const small = await toolSetup(t, { tools: { minCandidates: 3 }, extra: [A, B] });
  await small.start("task");
  assert.equal(small.requests.length, 0); assert.equal(await small.gate("ext_b"), undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------------------------------------
const reload = async (h: Awaited<ReturnType<typeof toolSetup>>, change: (settings: typeof h.settings) => void) => {
  const next = structuredClone((await loadSettings(h.path)).settings); change(next);
  await saveSettings(next, h.path);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
};
const until = async (condition: () => boolean, what: string) => {
  const deadline = Date.now() + 2000;
  while (!condition()) { if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 1)); }
};

test("enabling mid-session: tools the model may already have seen stay active and are recorded as base; only later-registered tools are filtered", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false }, extra: [A, B, mcpTool("srv", "x", "codemode")], scores: {} });
  h.sim.session.appendMessage("user", "earlier conversation"); h.sim.session.appendMessage("assistant", "reply");
  await reload(h, (settings) => { settings.tools.enabled = true; });
  await h.start("continue the work");
  assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"], "nothing the model already saw is withdrawn");
  assert.equal(h.requests.length, 0, "nothing is left to decide");
  assert.deepEqual(h.ledger(), [{ v: 1, tools: ["ext_a", "ext_b", "mcp__srv__x"], groups: ["ext__ext_a", "ext__ext_b", "mcp__srv"] }]);
  assert.equal(await h.gate("ext_b"), undefined); assert.equal(await h.gate("mcp__srv__x"), undefined);
  h.sim.registerTool(extTool("ext_late"));
  await h.end({ toolResults: [{}] });
  assert.deepEqual(h.scored(), ["ext_late"]); assert.ok(!h.active().includes("ext_late"), "a tool registered after enabling is filtered like any other");
  assert.match((await h.gate("ext_late"))!.reason, BLOCKED);
  // A fresh branch (no conversation yet) records no base: its first prompt really filters.
  const fresh = await toolSetup(t, { extra: [A, B] });
  await fresh.start("task"); assert.deepEqual(fresh.active(), CORE);
});
test("disabling on a branch with a ledger restores what we withheld and records everything; disabling without a ledger touches nothing", async (t) => {
  const h = await toolSetup(t, { extra: [A, B, mcpTool("srv", "x", "direct")], scores: { ext_a: 2 } });
  await h.start("task"); assert.deepEqual(h.active(), [...CORE, "ext_a"]);
  assert.deepEqual(h.ledger()[0].withheld, ["ext_b", "mcp__srv__x"]);
  await reload(h, (settings) => { settings.tools.enabled = false; });
  const requests = h.requests.length;
  await h.start("second");
  assert.deepEqual(h.active().sort(), [...CORE, "ext_a", "ext_b", "mcp__srv__x"].sort(), "withheld tools are given back");
  assert.equal(h.requests.length, requests, "no decision call while disabled");
  const last = h.ledger().at(-1)!;
  assert.deepEqual(last.released, ["ext_b", "mcp__srv__x"]); assert.deepEqual([...(last.tools as string[])].sort(), ["ext_b", "mcp__srv__x"], "everything is recorded, so re-enabling can never remove anything");
  assert.equal(await h.gate("ext_b"), undefined, "no gate while disabled");
  await reload(h, (settings) => { settings.tools.enabled = true; });
  await h.start("third");
  assert.deepEqual(h.active().sort(), [...CORE, "ext_a", "ext_b", "mcp__srv__x"].sort(), "re-enabling removes nothing");
  assert.equal(await h.gate("ext_b"), undefined);
  // Toggled off before any ledger existed on the branch: zero footprint.
  const none = await toolSetup(t, { extra: [A, B] });
  await reload(none, (settings) => { settings.tools.enabled = false; });
  await none.start("task"); await none.end({ toolResults: [{}] }); await none.agentEnd();
  assert.deepEqual(none.sim.calls, { getAllTools: 0, setActiveTools: 0 }); assert.deepEqual(none.sim.appended, []); assert.equal(await none.gate("ext_b"), undefined);
});
test("session_tree: each branch has its own ledger, and a stale in-flight state is dropped", async (t) => {
  const h = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2 } });
  await h.start("branch one");
  const leafOne = h.sim.session.leaf;
  assert.equal(await h.gate("ext_a"), undefined); assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
  // Navigate to before the addition, then take a different path on a sibling branch.
  h.sim.session.navigate(null);
  await h.sim.emit("session_tree", { type: "session_tree" }, h.ctx);
  assert.match((await h.gate("ext_a"))!.reason, BLOCKED, "an addition made on the other branch is not available here");
  h.sim.tools.active = [...CORE, "ext_a", "ext_b"]; // Pi restores the target branch's declared set
  h.scores.ext_a = 0; h.scores.ext_b = 2;
  await h.start("branch two");
  assert.equal(await h.gate("ext_b"), undefined); assert.match((await h.gate("ext_a"))!.reason, BLOCKED);
  assert.deepEqual(h.active(), [...CORE, "ext_b"]);
  h.sim.session.navigate(leafOne);
  await h.sim.emit("session_tree", { type: "session_tree" }, h.ctx);
  assert.equal(await h.gate("ext_a"), undefined); assert.match((await h.gate("ext_b"))!.reason, BLOCKED, "back on branch one, branch two's addition is blocked");
});
for (const [label, save] of [
  ["a settings save", (h: Awaited<ReturnType<typeof toolSetup>>) => h.set("decision.threshold", "0.5")],
  ["an allowlist save", (h: Awaited<ReturnType<typeof toolSetup>>) => h.allowlist({ tab: "skills", row: "Always allowed · Project" })],
] as const) {
  test(`${label} while a decision round is in flight aborts it and commits nothing`, async (t) => {
    const h = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2 } });
    let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
    const running = h.start("task");
    await until(() => h.requests.length === 1, "the decision call");
    await save(h);
    release(); await running;
    assert.equal(h.requests.length, 1, "no retry");
    assert.deepEqual(h.ledger(), [], "a stale pass writes nothing at all: no record, no marker, no base");
    assert.equal(h.sim.calls.setActiveTools, 0, "and reconciles nothing: the declarations are left for the next boundary");
    assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"]);
    assert.equal(h.notices().length, 0);
    assert.match((await h.gate("ext_b"))!.reason, BLOCKED, "the gate still fails closed for calls in the meantime"); h.behavior.gate = undefined; h.scores.ext_b = 0;
    // The superseded run went out with every tool declared, so the next boundary correctly treats them as already seen (the same
    // semantics as enabling mid-session); tools registered later are filtered normally.
    await h.start("task again");
    assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"]); assert.deepEqual(h.ledger().at(-1)?.tools, ["ext_a", "ext_b"]);
    assert.equal(await h.gate("ext_b"), undefined);
    h.sim.registerTool(extTool("ext_late")); h.scores.ext_late = 0;
    await h.end({ toolResults: [{}] });
    assert.ok(!h.active().includes("ext_late"), "a later registration is scored and withheld");
  });
}
test("a settings error keeps enforcing a branch's existing ledger and adds nothing; without a ledger it is inactive", async (t) => {
  const h = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2, ext_late: 2 } });
  await h.start("task"); assert.equal(await h.gate("ext_a"), undefined);
  await writeFile(h.path, "{ not json");
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  assert.ok(h.messages.some((message) => /Settings error/.test(message)));
  const requests = h.requests.length;
  assert.equal(await h.gate("ext_a"), undefined); assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
  await h.start("another task");
  h.sim.registerTool(extTool("ext_late")); await h.end({ toolResults: [{}] });
  assert.equal(h.requests.length, requests, "a broken settings file triggers no decision calls");
  assert.match((await h.gate("ext_b"))!.reason, BLOCKED); assert.match((await h.gate("ext_late"))!.reason, BLOCKED);
  assert.ok(!h.active().includes("ext_late") && !h.active().includes("ext_b"));
  assert.ok(h.ledger().every((entry) => entry.tools === undefined || (entry.tools as string[]).every((name) => name === "ext_a")), "nothing new became available");
  // No ledger on the branch: filtering is inactive and untouched.
  const clean = await toolSetup(t, { extra: [A, B] });
  await writeFile(clean.path, "{ not json");
  await clean.sim.emit("session_start", { type: "session_start", reason: "reload" }, clean.ctx);
  await clean.start("task"); await clean.end({ toolResults: [{}] });
  assert.deepEqual(clean.sim.calls, { getAllTools: 0, setActiveTools: 0 }); assert.equal(await clean.gate("ext_b"), undefined); assert.deepEqual(clean.active(), [...CORE, "ext_a", "ext_b"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Availability notice (names only; needed because codemode/deferred tools are discoverable but not declared)
// ---------------------------------------------------------------------------------------------------------------------------------
const noticeText = (entry: { content?: unknown }) => String(entry.content);
const CODE_A = extTool("lazy_a", "codemode"), CODE_B = extTool("lazy_b", "deferred");

test("notice: direct-only filtering sends none (Pi's own tool deltas inform the model)", async (t) => {
  const h = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2 } });
  const { results } = await h.start("task"); await h.end({ toolResults: [{}] });
  h.scores.ext_b = 2; await h.start("second"); assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"]);
  assert.equal(h.notices().length, 0); assert.ok(results.every((result) => !(result as { message?: unknown } | undefined)?.message));
});
test("notice: a baseline is sent once, only while a codemode/deferred candidate is unavailable; it is hidden, names-only and says what is available", async (t) => {
  const h = await toolSetup(t, { extra: [A, CODE_A, CODE_B, mcpTool("srv", "x", "codemode")], scores: { lazy_a: 2, ext_a: 2 } });
  const { results } = await h.start("use lazy_a");
  const message = (results.find((result) => (result as { message?: unknown } | undefined)?.message) as { message: { customType: string; display: boolean; details: unknown; content: string } }).message;
  assert.equal(message.customType, "context-decisions-tools-notice"); assert.equal(message.display, false);
  assert.match(message.content, /only these are available now: tools: lazy_a\./);
  assert.match(message.content, /calls to them are blocked/);
  assert.doesNotMatch(message.content, /lazy_b|mcp__srv|ext_a|Does |on srv|srv server/, "unavailable candidates, direct tools and descriptions are never listed");
  assert.deepEqual(message.details, { v: 1, tools: ["lazy_a"], groups: [] });
  assert.equal(h.notices().length, 1);
  await h.start("again"); await h.end({ toolResults: [{}] });
  assert.equal(h.notices().length, 1, "the baseline is not repeated");
  // "none available" wording.
  const none = await toolSetup(t, { extra: [CODE_A] });
  await none.start("task"); assert.match(noticeText(none.notices()[0]), /only these are available now: none\./);
});
test("notice: increments announce newly available codemode tools and servers at the next prompt and at turn_end; names only", async (t) => {
  const h = await toolSetup(t, { tools: { maxAdded: 1 }, extra: [CODE_A, CODE_B], scores: { lazy_a: 2, lazy_b: 2 } });
  await h.start("task");
  assert.match(noticeText(h.notices()[0]), /only these are available now: tools: lazy_a\./);
  h.scores.lazy_b = 2; await h.start("second");
  assert.equal(h.notices().length, 2); assert.equal(noticeText(h.notices()[1]), "Tool availability (pi-context-decisions): these indirect MCP servers, extensions or tools are now also available: tools: lazy_b.");
  assert.deepEqual((h.notices()[1].details as { tools: string[] }).tools, ["lazy_b"]);
  // A late codemode tool decided at turn_end is announced through a boundary draft.
  const late = extTool("lazy_late", "codemode"); h.sim.registerTool(late); h.scores.lazy_late = 2;
  const { all } = await h.end({ toolResults: [{}] });
  assert.ok(all.some((draft) => draft.customType === "context-decisions-tools-notice" && /now also available: tools: lazy_late\./.test(String(draft.content))));
  // mcp mode: servers are announced by their canonical namespace key.
  const m = await toolSetup(t, { tools: { mode: "mcp", maxAdded: 1 }, extra: [mcpTool("dev-radius", "q"), mcpTool("docs", "s"), mcpTool("wiki", "w")], scores: { mcp__dev_radius: 2, mcp__docs: 1.5 } });
  await m.start("task");
  assert.match(noticeText(m.notices()[0]), /only these are available now: MCP servers: mcp__dev_radius\./);
  assert.deepEqual(m.notices()[0].details, { v: 1, tools: [], groups: ["mcp__dev_radius"] });
  await m.start("second");
  assert.equal(noticeText(m.notices()[1]), "Tool availability (pi-context-decisions): these indirect MCP servers, extensions or tools are now also available: MCP servers: mcp__docs.");
  assert.doesNotMatch(JSON.stringify(m.notices()), /mcp__wiki|mcp__dev_radius__q|dev-radius server/);
});
test("notice: lists are bounded to 100 names, then 'and N more'", async (t) => {
  const many = Array.from({ length: 121 }, (_, i) => extTool(`lazy_${String(i).padStart(3, "0")}`, "codemode"));
  const scores = Object.fromEntries(many.slice(0, 120).map((tool) => [tool.name, 2]));
  const h = await toolSetup(t, { tools: { maxAdded: 1000 }, extra: many, scores });
  await h.start("task");
  const text = noticeText(h.notices()[0]);
  assert.match(text, /, and 20 more\./); assert.ok(text.includes("lazy_099") && !text.includes("lazy_100"));
  assert.ok(!text.includes("lazy_120"), "the one unavailable tool is not listed");
  assert.ok((h.notices()[0].details as { tools: string[] }).tools.length <= 1000);
});
test("notice: nothing to announce when every candidate is available", async (t) => {
  const h = await toolSetup(t, { extra: [CODE_A], scores: { lazy_a: 2 } });
  await h.start("task"); assert.equal(h.notices().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Concurrency with skill filtering
// ---------------------------------------------------------------------------------------------------------------------------------
const skillFixture = (count = 4) => Array.from({ length: count }, (_, i) => ({ name: `skill-${i}`, description: `Description ${i}`, filePath: `/private/${i}/SKILL.md`, baseDir: `/private/${i}`,
  sourceInfo: { path: `/private/${i}/SKILL.md`, source: "fixture", scope: "user" as const, origin: "top-level" as const }, disableModelInvocation: false }));

test("with skill AND tool filtering on, both decision calls are in flight together and the skill delta is exactly what skills alone produce", async (t) => {
  const scores = { skill_scores: 0, "skill-0": 2, "skill-1": 1.5, ext_a: 2 };
  const both = await toolSetup(t, { skills: true, extra: [A, B], scores, settings: { relevance: { ...defaultSettings().relevance, enabled: true, maxSkills: 2, minCandidates: 0 } } as never });
  both.skillList.push(...skillFixture());
  let release!: () => void; both.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const running = both.start("do the thing");
  await until(() => both.requests.length === 2, "both decision calls");
  assert.equal(both.behavior.peak, 2, "skill and tool decision calls overlap");
  release(); const { results } = await running;
  const skillMessage = (results.at(-1) as { message: { customType: string; content: string; details: unknown } }).message;
  const toolsOnly = await toolSetup(t, { skills: true, tools: { enabled: false }, extra: [A, B], scores, settings: { relevance: { ...defaultSettings().relevance, enabled: true, maxSkills: 2, minCandidates: 0 } } as never });
  toolsOnly.skillList.push(...skillFixture());
  const alone = await toolsOnly.start("do the thing");
  const aloneMessage = (alone.results.at(-1) as { message: typeof skillMessage }).message;
  assert.equal(skillMessage.customType, "context-decisions-skills");
  assert.deepEqual(skillMessage, aloneMessage, "the skill delta is unchanged by tool filtering");
  assert.deepEqual(both.active(), [...CORE, "ext_a"]); assert.equal(await both.gate("ext_a"), undefined);
  assert.equal(both.requests.filter((request) => request.state.tools).length, 1); assert.equal(both.requests.filter((request) => request.state.skills).length, 1);
  const kinds = both.sim.session.getBranch().filter((entry) => entry.customType?.startsWith("context-decisions")).map((entry) => entry.customType);
  assert.deepEqual(kinds, ["context-decisions-tools", "context-decisions-skills"], "the tool ledger record, then the hidden skill delta, right after the user message");
});
test("a failing tool round never disturbs the skill pass, and vice versa", async (t) => {
  const h = await toolSetup(t, { skills: true, extra: [A], fail: true, settings: { relevance: { ...defaultSettings().relevance, enabled: true, maxSkills: 2, minCandidates: 0 }, decision: { failMode: "closed" } } as never });
  h.skillList.push(...skillFixture());
  const { results } = await h.start("task");
  assert.equal((results.at(-1) as { message?: unknown } | undefined)?.message, undefined, "closed failure adds no skills");
  assert.deepEqual(h.active(), CORE, "and no tools");
  assert.equal(h.requests.length, 2, "each feature made exactly one (failed) call");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// MCP resource tools: an explicit ROUTING policy by their local `server` argument, not an exception to "internal tools are always
// allowed" (they stay declared and callable; a whole-server decision just cannot be bypassed through them).
// ---------------------------------------------------------------------------------------------------------------------------------
/** Recovery text for a server the picker cannot offer (resource-only / disconnected): config keys plus /reload, never the Tool picker. */
function assertSettingsFileGuidance(reason: string): void {
  assert.match(reason, /tools\.alwaysAllowedMcpServers/); assert.match(reason, /\.pi\/pi-context-decisions\.json/); assert.match(reason, /\/reload/);
  assert.doesNotMatch(reason, /Tool picker/);
}
const READ = (server: string) => ({ server, uri: "file:///x" });
const SENTINEL = "SENTINEL-SERVER-VALUE";

test("resources: reads are routed by server: blocked while the namespace is unavailable, allowed once it is available, with -/_ folding", async (t) => {
  const h = await toolSetup(t, { tools: { mode: "mcp" }, extra: [...resourceTools(), mcpTool("dev-radius", "q"), mcpTool("docs", "s")], scores: { mcp__dev_radius: 2 } });
  assert.deepEqual(h.active().filter((name) => name.includes("resource")), ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  // Before any decision: everything is unavailable.
  const blocked = await h.gate("read_mcp_resource", READ("dev-radius"));
  assert.match(blocked!.reason, /^MCP resource access to server "dev-radius" is unavailable/); assert.ok(blocked!.reason.length <= 300);
  assertSettingsFileGuidance(blocked!.reason);
  await h.start("search the radar");
  assert.deepEqual(h.active().filter((name) => name.includes("resource")), ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"], "resource tools are never withheld from declarations");
  for (const server of ["dev-radius", "dev_radius"]) assert.equal(await h.gate("read_mcp_resource", READ(server)), undefined, server);
  assert.match((await h.gate("read_mcp_resource", READ("docs")))!.reason, /server "docs" is unavailable/);
});
test("resources: in tools mode any available member tool (or an allowlisted server) makes the server's resources usable", async (t) => {
  const h = await toolSetup(t, { extra: [...resourceTools(), mcpTool("dev-radius", "q"), mcpTool("dev-radius", "r"), mcpTool("docs", "s")], scores: { mcp__dev_radius__q: 2 } });
  await h.start("task");
  assert.equal(await h.gate("read_mcp_resource", READ("dev-radius")), undefined, "one available member is enough");
  assert.match((await h.gate("read_mcp_resource", READ("docs")))!.reason, /unavailable/);
  assert.match((await h.gate("mcp__dev_radius__r"))!.reason, BLOCKED, "the sibling tool is still its own decision in tools mode");
  await reload(h, (settings) => { settings.tools.alwaysAllowedMcpServers = ["docs"]; });
  assert.equal(await h.gate("read_mcp_resource", READ("docs")), undefined, "allowlisting the server opens its resources");
});
test("resources: unscoped listing is ALWAYS blocked while filtering is on (the complete server inventory is unobservable); scoped listing follows availability", async (t) => {
  const h = await toolSetup(t, { tools: { mode: "mcp" }, extra: [...resourceTools(), mcpTool("dev-radius", "q"), mcpTool("docs", "s")], scores: { mcp__dev_radius: 2 } });
  await h.start("task");
  for (const name of ["list_mcp_resources", "list_mcp_resource_templates"]) {
    const blocked = await h.gate(name, {});
    assert.match(blocked!.reason, /Listing MCP resources across all servers is unavailable/, name); assert.ok(blocked!.reason.length <= 300);
    assertSettingsFileGuidance(blocked!.reason);
    assert.equal(await h.gate(name, READ("dev-radius")), undefined, `${name} with an available server`);
    assert.match((await h.gate(name, READ("docs")))!.reason, /unavailable/);
  }
  await reload(h, (settings) => { settings.tools.alwaysAllowedMcpServers = ["docs"]; });
  for (const name of ["list_mcp_resources", "list_mcp_resource_templates"]) assert.match((await h.gate(name, {}))!.reason, /Listing MCP resources/, `${name}: still blocked even when every KNOWN server is available`);
  // No MCP server registered at all: a resource-only server could still exist, so the unscoped listing stays blocked.
  const bare = await toolSetup(t, { extra: resourceTools() }); await bare.start("task");
  assert.match((await bare.gate("list_mcp_resources", {}))!.reason, /Listing MCP resources/);
  const off = await toolSetup(t, { tools: { enabled: false }, extra: resourceTools() });
  assert.equal(await off.gate("list_mcp_resources", {}), undefined, "filtering off: untouched");
});
test("resources: an unknown or resource-only server fails closed unless it is allowlisted", async (t) => {
  const h = await toolSetup(t, { extra: [...resourceTools(), mcpTool("docs", "s")], scores: { mcp__docs__s: 2 } });
  await h.start("task");
  const notes = (await h.gate("read_mcp_resource", READ("notes")))!.reason;
  assert.match(notes, /server "notes" is unavailable/, "no namespace observed: not a known group");
  assertSettingsFileGuidance(notes); // the Tool picker cannot add a server it has never observed: the guidance must name the files
  const longName = (await h.gate("read_mcp_resource", READ("n".repeat(64))))!.reason;
  assert.ok(longName.length <= 300, `${longName.length}`); assertSettingsFileGuidance(longName); // truncation never cuts the instruction
  assert.match((await h.gate("list_mcp_resources", READ("notes")))!.reason, /unavailable/);
  await reload(h, (settings) => { settings.tools.alwaysAllowedMcpServers = ["notes"]; });
  assert.equal(await h.gate("read_mcp_resource", READ("notes")), undefined); assert.equal(await h.gate("list_mcp_resource_templates", READ("notes")), undefined);
  assert.equal(await h.gate("read_mcp_resource", READ("docs")), undefined);
  // A project allowlist file works the same way.
  const p = await toolSetup(t, { extra: resourceTools() });
  await projectFile(p.root, { alwaysAllowedMcpServers: ["wiki"] }); await p.start("task");
  assert.equal(await p.gate("read_mcp_resource", READ("wiki")), undefined); assert.match((await p.gate("read_mcp_resource", READ("other")))!.reason, /unavailable/);
});
test("resources: the `server` value never reaches decisions, messages, ledger or status; hostile values are sanitized and bounded in the reason", async (t) => {
  const h = await toolSetup(t, { extra: [...resourceTools(), mcpTool("docs", "s")], scores: { mcp__docs__s: 2 } });
  await h.start("task");
  await h.gate("read_mcp_resource", READ(SENTINEL)); await h.gate("list_mcp_resources", { server: SENTINEL });
  await h.end({ toolResults: [{}] }); await h.agentEnd(); await h.command("status");
  assert.ok(!JSON.stringify([h.requests, h.messages, h.ledger(), h.notices()]).includes(SENTINEL));
  const hostile = `x\u0000\u001b[31m\n\u202e${"y".repeat(2000)}`;
  const blocked = (await h.gate("read_mcp_resource", READ(hostile)))!;
  assert.ok(blocked.reason.length <= 300); assert.doesNotMatch(blocked.reason, /[\p{Cc}\p{Cf}]/u);
  assert.equal(await h.gate("read_mcp_resource", { server: 42 }), undefined, "no usable server argument: nothing to route, Pi rejects the call itself");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------------------------------------------------------------
test("privacy: decision payloads carry exactly the task and name/description entries; schemas, instructions, annotations and paths never leave", async (t) => {
  const secretTool = extTool("ext_secret", "direct", { parameters: { type: "object", properties: { SECRET_PARAM: { description: "SECRET-SCHEMA-TEXT" } } }, annotations: { title: "SECRET-ANNOTATION", readOnlyHint: true },
    sourceInfo: { path: "/home/SECRET-PATH/ext.ts", source: "extension", scope: "project", origin: "package" }, promptGuidelines: ["SECRET-GUIDELINE"], description: `Useful. ${"long ".repeat(200)}` });
  const tools = await toolSetup(t, { decision: { maxDescriptionChars: 60 }, extra: [secretTool, mcpTool("srv", "x", "codemode", { annotations: { title: "SECRET-ANNOTATION" } })], scores: { ext_secret: 2 } });
  await tools.start("plain task text"); await tools.command("status");
  assert.ok(tools.requests.length > 0);
  for (const request of tools.requests) {
    assert.deepEqual(Object.keys(request.state).sort(), ["task", "tools"]);
    for (const entry of Object.values(request.state.tools as Record<string, Record<string, unknown>>)) {
      assert.deepEqual(Object.keys(entry).sort(), ["description", "name"]); assert.ok(String(entry.description).length <= 60);
    }
    assert.deepEqual(Object.keys(request).sort(), ["questions", "state"]);
  }
  const text = JSON.stringify(tools.requests);
  assert.doesNotMatch(text, /SECRET-(SCHEMA|ANNOTATION|GUIDELINE|PATH|INSTRUCTIONS)|SECRET_PARAM|\/home\/|builtin:mcp|"scope"|"origin"/);
  assert.match(text, /\[MCP server srv\] x on srv/, "the MCP server label accompanies a server's tools");
  assert.deepEqual(tools.ledger()[0].tools, ["ext_secret"], "the oversized candidate was still decided");
  const mcp = await toolSetup(t, { tools: { mode: "mcp" }, extra: [mcpTool("srv", "x", "codemode", { annotations: { title: "SECRET-ANNOTATION" } })], scores: { mcp__srv: 2 } });
  await mcp.start("task");
  const request = mcp.requests[0];
  assert.deepEqual(Object.keys(request.state).sort(), ["servers", "task"]);
  assert.deepEqual(Object.keys((request.state.servers as Record<string, object>).m0).sort(), ["description", "name"]);
  assert.doesNotMatch(JSON.stringify(request.state), /SECRET|builtin:|"aliases"|"instructions"|namespace/);
  assert.doesNotMatch(JSON.stringify(request), /SECRET|builtin:/);
  // Diagnostics, reports and notices never carry tool or server names.
  for (const harness of [tools, mcp]) {
    await harness.command("status");
    assert.doesNotMatch(JSON.stringify(harness.messages), /ext_secret|mcp__srv|SECRET/);
  }
});
test("privacy: decision calls use only the latest bounded user task, never assistant text, tool results or custom-message text", async (t) => {
  const h = await toolSetup(t, { tools: { cadence: "tool-round" }, extra: [A, B], scores: {} });
  await h.start("the user's real task");
  await h.end({ toolResults: [{ toolName: "read", content: "TOOL-RESULT-SECRET" }], pendingMessages: [{ role: "assistant", content: "ASSISTANT-SECRET" }] });
  await h.start("ignored custom text", { messageType: "custom" });
  assert.ok(h.requests.every((request) => request.state.task === "the user's real task"));
  assert.doesNotMatch(JSON.stringify(h.requests), /TOOL-RESULT-SECRET|ASSISTANT-SECRET|ignored custom text/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Gate robustness
// ---------------------------------------------------------------------------------------------------------------------------------
test("gate: unknown tools pass while the registry is readable; with a broken registry the last snapshot decides (internal pass, unknown or unavailable external blocked)", async (t) => {
  const h = await toolSetup(t, { extra: [A, extTool("codemode_like", "direct", { sourceInfo: { path: "builtin:codemode", source: "builtin" } }), { name: "codemode", exposure: "direct", sourceInfo: builtinSource("codemode"), reachesTools: true }, { name: "tool_search", exposure: "direct", sourceInfo: builtinSource("tool-search") }] });
  await h.start("task");
  assert.deepEqual(h.active().filter((name) => ["codemode", "tool_search", "codemode_like"].includes(name)), ["codemode_like", "codemode", "tool_search"], "internal tools are never withheld");
  for (const name of ["read", "bash", "codemode", "tool_search", "never_registered"]) assert.equal(await h.gate(name), undefined, name);
  const original = h.sim.pi.getAllTools;
  h.sim.pi.getAllTools = () => { throw new Error("registry unavailable"); };
  for (const name of ["read", "bash", "codemode", "tool_search"]) assert.equal(await h.gate(name), undefined, `${name}: verified internal by the last snapshot`);
  assert.match((await h.gate("never_registered"))!.reason, /could not be verified/, "a tool the snapshot never saw cannot be verified: blocked");
  assert.match((await h.gate("ext_a"))!.reason, /unavailable|could not be verified/, "a known unavailable external stays blocked");
  h.sim.pi.getAllTools = original;
  // Off: never touches anything.
  await reload(h, (settings) => { settings.tools.enabled = false; });
  assert.equal(await h.gate("ext_a"), undefined);
});
test("gate: an unavailable external candidate is blocked when the gate itself errors mid-way (fail closed); the reason is short and clean", async (t) => {
  const h = await toolSetup(t, { extra: [A], scores: { mcp__srv__x: 2 } });
  await h.start("task");
  h.sim.registerTool(mcpTool("srv", "x", "codemode"));
  const original = h.sim.pi.getAllTools!; let calls = 0;
  // The first read classifies the tool as an unscored candidate; the re-read after lazy scoring fails.
  h.sim.pi.getAllTools = (() => { if (++calls > 1) throw new Error("registry went away"); return original(); }) as typeof original;
  const blocked = await h.gate("mcp__srv__x");
  assert.ok(blocked, "blocked, not allowed"); assert.match(blocked.reason, /could not verify/); assert.ok(blocked.reason.length <= 300);
  h.sim.pi.getAllTools = original;
  assert.equal(await h.gate("read"), undefined);
});
test("gate: reasons are sanitized and bounded for hostile tool and server names", async (t) => {
  const evilTool = `bad\u001b[31m\nname\u0000\u202e${"z".repeat(400)}`;
  const evilServer = `evil\nserver\u001b[2J\u202e${"s".repeat(300)}`;
  const h = await toolSetup(t, { extra: [extTool(evilTool), mcpTool(evilServer, "x", "codemode", { namespace: { name: "mcp__evil_server", description: "d", aliases: [evilServer] } })] });
  await h.start("task");
  const tool = (await h.gate(evilTool))!;
  assert.ok(tool.reason.length <= 300); assert.doesNotMatch(tool.reason, /[\p{Cc}\p{Cf}]/u); assert.match(tool.reason, /^Tool "bad/);
  await reload(h, (settings) => { settings.tools.mode = "mcp"; });
  const server = (await h.gate("mcp__evil_server__x".replace("evil_server", `${evilServer}`.replace(/-/g, "_"))))!;
  assert.ok(server === undefined || server.reason.length <= 300);
  const registered = h.sim.registry.find((info) => info.namespace?.name === "mcp__evil_server")!;
  const blocked = (await h.gate(registered.name))!;
  assert.ok(blocked.reason.length <= 300); assert.doesNotMatch(blocked.reason, /[\p{Cc}\p{Cf}]/u); assert.match(blocked.reason, /^MCP server "evil/);
});
test("gate: nested (codemode-style) and top-level calls to a codemode tool of an unavailable namespace are blocked by name; internal orchestrators pass", async (t) => {
  const h = await toolSetup(t, { extra: [{ name: "codemode", exposure: "direct", sourceInfo: builtinSource("codemode"), reachesTools: true }, mcpTool("srv", "x", "codemode"), mcpTool("deferred-srv", "y", "deferred")], scores: { mcp__srv__x: 2 } });
  assert.equal(await h.gate("codemode", { code: "await tools.mcp__srv__x({})" }), undefined);
  for (const extra of [undefined, { toolCallId: "call-1/1", parentToolCallId: "call-1" }, { toolCallId: "call-1/1/2", parentToolCallId: "call-1/1" }]) {
    assert.match((await h.gate("mcp__srv__x", {}, extra))!.reason, BLOCKED, JSON.stringify(extra));
    assert.match((await h.gate("mcp__deferred_srv__y", {}, extra))!.reason, BLOCKED);
  }
  await h.start("use srv");
  assert.equal(await h.gate("mcp__srv__x", {}, { toolCallId: "call-2/1", parentToolCallId: "call-2" }), undefined, "once available, nested calls pass too");
  assert.match((await h.gate("mcp__deferred_srv__y", {}, { toolCallId: "call-2/2", parentToolCallId: "call-2" }))!.reason, BLOCKED);
  assert.deepEqual(h.active(), [...CORE, "codemode"], "codemode-exposed tools are never activated by us; internal codemode is untouched");
});
