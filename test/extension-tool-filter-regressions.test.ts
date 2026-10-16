// Regression tests for review findings: fail-closed registry/branch reads, stale-generation purity, lossless ledger chunks,
// restore at continuing boundaries, unconfigured/minimum policy at every boundary, canonical server keys, notice scope, resource additivity.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readToolLedger } from "../src/extension/tool-ledger.ts";
import { CORE, extTool, mcpTool, resourceTools, toolSetup, type ToolHarness } from "./helpers/tool-fixture.ts";
import { loadSettings, saveSettings } from "../src/settings.ts";
import { normalizeServerAllowlist } from "../src/apps/allowlist.ts";

const A = extTool("ext_a"), B = extTool("ext_b");
const BLOCKED = /is unavailable|could not be verified/;
const until = async (condition: () => boolean, what: string) => { for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 1)); assert.ok(condition(), what); };
const reload = async (h: ToolHarness, change: (settings: Awaited<ReturnType<typeof loadSettings>>["settings"]) => void) => {
  const { settings } = await loadSettings(h.path); change(settings); await saveSettings(settings, h.path);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
};

test("registry unreadable, NO snapshot: nothing can be verified, so every call is blocked until it recovers", async (t) => {
  const h = await toolSetup(t, { extra: [A] });
  const original = h.sim.pi.getAllTools!;
  h.sim.pi.getAllTools = () => { throw new Error("registry unavailable"); };
  for (const name of ["ext_a", "read", "bash", "never_registered"]) assert.match((await h.gate(name))!.reason, /could not be verified/, name);
  h.sim.pi.getAllTools = original;
  assert.equal(await h.gate("read"), undefined, "recovered");
});
test("registry unreadable WITH a snapshot: verified internal tools pass, known unavailable and unknown tools are blocked, known available externals pass", async (t) => {
  const h = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2 } });
  await h.start("task");
  h.sim.pi.getAllTools = () => { throw new Error("registry unavailable"); };
  for (const name of ["read", "bash"]) assert.equal(await h.gate(name), undefined, name);
  assert.equal(await h.gate("ext_a"), undefined, "known and available by the ledger");
  assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
  assert.match((await h.gate("never_registered"))!.reason, /could not be verified/);
  assert.equal(h.requests.length, 1, "a degraded registry never triggers lazy scoring");
});
test("resource tools with a degraded registry keep their routing policy (a known resource tool is never treated as plain internal)", async (t) => {
  const h = await toolSetup(t, { extra: [...resourceTools(), mcpTool("docs", "s", "direct")], scores: { mcp__docs__s: 2 } });
  await h.start("task");
  h.sim.pi.getAllTools = () => { throw new Error("registry unavailable"); };
  assert.equal(await h.gate("read_mcp_resource", { server: "docs" }), undefined);
  assert.match((await h.gate("read_mcp_resource", { server: "other" }))!.reason, /unavailable/);
  assert.match((await h.gate("list_mcp_resources", {}))!.reason, /Listing MCP resources/);
});
test("a throwing project allowlist read never loosens the gate: the last good cache or the global lists apply, and the caller never sees the error", async (t) => {
  let fail = false;
  const h = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_g"] }, extra: [A, B, extTool("ext_g")], scores: { ext_a: 0 },
    async loadProjectAllowlist() { if (fail) throw new Error("PRIVATE disk error"); return { names: [], tools: ["ext_b"], mcpServers: [], warnings: [] }; } });
  assert.equal(await h.gate("ext_b"), undefined, "first read succeeds and caches: ext_b is project-allowlisted");
  fail = true;
  assert.equal(await h.gate("ext_b"), undefined, "the last good cache survives a failing refresh");
  await h.start("task").catch(() => {}); // refreshes at the boundary: the (test-only) read throws; the skill path has its own reader
  assert.equal(await h.gate("ext_g"), undefined); assert.equal(await h.gate("read"), undefined); assert.match((await h.gate("ext_a"))!.reason, BLOCKED);
  assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE/);
  const cold = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_g"] }, extra: [A, B, extTool("ext_g")], async loadProjectAllowlist() { throw new Error("boom"); } });
  assert.equal(await cold.gate("ext_g"), undefined, "no cache: only the global list applies"); assert.match((await cold.gate("ext_b"))!.reason, BLOCKED);
});

