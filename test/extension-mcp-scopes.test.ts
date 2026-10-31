import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpTool, extTool, resourceTools, toolSetup } from "./helpers/tool-fixture.ts";
import { loadProjectAllowlist, saveProjectAllowlist } from "../src/project-allowlist.ts";
import { readDecisionsHistory } from "../src/extension/decisions-history.ts";
import { loadSettings } from "../src/settings.ts";

const SECRET = "CONFIG_FIELDS_MUST_STAY_LOCAL";
const entry = () => ({ command: SECRET, args: [SECRET], env: { TOKEN: SECRET }, headers: { Authorization: SECRET } });
async function files(h: Awaited<ReturnType<typeof toolSetup>>, project: Record<string, unknown>, global: Record<string, unknown> = {}) {
  await mkdir(join(h.root, ".pi"), { recursive: true });
  await writeFile(join(h.agentDir, "mcp.json"), JSON.stringify({ mcpServers: global }));
  await writeFile(join(h.root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: project }));
  h.ctx.isProjectTrusted = () => true;
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
}

test("missing optional MCP configs stay silent during inventory classification with filtering on or off", async (t) => {
  for (const enabled of [true, false]) {
    const h = await toolSetup(t, { tools: { enabled, alwaysAllowedMcpServers: ["global"] }, extra: [mcpTool("global", "q")] });
    await rm(join(h.agentDir, "mcp.json"));
    h.ctx.isProjectTrusted = () => true;
    await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
    await h.command("mcp list");
    await h.start("task");
    assert.equal(await h.gate("mcp__global__q"), undefined, "unresolved origins retain the Global allowlist fallback");
    assert.deepEqual(h.messages.filter((message) => /MCP config scope warning/.test(message)), []);
  }
});

test("built-in MCP file origins scope gates, resource-only grants, notices and editor saves without leaking config values", async (t) => {
  for (const mode of ["tools", "mcp"] as const) {
    const h = await toolSetup(t, { tools: { mode, alwaysAllowedMcpServers: ["global", "project", "settings", "extension"] }, extra: [
      mcpTool("global", "q"), mcpTool("project", "q"), mcpTool("same", "q"), mcpTool("settings", "q"), ...resourceTools(),
      // An extension-provenance namespace ignores file origins and keeps its public scope.
      mcpTool("extension", "q", "codemode", { sourceInfo: { source: "extension", path: "/ext/host.ts", scope: "user" } }),
      extTool("project_ext", "direct", { sourceInfo: { source: "extension", path: "/ext/project_ext.ts", scope: "project" } }),
    ] });
    await files(h, { project: entry(), same: entry(), settings: { enabled: false }, resources_only: entry(), extension: entry(), invalid: { command: 3, env: SECRET } },
      { global: entry(), same: entry(), settings: entry() });
    await saveProjectAllowlist(h.root, { mcpServers: ["same", "resources_only", "global"] });
    await h.start("task");
    for (const server of ["global", "same", "settings"]) assert.equal(await h.gate(`mcp__${server}__q`), undefined, `${mode}: ${server}`);
    assert.equal((await h.gate("mcp__project__q"))?.block, true, "the global project pin is not effective");
    assert.equal(await h.gate("mcp__extension__q"), undefined, "the project config must not relabel an extension-provenance namespace; its global pin still applies");
    assert.equal(await h.gate("read_mcp_resource", { server: "resources_only", uri: "x" }), undefined, "resource-only project scope is observable from names-only config");
    assert.ok(h.ledger().some((record) => record.groups?.includes("mcp__resources_only")));
    assert.match(JSON.stringify(h.notices()), /mcp__same/);
    // The actual command/editor path uses the same session capture as the gate, without re-reading disk.
    await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Project", toggle: "project" });
    assert.ok((await loadProjectAllowlist(h.root)).mcpServers.includes("mcp__project"), JSON.stringify((await loadProjectAllowlist(h.root)).mcpServers));
    assert.equal(await h.gate("mcp__project__q"), undefined, "the scoped editor saved the project pin");
    const serialized = JSON.stringify([h.requests, h.ledger(), h.notices(), h.messages, readDecisionsHistory(h.sim.session as unknown as Parameters<typeof readDecisionsHistory>[0]), (await loadSettings(h.path)).settings,
      await readFile(join(h.root, ".pi", "pi-context-decisions.json"), "utf8")]);
    assert.doesNotMatch(serialized, /CONFIG_FIELDS|Authorization|"command"|"headers"|"env"|"args"/);
    assert.ok(h.messages.some((message) => /mcp-project-entry-invalid/.test(message)), "invalid entries warn with a safe code only");
    assert.match(await readFile(join(h.agentDir, "mcp.json"), "utf8"), /CONFIG_FIELDS_MUST_STAY_LOCAL/, "the config was not rewritten");
  }
});
test("session start refreshes MCP origins, and untrusted or malformed project config never gives Project scope", async (t) => {
  const h = await toolSetup(t, { extra: [mcpTool("late", "q")] });
  await h.start("task");
  await files(h, { late: entry() });
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Project", toggle: "late" });
  assert.equal(await h.gate("mcp__late__q"), undefined);
  for (const trusted of [false, true]) {
    const x = await toolSetup(t, { extra: [mcpTool("project", "q")], tools: { alwaysAllowedMcpServers: ["project"] } });
    await files(x, { project: entry() }); x.ctx.isProjectTrusted = () => trusted;
    if (trusted) await writeFile(join(x.root, ".pi", "mcp.json"), `{ "mcpServers": { "project": ${SECRET}`);
    await x.sim.emit("session_start", { type: "session_start", reason: "reload" }, x.ctx);
    await x.start("task");
    assert.equal(await x.gate("mcp__project__q"), undefined, "unresolved origin retains Global fallback, never Project");
    assert.doesNotMatch(JSON.stringify(x.messages), /CONFIG_FIELDS/);
  }
});


