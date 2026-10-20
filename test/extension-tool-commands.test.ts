// Tool/MCP settings through the dialog's save paths (RPC menus, terminal editors), plus the read-only `/decisions tools|mcp list` reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { defaultSettings, loadSettings, updateSetting } from "../src/settings.ts";
import { rpcContext, setModel } from "./helpers/settings-ui.ts";
import { loadProjectAllowlist, projectAllowlistPath, saveProjectAllowlist } from "../src/project-allowlist.ts";
import type { SimToolInfo } from "./helpers/pi-sim.ts";
import { extTool, mcpTool, toolSetup, resourceTools, type ToolHarness } from "./helpers/tool-fixture.ts";

const last = (h: ToolHarness) => h.messages.at(-1)!;
const saved = async (h: ToolHarness) => (await loadSettings(h.path)).settings;

test("the tool picker toggle persists, never selects a model and never touches skill filtering; defaults stay off", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false }, unconfigured: true, skills: true });
  await h.set("tools.enabled");
  assert.equal((await saved(h)).tools.enabled, true); assert.equal((await saved(h)).backend, null, "enabling tool filtering never selects a model");
  assert.equal((await saved(h)).relevance.enabled, true, "skill filtering is untouched");
  await h.set("tools.enabled"); assert.equal((await saved(h)).tools.enabled, false);
  await setModel((args, ctx) => h.sim.command(args, ctx), h.ctx, "none");
  assert.equal((await saved(h)).tools.enabled, false, "selecting a model never enables tool filtering");
});
test("tool settings: mode, cadence and scalars validate through the same strict rules; bad input changes nothing", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  await h.set("tools.mode", "mcp"); await h.set("tools.cadence", "initial"); await h.set("decision.threshold", "0.5"); await h.set("tools.maxAdded", "3");
  await h.set("tools.minCandidates", "2"); await h.set("decision.failMode", "open"); await h.set("decision.maxDescriptionChars", "120");
  assert.deepEqual({ ...(await saved(h)).tools }, { enabled: false, mode: "mcp", cadence: "initial", maxAdded: 3, minCandidates: 2, alwaysAllowedTools: [], alwaysAllowedMcpServers: [] });
  assert.deepEqual((await saved(h)).decision, { ...defaultSettings().decision, threshold: 0.5, failMode: "open", maxDescriptionChars: 120 });
  for (const [key, bad] of [["decision.threshold", "2"], ["decision.threshold", "-1"], ["tools.maxAdded", "1001"], ["decision.maxDescriptionChars", "0"], ["tools.mode", "everything"], ["tools.cadence", "sometimes"]] as const) {
    const before = JSON.stringify(await saved(h));
    await h.set(key, bad);
    assert.equal(JSON.stringify(await saved(h)), before, `${key} ${bad}`);
  }
  assert.ok(h.messages.length >= 4, "numeric validation errors are reported");
  assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE|SECRET/);
  // The allowlists are edited by the editors, never by a scalar setting.
  assert.throws(() => updateSetting(defaultSettings(), "tools.alwaysAllowedTools", "x"), /Tools tab/);
});
// Tools with no usable provenance belong to no group, so the editor saves them by name.
const ungrouped = (name: string): SimToolInfo => ({ name, description: `Does ${name}`, exposure: "direct" });
test("allowlist editors: tool, MCP server and skill lists persist per scope, keep each other, and are names-only", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false }, extra: [ungrouped("alpha"), ungrouped("zeta"), { ...ungrouped("project_alpha"), sourceInfo: { source: "sdk", path: "", scope: "project" } }, mcpTool("dev-radius", "q", "direct"), mcpTool("project-server", "q", "direct", { sourceInfo: { source: "sdk", path: "", scope: "project" } })] });
  await saveProjectAllowlist(h.root, { skills: ["skill-one"] });
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "zeta" });
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "alpha" });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["alpha", "zeta"]);
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "alpha" });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["zeta"], "toggling removes");
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Project", toggle: "project_alpha" });
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Project", toggle: "project-server" });
  assert.deepEqual(await loadProjectAllowlist(h.root), { names: ["skill-one"], tools: ["project_alpha"], mcpServers: ["mcp__project_server"], warnings: [] });
  const file = JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8"));
  assert.deepEqual(file, { alwaysAllowed: ["skill-one"], alwaysAllowedTools: ["project_alpha"], alwaysAllowedMcpServers: ["mcp__project_server"] });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["zeta"], "project saves leave the global list alone");
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Global", toggle: "dev-radius" });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedMcpServers, ["mcp__dev_radius"], "groups are saved by their canonical key");
  assert.deepEqual(JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8")), file, "global saves never touch the project file");
});
test("tools list and mcp list are local, names-only and make no decision calls; tool and server counts are honest", async (t) => {
  const h = await toolSetup(t, { extra: [extTool("ext_a"), mcpTool("dev-radius", "q", "codemode"), mcpTool("docs", "s", "direct"), { name: "hid", exposure: "hidden" }, ...resourceTools()], scores: { ext_a: 2 } });
  await h.start("task");
  const calls = h.requests.length;
  await h.command("tools list");
  const report = last(h);
  assert.match(report, /Tools \(3 external, 5 internal always allowed, 1 hidden; filtering on · mode tools\)/);
  assert.match(report, /ext_a · extension ext_a · direct · available/); assert.match(report, /mcp__dev_radius__q · MCP dev-radius · codemode · unavailable/);
  assert.doesNotMatch(report, /SECRET|parameters|instructions/);
  await h.command("mcp list");
  assert.match(last(h), /MCP servers and extensions \(3, filtering on · mode tools\)/); assert.match(last(h), /MCP dev-radius \(mcp__dev_radius\) · 1 tools · unavailable/);
  assert.match(last(h), /extension ext_a \(ext__ext_a\) · 1 tools/, "extensions are listed beside servers, by their canonical key");
  assert.match(last(h), /Tools tab cannot add them/); assert.match(last(h), /tools\.alwaysAllowedMcpServers/); assert.match(last(h), /\.pi\/pi-context-decisions\.json/); assert.match(last(h), /\/reload/);
  assert.equal(h.requests.length, calls, "listing never calls the decision model");
});
test("status shows tool filtering lines and the not-a-sandbox sentence; off says opt-in", async (t) => {
  const off = await toolSetup(t, { tools: { enabled: false } });
  await off.command("status"); assert.match(last(off), /Tool filtering: off \(opt-in, separate from skill filtering/);
  const on = await toolSetup(t, { extra: [extTool("ext_a")], scores: { ext_a: 2 } });
  await on.start("task"); await on.command("status");
  const text = last(on);
  assert.match(text, /Tool filtering: on · mode tools · picker prompt/); assert.match(text, /Last tool round \(prompt\): filtered, \+1 of 1 candidates, 1\/1 available/);
  assert.match(text, /not a sandbox/); assert.match(text, /discovery listings/); assert.match(text, /mid-session keeps tools already registered available/);
  assert.doesNotMatch(text, /ext_a/, "status carries counts, never tool names");
});
test("RPC tool-limit labels and input help follow mode changes while edits keep their original keys", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  type Select = (title: string, options: string[]) => string | undefined;
  const pick = (prefix: string): Select => (_title, options) => { const option = options.find((value) => value.startsWith(prefix)); assert.ok(option, `missing ${prefix}`); return option; };
  const limit = (key: string, noun: string, max: number, min: number): Select => (title, options) => {
    assert.equal(title, "Decisions · Advanced settings");
    assert.ok(options.includes(`tools.maxAdded: ${max} · ${noun} · Max added per round`));
    assert.ok(options.includes(`tools.minCandidates: ${min} · ${noun} · Minimum candidates`));
    return key === "Back" ? "Back" : pick(`tools.${key}:`)(title, options);
  };
  const actions: Select[] = [
    () => "Advanced", limit("maxAdded", "Tools", 8, 0), limit("minCandidates", "Tools", 3, 0), () => "Back",
    () => "Tools", pick("tools.mode:"), pick("mcp ·"), () => "Back",
    () => "Advanced", limit("maxAdded", "MCP/exts", 3, 2), limit("minCandidates", "MCP/exts", 5, 2), () => "Back",
    () => "Tools", pick("tools.mode:"), pick("tools ·"), () => "Back",
    () => "Advanced", limit("Back", "Tools", 5, 4), () => "Done",
  ];
  const titles: string[] = []; const inputs = ["3", "2", "5", "4"];
  await h.sim.command("", rpcContext(h.ctx, {
    async select(title: string, options: string[]) { assert.ok(actions.length, "unexpected menu"); return actions.shift()!(title, options); },
    async input(title: string) { titles.push(title); return inputs.shift(); },
    custom() { throw new Error("custom overlay in rpc"); },
  }));
  assert.equal(actions.length, 0); assert.equal(inputs.length, 0);
  assert.match(titles[0], /tools\.maxAdded.*Tools · Max added per round/);
  assert.match(titles[1], /tools\.minCandidates.*Tools · Minimum candidates/);
  assert.match(titles[2], /tools\.maxAdded.*MCP\/exts · Max added per round.*whole group counts once/);
  assert.match(titles[3], /tools\.minCandidates.*MCP\/exts · Minimum candidates.*Below this many groups/);
  assert.deepEqual((await saved(h)).tools, { ...defaultSettings().tools, maxAdded: 5, minCandidates: 4 });
  assert.equal(h.requests.length, 0, "settings edits never score candidates");
});

