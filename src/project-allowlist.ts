import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeAllowlist } from "./apps/allowlist.ts";
import { SettingsError } from "./settings.ts";

const MAX_BYTES = 65536;
export function projectAllowlistPath(cwd: string): string { return join(cwd, ".pi", "pi-context-decisions.json"); }
export interface ProjectAllowlistLoad { names: string[]; warnings: string[]; error?: string }
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
    if (!Array.isArray(data.alwaysAllowed)) throw new SettingsError("Project allowlist alwaysAllowed must be an array");
    const warnings = Object.keys(data).some((key) => key !== "alwaysAllowed") ? ["Unknown project allowlist fields were ignored"] : [];
    return { names: normalizeAllowlist(data.alwaysAllowed), warnings };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { names: [], warnings: [] };
    return { names: [], warnings: [], error: error instanceof SettingsError ? error.message : "Could not read valid project skill allowlist" };
  } finally { await file?.close(); }
}
export async function saveProjectAllowlist(cwd: string, names: Iterable<string>): Promise<void> {
  let validated: string[];
  try { validated = normalizeAllowlist(names); } catch { throw new SettingsError("Project allowlist names must be bounded, nonempty identifiers"); }
  const text = JSON.stringify({ alwaysAllowed: validated }, null, 2) + "\n";
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
