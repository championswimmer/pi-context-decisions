import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackendSelection } from "./core/backends/factory.ts";
import { isAllowedOpenRouterModel } from "./catalog/openrouter-models.ts";
import { normalizeAllowlist, normalizeServerAllowlist, normalizeToolAllowlist } from "./apps/allowlist.ts";
import { DEFAULT_RELEVANCE_THRESHOLD, validThreshold } from "./apps/skill-filter.ts";

/** When the additive picker runs. Both values only ever ADD skills for the same bounded user task. */
export type PickerCadence = "prompt" | "tool-round";
export const PICKER_CADENCES: readonly PickerCadence[] = ["prompt", "tool-round"];
export interface RelevanceSettings {
  enabled: boolean;
  /** Normalized 0–1, inclusive: a skill qualifies when its 0–2 score is at least 2 × threshold. */
  threshold: number;
  /** Most NEW skills added by one picking round, ranked across all shards. Already-added skills never count. */
  maxSkills: number;
  /** `prompt`: every submitted prompt (and queued steering/follow-up user text). `tool-round`: also after each completed tool round. */
  cadence: PickerCadence;
  minCandidates: number;
  failMode: "open" | "closed";
  timeoutMs: number;
  maxPromptChars: number;
  maxDescriptionChars: number;
  chunkSize: number;
  /** 0 dispatches every batch in parallel; positive values cap concurrent batches. */
  concurrency: number;
  pinned: string[];
}
/** `tools`: every external tool is its own candidate. `mcp`: whole MCP namespaces are on or off; other extension tools are never filtered. */
export type ToolFilterMode = "tools" | "mcp";
export const TOOL_FILTER_MODES: readonly ToolFilterMode[] = ["tools", "mcp"];
/** `initial`: pick once from the first user prompt. `prompt`: every new user prompt. `tool-round`: also after completed tool rounds. */
export type ToolCadence = "initial" | "prompt" | "tool-round";
export const TOOL_CADENCES: readonly ToolCadence[] = ["initial", "prompt", "tool-round"];
/**
 * Opt-in tool and MCP filtering. Independent of `relevance.enabled` (skills); only the master `enabled` switch, the decision
 * `backend` and the shared transport limits (`relevance.timeoutMs/chunkSize/concurrency/maxPromptChars`) are common.
 */
