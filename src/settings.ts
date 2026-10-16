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
/** Framework-wide tuning used by skill/tool picking and explicit allowlist ranking. */
export interface DecisionSettings {
  threshold: number;
  failMode: "open" | "closed";
  timeoutMs: number;
  maxPromptChars: number;
  maxDescriptionChars: number;
  chunkSize: number;
  /** 0 dispatches every shard in parallel; positive values cap concurrent shards. */
  concurrency: number;
}
export interface RelevanceSettings {
  enabled: boolean;
  /** Cap on newly advertised skills, not tools or entire tool groups. */
  maxSkills: number;
  cadence: PickerCadence;
  /** Automatic skill picking starts at eight skills by default (tool gating starts at zero). */
  minCandidates: number;
  pinned: string[];
}
/** `tools`: every external tool is its own candidate. `mcp` (group mode): every MCP namespace and every extension (grouped by Pi's public `sourceInfo`) is on or off as a whole; only extension tools without public provenance are never filtered. */
export type ToolFilterMode = "tools" | "mcp";
export const TOOL_FILTER_MODES: readonly ToolFilterMode[] = ["tools", "mcp"];
/** `initial`: pick once from the first user prompt. `prompt`: every new user prompt. `tool-round`: also after completed tool rounds. */
export type ToolCadence = "initial" | "prompt" | "tool-round";
export const TOOL_CADENCES: readonly ToolCadence[] = ["initial", "prompt", "tool-round"];
/** Opt-in tool/MCP/extension filtering, independent of the skill switch. */
export interface ToolFilterSettings {
  enabled: boolean;
  mode: ToolFilterMode;
  cadence: ToolCadence;
  /** New tools (or whole servers/extensions in group mode) per round; not a skill cap. */
  maxAdded: number;
  minCandidates: number;
  alwaysAllowedTools: string[];
  /** MCP names/namespace keys and canonical extension keys; retains its original setting name. */
  alwaysAllowedMcpServers: string[];
}
export interface ContextDecisionsSettings {
  backend: BackendSelection | null;
  globalAllowlist: string[];
  decision: DecisionSettings;
  relevance: RelevanceSettings;
  tools: ToolFilterSettings;
}
export function defaultDecisionSettings(): DecisionSettings {
  return { threshold: DEFAULT_RELEVANCE_THRESHOLD, failMode: "closed", timeoutMs: 8000, maxPromptChars: 4000,
    maxDescriptionChars: 400, chunkSize: 50, concurrency: 0 };
}
export function defaultToolSettings(): ToolFilterSettings {
  return { enabled: false, mode: "tools", cadence: "prompt", maxAdded: 8, minCandidates: 0, alwaysAllowedTools: [], alwaysAllowedMcpServers: [] };
}
export function defaultSettings(): ContextDecisionsSettings {
  return { backend: null, globalAllowlist: [], decision: defaultDecisionSettings(), tools: defaultToolSettings(),
    relevance: { enabled: true, maxSkills: 12, cadence: "prompt", minCandidates: 8, pinned: [] } };
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
/** Pre-0.3 keys. Read on load only; the next save writes normalized `decision.threshold` instead. */
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
const DECISION_BOUNDS = { timeoutMs: [1, 300000], maxPromptChars: [1, 4000], maxDescriptionChars: [1, 400], chunkSize: [1, 50], concurrency: [0, 32] } as const;
const SHARED_KEYS = Object.keys(defaultDecisionSettings());
const LEGACY_TOOL_KEYS = ["threshold", "failMode", "maxDescriptionChars"];
function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new SettingsError(`${path} must be an integer in [${min}, ${max}]`);
  return value;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new SettingsError(`${path} must be a boolean`);
  return value;
}
function enumValue(value: unknown, values: readonly string[], path: string): string {
  if (typeof value !== "string" || !values.includes(value)) throw new SettingsError(`Invalid ${path}`);
  return value;
}
/** Validate even shadowed legacy fields: explicit shared values never hide a corrupt configuration. */
function sharedValues(input: Record<string, unknown>, group: string, allowed = SHARED_KEYS): Partial<DecisionSettings> {
  const result: Partial<DecisionSettings> = {};
  for (const key of allowed) {
    const value = input[key];
    if (value === undefined) continue;
    const path = `${group}.${key}`;
    if (key === "threshold") {
      if (!validThreshold(value)) throw new SettingsError(`${path} must be finite in [0, 1]`);
      result.threshold = value;
    } else if (key === "failMode") result.failMode = enumValue(value, ["open", "closed"], path) as DecisionSettings["failMode"];
    else {
      const [min, max] = DECISION_BOUNDS[key as keyof typeof DECISION_BOUNDS];
      Object.assign(result, { [key]: integer(value, path, min, max) });
    }
  }
  return result;
}
export function parseSettings(value: unknown, warnings?: string[]): ContextDecisionsSettings {
  rejectSecrets(value);
  if (!object(value)) throw new SettingsError("Settings must be a JSON object");
  keys(value, ["enabled", "backend", "globalAllowlist", "decision", "relevance", "tools"], warnings);
  const result = defaultSettings();
  if (value.backend !== undefined) result.backend = validateBackendSelection(value.backend);
  if (value.globalAllowlist !== undefined) {
    if (!Array.isArray(value.globalAllowlist)) throw new SettingsError("Global allowlist must be an array of skill names");
    try { result.globalAllowlist = normalizeAllowlist(value.globalAllowlist); }
    catch { throw new SettingsError("Global allowlist names must be bounded, nonempty identifiers"); }
  }
  const block = (name: string): Record<string, unknown> => {
    if (value[name] === undefined) return {};
    if (!object(value[name])) throw new SettingsError(`${name} must be an object`);
    return value[name];
  };
  const skill = block("relevance"), tool = block("tools"), decision = block("decision");
  keys(skill, [...Object.keys(result.relevance), ...SHARED_KEYS, ...LEGACY_RELEVANCE_KEYS], warnings);
  keys(tool, [...Object.keys(result.tools), ...LEGACY_TOOL_KEYS], warnings);
  keys(decision, SHARED_KEYS, warnings);
  if (skill.enabled !== undefined) result.relevance.enabled = boolean(skill.enabled, "relevance.enabled");
  if (tool.enabled !== undefined) result.tools.enabled = boolean(tool.enabled, "tools.enabled");
  if (skill.cadence !== undefined) result.relevance.cadence = enumValue(skill.cadence, PICKER_CADENCES, "relevance.cadence") as PickerCadence;
  if (tool.cadence !== undefined) result.tools.cadence = enumValue(tool.cadence, TOOL_CADENCES, "tools.cadence") as ToolCadence;
  if (tool.mode !== undefined) result.tools.mode = enumValue(tool.mode, TOOL_FILTER_MODES, "tools.mode") as ToolFilterMode;
  for (const [input, output, group, cap] of [[skill, result.relevance, "relevance", "maxSkills"], [tool, result.tools, "tools", "maxAdded"]] as const) {
    for (const key of [cap, "minCandidates"]) if (input[key] !== undefined) Object.assign(output, { [key]: integer(input[key], `${group}.${key}`, 0, 1000) });
  }
  if (skill.pinned !== undefined) {
    if (!Array.isArray(skill.pinned) || skill.pinned.length > 1000 || skill.pinned.some((name) => !identifier(name) || name.length > 64)) throw new SettingsError("Pinned skill names must be nonempty, bounded identifiers");
    result.relevance.pinned = [...new Set(skill.pinned as string[])];
  }
  for (const key of ["alwaysAllowedTools", "alwaysAllowedMcpServers"] as const) {
    if (tool[key] === undefined) continue;
    if (!Array.isArray(tool[key])) throw new SettingsError(`tools.${key} must be an array of names`);
    try { result.tools[key] = (key === "alwaysAllowedTools" ? normalizeToolAllowlist : normalizeServerAllowlist)(tool[key]); }
    catch { throw new SettingsError(key === "alwaysAllowedTools" ? "Tool allowlist names must be 1-128 characters without whitespace or control characters (at most 1000)"
      : "MCP server / extension allowlist names must match [A-Za-z0-9_-]{1,64}, optionally after the mcp__ or ext__ prefix (at most 1000)"); }
  }
  const migrationWarnings: string[] = [];
  const rawThreshold = migrateLegacyThreshold(skill, migrationWarnings);
  const skills = sharedValues(skill, "relevance"), tools = sharedValues(tool, "tools", LEGACY_TOOL_KEYS), shared = sharedValues(decision, "decision");
  if (skills.threshold === undefined && rawThreshold !== undefined) skills.threshold = rawThreshold;
  // Conflicting old values cannot both survive unification. Prefer the stricter legacy policy;
  // a new explicit decision.* value is deliberate and always wins, including fail-open.
  Object.assign(result.decision, skills, tools);
  if (skills.threshold !== undefined && tools.threshold !== undefined) result.decision.threshold = Math.max(skills.threshold, tools.threshold);
  if (skills.maxDescriptionChars !== undefined && tools.maxDescriptionChars !== undefined) result.decision.maxDescriptionChars = Math.min(skills.maxDescriptionChars, tools.maxDescriptionChars);
  if (skills.failMode !== undefined && tools.failMode !== undefined) result.decision.failMode = skills.failMode === "closed" || tools.failMode === "closed" ? "closed" : "open";
  Object.assign(result.decision, shared);
  if (value.enabled !== undefined) {
    const enabled = boolean(value.enabled, "enabled");
    result.relevance.enabled &&= enabled;
    result.tools.enabled &&= enabled;
  }
  const migrated = value.enabled !== undefined || SHARED_KEYS.some((key) => skill[key] !== undefined) || LEGACY_TOOL_KEYS.some((key) => tool[key] !== undefined) || rawThreshold !== undefined;
  if (migrated) warnings?.push(`Legacy settings migrated to shared decision.* tuning and independent feature switches; explicit decision.* wins, conflicting legacy policies use the stricter value.${migrationWarnings.length ? ` ${migrationWarnings.join(". ")}` : ""}`);
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
  if (key === "enabled") throw new SettingsError("Removed master switch; use relevance.enabled or tools.enabled");
  if (key.startsWith("decision.")) { target = next.decision as unknown as Record<string, unknown>; field = key.slice(9); }
  else if (key.startsWith("relevance.")) { target = next.relevance as unknown as Record<string, unknown>; field = key.slice(10); }
  else if (key.startsWith("tools.")) { target = next.tools as unknown as Record<string, unknown>; field = key.slice(6); }
  else throw new SettingsError("Use a decision, relevance or tools setting; choose a backend in the /decisions dialog");
  if (target === (next.relevance as unknown) && (LEGACY_RELEVANCE_KEYS as readonly string[]).includes(field)) {
    throw new SettingsError("Removed setting: skill picking is score-only. Use decision.threshold <0–1>");
  }
  if ((key.startsWith("relevance.") && SHARED_KEYS.includes(field)) || (key.startsWith("tools.") && LEGACY_TOOL_KEYS.includes(field))) throw new SettingsError(`Removed per-feature tuning; use decision.${field}`);
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
