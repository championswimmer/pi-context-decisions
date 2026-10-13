import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeAllowlist, normalizeServerAllowlist, normalizeToolAllowlist } from "./apps/allowlist.ts";
import { SettingsError } from "./settings.ts";

const MAX_BYTES = 65536;
export function projectAllowlistPath(cwd: string): string { return join(cwd, ".pi", "pi-context-decisions.json"); }
/** `names` is the always-advertised skill list (file key `alwaysAllowed`); tools and MCP servers have their own keys. */
export interface ProjectAllowlistLoad { names: string[]; tools: string[]; mcpServers: string[]; warnings: string[]; error?: string }
export interface ProjectAllowlistLists { skills?: Iterable<string>; tools?: Iterable<string>; mcpServers?: Iterable<string> }
const KNOWN_KEYS = ["alwaysAllowed", "alwaysAllowedTools", "alwaysAllowedMcpServers"];
const EMPTY = (): ProjectAllowlistLoad => ({ names: [], tools: [], mcpServers: [], warnings: [] });
function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new SettingsError("Project allowlist nesting exceeds the allowed bound");
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/api.?key|token|secret|password|authorization|credential/iu.test(key)) throw new SettingsError("Credentials must not be stored in project allowlists");
    rejectSecrets(entry, depth + 1);
  }
}
async function regularDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new SettingsError("Project allowlist directory must be a real directory, not a symlink");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
async function regularFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new SettingsError("Project allowlist path must be a regular file, not a symlink");
    if (info.size > MAX_BYTES) throw new SettingsError("Project allowlist exceeds 64 KiB");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
export async function loadProjectAllowlist(cwd: string): Promise<ProjectAllowlistLoad> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = projectAllowlistPath(cwd);
    await regularDirectory(dirname(path));
    await regularFile(path);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile()) throw new SettingsError("Project allowlist path must be a regular file");
    if (info.size > MAX_BYTES) throw new SettingsError("Project allowlist exceeds 64 KiB");
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new SettingsError("Project allowlist exceeds 64 KiB");
    const input: unknown = JSON.parse(text);
    rejectSecrets(input);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsError("Project allowlist must be a JSON object");
    const data = input as Record<string, unknown>;
    const present = KNOWN_KEYS.filter((key) => data[key] !== undefined);
    if (!present.length) throw new SettingsError("Project allowlist alwaysAllowed must be an array");
    for (const key of present) if (!Array.isArray(data[key])) throw new SettingsError(`Project allowlist ${key} must be an array`);
    const warnings = Object.keys(data).some((key) => !KNOWN_KEYS.includes(key)) ? ["Unknown project allowlist fields were ignored"] : [];
    let tools: string[], mcpServers: string[];
    try { tools = data.alwaysAllowedTools === undefined ? [] : normalizeToolAllowlist(data.alwaysAllowedTools as unknown[]); }
    catch { throw new SettingsError("Project tool allowlist names must be 1-128 characters without whitespace or control characters"); }
    try { mcpServers = data.alwaysAllowedMcpServers === undefined ? [] : normalizeServerAllowlist(data.alwaysAllowedMcpServers as unknown[]); }
    catch { throw new SettingsError("Project MCP server allowlist names must match [A-Za-z0-9_-]{1,64}"); }
    return { names: data.alwaysAllowed === undefined ? [] : normalizeAllowlist(data.alwaysAllowed as unknown[]), tools, mcpServers, warnings };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return EMPTY();
    // A malformed file yields empty lists (never the full inventory) plus a visible error.
    return { ...EMPTY(), error: error instanceof SettingsError ? error.message : "Could not read valid project skill allowlist" };
  } finally { await file?.close(); }
}
/**
 * Read-modify-write: a list that is not supplied keeps its current value, so saving skills never drops tool or MCP
 * entries (and vice versa). `alwaysAllowed` is ALWAYS written (possibly `[]`) so v0.3.0 readers keep working.
 * An unreadable existing file contributes empty lists (the same as loading it); symlinks and non-regular files still reject the write.
 */
export async function saveProjectAllowlist(cwd: string, lists: ProjectAllowlistLists | Iterable<string>): Promise<void> {
  const input: ProjectAllowlistLists = Symbol.iterator in Object(lists) ? { skills: lists as Iterable<string> } : lists as ProjectAllowlistLists;
  const current = await loadProjectAllowlist(cwd);
  let skills: string[], tools: string[], mcpServers: string[];
  try {
    skills = input.skills === undefined ? current.names : normalizeAllowlist(input.skills);
    tools = input.tools === undefined ? current.tools : normalizeToolAllowlist(input.tools);
    mcpServers = input.mcpServers === undefined ? current.mcpServers : normalizeServerAllowlist(input.mcpServers);
  } catch { throw new SettingsError("Project allowlist names must be bounded, nonempty identifiers"); }
  const text = JSON.stringify({ alwaysAllowed: skills, ...(tools.length ? { alwaysAllowedTools: tools } : {}), ...(mcpServers.length ? { alwaysAllowedMcpServers: mcpServers } : {}) }, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES) throw new SettingsError("Project allowlist exceeds 64 KiB");
  const path = projectAllowlistPath(cwd), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await regularDirectory(dirname(path));
    await mkdir(dirname(path), { recursive: true });
    await regularDirectory(dirname(path));
    await regularFile(path);
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await regularFile(path);
    await rename(temporary, path);
  } catch (error) { throw error instanceof SettingsError ? error : new SettingsError("Could not save project skill allowlist"); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