test("stale generation: removing a pin, disabling or changing the mode mid-round leaves NO ledger record, marker, base or declaration change", async (t) => {
  const changes: [string, (h: Awaited<ReturnType<typeof toolSetup>>) => Promise<void>][] = [
    ["removing a pin", (h) => h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "ext_p" })],
    ["disabling", (h) => h.set("tools.enabled")], ["changing the mode", (h) => h.set("tools.mode", "mcp")],
  ];
  for (const [change, apply] of changes) {
    const h = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_p"] }, extra: [A, extTool("ext_p"), mcpTool("srv", "x", "direct")], scores: { ext_a: 2 } });
    const before = h.active();
    let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
    const running = h.start("task");
    await until(() => h.requests.length === 1, "the decision call");
    await apply(h);
    release(); await running;
    assert.deepEqual(h.ledger(), [], `${change}: nothing recorded`); assert.equal(h.sim.calls.setActiveTools, 0, `${change}: nothing reconciled`);
    assert.deepEqual(h.active(), before); assert.equal(h.notices().length, 0);
  }
});
test("same-generation abort (the run was cancelled): reconcile from the committed branch only, with no additions, base growth or initial task", async (t) => {
  const h = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_p"], cadence: "initial" }, extra: [A, B, extTool("ext_p")], scores: { ext_a: 2 } });
  const controller = new AbortController(); (h.ctx as { signal?: AbortSignal }).signal = controller.signal;
  let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const running = h.start("first task");
  await until(() => h.requests.length === 1, "the decision call");
  controller.abort(); release(); await running;
  const ledger = readToolLedger(h.sim.session);
  assert.deepEqual([...ledger.tools], [], "no additions and no allowlist base from the aborted pass"); assert.equal(ledger.initialTask, undefined);
  assert.deepEqual([...ledger.withheld].sort(), ["ext_a", "ext_b"], "undecided declared tools are withheld from the committed state (fail closed)");
  assert.ok(ledger.present, "the fresh-branch marker survives, so a later tool is still scored rather than assumed seen");
  assert.deepEqual(h.active(), [...CORE, "ext_p"]);
});
test("an unreadable session branch is not mid-session evidence: nothing is granted, written or reconciled; only the fail-closed gate acts", async (t) => {
  const h = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_p"] }, extra: [A, B, extTool("ext_p")], scores: { ext_a: 2 } });
  const original = h.sim.session.getBranch.bind(h.sim.session);
  h.sim.session.getBranch = () => { throw new Error("branch unreadable"); };
  const mine = () => h.sim.session.all.filter((entry) => /^context-decisions-tools/.test(entry.customType ?? "")).length;
  await h.start("task"); await h.end({ toolResults: [{}] }); await h.agentEnd();
  assert.equal(h.requests.length, 0); assert.equal(h.sim.calls.setActiveTools, 0); assert.equal(mine(), 0);
  assert.equal(await h.gate("read"), undefined); assert.equal(await h.gate("ext_p"), undefined, "allowlisted names still apply");
  assert.match((await h.gate("ext_a"))!.reason, BLOCKED); assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
  h.sim.session.getBranch = original;
  // Once readable, the run that went out with every tool declared is real mid-session evidence (the model did see them): that is the
  // documented enable-mid-session semantics, decided from the readable branch, not invented from the failure.
  await h.start("task"); assert.ok(readToolLedger(h.sim.session).present); assert.equal(await h.gate("ext_a"), undefined);
});

