import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMcpConfigScopes } from "../src/host/mcp-config-scopes.ts";
import { serverKey } from "../src/apps/tool-inventory.ts";

// Contract check against the installed loader, not a production dependency on Pi internals.
const { loadMcpConfig } = await import(new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-scope-")), agentDir = join(cwd, "agent");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(agentDir); await mkdir(join(cwd, ".pi"));
  const global = join(agentDir, "mcp.json"), project = join(cwd, ".pi", "mcp.json");
  return { cwd, agentDir, global, project, async put(g: unknown, p: unknown) { await writeFile(global, JSON.stringify(g)); await writeFile(project, JSON.stringify(p)); } };
}
const names = (scopes: ReadonlyMap<string, string>) => [...scopes].sort(([a], [b]) => a.localeCompare(b));
const SECRET = "CONFIG_VALUE_MUST_NOT_ESCAPE";

test("MCP scope reader mirrors Pi's valid definitions, settings-only overrides, invalid replacements and canonical name clashes", async (t) => {
  const f = await fixture(t);
  await f.put({ mcpServers: {
    global: { command: SECRET, args: [SECRET], env: { PRIVATE: SECRET } }, same: { command: SECRET }, settings: { url: "https://example.invalid", headers: { Authorization: SECRET } },
    invalid: { command: SECRET }, "dev-radius": { command: SECRET }, httpauth: { url: "https://example.invalid", auth: { provider: SECRET } },
  } }, { mcpServers: {
    project: { command: SECRET }, same: { url: "https://example.invalid", headers: { PRIVATE: SECRET } }, settings: { enabled: false, exposure: "codemode-deferred", toolExposure: { "*": "direct" } },
    invalid: { command: 4, env: SECRET }, dev_radius: { command: SECRET }, httpauth: { url: "https://example.invalid", auth: { provider: SECRET } }, orphan: { enabled: true },
  } });
  const options = { agentDir: f.agentDir, cwd: f.cwd, projectTrusted: true };
  const actual = await readMcpConfigScopes(options);
  const pi = loadMcpConfig(options);
  assert.deepEqual(names(actual.scopes), pi.servers.map((entry: { name: string; scope: string }) => [serverKey(entry.name), entry.scope]).sort(([a]: string[], [b]: string[]) => a.localeCompare(b)));
  assert.equal(actual.scopes.get("mcp__same"), "project");
  for (const name of ["global", "settings", "invalid", "dev_radius", "httpauth"]) assert.equal(actual.scopes.get(`mcp__${name}`), "global", name);
  assert.equal(actual.scopes.get("mcp__project"), "project"); assert.equal(actual.scopes.has("mcp__orphan"), false);
  assert.ok(actual.warnings.includes("mcp-project-entry-invalid")); assert.ok(actual.warnings.includes("mcp-project-name-clash"));
  assert.doesNotMatch(JSON.stringify({ scopes: [...actual.scopes], warnings: actual.warnings }), /CONFIG_VALUE|example\.invalid|Authorization|command|args|headers|env/);
});
test("common/transport/OAuth shapes have the same precedence as Pi, without returning config values", async (t) => {
  const f = await fixture(t);
  const values = [null, [], {}, { command: 4 }, { command: "x", args: [3] }, { command: "x", env: { x: 4 } }, { command: "x", cwd: 3 },
    { command: "x", enabled: 3 }, { command: "x", timeout: 0 }, { command: "x", description: 4 }, { command: "x", exposure: "bad" }, { command: "x", toolExposure: { x: "bad" } },
    { url: "bad" }, { url: "file:///x" }, { url: "https://example.invalid", headers: { x: 4 } }, { url: "https://example.invalid", oauth: { clientId: 4 } },
    { url: "https://example.invalid", oauth: { callbackUrl: "http://localhost/callback", callbackPort: 1234, clientRegistration: "cimd" } },
    { url: "https://example.invalid", oauth: { callbackUrl: "http://[::1]/callback", clientRegistration: "cimd" } },
    { url: "https://example.invalid", oauth: { authServerMetadataUrl: "http://example.invalid" } }, { url: "https://example.invalid", oauth: { callbackPort: 0 } },
    { url: "https://example.invalid", oauth: { clientName: " " } }, { url: "https://example.invalid", oauth: { clientRegistration: "bad" } },
    { type: "sse", url: "https://example.invalid" }, { url: "http://example.invalid", auth: { provider: "x" } }, { enabled: 4 }, { enabled: true, env: { x: SECRET } },
    // Stdio keeps extra URL/auth fields; the loader's project-auth predicate is transport-independent.
    { type: "stdio", command: "x", url: "https://example.invalid", auth: { provider: "x" } },
    { command: "x", url: 7, auth: true }, { type: "stdio", command: "x", url: null, auth: SECRET },
    { type: "stdio", command: "x", auth: { provider: "x" } },
    { type: "stdio", command: "x", url: "https://example.invalid", auth: false },
    { type: "stdio", command: "x", url: "https://example.invalid", auth: null },
    { type: "stdio", command: "x", url: "https://example.invalid", auth: 0 }];
  await f.put({ mcpServers: Object.fromEntries(values.map((_, i) => [`s${i}`, { command: "base" }])) }, { mcpServers: Object.fromEntries(values.map((value, i) => [`s${i}`, value])) });
  const options = { agentDir: f.agentDir, cwd: f.cwd, projectTrusted: true };
  const actual = await readMcpConfigScopes(options), pi = loadMcpConfig(options);
  assert.deepEqual(names(actual.scopes), pi.servers.map((entry: { name: string; scope: string }) => [serverKey(entry.name), entry.scope]).sort(([a]: string[], [b]: string[]) => a.localeCompare(b)));
});
test("untrusted projects are not read, and only Pi's cwd/.pi and agent-dir files participate", async (t) => {
  const f = await fixture(t);
  await f.put({ mcpServers: { same: { command: "x" } } }, { mcpServers: { same: { command: "y" }, project: { command: "z" } } });
  const untrusted = await readMcpConfigScopes({ ...f, projectTrusted: false });
  assert.deepEqual([...untrusted.scopes], [["mcp__same", "global"]]); assert.deepEqual(untrusted.warnings, []);
  const child = join(f.cwd, "subdir"); await mkdir(child);
  const nested = await readMcpConfigScopes({ agentDir: f.agentDir, cwd: child, projectTrusted: true });
  assert.deepEqual([...nested.scopes], [["mcp__same", "global"]]); assert.deepEqual(nested.warnings, ["mcp-project-missing"]);
});
test("missing, malformed, symlink, oversized and non-regular config files yield only safe warnings and no names", async (t) => {
  const f = await fixture(t);
  for (const text of [`{ "mcpServers": { "${SECRET}":`, "[]", '{"mcpServers":[]}', " ".repeat(65537)]) {
    await writeFile(f.global, text);
    const read = await readMcpConfigScopes({ ...f, projectTrusted: true });
    assert.equal(read.scopes.size, 0); assert.ok(read.warnings.includes("mcp-global-invalid")); assert.doesNotMatch(JSON.stringify(read.warnings), /CONFIG_VALUE|mcp-scope-|SyntaxError/);
  }
  await rm(f.global); await symlink(f.project, f.global); await writeFile(f.project, '{"mcpServers":{"secret":{"command":"x"}}}');
  assert.equal((await readMcpConfigScopes({ ...f, projectTrusted: false })).scopes.size, 0, "symlink not followed");
  await rm(f.global); await mkdir(f.global);
  assert.deepEqual((await readMcpConfigScopes({ ...f, projectTrusted: false })).warnings, ["mcp-global-invalid"]);
});


test("an oversized name inventory contributes no partial scope, and a bad global file does not suppress a valid project", async (t) => {
  const f = await fixture(t);
  await f.put({ mcpServers: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`s${i}`, { command: "x" }])) }, { mcpServers: { project: { command: "x" } } });
  const options = { agentDir: f.agentDir, cwd: f.cwd, projectTrusted: true };
  const bounded = await readMcpConfigScopes(options);
  assert.deepEqual([...bounded.scopes], [["mcp__project", "project"]]); assert.deepEqual(bounded.warnings, ["mcp-global-invalid"]);
  await writeFile(f.global, `{ "mcpServers": ${SECRET}`);
  assert.deepEqual([...(await readMcpConfigScopes(options)).scopes], [["mcp__project", "project"]]);
});
