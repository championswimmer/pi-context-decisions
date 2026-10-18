import test from "node:test";
import assert from "node:assert/strict";
import { classifyTools, type ToolInfoLike } from "../src/apps/tool-inventory.ts";
import { availability, baseGrowth, effectiveToolAllowlists, NO_ALLOWLISTS, reconcileActive, remaining, serverAllowlisted, type AvailabilityLedger, type EffectiveAllowlists } from "../src/apps/tool-policy.ts";

const builtin = (name: string): ToolInfoLike => ({ name, exposure: "direct", sourceInfo: { source: "builtin", path: `builtin:${name}` } });
const ext = (name: string, exposure = "direct"): ToolInfoLike => ({ name, exposure, sourceInfo: { source: "extension", path: `/ext/${name}.ts` } });
const mcp = (server: string, tool: string, exposure = "codemode"): ToolInfoLike => ({ name: `mcp__${server.replace(/-/g, "_")}__${tool}`, exposure,
  namespace: { name: `mcp__${server.replace(/-/g, "_")}`, aliases: [server] }, sourceInfo: { source: "builtin", path: "builtin:mcp" } });
const bare = (name: string): ToolInfoLike => ({ name, exposure: "direct" });
// ext_a/ext_b/ext_lazy are three single-tool extensions (groups ext__ext_a, ext__ext_b, ext__ext_lazy); `shared_*` come from ONE extension; `loose` has no provenance.
const inv = classifyTools([builtin("read"), builtin("bash"), ext("ext_a"), ext("ext_b"), ext("ext_lazy", "codemode"), mcp("dev-radius", "q", "direct"), mcp("dev-radius", "r"), mcp("docs", "s", "direct"), mcp("docs", "t")]);
const shared = classifyTools([ext("ext_a"), { name: "shared_1", exposure: "direct", sourceInfo: { source: "auto", path: "/ext/shared.ts" } }, { name: "shared_2", exposure: "codemode", sourceInfo: { source: "auto", path: "/ext/shared.ts" } }, bare("loose")]);
const ledger = (tools: string[] = [], groups: string[] = []): AvailabilityLedger => ({ tools: new Set(tools), groups: new Set(groups) });
const allow = (tools: string[] = [], servers: string[] = []): EffectiveAllowlists => ({ tools: new Set(tools), servers: new Set(servers) });
const open = (mode: "tools" | "mcp", l = ledger(), a = allow()) => {
  const avail = availability(inv, mode, l, a);
  return { avail, names: inv.tools.filter((tool) => avail.isAvailable(tool)).map((tool) => tool.name) };
};