test("lossless ledger: 1001 withheld direct tools survive chunking, a reload and disabling (all restored); 1001 added names are all remembered", async (t) => {
  const tools = Array.from({ length: 1001 }, (_, i) => extTool(`ext_${String(i).padStart(4, "0")}`));
  const h = await toolSetup(t, { extra: tools });
  await h.start("task");
  assert.deepEqual(h.active(), CORE);
  const records = h.ledger().filter((entry) => entry.withheld);
  assert.ok(records.length >= 2 && records.every((entry) => (entry.withheld as string[]).length <= 1000), "chunked");
  assert.equal(readToolLedger(h.sim.session).withheld.size, 1001, "no tool lost ownership");
  const reloaded = await toolSetup(t, { session: h.sim.session, tools: { enabled: false }, extra: tools });
  reloaded.sim.tools.active = [...CORE];
  await reloaded.start("next");
  assert.equal(reloaded.active().length, CORE.length + 1001, "disabling restored every withheld tool");
  assert.equal(readToolLedger(h.sim.session).tools.size, 1001, "and recorded every tool as available (no 1000-name truncation)");
  const open = await toolSetup(t, { decision: { failMode: "open" }, extra: tools, fail: true });
  await open.start("task");
  assert.equal(readToolLedger(open.sim.session).tools.size, 1001); assert.equal(open.active().length, CORE.length + 1001);
  const considered = await toolSetup(t, { tools: { cadence: "initial" }, extra: tools });
  await considered.start("first");
  assert.equal(readToolLedger(considered.sim.session).considered.size, 1001);
});
test("turning filtering off mid-run restores withheld tools at the next continuing boundary, not only at a new prompt; never-filtered branches stay untouched", async (t) => {
  const h = await toolSetup(t, { extra: [A, B], scores: { ext_a: 2 } });
  await h.start("task");
  assert.deepEqual(h.active(), [...CORE, "ext_a"]);
  await h.set("tools.enabled");
  const { all } = await h.end({ toolResults: [{}] });
  assert.deepEqual(h.active(), [...CORE, "ext_a", "ext_b"], "restored at turn_end");
  assert.ok(all.some((draft) => (draft as { data?: { released?: string[] } }).data?.released?.includes("ext_b")));
  assert.equal(await h.gate("ext_b"), undefined, "and the gate is off");
  const calls = { ...h.sim.calls }; await h.end({ toolResults: [{}] });
  assert.deepEqual((await h.end({ toolResults: [{}] })).all, [], "nothing more to write once restored");
  assert.ok(h.sim.calls.setActiveTools === calls.setActiveTools);
  const never = await toolSetup(t, { tools: { enabled: false }, extra: [A, B] });
  await never.start("task"); await never.end({ toolResults: [{}] });
  assert.deepEqual(never.sim.calls, { getAllTools: 0, setActiveTools: 0 });
});
test("unconfigured or below-minimum: late tools stay available at turn_end and at the gate, with no decision calls", async (t) => {
  for (const options of [{ unconfigured: true }, { tools: { minCandidates: 10 } }]) {
    const h = await toolSetup(t, { ...options, extra: [A] });
    await h.start("task");
    h.sim.registerTool(extTool("ext_late")); h.sim.registerTool(mcpTool("srv", "x", "codemode"));
    assert.equal(await h.gate("mcp__srv__x"), undefined, "a late codemode tool is available at the gate");
    await h.end({ toolResults: [{}] });
    assert.ok(h.active().includes("ext_late"), "a late direct tool is not withheld"); assert.equal(h.requests.length, 0);
    await h.agentEnd();
    assert.ok(readToolLedger(h.sim.session).tools.has("ext_late"), "and recorded as available");
  }
});
test("an unconfigured boundary also keeps tools registered between prompts available on the next prompt", async (t) => {
  const h = await toolSetup(t, { unconfigured: true, extra: [A] });
  await h.start("one"); h.sim.registerTool(extTool("ext_late"));
  await h.start("two");
  assert.ok(h.active().includes("ext_late")); assert.equal(h.requests.length, 0);
});

