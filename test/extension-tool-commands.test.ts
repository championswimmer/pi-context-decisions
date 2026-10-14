// `/decisions tools|mcp ...` headless/RPC commands, persistence, validation and names-only reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { loadSettings } from "../src/settings.ts";
import { loadProjectAllowlist, projectAllowlistPath } from "../src/project-allowlist.ts";
import { extTool, mcpTool, toolSetup, resourceTools, type ToolHarness } from "./helpers/tool-fixture.ts";

const last = (h: ToolHarness) => h.messages.at(-1)!;
const saved = async (h: ToolHarness) => (await loadSettings(h.path)).settings;

test("tools on/off persists, never selects a model and never touches skill filtering; defaults stay off", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false }, unconfigured: true, skills: true });
  await h.command("tools on");
  assert.equal((await saved(h)).tools.enabled, true); assert.equal((await saved(h)).backend, null, "enabling tool filtering never selects a model");
  assert.match(last(h), /Tool filtering enabled\. No decision model is selected/);
  assert.equal((await saved(h)).relevance.enabled, true, "skill filtering is untouched");
  await h.command("tools off"); assert.equal((await saved(h)).tools.enabled, false);
  await h.command("model none");
  assert.equal((await saved(h)).tools.enabled, false, "selecting a model never enables tool filtering");
});
test("tools settings: mode, cadence and scalars validate through the same strict rules; bad input changes nothing", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  await h.command("tools mode mcp"); await h.command("tools cadence initial"); await h.command("tools threshold 0.5"); await h.command("tools maxAdded 3");
  await h.command("tools minCandidates 2"); await h.command("tools failMode open"); await h.command("tools maxDescriptionChars 120");
  assert.deepEqual({ ...(await saved(h)).tools }, { enabled: false, mode: "mcp", cadence: "initial", threshold: 0.5, maxAdded: 3, minCandidates: 2, failMode: "open", maxDescriptionChars: 120, alwaysAllowedTools: [], alwaysAllowedMcpServers: [] });
  for (const bad of ["tools mode everything", "tools cadence sometimes", "tools threshold 2", "tools threshold -1", "tools maxAdded 1001", "tools maxDescriptionChars 0", "tools bogus 1", "tools alwaysAllowedTools x", "tools mode"]) {
    const before = JSON.stringify(await saved(h));
    await h.command(bad);
    assert.equal(JSON.stringify(await saved(h)), before, bad); assert.ok(h.messages.length > 0);
  }
  assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE|SECRET/);
});
test("tools allow: global and project lists persist separately, validate names, preserve each other and the skill list, and add/remove/clear/list work", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  await h.command("tools allow global add zeta alpha alpha");
  assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["alpha", "zeta"]);
  await h.command("tools allow global list"); assert.match(last(h), /Always-allowed tools, global \(2\): alpha, zeta/);
  await h.command("tools allow global remove alpha"); assert.deepEqual((await saved(h)).tools.alwaysAllowedTools, ["zeta"]);
  await h.command("allow project add skill-one");
  await h.command("tools allow project add proj_tool"); await h.command("mcp allow project add dev-radius");
  assert.deepEqual(await loadProjectAllowlist(h.root), { names: ["skill-one"], tools: ["proj_tool"], mcpServers: ["dev-radius"], warnings: [] });
  const file = JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8"));
  assert.deepEqual(file, { alwaysAllowed: ["skill-one"], alwaysAllowedTools: ["proj_tool"], alwaysAllowedMcpServers: ["dev-radius"] });
  await h.command("allow project clear"); assert.deepEqual((await loadProjectAllowlist(h.root)).tools, ["proj_tool"], "clearing skills keeps the tool list");
  await h.command("tools allow project clear"); assert.deepEqual((await loadProjectAllowlist(h.root)).tools, []);
  assert.deepEqual((await loadProjectAllowlist(h.root)).mcpServers, ["dev-radius"]);
  assert.ok(JSON.parse(await readFile(projectAllowlistPath(h.root), "utf8")).alwaysAllowed, "v0.3.0 readers still find alwaysAllowed");
  for (const bad of ["tools allow global add bad\u0007name", `tools allow global add ${"x".repeat(129)}`, "tools allow nowhere list", "tools allow global add", "tools allow global frobnicate x"]) {
    const before = JSON.stringify(await saved(h)); await h.command(bad); assert.equal(JSON.stringify(await saved(h)), before, bad);
  }
  assert.ok(h.messages.some((message) => /Tool names must be 1-128 characters/.test(message)));
});
test("mcp allow: server names validate, `-` and `_` spellings are one server, list and remove fold the same way", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false } });
  await h.command("mcp allow global add dev-radius dev_radius docs");
  assert.deepEqual((await saved(h)).tools.alwaysAllowedMcpServers, ["dev-radius", "docs"]);
  await h.command("mcp allow global remove dev_radius"); assert.deepEqual((await saved(h)).tools.alwaysAllowedMcpServers, ["docs"]);
  for (const bad of ["mcp allow global add a.b", "mcp allow global add ../x", `mcp allow global add ${"s".repeat(65)}`, "mcp list extra", "mcp"]) {
    const before = JSON.stringify(await saved(h)); await h.command(bad); assert.equal(JSON.stringify(await saved(h)), before, bad);
  }
  assert.ok(h.messages.some((message) => /MCP server names, mcp__ namespace keys and ext__ extension keys must match/.test(message)));
});
test("in mcp mode, allowlisting one tool of an MCP server says it promotes the whole server", async (t) => {
  const h = await toolSetup(t, { tools: { mode: "mcp", enabled: true }, extra: [mcpTool("dev-radius", "q", "direct"), mcpTool("dev-radius", "r")] });
  await h.command("tools allow global add mcp__dev_radius__q");
  assert.match(last(h), /makes the whole MCP server or extension available: dev-radius/);
  const quiet = await toolSetup(t, { extra: [mcpTool("dev-radius", "q", "direct")] });
  await quiet.command("tools allow global add mcp__dev_radius__q"); assert.doesNotMatch(last(quiet), /whole MCP server/);
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
  assert.match(last(h), /allowlist them by name/);
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
  await h.command("settings");
  const s = await saved(h);
  assert.deepEqual([s.tools.enabled, s.tools.mode, s.tools.threshold], [true, "mcp", 0.6]);
  assert.ok(picks.some((title) => /Tools & MCP settings/.test(title)));
});
