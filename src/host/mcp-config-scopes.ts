// Names-only view of Pi 1.1.0's MCP config loader. Config values exist only inside this reader/validation
// stack: never returned, cached, reported, executed or written. No private Pi runtime imports.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { serverKey } from "../apps/tool-inventory.ts";
import type { AllowlistScope } from "../apps/allowlist-scope.ts";

const MAX_BYTES = 65536;
const MAX_SERVERS = 1000;
type RecordValue = Record<string, unknown>;
export type McpScopeWarning = `mcp-${AllowlistScope}-${"missing" | "unreadable" | "invalid" | "entry-invalid" | "name-clash"}`;
export interface McpConfigScopes { scopes: Map<string, AllowlistScope>; warnings: McpScopeWarning[] }
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): boolean => record(value) && Object.values(value).every((entry) => typeof entry === "string");
const exposure = (value: unknown): boolean => ["codemode", "codemode-deferred", "deferred", "direct", "hidden"].includes(value as string);
const loopback = (host: string): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(host);
function url(value: unknown): URL | undefined { return typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined; }
/** Mirrored from Pi's validateMcpServerConfig/validateOAuth; booleans only, no raw validation messages. */
function common(value: RecordValue): boolean {
  return (value.exposure === undefined || exposure(value.exposure))
    && (value.toolExposure === undefined || record(value.toolExposure) && Object.values(value.toolExposure).every(exposure))
    && (value.enabled === undefined || typeof value.enabled === "boolean")
    && (value.description === undefined || typeof value.description === "string")
    && (value.timeout === undefined || typeof value.timeout === "number" && value.timeout > 0);
}
function oauth(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  for (const field of ["clientId", "clientSecret", "scope"] as const) if (value[field] !== undefined && typeof value[field] !== "string") return false;
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return false;
  const callback = url(value.callbackUrl);
  if (value.callbackUrl !== undefined && (!callback || callback.protocol !== "http:" || !loopback(callback.hostname) || callback.search || callback.hash
    || callback.port && port !== undefined && Number(callback.port) !== port)) return false;
  if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) return false;
  if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
    if (value.clientRegistration !== "cimd" || value.clientId !== undefined || value.clientName !== undefined) return false;
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) return false;
  }
  const metadata = url(value.authServerMetadataUrl);
  return value.authServerMetadataUrl === undefined || !!metadata && (metadata.protocol === "https:" || metadata.protocol === "http:" && loopback(metadata.hostname));
}
/** Validate transiently without returning a config copy or raw error message. */
function definition(name: string, value: unknown): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(name) || !record(value) || !common(value) || value.type === "sse") return false;
  if (typeof value.url === "string" && (value.type === undefined || value.type === "http" || value.type === "streamable-http")) {
    const target = url(value.url);
    if (!target || !["http:", "https:"].includes(target.protocol) || value.headers !== undefined && !strings(value.headers) || !oauth(value.oauth)) return false;
    if (value.auth !== undefined) {
      if (!record(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider || target.protocol !== "https:" && !loopback(target.hostname)) return false;
    }
    return true;
  }
  if (typeof value.command === "string" && (value.type === undefined || value.type === "stdio")) {
    if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
      || value.env !== undefined && !strings(value.env) || value.cwd !== undefined && typeof value.cwd !== "string") return false;
    return true;
  }
  return false;
}
async function readNames(path: string, scope: AllowlistScope, names: Map<string, AllowlistScope>, warnings: Set<McpScopeWarning>): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_BYTES) { warnings.add(`mcp-${scope}-invalid`); return; }
    // NONBLOCK also prevents a path swapped for a FIFO between lstat and open from hanging the agent.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) { warnings.add(`mcp-${scope}-invalid`); return; }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) { const { bytesRead } = await file.read(bytes, used, bytes.length - used); if (!bytesRead) break; used += bytesRead; }
    if (used > MAX_BYTES) { warnings.add(`mcp-${scope}-invalid`); return; }
    const parsed: unknown = JSON.parse(bytes.subarray(0, used).toString("utf8"));
    if (!record(parsed) || parsed.mcpServers !== undefined && !record(parsed.mcpServers)) { warnings.add(`mcp-${scope}-invalid`); return; }
    const entries = Object.entries(parsed.mcpServers ?? {});
    if (entries.length > MAX_SERVERS) { warnings.add(`mcp-${scope}-invalid`); return; }
    if (parsed.autoEnableCodemode !== undefined && typeof parsed.autoEnableCodemode !== "boolean") warnings.add(`mcp-${scope}-entry-invalid`);
    for (const [name, value] of entries) {
      // Pi's settings-only project override retains the GLOBAL source/scope. A valid base is enough:
      // only common policy fields can change, and no config values need to be retained for a merge.
      if (scope === "project" && record(value) && value.command === undefined && value.url === undefined && value.type === undefined) {
        if (!names.has(name) || Object.keys(value).some((key) => !["enabled", "exposure", "toolExposure"].includes(key)) || !common(value)) warnings.add("mcp-project-entry-invalid");
        continue;
      }
      const valid = definition(name, value);
      // Pi applies this project-auth rejection after validation for every transport, including stdio extras.
      if (!valid || scope === "project" && record(value) && "url" in value && value.auth) { warnings.add(`mcp-${scope}-entry-invalid`); continue; }
      if ([...names.keys()].some((other) => other !== name && serverKey(other) === serverKey(name))) { warnings.add(`mcp-${scope}-name-clash`); continue; }
      names.set(name, scope);
    }
  } catch (error) {
    warnings.add(`mcp-${scope}-${error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" : "unreadable"}`);
  } finally { await file?.close().catch(() => {}); }
}
/** Pi's exact two paths/order; no ancestor discovery. Missing/unsafe/malformed scopes contribute no names. */
export async function readMcpConfigScopes(options: { agentDir: string; cwd?: string; projectTrusted: boolean }): Promise<McpConfigScopes> {
  const names = new Map<string, AllowlistScope>(), warnings = new Set<McpScopeWarning>();
  await readNames(join(options.agentDir, "mcp.json"), "global", names, warnings);
  if (options.projectTrusted && options.cwd) await readNames(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), "project", names, warnings);
  return { scopes: new Map([...names].map(([name, scope]) => [serverKey(name), scope])), warnings: [...warnings] };
}