test("allowlist entries: a `mcp__` prefix is EXCLUSIVELY a canonical key; a raw server named mcp__prod is mcp__mcp__prod", async (t) => {
  const prod = mcpTool("prod", "x"), raw = mcpTool("mcp__prod", "y");
  for (const [entry, allowed, blocked] of [["mcp__prod", prod, raw], ["mcp__mcp__prod", raw, prod], ["prod", prod, raw]] as const) {
    const h = await toolSetup(t, { tools: { alwaysAllowedMcpServers: [entry] }, extra: [prod, raw] });
    await h.start("task");
    assert.equal(await h.gate(allowed.name), undefined, `${entry} allows its own server`); assert.match((await h.gate(blocked.name))!.reason, BLOCKED, `${entry} does not allow the other`);
    assert.deepEqual(readToolLedger(h.sim.session).groups.has(allowed.namespace!.name), true);
  }
  // `prod` and `mcp__prod` are one server; a raw `mcp__prod` server is spelled by its namespace key. The editors persist through this normalizer.
  assert.deepEqual(normalizeServerAllowlist(["mcp__prod", "prod", "mcp__mcp__prod"]), ["mcp__mcp__prod", "mcp__prod"]);
});
test("notice scope: it speaks only about indirect (codemode/deferred) candidates and says directly declared and unfiltered tools are unaffected", async (t) => {
  const h = await toolSetup(t, { extra: [A, extTool("lazy", "codemode"), mcpTool("srv", "x", "codemode")], scores: { ext_a: 2, lazy: 2 } });
  await h.start("task");
  const text = String(h.notices()[0].content);
  assert.match(text, /reached indirectly/); assert.match(text, /only these are available now: tools: lazy\./); assert.match(text, /declared to you directly, built-in tools and unfiltered extension tools are unaffected/);
  assert.doesNotMatch(text, /ext_a|mcp__srv__x/, "direct selections are Pi's own declarations; the unavailable server is not named");
  assert.doesNotMatch(text, /of the MCP servers and tools listed elsewhere/);
  const m = await toolSetup(t, { tools: { mode: "mcp" }, extra: [A, mcpTool("srv", "x", "codemode"), mcpTool("docs", "s", "codemode")], scores: { mcp__docs: 2 } });
  await m.start("task");
  const mcpText = String(m.notices()[0].content);
  assert.match(mcpText, /MCP servers: mcp__docs/); assert.doesNotMatch(mcpText, /ext_a/); assert.match(mcpText, /unfiltered extension tools are unaffected/);
  assert.match((await m.gate("ext_a"))!.reason, /^Extension "ext_a" is unavailable/, "an extension is a decided group in mcp mode, exactly like a server");
});
test("resource-only servers: allowlist keys are recorded durably, so removing the entry never revokes access that was available; a gate-time use is flushed too", async (t) => {
  const h = await toolSetup(t, { tools: { alwaysAllowedMcpServers: ["files"] }, extra: resourceTools() });
  await h.start("task");
  assert.ok(readToolLedger(h.sim.session).groups.has("mcp__files"), "recorded by canonical key even with no registered tools");
  assert.equal(await h.gate("read_mcp_resource", { server: "files" }), undefined);
  await reload(h, (settings) => { settings.tools.alwaysAllowedMcpServers = []; });
  assert.equal(await h.gate("read_mcp_resource", { server: "files" }), undefined, "still accessible after the allowlist entry is removed");
  assert.equal(await h.gate("read_mcp_resource", { server: "other" }) === undefined, false);
  // Used at the gate before any boundary recorded it.
  const early = await toolSetup(t, { tools: { alwaysAllowedMcpServers: ["notes"] }, extra: resourceTools() });
  assert.equal(await early.gate("read_mcp_resource", { server: "notes" }), undefined);
  await early.start("task");
  await reload(early, (settings) => { settings.tools.alwaysAllowedMcpServers = []; });
  assert.equal(await early.gate("read_mcp_resource", { server: "notes" }), undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Race regressions: a superseded pass takes back ONLY its own additions; a gate verdict is re-evaluated when its inputs changed.
// ---------------------------------------------------------------------------------------------------------------------------------
const holdRound = (h: ToolHarness) => { let release!: () => void; h.behavior.gate = new Promise<void>((resolve) => { release = resolve; }); return () => { release(); h.behavior.gate = undefined; }; };

test("branch change during a boundary: the stale pass never resurrects pending names from the OLD branch onto the new one", async (t) => {
  const h = await toolSetup(t, { tools: { alwaysAllowedMcpServers: ["notes"] }, extra: [...resourceTools(), A, B], scores: { ext_a: 2 } });
  assert.equal(await h.gate("read_mcp_resource", { server: "notes" }), undefined, "an allowlisted resource server is used: its key is pending (unflushed) on the old branch");
  const release = holdRound(h);
  const running = h.start("second task");
  await until(() => h.requests.length === 1, "the boundary's decision call");
  h.sim.session.navigate(null); // a different, empty branch
  await h.sim.emit("session_tree", { type: "session_tree" }, h.ctx);
  release(); await running;
  await h.agentEnd();
  assert.deepEqual(h.ledger(), [], "nothing from the old branch (pending A) or from the stale pass reached the new branch");
  assert.equal(readToolLedger(h.sim.session).groups.size, 0);
  assert.match((await h.gate("ext_b"))!.reason, BLOCKED);
});
test("settings save during a boundary: the stale pass takes back only ITS additions; names pending from other passes survive", async (t) => {
  const h = await toolSetup(t, { tools: { alwaysAllowedMcpServers: ["notes"] }, extra: [...resourceTools(), A, B], scores: { ext_a: 2 } });
  assert.equal(await h.gate("read_mcp_resource", { server: "notes" }), undefined);
  const release = holdRound(h);
  const running = h.start("task");
  await until(() => h.requests.length === 1, "the decision call");
  await h.set("decision.threshold", "0.5");
  release(); await running;
  await h.agentEnd();
  const ledger = readToolLedger(h.sim.session);
  assert.deepEqual([...ledger.groups], ["mcp__notes"], "the pending name that predates the stale pass is still flushed");
  assert.equal(ledger.tools.size, 0, "the stale pass's own additions (the decided tool) were never recorded");
  assert.equal(ledger.initialTask, undefined);
});

test("gate: removing the global pin while the project allowlist read is pending re-evaluates with the CURRENT settings (blocked, not granted)", async (t) => {
  let hold: Promise<void> | undefined; let reads = 0;
  const h = await toolSetup(t, { tools: { alwaysAllowedTools: ["ext_x"] }, extra: [extTool("ext_x")],
    // Only the gate's own read is held: the dialog that saves the allowlist reads the project list too.
    async loadProjectAllowlist() { const mine = reads++ === 0; if (mine) await hold; return { names: [], tools: [], mcpServers: [], warnings: [] }; } });
  let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
  const call = h.gate("ext_x");
  await until(() => reads === 1, "the project read");
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "ext_x" });
  const readsAfterSave = reads;
  hold = undefined; release();
  assert.match((await call)!.reason, BLOCKED, "the verdict computed from the old pin was discarded");
  assert.ok(reads > readsAfterSave, "the allowlists were re-read for the re-evaluation");
  assert.equal(readToolLedger(h.sim.session).tools.has("ext_x"), false, "and nothing was recorded for it");
});
test("gate: a mode change during lazy scoring discards the old-mode verdict and its additions", async (t) => {
  const h = await toolSetup(t, { extra: [A], scores: { ext_a: 2, mcp__srv__x: 2 } });
  await h.start("task");
  h.sim.registerTool(mcpTool("srv", "x", "codemode"));
  const release = holdRound(h);
  const call = h.gate("mcp__srv__x");
  await until(() => h.requests.length === 2, "the lazy round");
  await h.set("tools.mode", "mcp");
  release();
  assert.match((await call)!.reason, /MCP server "srv" is unavailable/, "re-evaluated in mcp mode: the namespace was never decided there");
  await h.agentEnd();
  assert.equal(readToolLedger(h.sim.session).tools.has("mcp__srv__x"), false, "the obsolete tools-mode addition was not recorded");
});
test("gate: disabling filtering during lazy scoring lets the call through without recording the obsolete round", async (t) => {
  const h = await toolSetup(t, { extra: [A], scores: { mcp__srv__x: 2 } });
  await h.start("task");
  h.sim.registerTool(mcpTool("srv", "x", "codemode"));
  const release = holdRound(h);
  const call = h.gate("mcp__srv__x");
  await until(() => h.requests.length === 2, "the lazy round");
  await h.set("tools.enabled");
  release();
  assert.equal(await call, undefined, "filtering is off now");
  await h.agentEnd();
  assert.equal(readToolLedger(h.sim.session).tools.has("mcp__srv__x"), false);
});
test("gate: an obsolete project-allowlist read can never populate the cache after a reset", async (t) => {
  let reads = 0; let hold!: () => void;
  const first = new Promise<void>((resolve) => { hold = resolve; });
  const h = await toolSetup(t, { extra: [extTool("ext_x")], async loadProjectAllowlist() {
    reads++;
    if (reads === 1) { await first; return { names: [], tools: ["ext_x"], mcpServers: [], warnings: [] }; }
    return { names: [], tools: [], mcpServers: [], warnings: [] };
  } });
  const call = h.gate("ext_x");
  await until(() => reads === 1, "the first read");
  h.sim.session.navigate(null);
  await h.sim.emit("session_tree", { type: "session_tree" }, h.ctx); // reset: the pending read is obsolete
  hold();
  assert.match((await call)!.reason, BLOCKED, "the obsolete read's allowlist did not grant the call");
  assert.equal(reads, 2, "it was re-read, not served from an obsolete cache");
  assert.match((await h.gate("ext_x"))!.reason, BLOCKED); assert.equal(reads, 2, "and only the fresh read was cached");
});