test("internal tools are always available; nothing external is available without a decision", () => {
  assert.deepEqual(open("tools").names, ["read", "bash"]);
  assert.deepEqual(open("tools", ledger(), NO_ALLOWLISTS).names, ["read", "bash"]);
});
test("tools mode: ledger and allowlisted tools are individually available, siblings are not", () => {
  assert.deepEqual(open("tools", ledger(["ext_a", "mcp__dev_radius__r"])).names, ["read", "bash", "ext_a", "mcp__dev_radius__r"]);
  assert.deepEqual(open("tools", ledger(), allow(["ext_b", "mcp__docs__s"])).names, ["read", "bash", "ext_b", "mcp__docs__s"]);
  const a = open("tools", ledger(["mcp__docs__s"])).avail;
  assert.equal(a.isGroupAvailable("mcp__docs"), false, "a single tool never makes its namespace available in tools mode");
  assert.equal(a.groups.size, 0);
});
test("tools mode: a namespace in the ledger or a server allowlist enables every member, including late ones", () => {
  for (const [l, a] of [[ledger([], ["mcp__docs"]), allow()], [ledger(), allow([], ["docs"])], [ledger(), allow([], ["mcp__docs"])]] as const) {
    assert.deepEqual(open("tools", l, a).names, ["read", "bash", "mcp__docs__s", "mcp__docs__t"]);
  }
  const late = classifyTools([...inv.tools.map((tool) => ({ name: tool.name, exposure: tool.exposure, namespace: tool.group ? { name: tool.group } : undefined, sourceInfo: tool.kind === "internal" || tool.kind === "mcp" ? { source: "builtin", path: tool.kind === "mcp" ? "builtin:mcp" : `builtin:${tool.name}` } : { source: "extension", path: "/x" } })), mcp("docs", "late")]);
  assert.equal(availability(late, "tools", ledger([], ["mcp__docs"]), allow()).isAvailable(late.byName.get("mcp__docs__late")!), true);
});
test("server allowlist spelling: `-`, `_` and the canonical key are equivalent; a prefix or other server is not", () => {
  for (const entry of ["dev-radius", "dev_radius", "mcp__dev_radius"]) assert.equal(serverAllowlisted(allow([], [entry]), "mcp__dev_radius"), true, entry);
  for (const entry of ["dev", "radius", "docs", "mcp__dev"]) assert.equal(serverAllowlisted(allow([], [entry]), "mcp__dev_radius"), false, entry);
  assert.equal(serverAllowlisted(NO_ALLOWLISTS, "mcp__dev_radius"), false);
});
test("mcp mode: MCP servers AND extensions are decided as whole groups; only provenance-less extension tools are never filtered", () => {
  assert.deepEqual(open("mcp").names, ["read", "bash"], "no extension tool is available without a decision any more");
  assert.deepEqual(open("mcp", ledger([], ["mcp__docs"])).names, ["read", "bash", "mcp__docs__s", "mcp__docs__t"]);
  assert.deepEqual(open("mcp", ledger([], ["ext__ext_a"])).names, ["read", "bash", "ext_a"]);
  assert.deepEqual(open("mcp", ledger(), allow([], ["ext__ext_b", "dev-radius"])).names, ["read", "bash", "ext_b", "mcp__dev_radius__q", "mcp__dev_radius__r"]);
  const loose = availability(shared, "mcp", ledger(), allow());
  assert.deepEqual(shared.tools.filter((tool) => loose.isAvailable(tool)).map((tool) => tool.name), ["loose"], "an ungrouped extension tool has no group to decide");
  const tools = availability(shared, "tools", ledger(), allow());
  assert.deepEqual(shared.tools.filter((tool) => tools.isAvailable(tool)).map((tool) => tool.name), [], "in tools mode it is decided by name");
});
test("extension groups behave like MCP namespaces: an allowlisted key enables every member (late ones too); a lone tool never does in tools mode", () => {
  const key = "ext__shared";
  for (const mode of ["tools", "mcp"] as const) {
    const a = availability(shared, mode, ledger(), allow([], [key]));
    assert.deepEqual(shared.tools.filter((tool) => a.isAvailable(tool)).map((tool) => tool.name), ["shared_1", "shared_2", ...(mode === "mcp" ? ["loose"] : [])], mode);
    assert.equal(a.isGroupAvailable(key), true); assert.equal(a.promoted.size, 0);
  }
  const lone = availability(shared, "tools", ledger(), allow(["shared_1"]));
  assert.equal(lone.isGroupAvailable(key), false); assert.equal(lone.isAvailable(shared.byName.get("shared_2")!), false); assert.equal(lone.isAvailable(shared.byName.get("shared_1")!), true);
  // mcp mode: ANY allowlisted or recorded member promotes the whole extension.
  for (const [l, al] of [[ledger(), allow(["shared_2"])], [ledger(["shared_2"]), allow()]] as const) {
    const m = availability(shared, "mcp", l, al);
    assert.equal(m.isAvailable(shared.byName.get("shared_1")!), true); assert.deepEqual([...m.promoted], [key]);
  }
  assert.deepEqual([...remaining(shared, "mcp", availability(shared, "mcp", ledger(), allow()))].sort(), ["ext__ext_a", "ext__shared"]);
});
test("serverAllowlisted also matches ext__ keys (lowercased, `-`/`_` folded) and never an MCP namespace of the same name", () => {
  assert.equal(serverAllowlisted(allow([], ["ext__Shared"]), "ext__shared"), true); assert.equal(serverAllowlisted(allow([], ["ext__shared"]), "mcp__shared"), false);
  assert.equal(serverAllowlisted(allow([], ["shared"]), "ext__shared"), false, "a bare name is a raw MCP server, never an extension");
});
test("mcp mode: ANY allowlisted or ledger tool of a namespace promotes the whole namespace (never half-on)", () => {
  for (const [l, a] of [[ledger(), allow(["mcp__dev_radius__r"])], [ledger(["mcp__dev_radius__r"]), allow()]] as const) {
    const { avail, names } = open("mcp", l, a);
    assert.deepEqual(names.filter((name) => name.startsWith("mcp__")), ["mcp__dev_radius__q", "mcp__dev_radius__r"]);
    assert.deepEqual([...avail.promoted], ["mcp__dev_radius"]); assert.equal(avail.isGroupAvailable("mcp__dev_radius"), true);
    assert.equal(avail.isGroupAvailable("mcp__docs"), false);
  }
  // Promotion applies only in mcp mode; an explicitly enabled group is not "promoted".
  assert.equal(open("tools", ledger(), allow(["mcp__dev_radius__r"])).avail.promoted.size, 0);
  assert.equal(open("mcp", ledger([], ["mcp__docs"])).avail.promoted.size, 0);
});
test("tool allowlists work in both modes; an allowlist name that is not registered is harmless", () => {
  assert.equal(open("tools", ledger(), allow(["ghost"])).names.length, 2);
  assert.equal(open("mcp", ledger(), allow(["ghost"])).avail.groups.size, 0);
});
test("remaining: tool names in tools mode (never internal), group keys (MCP and extension) in mcp mode", () => {
  const t = open("tools", ledger(["ext_a"], ["mcp__docs"]));
  assert.deepEqual([...remaining(inv, "tools", t.avail)].sort(), ["ext_b", "ext_lazy", "mcp__dev_radius__q", "mcp__dev_radius__r"]);
  const m = open("mcp", ledger([], ["mcp__docs"]));
  assert.deepEqual([...remaining(inv, "mcp", m.avail)].sort(), ["ext__ext_a", "ext__ext_b", "ext__ext_lazy", "mcp__dev_radius"]);
  assert.equal(remaining(inv, "mcp", open("mcp", ledger([], ["mcp__docs", "mcp__dev_radius", "ext__ext_a", "ext__ext_b", "ext__ext_lazy"])).avail).size, 0);
});
test("baseGrowth records allowlisted names and available groups once; mcp mode also records provenance-less extension tools only", () => {
  const l = ledger(); const a = allow(["ext_a", "ghost"], ["docs"]);
  const tools = availability(inv, "tools", l, a);
  assert.deepEqual(baseGrowth(inv, "tools", l, a, tools), { tools: ["ext_a"], groups: ["mcp__docs"] });
  const mcpMode = availability(inv, "mcp", l, a);
  assert.deepEqual(baseGrowth(inv, "mcp", l, a, mcpMode), { tools: ["ext_a"], groups: ["ext__ext_a", "mcp__docs"] }, "ext_a is allowlisted by name and promotes its extension");
  const withLoose = availability(shared, "mcp", l, allow());
  assert.deepEqual(baseGrowth(shared, "mcp", l, allow(), withLoose), { tools: ["loose"], groups: [] }, "grouped extension tools are covered by their group, never recorded one by one");
  // Already recorded names are not repeated, and a promoted group becomes a recorded group.
  const known = ledger(["ext_a"], ["mcp__docs", "ext__ext_a"]);
  assert.deepEqual(baseGrowth(inv, "mcp", known, a, availability(inv, "mcp", known, a)), { tools: [], groups: [] });
  const promoted = availability(inv, "mcp", ledger(), allow(["mcp__dev_radius__q"]));
  assert.deepEqual(baseGrowth(inv, "mcp", ledger(), allow(["mcp__dev_radius__q"]), promoted).groups, ["mcp__dev_radius"]);
  // Internal tools are never recorded.
  assert.ok(!baseGrowth(inv, "mcp", l, allow(["read"]), mcpMode).tools.includes("read"));
});
test("reconcileActive withholds only undecided declared external tools, never internal, and preserves unrelated names", () => {
  const a = availability(inv, "tools", ledger(["ext_a"]), allow());
  const active = ["read", "ext_a", "ext_b", "other_extension_tool", "mcp__docs__s", "bash", "ext_lazy"];
  const { withhold, restore } = reconcileActive(inv, a, active, new Set());
  assert.deepEqual(withhold, ["ext_b", "mcp__docs__s"], "internal, available, unknown and non-declarable (codemode) tools are untouched");
  assert.deepEqual(restore, []);
});
test("reconcileActive restores only tools WE withheld that are now available, registered, declarable and inactive", () => {
  const a = availability(inv, "tools", ledger(["ext_a", "ext_b", "ext_lazy", "mcp__docs__t"]), allow());
  const withheld = new Set(["ext_a", "ext_b", "ext_lazy", "mcp__docs__t", "ghost", "read", "mcp__docs__s"]);
  const { withhold, restore } = reconcileActive(inv, a, ["read", "ext_a"], withheld);
  assert.deepEqual(withhold, []);
  assert.deepEqual(restore, ["ext_b"], "ext_a is already active, ext_lazy/mcp__docs__t are not declarable, ghost is unknown, read is internal, mcp__docs__s is still unavailable");
  // Tools never in the withheld set are never activated, even when available.
  assert.deepEqual(reconcileActive(inv, a, ["read"], new Set()).restore, []);
});


