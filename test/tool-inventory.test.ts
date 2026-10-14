import test from "node:test";
import assert from "node:assert/strict";
import { candidatesFor, canonicalServerKey, classifyTools, extensionKey, extensionName, groupDescription, MCP_RESOURCE_TOOLS, sameServer, serverKey, type ToolInfoLike } from "../src/apps/tool-inventory.ts";
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
test("a tool NAMED mcp__a__b without a namespace is an ordinary extension tool; non-MCP namespaces create no MCP group", () => {
  const inv = classifyTools([ext("mcp__a__b"), ext("docs_tool", { namespace: { name: "docs" } }), ext("empty_prefix", { namespace: { name: "mcp__" } }), ext("odd", { namespace: { name: 7 as never } })]);
  assert.deepEqual(inv.tools.map((tool) => tool.kind), ["extension", "extension", "extension", "extension"]);
  assert.deepEqual([...inv.groups.values()].filter((group) => group.type === "mcp"), [], "tool names and non-mcp namespaces never create MCP groups");
  assert.equal(inv.byName.get("mcp__a__b")!.group, "ext__mcp__a__b", "its group is its EXTENSION (from sourceInfo), not parsed from the tool name");
});
test("extension tools are grouped by the extension Pi names in public sourceInfo; MCP and built-in provenance never make an extension group", () => {
  const inv = classifyTools([
    ext("a1", { sourceInfo: { source: "auto", path: "/home/u/.pi/agent/extensions/notes.ts", origin: "top-level" } }),
    ext("a2", { sourceInfo: { source: "auto", path: "/home/u/.pi/agent/extensions/notes.ts", origin: "top-level" } }),
    ext("b1", { sourceInfo: { source: "npm:@acme/pi-web@1.2.3", path: "/n/node_modules/@acme/pi-web/ext/index.ts", origin: "package", baseDir: "/n/node_modules/@acme/pi-web" } }),
    builtin("read"), mcp("docs", "s", "direct")]);
  assert.deepEqual([...inv.groups.values()].map((group) => [group.key, group.type, group.label, group.tools]),
    [["ext__notes", "extension", "notes", ["a1", "a2"]], [extensionKey("@acme/pi-web"), "extension", "@acme/pi-web", ["b1"]], ["mcp__docs", "mcp", "docs", ["mcp__docs__s"]]]);
  assert.match(extensionKey("@acme/pi-web")!, /^ext__acme_pi_web_[0-9a-f]{10}$/, "readable slug plus a hash of the full name");
  assert.equal(inv.byName.get("a1")!.group, "ext__notes"); assert.equal(inv.byName.get("read")!.group, undefined); assert.equal(inv.byName.get("mcp__docs__s")!.group, "mcp__docs");
});
test("extension tools with no usable provenance stay ungrouped (and external)", () => {
  const inv = classifyTools([{ name: "bare" }, { name: "x", sourceInfo: {} }, { name: "y", sourceInfo: { source: "sdk", path: "" } }, { name: "z", sourceInfo: { source: "sdk", path: "<>" } }, { name: "half", sourceInfo: { source: "builtin" } }]);
  assert.deepEqual(inv.tools.map((tool) => [tool.name, tool.kind, tool.group]), [["bare", "extension", undefined], ["x", "extension", undefined], ["y", "extension", undefined], ["z", "extension", undefined], ["half", "extension", undefined]]);
  assert.equal(inv.groups.size, 0);
});
test("extensionName comes only from public provenance fields: package source, baseDir, synthetic path or file", () => {
  const name = (sourceInfo: ToolInfoLike["sourceInfo"]) => extensionName({ sourceInfo });
  assert.equal(name({ source: "npm:pi-foo@1.0.0", origin: "package", path: "/x/y.ts" }), "pi-foo");
  assert.equal(name({ source: "npm:@scope/pi-foo@1.0.0", origin: "package", path: "/x/y.ts" }), "@scope/pi-foo");
  assert.equal(name({ source: "npm:@scope/pi-foo", origin: "package", path: "/x/y.ts" }), "@scope/pi-foo");
  assert.equal(name({ source: "git:github.com/me/pi-bar@v2", origin: "package", path: "/x/y.ts" }), "pi-bar");
  assert.equal(name({ source: "https://github.com/me/pi-baz.git", origin: "package", path: "/x/y.ts" }), "pi-baz");
  assert.equal(name({ source: "git@github.com:me/pi-qux.git", origin: "package", path: "/x/y.ts" }), "pi-qux");
  assert.equal(name({ source: "../local-pkg", origin: "package", path: "/x/y.ts" }), "local-pkg");
  assert.equal(name({ source: "", origin: "package", baseDir: "/n/node_modules/pkg-dir", path: "/x/y.ts" }), "pkg-dir");
  assert.equal(name({ source: "cli", origin: "top-level", path: "/work/src/extension.ts" }), "extension");
  assert.equal(name({ source: "auto", origin: "top-level", path: "C:\\Users\\u\\.pi\\agent\\extensions\\notes\\index.ts" }), "notes");
  assert.equal(name({ source: "local", origin: "top-level", path: "/a/b/tools.mjs" }), "tools");
  assert.equal(name({ source: "inline", origin: "top-level", path: "<inline:my-host>" }), "my-host");
  assert.equal(name({ source: "inline", origin: "top-level", path: "<inline:2>" }), "inline-2", "Pi numbers unnamed inline factories");
  assert.equal(name({ source: "inline", origin: "top-level", path: "<inline>" }), "inline");
  assert.equal(name({ source: "builtin", path: "" }), undefined); assert.equal(name(undefined), undefined);
  assert.equal(name({ path: "/a/b/\u0007bell\u202Eevil.ts" }), "bell evil", "control and format characters never reach the label");
  assert.ok(name({ path: `/a/${"x".repeat(200)}.ts` })!.length <= 48);
});
test("extensionKey: canonical names (up to case and `-`) are used as is; every other name keeps a readable slug plus a hash of the FULL name", () => {
  assert.equal(extensionKey("notes"), "ext__notes"); assert.equal(extensionKey("Pi-Web"), "ext__pi_web"); assert.equal(extensionKey("pi_web"), "ext__pi_web", "`-` and `_` are one character, as for MCP servers");
  assert.equal(extensionKey("   "), undefined); assert.equal(extensionKey(""), undefined);
  const keys = ["@acme/pi-web", "acme-pi-web", "acme.pi.web", "acme pi web", "Acme/pi-web", "@acme/pi_web"].map((name) => extensionKey(name)!);
  assert.equal(new Set(keys).size, keys.length, `distinct names never share a key: ${keys.join(" ")}`);
  assert.equal(extensionKey("acme-pi-web"), "ext__acme_pi_web");
  for (const key of keys) assert.match(key, /^ext__[a-z0-9_]{1,59}$/);
});
test("extensionKey is deterministic, bounded to 64 characters, and independent of any truncation of the displayed label", () => {
  assert.equal(extensionKey("@acme/pi-web"), extensionKey("@acme/pi-web")); assert.equal(extensionKey("a\u0007b"), extensionKey("a b"), "control characters are removed from the name before hashing");
  const long = `${"x".repeat(60)}-one`, other = `${"x".repeat(60)}-two`;
  assert.notEqual(extensionKey(long), extensionKey(other), "the 48-character label is the same, the keys are not");
  for (const name of [long, "a".repeat(500), "é".repeat(100), `${"a".repeat(59)}`, `${"a".repeat(60)}`]) assert.ok(extensionKey(name)!.length <= 64, name.length + "");
  assert.equal(extensionKey("a".repeat(59)), `ext__${"a".repeat(59)}`, "a canonical name that fits is not suffixed");
  const a = classifyTools([ext("t1", { sourceInfo: { source: "auto", path: `/u/${long}.ts` } }), ext("t2", { sourceInfo: { source: "auto", path: `/u/${other}.ts` } })]);
  assert.equal(a.groups.size, 2, "two long names that share their first 48 characters are two groups");
  assert.equal([...a.groups.values()][0]!.label.length, 48);
});
test("non-ASCII and symbol-only names get a stable group instead of escaping group filtering", () => {
  const notes = extensionKey("笔记")!, other = extensionKey("日記")!;
  assert.match(notes, /^ext__ext_[0-9a-f]{10}$/); assert.notEqual(notes, other); assert.equal(notes, extensionKey("笔记"));
  assert.match(extensionKey("!!!")!, /^ext__ext_[0-9a-f]{10}$/);
  assert.match(extensionKey("café-tools")!, /^ext__caf_tools_[0-9a-f]{10}$/);
  const inv = classifyTools([ext("note_add", { sourceInfo: { source: "auto", path: "/u/.pi/agent/extensions/笔记.ts" } }), ext("diary_add", { sourceInfo: { source: "auto", path: "/u/.pi/agent/extensions/日記/index.ts" } })]);
  assert.equal(inv.byName.get("note_add")!.group, notes); assert.equal(inv.groups.get(notes)!.label, "笔记"); assert.equal(inv.byName.get("diary_add")!.group, other);
  assert.equal(classifyTools([ext("x", { sourceInfo: { source: "auto", path: "/u/ext/foo.ts" } }), ext("y", { sourceInfo: { source: "auto", path: "/p/.pi/extensions/foo/index.ts" } })]).groups.size, 1, "same name, same group");
});
test("`.`, `..` and paths ending in them are never names: the package falls back to the resolved base directory", () => {
  const name = (source: string, baseDir?: string) => extensionName({ sourceInfo: { source, origin: "package", path: "/x/y/index.ts", ...(baseDir ? { baseDir } : {}) } });
  for (const source of [".", "..", "./", "../", "../..", "./pkg/..", "foo/..", "~/..", "\\.", "npm:."]) assert.equal(name(source, "/work/my-pkg"), "my-pkg", source);
  assert.equal(name("..", "/work/my-pkg/sub/.."), "my-pkg", "an unresolved baseDir is resolved before it is named");
  assert.equal(name("../local-pkg", "/work/other"), "local-pkg"); assert.equal(name("./pkg/..//sub", "/b"), "sub");
  assert.equal(name(".", "."), "y", "with nothing usable in the package fields the extension file's directory is the last resort (`y/index.ts`)");
  const inv = classifyTools([ext("t", { sourceInfo: { source: "..", origin: "package", path: "/w/my-pkg/ext/index.ts", baseDir: "/w/my-pkg" } })]);
  assert.equal(inv.byName.get("t")!.group, "ext__my_pkg"); assert.notEqual(inv.byName.get("t")!.group, "ext__");
});
test("canonicalServerKey: ext__ entries are exclusively canonical extension keys (lowercase, `-` folded)", () => {
  assert.equal(canonicalServerKey("ext__My-Ext"), "ext__my_ext"); assert.equal(canonicalServerKey("mcp__a-b"), "mcp__a_b"); assert.equal(canonicalServerKey("a-b"), "mcp__a_b");
  assert.equal(canonicalServerKey("mcp__ext__x"), "mcp__ext__x", "a raw MCP server named ext__x is allowlisted by its doubled canonical key");
  assert.equal(sameServer("ext__notes", "ext__notes"), true); assert.equal(sameServer("ext__notes", "mcp__ext__notes"), false);
});
test("group label falls back to the namespace suffix; aliases must be non-empty strings", () => {
  const noAlias = classifyTools([ext("t", { namespace: { name: "mcp__plain" } })]).groups.get("mcp__plain")!;
  assert.equal(noAlias.label, "plain"); assert.equal(noAlias.description, "");
  const bad = classifyTools([ext("t", { namespace: { name: "mcp__b", aliases: [3, "", "real"] } })]).groups.get("mcp__b")!;
  assert.equal(bad.label, "real");
});
test("hidden tools are excluded and counted; unknown exposure defaults to direct; duplicate names keep the first", () => {
  const inv = classifyTools([ext("h", { exposure: "hidden" }), ext("weird", { exposure: "nonsense" }), ext("d", { description: "first" }), ext("d", { description: "second" }), mcp("s", "hid", "hidden"), ext("m", { exposure: "model-only" }), ext("c", { exposure: "codemode" }), ext("f", { exposure: "deferred" })]);
  assert.equal(inv.hidden, 2); assert.ok(!inv.byName.has("h")); assert.ok(!inv.groups.has("mcp__s") && !inv.groups.has("ext__h"), "a hidden tool creates no group");
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
  assert.equal(tools[0].description, "[extension a] xxxxxx…".slice(0, 19) + "…", "bounded, with the extension label");
  assert.equal(candidatesFor(inv, "tools", new Set(["a"]), 400)[0].description, `[extension a] ${"x".repeat(50)}`);
  assert.match(candidatesFor(inv, "tools", new Set(["mcp__docs__s"]), 400)[0].description, /^\[MCP server docs\] s on docs$/);
  const groups = candidatesFor(inv, "mcp", new Set(["mcp__dev_radius", "mcp__docs", "a"]), 400);
  assert.deepEqual(groups.map((candidate) => candidate.name), ["mcp__dev_radius", "mcp__docs"], "a tool name is not an mcp-mode candidate; only group keys are");
  const both = candidatesFor(inv, "mcp", new Set(["ext__a", "mcp__docs"]), 400);
  assert.deepEqual(both.map((candidate) => candidate.name).sort(), ["ext__a", "mcp__docs"]);
  assert.equal(both.find((candidate) => candidate.name === "ext__a")!.description, "Extension a. Tools: a");
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