test("RPC mode keeps select/input menus for the tools group and never calls custom overlays", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  const picks: string[] = [];
  const answers = ["Tools", "tools.enabled", "tools.mode", (o: string[]) => o.find((x) => x.startsWith("mcp"))!, "decision.threshold", "Back", "Done"];
  const inputs = ["0.6"]; let step = 0;
  const ctx = h.ctx as unknown as { hasUI: boolean; mode: string; ui: Record<string, unknown> };
  ctx.hasUI = true; ctx.mode = "rpc";
  ctx.ui.custom = () => { throw new Error("custom overlay in rpc"); };
  ctx.ui.select = async (title: string, options: string[]) => {
    picks.push(title);
    const want = [
      (o: string[]) => o.find((x) => x.startsWith("Tools"))!, (o: string[]) => o.find((x) => x.startsWith("tools.enabled"))!, (o: string[]) => o.find((x) => x.startsWith("tools.mode"))!,
      (o: string[]) => o.find((x) => x.startsWith("mcp"))!, () => "Back", () => "Advanced", (o: string[]) => o.find((x) => x.startsWith("decision.threshold"))!, () => "Back", () => "Done"][step++];
    void answers; return want(options);
  };
  ctx.ui.input = async () => inputs.shift();
  await h.command("");
  const s = await saved(h);
  assert.deepEqual([s.tools.enabled, s.tools.mode, s.decision.threshold], [true, "mcp", 0.6]);
  assert.ok(picks.some((title) => /Tools settings/.test(title)));
});