test("scoped allowlists resolve tools/groups before policy; unknown MCP scope is global only and absent extension scope grants nothing", () => {
  const inv = classifyTools([ext("global"), { ...ext("project"), sourceInfo: { path: "/x/project.ts", scope: "project" } },
    mcp("global", "q"), { ...mcp("project", "q"), sourceInfo: { scope: "project" } }]);
  const both = allow(["global", "project"], ["global", "project", "unloaded", "ext__absent"]);
  const global = effectiveToolAllowlists(inv, both, NO_ALLOWLISTS);
  assert.deepEqual([...global.tools], ["global"]); assert.deepEqual([...global.servers], ["global", "unloaded"]);
  const project = effectiveToolAllowlists(inv, NO_ALLOWLISTS, both);
  assert.deepEqual([...project.tools], ["project"]); assert.deepEqual([...project.servers], ["project"]);
});
test("same-named mixed-origin groups cannot leak allowlist grants across scopes, including mcp-mode promotion", () => {
  const mixed = classifyTools(["user", "project"].map((scope) => ({ name: scope, sourceInfo: { scope, path: `/${scope}/notes.ts` } })));
  for (const mode of ["tools", "mcp"] as const) {
    const groupsOnly = effectiveToolAllowlists(mixed, allow([], ["ext__notes"]), allow([], ["ext__notes"]));
    assert.equal(groupsOnly.servers.size, 0, "a group with no single origin is not grantable as a whole");
    const pins = effectiveToolAllowlists(mixed, allow(["user"]), allow(["user"]));
    const a = availability(mixed, mode, ledger(), pins);
    assert.equal(a.isAvailable(mixed.byName.get("user")!), true); assert.equal(a.isAvailable(mixed.byName.get("project")!), false);
    const growth = baseGrowth(mixed, mode, ledger(), pins, a);
    assert.deepEqual(growth, { tools: ["user"], groups: [] });
    const next = availability(mixed, mode, ledger(growth.tools, growth.groups), NO_ALLOWLISTS);
    assert.equal(next.isAvailable(mixed.byName.get("user")!), true); assert.equal(next.isAvailable(mixed.byName.get("project")!), false, "committing the pin never promotes the opposite origin");
  }
});


test("resource-only MCP allowlists use a known config origin before the Global fallback", () => {
  const resourceOnly = classifyTools([], new Map([["mcp__project", "project"]]));
  const both = allow([], ["project", "unknown"]);
  assert.deepEqual([...effectiveToolAllowlists(resourceOnly, both, NO_ALLOWLISTS).servers], ["unknown"]);
  assert.deepEqual([...effectiveToolAllowlists(resourceOnly, NO_ALLOWLISTS, both).servers], ["project"]);
});