test("built-in config scope filters both MCP editors and keeps global/project saves isolated", async (t) => {
  const h = await toolSetup(t, { extra: [mcpTool("global", "q"), mcpTool("project", "q")] });
  await files(h, { project: entry() }, { global: entry() });
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Global", toggle: "project" });
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, [], "global editor cannot select project MCPs");
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Global", toggle: "global" });
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Project", toggle: "global" });
  assert.deepEqual((await loadProjectAllowlist(h.root)).mcpServers, [], "project editor cannot select global MCPs");
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Project", toggle: "project" });
  assert.deepEqual((await loadSettings(h.path)).settings.tools.alwaysAllowedMcpServers, ["mcp__global"]);
  assert.deepEqual((await loadProjectAllowlist(h.root)).mcpServers, ["mcp__project"]);
  await h.start("task");
  assert.deepEqual(h.scored(), []); assert.equal(await h.gate("mcp__global__q"), undefined); assert.equal(await h.gate("mcp__project__q"), undefined);
});


test("session MCP origins survive later enabling, editor saves and branch navigation until a new session_start", async (t) => {
  const h = await toolSetup(t, { tools: { enabled: false, mode: "mcp" }, extra: [mcpTool("live", "q"), ...resourceTools()] });
  await files(h, {}, { live: entry() });
  await writeFile(join(h.root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { live: entry() } }));
  await saveProjectAllowlist(h.root, { mcpServers: ["live"] });
  await h.set("tools.enabled");
  assert.equal((await h.gate("mcp__live__q"))?.block, true, "enabling later uses the original Global capture");
  await h.allowlist({ tab: "tools", row: "Always allowed MCP servers & extensions · Project" });
  assert.equal((await h.gate("mcp__live__q"))?.block, true, "an editor save cannot relabel the live server");
  await h.sim.emit("session_tree", { type: "session_tree" }, h.ctx);
  assert.equal((await h.gate("mcp__live__q"))?.block, true, "branch navigation retains the connection's Global capture");
  assert.match((await h.gate("list_mcp_resources", { server: "live" }))?.reason ?? "", /Pi agent settings\.json/);
  await h.sim.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
  const registry = h.sim.pi.getAllTools!;
  h.sim.pi.getAllTools = () => { throw new Error("registry unavailable"); };
  assert.match((await h.gate("mcp__live__q"))?.reason ?? "", /could not be verified/, "reload cannot reuse a prior-session origin snapshot");
  h.sim.pi.getAllTools = registry;
  assert.equal(await h.gate("mcp__live__q"), undefined, "reload recaptures Project scope");
  assert.equal(await h.gate("list_mcp_resources", { server: "live" }), undefined);
});