export interface ToolFilterSettings {
  enabled: boolean;
  mode: ToolFilterMode;
  cadence: ToolCadence;
  /** Normalized 0–1, inclusive, like the skill threshold. */
  threshold: number;
  /** Most NEW tools (or MCP servers) added by one round. */
  maxAdded: number;
  /** Below this many candidates nothing is scored and every candidate stays available (recorded on the branch). */
  minCandidates: number;
  failMode: "open" | "closed";
  maxDescriptionChars: number;
  /** Always-available external tools (names). Global; the project list lives in `.pi/pi-context-decisions.json`. */
  alwaysAllowedTools: string[];
  /** Always-available MCP servers (server names or `mcp__` namespace keys). */
  alwaysAllowedMcpServers: string[];
}
export interface ContextDecisionsSettings {
  enabled: boolean;
  backend: BackendSelection | null;
  globalAllowlist: string[];
  relevance: RelevanceSettings;
  tools: ToolFilterSettings;
}
export function defaultToolSettings(): ToolFilterSettings {
  return { enabled: false, mode: "tools", cadence: "prompt", threshold: DEFAULT_RELEVANCE_THRESHOLD, maxAdded: 8, minCandidates: 0,
    failMode: "closed", maxDescriptionChars: 400, alwaysAllowedTools: [], alwaysAllowedMcpServers: [] };
}
export function defaultSettings(): ContextDecisionsSettings {
  return { enabled: true, backend: null, globalAllowlist: [], tools: defaultToolSettings(), relevance: {
    enabled: true, threshold: DEFAULT_RELEVANCE_THRESHOLD, maxSkills: 12, cadence: "prompt", minCandidates: 8,
    failMode: "closed", timeoutMs: 8000, maxPromptChars: 4000, maxDescriptionChars: 400,
    chunkSize: 50, concurrency: 0, pinned: [],
  } };
}
export class SettingsError extends Error {
  readonly code = "config";
  constructor(message: string) { super(message); this.name = "SettingsError"; }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\p{Cc}]/u.test(value);
}
function keys(value: Record<string, unknown>, allowed: string[], warnings?: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  if (!warnings) throw new SettingsError("Unknown settings fields are not allowed");
  warnings.push("Unknown settings fields were ignored");
}
function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new SettingsError("Settings nesting exceeds the allowed bound");
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/api.?key|token|secret|password|authorization|credential/iu.test(key)) throw new SettingsError("Credentials must not be stored in context-decisions settings");
    rejectSecrets(entry, depth + 1);
  }
}
/** Validates both direct and Pi OpenRouter selections against the checked-in ten. */
export function validateBackendSelection(value: unknown): BackendSelection | null {
  if (value === null) return null;
  if (!object(value)) throw new SettingsError("Invalid decision backend selection");
  if (value.backend === "pi") {
    keys(value, ["backend", "provider", "id"]);
    if (!identifier(value.provider) || !identifier(value.id)) throw new SettingsError("Pi selection requires provider and classifier ID");
    if (value.provider === "openrouter" && !isAllowedOpenRouterModel(value.id)) throw new SettingsError("OpenRouter model is outside the checked-in top ten; select a listed model");
    return { backend: "pi", provider: value.provider, id: value.id };
  }
  if (value.backend === "openrouter") {
    keys(value, ["backend", "model"]);
    if (!identifier(value.model) || !isAllowedOpenRouterModel(value.model)) throw new SettingsError("OpenRouter model is outside the checked-in top ten; select a listed model");
    return { backend: "openrouter", model: value.model };
  }
  if (value.backend === "typesafe" || value.backend === "openai") {
    keys(value, ["backend", "model"]);
    const model = value.model ?? (value.backend === "typesafe" ? "jev-latest" : "gpt-6-luna");
    if (!identifier(model) || !(value.backend === "typesafe" ? ["jev-latest", "jev-1.13.0"] : ["gpt-6-luna"]).includes(model)) throw new SettingsError("Select a supported direct decision model");
    return { backend: value.backend, model };
  }
  throw new SettingsError("Unknown decision backend");
}
/** Pre-0.3 keys. Read on load only; the next save writes the normalized `threshold` instead. */
const LEGACY_RELEVANCE_KEYS = ["mode", "minLabel", "relatedThreshold", "directThreshold"] as const;
/**
 * Validates the legacy keys with their ORIGINAL rules (an invalid file stays a visible settings error and
 * fails closed), then maps them losslessly: threshold = (direct or related raw 0–2 threshold) / 2.
 */
