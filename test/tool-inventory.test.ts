import test from "node:test";
import assert from "node:assert/strict";
import { candidatesFor, classifyTools, groupDescription, MCP_RESOURCE_TOOLS, sameServer, serverKey, type ToolInfoLike } from "../src/apps/tool-inventory.ts";
import { buildRelevanceRequests } from "../src/apps/relevance.ts";

const builtin = (name: string, path = `builtin:${name}`): ToolInfoLike => ({ name, description: `core ${name}`, exposure: "direct", sourceInfo: { source: "builtin", path } });
const mcp = (server: string, tool: string, exposure = "codemode", extra: Partial<ToolInfoLike> = {}): ToolInfoLike => ({
  name: `mcp__${server.replace(/-/g, "_")}__${tool}`, description: `${tool} on ${server}`, exposure,
  namespace: { name: `mcp__${server.replace(/-/g, "_")}`, aliases: [server], description: `${server} server` }, sourceInfo: { source: "builtin", path: "builtin:mcp" }, ...extra,
});
const ext = (name: string, extra: Partial<ToolInfoLike> = {}): ToolInfoLike => ({ name, description: `ext ${name}`, exposure: "direct", sourceInfo: { source: "extension", path: `/ext/${name}.ts` }, ...extra });
const kinds = (infos: ToolInfoLike[]) => Object.fromEntries(classifyTools(infos).tools.map((tool) => [tool.name, tool.kind]));

