// Tool/MCP settings through the dialog's save paths (RPC menus, terminal editors), plus the read-only `/decisions tools|mcp list` reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { defaultSettings, loadSettings, updateSetting } from "../src/settings.ts";
import { setModel } from "./helpers/settings-ui.ts";
import { loadProjectAllowlist, projectAllowlistPath, saveProjectAllowlist } from "../src/project-allowlist.ts";
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
  await h.set("tools.mode", "mcp"); await h.set("tools.cadence", "initial"); await h.set("tools.threshold", "0.5"); await h.set("tools.maxAdded", "3");
  await h.set("tools.minCandidates", "2"); await h.set("tools.failMode", "open"); await h.set("tools.maxDescriptionChars", "120");
  assert.deepEqual({ ...(await saved(h)).tools }, { enabled: false, mode: "mcp", cadence: "initial", threshold: 0.5, maxAdded: 3, minCandidates: 2, failMode: "open", maxDescriptionChars: 120, alwaysAllowedTools: [], alwaysAllowedMcpServers: [] });
  for (const [key, bad] of [["tools.threshold", "2"], ["tools.threshold", "-1"], ["tools.maxAdded", "1001"], ["tools.maxDescriptionChars", "0"], ["tools.mode", "everything"], ["tools.cadence", "sometimes"]] as const) {
    const before = JSON.stringify(await saved(h));
    await h.set(key, bad);
    assert.equal(JSON.stringify(await saved(h)), before, `${key} ${bad}`);
  }
  assert.ok(h.messages.length >= 4, "numeric validation errors are reported");
  assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE|SECRET/);
  // The allowlists are edited by the editors, never by a scalar setting.
  assert.throws(() => updateSetting(defaultSettings(), "tools.alwaysAllowedTools", "x"), /Tool picker tab/);
});
test("allowlist editors: tool, MCP server and skill lists persist per scope, keep each other, and are names-only", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false }, extra: [extTool("alpha"), extTool("zeta"), mcpTool("dev-radius", "q", "direct")] });
  await saveProjectAllowlist(h.root, { skills: ["skill-one"] });
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "zeta" });
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "alpha" });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["alpha", "zeta"]);
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Global", toggle: "alpha" });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["zeta"], "toggling removes");
  await h.allowlist({ tab: "tools", row: "Always allowed tools · Project", toggle: "alpha" });
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers · Project", toggle: "dev-radius" });
  assert.deepEqual(await loadProjectAllowlist(h.root), { names: ["skill-one"], tools: ["alpha"], mcpServers: ["dev-radius"], warnings: [] });
  const file = JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8"));
  assert.deepEqual(file, { alwaysAllowed: ["skill-one"], alwaysAllowedTools: ["alpha"], alwaysAllowedMcpServers: ["dev-radius"] });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["zeta"], "project saves leave the global list alone");
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers · Global", toggle: "dev-radius" });
  assert.deepEqual((await saved(h)).tools.alwaysAllowedMcpServers, ["dev-radius"]);
});
test("tools list and mcp list are local, names-only and make no decision calls; tool and server counts are honest", async (t) => {
  const h = await toolSetup(t, { extra: [extTool("ext_a"), mcpTool("dev-radius", "q", "codemode"), mcpTool("docs", "s", "direct"), { name: "hid", exposure: "hidden" }, ...resourceTools()], scores: { ext_a: 2 } });
  await h.start("task");
  const calls = h.requests.length;
  await h.command("tools list");
  const report = last(h);
  assert.match(report, /Tools \(3 external, 5 internal always allowed, 1 hidden; filtering on · mode tools\)/);
  assert.match(report, /ext_a · extension · direct · available/); assert.match(report, /mcp__dev_radius__q · MCP dev-radius · codemode · unavailable/);
  assert.doesNotMatch(report, /SECRET|parameters|instructions/);
  await h.command("mcp list");
  assert.match(last(h), /MCP servers \(2, filtering on · mode tools\)/); assert.match(last(h), /dev-radius \(mcp__dev_radius\) · 1 tools · unavailable/);
  assert.match(last(h), /allowlist them by name in the \/decisions Tool picker tab/);
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
test("RPC mode keeps select/input menus for the tools group and never calls custom overlays", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  const picks: string[] = [];
  const answers = ["Tools & MCP…", "tools.enabled", "tools.mode", (o: string[]) => o.find((x) => x.startsWith("mcp"))!, "tools.threshold", "Back", "Done"];
  const inputs = ["0.6"]; let step = 0;
  const ctx = h.ctx as unknown as { hasUI: boolean; mode: string; ui: Record<string, unknown> };
  ctx.hasUI = true; ctx.mode = "rpc";
  ctx.ui.custom = () => { throw new Error("custom overlay in rpc"); };
  ctx.ui.select = async (title: string, options: string[]) => {
    picks.push(title);
    const want = [
      (o: string[]) => o.find((x) => x.startsWith("Tools & MCP…"))!, (o: string[]) => o.find((x) => x.startsWith("tools.enabled"))!, (o: string[]) => o.find((x) => x.startsWith("tools.mode"))!,
      (o: string[]) => o.find((x) => x.startsWith("mcp"))!, (o: string[]) => o.find((x) => x.startsWith("tools.threshold"))!, () => "Back", () => "Done"][step++];
    void answers; return want(options);
  };
  ctx.ui.input = async () => inputs.shift();
  await h.command("");
  const s = await saved(h);
  assert.deepEqual([s.tools.enabled, s.tools.mode, s.tools.threshold], [true, "mcp", 0.6]);
  assert.ok(picks.some((title) => /Tools & MCP settings/.test(title)));
});