function migrateLegacyThreshold(input: Record<string, unknown>, warnings?: string[]): number | undefined {
  if (!LEGACY_RELEVANCE_KEYS.some((key) => input[key] !== undefined)) return undefined;
  if (input.mode !== undefined && input.mode !== "score" && input.mode !== "choice") throw new SettingsError("Invalid relevance.mode");
  if (input.minLabel !== undefined && input.minLabel !== "related" && input.minLabel !== "directly_relevant") throw new SettingsError("Invalid relevance.minLabel");
  const raw = { relatedThreshold: 0.75, directThreshold: 1.5 };
  for (const key of ["relatedThreshold", "directThreshold"] as const) {
    const number = input[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 2) throw new SettingsError(`relevance.${key} must be finite in [0, 2]`);
    raw[key] = number;
  }
  if (raw.relatedThreshold > raw.directThreshold) throw new SettingsError("Relevance thresholds must be ordered: relatedThreshold <= directThreshold");
  if (input.threshold !== undefined) warnings?.push("Legacy relevance settings were ignored because relevance.threshold is set");
  else if (input.mode === "choice") warnings?.push("Choice scoring was removed; skill picking now uses relevance scores with the migrated threshold");
  return (input.minLabel === "directly_relevant" ? raw.directThreshold : raw.relatedThreshold) / 2;
}
const NUMERIC_BOUNDS = {
  maxSkills: [0, 1000], minCandidates: [0, 1000], timeoutMs: [1, 300000],
  maxPromptChars: [1, 4000], maxDescriptionChars: [1, 400], chunkSize: [1, 50], concurrency: [0, 32],
} as const;
const TOOL_NUMERIC_BOUNDS = { maxAdded: [0, 1000], minCandidates: [0, 1000], maxDescriptionChars: [1, 400] } as const;
function parseToolSettings(value: unknown, warnings?: string[]): ToolFilterSettings {
  if (!object(value)) throw new SettingsError("tools must be an object");
  const result = defaultToolSettings();
  keys(value, Object.keys(result), warnings);
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new SettingsError("tools.enabled must be a boolean");
    result.enabled = value.enabled;
  }
  const enums = { mode: TOOL_FILTER_MODES, cadence: TOOL_CADENCES, failMode: ["open", "closed"] } as const;
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !(enums[key] as readonly string[]).includes(value[key])) throw new SettingsError(`Invalid tools.${key}`);
    Object.assign(result, { [key]: value[key] });
  }
  for (const key of Object.keys(TOOL_NUMERIC_BOUNDS) as (keyof typeof TOOL_NUMERIC_BOUNDS)[]) {
    const number = value[key];
    if (number === undefined) continue;
    const [min, max] = TOOL_NUMERIC_BOUNDS[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) throw new SettingsError(`tools.${key} must be an integer in [${min}, ${max}]`);
    result[key] = number;
  }
  if (value.threshold !== undefined) {
    if (!validThreshold(value.threshold)) throw new SettingsError("tools.threshold must be finite in [0, 1]");
    result.threshold = value.threshold;
  }
  if (value.alwaysAllowedTools !== undefined) {
    if (!Array.isArray(value.alwaysAllowedTools)) throw new SettingsError("tools.alwaysAllowedTools must be an array of tool names");
    try { result.alwaysAllowedTools = normalizeToolAllowlist(value.alwaysAllowedTools); }
    catch { throw new SettingsError("Tool allowlist names must be 1-128 characters without whitespace or control characters (at most 1000)"); }
  }
  if (value.alwaysAllowedMcpServers !== undefined) {
    if (!Array.isArray(value.alwaysAllowedMcpServers)) throw new SettingsError("tools.alwaysAllowedMcpServers must be an array of MCP server names");
    try { result.alwaysAllowedMcpServers = normalizeServerAllowlist(value.alwaysAllowedMcpServers); }
    catch { throw new SettingsError("MCP server allowlist names must match [A-Za-z0-9_-]{1,64} (at most 1000)"); }
  }
  return result;
}
export function parseSettings(value: unknown, warnings?: string[]): ContextDecisionsSettings {
  rejectSecrets(value);
  if (!object(value)) throw new SettingsError("Settings must be a JSON object");
  keys(value, ["enabled", "backend", "globalAllowlist", "relevance", "tools"], warnings);
  const result = defaultSettings();
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new SettingsError("enabled must be a boolean");
    result.enabled = value.enabled;
  }
  if (value.backend !== undefined) result.backend = validateBackendSelection(value.backend);
  if (value.globalAllowlist !== undefined) {
    if (!Array.isArray(value.globalAllowlist)) throw new SettingsError("Global allowlist must be an array of skill names");
    try { result.globalAllowlist = normalizeAllowlist(value.globalAllowlist); }
    catch { throw new SettingsError("Global allowlist names must be bounded, nonempty identifiers"); }
  }
  if (value.tools !== undefined) result.tools = parseToolSettings(value.tools, warnings);
  if (value.relevance === undefined) return result;
  if (!object(value.relevance)) throw new SettingsError("relevance must be an object");
  const input = value.relevance;
  keys(input, [...Object.keys(result.relevance), ...LEGACY_RELEVANCE_KEYS], warnings);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new SettingsError("relevance.enabled must be a boolean");
    result.relevance.enabled = input.enabled;
  }
  const enums = { failMode: ["open", "closed"], cadence: PICKER_CADENCES } as const;
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || !(enums[key] as readonly string[]).includes(input[key])) throw new SettingsError(`Invalid relevance.${key}`);
      Object.assign(result.relevance, { [key]: input[key] });
    }
  }
  for (const key of Object.keys(NUMERIC_BOUNDS) as (keyof typeof NUMERIC_BOUNDS)[]) {
    const number = input[key];
    if (number === undefined) continue;
    const [min, max] = NUMERIC_BOUNDS[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) throw new SettingsError(`relevance.${key} must be an integer in [${min}, ${max}]`);
    result.relevance[key] = number;
  }
  const migrated = migrateLegacyThreshold(input, warnings);
  if (input.threshold !== undefined) {
    if (!validThreshold(input.threshold)) throw new SettingsError("relevance.threshold must be finite in [0, 1]");
    result.relevance.threshold = input.threshold;
  } else if (migrated !== undefined) result.relevance.threshold = migrated;
  if (input.pinned !== undefined) {
    if (!Array.isArray(input.pinned) || input.pinned.length > 1000 || input.pinned.some((name) => !identifier(name) || name.length > 64)) throw new SettingsError("Pinned skill names must be nonempty, bounded identifiers");
    result.relevance.pinned = [...new Set(input.pinned as string[])];
  }
  return result;
}
export interface SettingsLoadResult { settings: ContextDecisionsSettings; warnings: string[]; error?: string }
export async function loadSettings(path: string): Promise<SettingsLoadResult> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new SettingsError("Settings path must be a regular file");
    if (info.size > 65536) throw new SettingsError("Settings file exceeds 64 KiB");
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 65536) throw new SettingsError("Settings file exceeds 64 KiB");
    const warnings: string[] = [];
    return { settings: parseSettings(JSON.parse(text), warnings), warnings };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { settings: defaultSettings(), warnings: [] };
    // Invalid persisted selections are visible errors, never a fallback to a different paid backend.
    return { settings: defaultSettings(), warnings: [], error: error instanceof SettingsError ? error.message : "Could not read valid context-decisions settings" };
  }
}
/** Atomic replacement, restrictive permissions, cleanup on failure; never persists credentials. */
export async function saveSettings(settings: ContextDecisionsSettings, path: string): Promise<void> {
  const validated = parseSettings(settings);
  const text = JSON.stringify(validated, null, 2) + "\n";
  if (Buffer.byteLength(text) > 65536) throw new SettingsError("Settings file exceeds 64 KiB");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch { throw new SettingsError("Could not save context-decisions settings"); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
/** CLI/UI updates always pass through the same strict validation as persistence. */
export function updateSetting(settings: ContextDecisionsSettings, key: string, text: string): ContextDecisionsSettings {
  if (key === "globalAllowlist") throw new SettingsError("Edit the allowlist in the /decisions dialog");
  if (key === "tools.alwaysAllowedTools" || key === "tools.alwaysAllowedMcpServers") throw new SettingsError("Edit these allowlists in the /decisions Tool picker tab");
  const next = structuredClone(settings);
  let target: Record<string, unknown>;
  let field: string;
  if (key === "enabled") { target = next as unknown as Record<string, unknown>; field = key; }
  else if (key.startsWith("relevance.")) { target = next.relevance as unknown as Record<string, unknown>; field = key.slice(10); }
  else if (key.startsWith("tools.")) { target = next.tools as unknown as Record<string, unknown>; field = key.slice(6); }
  else throw new SettingsError("Use enabled, a relevance or tools setting; choose a backend in the /decisions dialog");
  if (target === (next.relevance as unknown) && (LEGACY_RELEVANCE_KEYS as readonly string[]).includes(field)) {
    throw new SettingsError("Removed setting: skill picking is score-only. Use relevance threshold <0–1>");
  }
  if (!Object.hasOwn(target, field) || field === "pinned") throw new SettingsError("Unknown setting; use pin/unpin for pinned skills");
  if (typeof target[field] === "boolean") {
    if (text !== "true" && text !== "false") throw new SettingsError("Boolean setting requires true or false");
    target[field] = text === "true";
  } else if (typeof target[field] === "number") {
    const threshold = field === "threshold";
    if (!(threshold ? /^(?:\d+(?:\.\d+)?|\.\d+)$/u : /^\d+$/u).test(text)) throw new SettingsError(threshold ? "Threshold requires a decimal in [0, 1]" : "Numeric setting requires a nonnegative integer");
    target[field] = Number(text);
  } else target[field] = text;
  return parseSettings(next);
}