test("built-in provenance is internal; extension, SDK and provenance-less tools are external", () => {
  assert.deepEqual(kinds([builtin("read"), builtin("bash"), builtin("codemode"), ext("mine"),
    { name: "sdk_tool", sourceInfo: { source: "sdk", path: "<sdk:sdk_tool>" } }, { name: "bare" }, { name: "half", sourceInfo: { source: "builtin" } }, { name: "half2", sourceInfo: { path: "builtin:x" } }]),
  { read: "internal", bash: "internal", codemode: "internal", mine: "extension", sdk_tool: "extension", bare: "extension", half: "extension", half2: "extension" });
});
test("core-looking names and reachesTools never grant internal status", () => {
  const spoof = classifyTools([ext("read", { reachesTools: true } as never), ext("bash"), { name: "tool_search", reachesTools: true } as never]);
  assert.deepEqual(spoof.tools.map((tool) => [tool.name, tool.kind]), [["read", "extension"], ["bash", "extension"], ["tool_search", "extension"]]);
  // First registration wins: the real built-in read keeps the name and a later extension override is ignored entirely.
  const dup = classifyTools([builtin("read"), ext("read")]);
  assert.equal(dup.tools.length, 1); assert.equal(dup.byName.get("read")!.kind, "internal");
});
test("MCP server tools carry builtin provenance but are external; the namespace check runs before provenance", () => {
  const inv = classifyTools([mcp("dev-radius", "query", "direct")]);
  const tool = inv.tools[0];
  assert.equal(tool.kind, "mcp"); assert.equal(tool.group, "mcp__dev_radius"); assert.equal(tool.declarable, true);
  const group = inv.groups.get("mcp__dev_radius")!;
  assert.deepEqual({ key: group.key, label: group.label, description: group.description, tools: group.tools, verified: group.verified },
    { key: "mcp__dev_radius", label: "dev-radius", description: "dev-radius server", tools: ["mcp__dev_radius__query"], verified: true });
});
test("a namespaced mcp__ tool from an extension path is mcp but unverified; mixed members verify the group", () => {
  const inv = classifyTools([mcp("x", "a", "codemode", { sourceInfo: { source: "extension", path: "/ext/x.ts" } })]);
  assert.equal(inv.tools[0].kind, "mcp"); assert.equal(inv.groups.get("mcp__x")!.verified, false);
  const mixed = classifyTools([mcp("x", "a", "codemode", { sourceInfo: { source: "extension", path: "/ext/x.ts" } }), mcp("x", "b")]);
  assert.equal(mixed.groups.get("mcp__x")!.verified, true); assert.deepEqual(mixed.groups.get("mcp__x")!.tools, ["mcp__x__a", "mcp__x__b"]);
  // Spoofed path with the wrong source is not verified.
  assert.equal(classifyTools([mcp("y", "a", "codemode", { sourceInfo: { source: "extension", path: "builtin:mcp" } })]).groups.get("mcp__y")!.verified, false);
});
test("a tool NAMED mcp__a__b without a namespace is an ordinary extension tool; non-MCP namespaces create no group", () => {
  const inv = classifyTools([ext("mcp__a__b"), ext("docs_tool", { namespace: { name: "docs" } }), ext("empty_prefix", { namespace: { name: "mcp__" } }), ext("odd", { namespace: { name: 7 as never } })]);
  assert.deepEqual(inv.tools.map((tool) => tool.kind), ["extension", "extension", "extension", "extension"]);
  assert.equal(inv.groups.size, 0);
});
test("group label falls back to the namespace suffix; aliases must be non-empty strings", () => {
  const noAlias = classifyTools([ext("t", { namespace: { name: "mcp__plain" } })]).groups.get("mcp__plain")!;
  assert.equal(noAlias.label, "plain"); assert.equal(noAlias.description, "");
  const bad = classifyTools([ext("t", { namespace: { name: "mcp__b", aliases: [3, "", "real"] } })]).groups.get("mcp__b")!;
  assert.equal(bad.label, "real");
});
test("hidden tools are excluded and counted; unknown exposure defaults to direct; duplicate names keep the first", () => {
  const inv = classifyTools([ext("h", { exposure: "hidden" }), ext("weird", { exposure: "nonsense" }), ext("d", { description: "first" }), ext("d", { description: "second" }), mcp("s", "hid", "hidden"), ext("m", { exposure: "model-only" }), ext("c", { exposure: "codemode" }), ext("f", { exposure: "deferred" })]);
  assert.equal(inv.hidden, 2); assert.ok(!inv.byName.has("h")); assert.equal(inv.groups.size, 0, "a hidden MCP tool creates no group");
  assert.equal(inv.byName.get("weird")!.exposure, "direct"); assert.equal(inv.byName.get("d")!.description, "first");
  assert.deepEqual(["weird", "m", "c", "f"].map((name) => inv.byName.get(name)!.declarable), [true, true, false, false]);
});
test("malformed entries are skipped instead of throwing", () => {
  const inv = classifyTools([null as never, { name: "" }, { name: 3 } as never, ext("ok", { description: 42 as never })]);
  assert.deepEqual(inv.tools.map((tool) => [tool.name, tool.description]), [["ok", ""]]);
});
test("MCP resource tools (builtin:mcp, no namespace) are internal and flagged as routed; look-alikes are not", () => {
  const inv = classifyTools([...MCP_RESOURCE_TOOLS.map((name) => builtin(name, "builtin:mcp")), builtin("other_builtin", "builtin:mcp"), ext("read_mcp_resource")]);
  for (const name of MCP_RESOURCE_TOOLS) { assert.equal(inv.byName.get(name)!.kind, "internal"); }
  assert.deepEqual(MCP_RESOURCE_TOOLS.map((name) => inv.byName.get(name)!.resource), [true, true, true]);
  assert.equal(inv.byName.get("other_builtin")!.resource, undefined);
  // The first registration wins, so the genuine one stays flagged; a lone extension look-alike is external and not routed.
  const lookalike = classifyTools([ext("read_mcp_resource")]).tools[0];
  assert.equal(lookalike.kind, "extension"); assert.equal(lookalike.resource, undefined);
  assert.equal(classifyTools([builtin("read_mcp_resource", "builtin:read_mcp_resource")]).tools[0].resource, undefined, "resource flag needs builtin:mcp provenance");
});
test("serverKey folds hyphens; sameServer accepts spelling or canonical key", () => {
  assert.equal(serverKey("dev-radius"), "mcp__dev_radius"); assert.equal(serverKey("dev-radius"), serverKey("dev_radius"));
  assert.equal(sameServer("dev-radius", "mcp__dev_radius"), true); assert.equal(sameServer("dev_radius", "mcp__dev_radius"), true);
  assert.equal(sameServer("mcp__dev_radius", "mcp__dev_radius"), true); assert.equal(sameServer("other", "mcp__dev_radius"), false);
  assert.equal(sameServer("dev", "mcp__dev_radius"), false);
});
test("candidatesFor: tools mode lists external tools only, labels MCP members, bounds descriptions; mcp mode lists namespaces with sorted tool names", () => {
  const inv = classifyTools([builtin("read"), ext("a", { description: "x".repeat(50) }), mcp("dev-radius", "zeta", "direct"), mcp("dev-radius", "alpha"), mcp("docs", "s")]);
  const names = new Set(inv.tools.map((tool) => tool.name));
  const tools = candidatesFor(inv, "tools", names, 20);
  assert.deepEqual(tools.map((candidate) => candidate.name), ["a", "mcp__dev_radius__zeta", "mcp__dev_radius__alpha", "mcp__docs__s"], "internal read is never a candidate");
  for (const candidate of tools) assert.ok(candidate.description.length <= 20, candidate.description);
  assert.equal(tools[0].description, `${"x".repeat(19)}…`);
  assert.match(candidatesFor(inv, "tools", new Set(["mcp__docs__s"]), 400)[0].description, /^\[MCP server docs\] s on docs$/);
  const groups = candidatesFor(inv, "mcp", new Set(["mcp__dev_radius", "mcp__docs", "a"]), 400);
  assert.deepEqual(groups.map((candidate) => candidate.name), ["mcp__dev_radius", "mcp__docs"], "extension tools are not mcp-mode candidates");
  assert.equal(groups[0].description, "MCP server dev-radius. dev-radius server. Tools: mcp__dev_radius__alpha, mcp__dev_radius__zeta");
  assert.deepEqual(candidatesFor(inv, "mcp", new Set(["mcp__docs"]), 400).map((candidate) => candidate.name), ["mcp__docs"], "only requested names");
});
test("groupDescription truncates the tool list with an ellipsis and never exceeds the bound", () => {
  const inv = classifyTools(["a", "b", "c", "d"].map((tool) => mcp("srv", tool + "x".repeat(20))));
  const group = inv.groups.get("mcp__srv")!;
  for (const limit of [10, 60, 90, 150, 400]) assert.ok(groupDescription(group, limit).length <= limit, `${limit}`);
  assert.match(groupDescription(group, 90), /…$/); assert.doesNotMatch(groupDescription(group, 400), /…/);
  assert.ok(groupDescription(group, 1).length <= 1);
});
test("decision payloads contain only names, bounded descriptions and server labels: no schemas, instructions, annotations or paths", () => {
  const secret = (what: string) => `SECRET-${what}`;
  const infos: ToolInfoLike[] = [
    ext("plain", { parameters: { type: "object", properties: { x: { description: secret("SCHEMA") } } }, promptGuidelines: [secret("GUIDE")], annotations: { title: secret("ANNOT") }, sourceInfo: { source: "extension", path: `/home/${secret("PATH")}/x.ts`, baseDir: secret("BASE") } } as never),
    mcp("srv", "q", "direct", { namespace: { name: "mcp__srv", aliases: ["srv"], description: "public blurb", instructions: secret("INSTR") } as never, parameters: secret("PARAMS"), annotations: { readOnlyHint: true, title: secret("ANNOT2") } } as never),
  ];
  const inv = classifyTools(infos);
  for (const mode of ["tools", "mcp"] as const) {
    const names = new Set([...inv.tools.map((tool) => tool.name), ...inv.groups.keys()]);
    const candidates = candidatesFor(inv, mode, names, 400);
    const requests = buildRelevanceRequests("task", candidates, { subject: mode === "mcp" ? "mcp_server" : "tool" });
    // Question objects legitimately have an `instructions` field; the metadata that reaches the model lives in `state`.
    const serialized = JSON.stringify([candidates, requests.map((batch) => batch.request.state), requests.flatMap((batch) => Object.values(batch.request.questions).map((q) => q.instructions))]);
    assert.doesNotMatch(serialized, /SECRET|\/home\/|baseDir|"parameters"|"instructions"|"annotations"|"sourceInfo"|builtin:/, mode);
    for (const batch of requests) assert.deepEqual(Object.keys(batch.request.state), mode === "mcp" ? ["task", "servers"] : ["task", "tools"]);
    for (const batch of requests) for (const entry of Object.values(batch.request.state[mode === "mcp" ? "servers" : "tools"] as Record<string, object>)) assert.deepEqual(Object.keys(entry), ["name", "description"]);
    assert.ok(candidates.length > 0);
  }
});
