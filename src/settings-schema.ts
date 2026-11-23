import {
  defineSettings,
  field,
  type DynamicPickerOption,
  type ExternalSubrouteParams,
  type ExternalSummaryContext,
  type ExternalSummaryResult,
  type ModelPickerEntry,
  type ModelSelection,
  type PickerLoadContext,
  type SettingsScope,
  type ViewContentContext,
} from "pi-extension-settings-tui/schema";
import type { BackendSelection } from "./core/backends/factory.ts";
import { GEMINI_DECISION_MODEL } from "./core/codecs/gemini.ts";
import { isAllowedOpenRouterModel } from "./catalog/openrouter-models.ts";
import { normalizeAllowlist, normalizeServerAllowlist, normalizeToolAllowlist } from "./apps/allowlist.ts";
import { DEFAULT_RELEVANCE_THRESHOLD, validThreshold } from "./apps/skill-filter.ts";
import { SettingsError } from "./settings-error.ts";

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
  /** Experimental: score the entire invocable inventory, including advertised skills. */
  constantMatrix: boolean;
  enabled: boolean;
  /** Cap on newly advertised skills, not tools or entire tool groups. */
  maxSkills: number;
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
  /** Opt-in pin for the manager’s observable child bridge; never creates inherited tools. */
  allowSubagentInheritedTools: boolean;
  /** Global-source tools only (public user/temporary/missing scope); project-source pins live in the project file. */
  alwaysAllowedTools: string[];
  /** Global-source MCP names/namespace keys and canonical extension keys; retains its original setting name. */
  alwaysAllowedMcpServers: string[];
}
/** Footer glyphs: Unicode needs no patched font; Nerd Font is explicitly opt-in. */
export type IconStyle = "unicode" | "emoji" | "nerd";
export const ICON_STYLES: readonly IconStyle[] = ["unicode", "emoji", "nerd"];
export const ICON_STYLE_LABELS: Readonly<Record<IconStyle, string>> = {
  unicode: "ASCII / Unicode",
  emoji: "Emoji",
  nerd: "Nerd Font",
};
const HISTORY_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type HistoryThinkingLevel = (typeof HISTORY_THINKING_LEVELS)[number];
export interface HistorySettings { enabled: boolean; model: string; thinkingLevel: HistoryThinkingLevel }
export interface ContextDecisionsSettings {
  iconStyle: IconStyle;
  backend: BackendSelection | null;
  globalAllowlist: string[];
  decision: DecisionSettings;
  relevance: RelevanceSettings;
  tools: ToolFilterSettings;
  history: HistorySettings;
}

/** Persisted v5 flat settings shape stored in `pi-context-decisions/settings.json`. Allowlists live separately in `allowlists.json`. */
export type FlatContextDecisionsSettings = {
  skillFilteringEnabled: boolean;
  skillMaxAdded: number;
  skillMinCandidates: number;
  pinnedSkills: string[];
  toolFilteringEnabled: boolean;
  toolMode: ToolFilterMode;
  toolCadence: ToolCadence;
  toolMaxAdded: number;
  toolMinCandidates: number;
  allowSubagentInheritedTools: boolean;
  backend: BackendSelection | null;
  decisionThreshold: number;
  decisionFailMode: "closed" | "open";
  decisionChunkSize: number;
  decisionConcurrency: number;
  decisionTimeoutMs: number;
  decisionMaxPromptChars: number;
  decisionMaxDescriptionChars: number;
  iconStyle: IconStyle;
  constantMatrix: boolean;
  historyModel: ModelSelection | null;
  historyEnabled: boolean;
};

export type AllowlistScopeKind = "global" | "project";
export type AllowlistCategory = "skills" | "tools" | "mcp";

export interface SettingsUiHooks {
  loadBackendOptions?: (
    ctx: PickerLoadContext<FlatContextDecisionsSettings>,
  ) => readonly DynamicPickerOption<BackendSelection | null>[] | Promise<readonly DynamicPickerOption<BackendSelection | null>[]>;
  validateBackendSelection?: (
    option: DynamicPickerOption<BackendSelection | null>,
    ctx: PickerLoadContext<FlatContextDecisionsSettings>,
  ) => boolean | string | Promise<boolean | string>;
  isSubagentManagerPresent?: () => boolean;
  getAvailableHousekeepingModels?: (context?: unknown) => readonly ModelPickerEntry[];
  isHousekeepingModelUsable?: (selection: ModelSelection) => boolean;
  renderStatusMarkdown?: (ctx: ViewContentContext<FlatContextDecisionsSettings>) => string | Promise<string>;
  externalAllowlistSummary?: (
    scope: AllowlistScopeKind,
    kind: AllowlistCategory,
    ctx: ExternalSummaryContext<FlatContextDecisionsSettings>,
  ) => ExternalSummaryResult | Promise<ExternalSummaryResult>;
  openAllowlistSubroute?: (
    scope: AllowlistScopeKind,
    kind: AllowlistCategory,
    params: ExternalSubrouteParams<FlatContextDecisionsSettings>,
  ) => unknown | Promise<unknown>;
  rpcAllowlistRun?: (
    scope: AllowlistScopeKind,
    kind: AllowlistCategory,
    ctx: unknown,
    draft: Readonly<FlatContextDecisionsSettings>,
    settingsScope: SettingsScope,
  ) => Promise<void>;
}

const SUBAGENT_INHERITED_TOOLS_HELP =
  "pi-subagent-manager integration (diagnostics routed to the parent) requires pi-subagent-manager >= 1.1.0 with diagnostics protocol 1. Without this capability, subagent diagnostics fall back to stderr. Requires enabled pi-subagent-manager with subagentExtensions: true ([lab] Enable subagent extensions), and pi-context-decisions installed as a configured package (not only -e). Allows already-bridged parent tools; does not create bridges or bypass the manager's policy.";

function defaultDecisionSettings(): DecisionSettings {
  return {
    threshold: DEFAULT_RELEVANCE_THRESHOLD,
    failMode: "closed",
    timeoutMs: 8000,
    maxPromptChars: 4000,
    maxDescriptionChars: 400,
    chunkSize: 50,
    concurrency: 0,
  };
}
export function defaultToolSettings(): ToolFilterSettings {
  return {
    enabled: false,
    mode: "tools",
    cadence: "prompt",
    maxAdded: 8,
    minCandidates: 0,
    allowSubagentInheritedTools: false,
    alwaysAllowedTools: [],
    alwaysAllowedMcpServers: [],
  };
}
export function defaultSettings(): ContextDecisionsSettings {
  return {
    iconStyle: "unicode",
    backend: null,
    globalAllowlist: [],
    decision: defaultDecisionSettings(),
    tools: defaultToolSettings(),
    history: { enabled: false, model: "", thinkingLevel: "off" },
    relevance: { enabled: true, constantMatrix: false, maxSkills: 12, minCandidates: 8, pinned: [] },
  };
}

function formatBackendSelection(selection: BackendSelection | null): string {
  if (!selection) return "Not configured";
  if (selection.backend === "pi") return `Pi ${selection.provider}/${selection.id}`;
  return `${selection.backend} direct ${selection.model ?? (selection.backend === "typesafe" ? "jev-latest" : selection.backend === "gemini" ? GEMINI_DECISION_MODEL : "gpt-6-luna")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\p{Cc}]/u.test(value);
}
function checkKeys(value: Record<string, unknown>, allowed: readonly string[], warnings?: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  if (!warnings) throw new SettingsError("Unknown settings fields are not allowed");
  warnings.push("Unknown settings fields were ignored");
}
export function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new SettingsError("Settings nesting exceeds the allowed bound");
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/api.?key|token|secret|password|authorization|credential/iu.test(key)) {
      throw new SettingsError("Credentials must not be stored in context-decisions settings");
    }
    rejectSecrets(entry, depth + 1);
  }
}

/** Validates both direct and Pi OpenRouter selections against the checked-in list. */
export function validateBackendSelection(value: unknown): BackendSelection | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new SettingsError("Invalid decision backend selection");
  if (value.backend === "pi") {
    checkKeys(value, ["backend", "provider", "id"]);
    if (!identifier(value.provider) || !identifier(value.id)) throw new SettingsError("Pi selection requires provider and classifier ID");
    if (value.provider === "openrouter" && !isAllowedOpenRouterModel(value.id)) {
      throw new SettingsError("OpenRouter model is outside the checked-in catalog; select a listed model");
    }
    return { backend: "pi", provider: value.provider, id: value.id };
  }
  if (value.backend === "openrouter") {
    checkKeys(value, ["backend", "model"]);
    if (!identifier(value.model) || !isAllowedOpenRouterModel(value.model)) {
      throw new SettingsError("OpenRouter model is outside the checked-in catalog; select a listed model");
    }
    return { backend: "openrouter", model: value.model };
  }
  if (value.backend === "gemini") {
    checkKeys(value, ["backend", "model"]);
    if (value.model !== undefined && value.model !== GEMINI_DECISION_MODEL) throw new SettingsError("Select a supported Gemini decision model");
    return { backend: "gemini", model: GEMINI_DECISION_MODEL };
  }
  if (value.backend === "typesafe" || value.backend === "openai") {
    checkKeys(value, ["backend", "model"]);
    const model = value.model ?? (value.backend === "typesafe" ? "jev-latest" : "gpt-6-luna");
    if (!identifier(model) || !(value.backend === "typesafe" ? ["jev-latest", "jev-1.13.0"] : ["gpt-6-luna"]).includes(model)) {
      throw new SettingsError("Select a supported direct decision model");
    }
    return { backend: value.backend, model };
  }
  throw new SettingsError("Unknown decision backend");
}

function validatePinnedSkills(raw: unknown): true | string {
  if (!Array.isArray(raw) || raw.length > 1000 || raw.some((name) => !identifier(name) || name.length > 64)) {
    return "Pinned skill names must be nonempty, bounded identifiers";
  }
  return true;
}

export function isValidHistoryModelString(value: unknown): value is string {
  return typeof value === "string" && /^[^\s/\p{Cc}\p{Cf}]+\/[^\s\p{Cc}\p{Cf}]+$/u.test(value) && value.length <= 512;
}

/** Pre-0.3 keys. Read on load only; the next save writes flat `decisionThreshold` instead. */
export const LEGACY_RELEVANCE_KEYS = ["mode", "minLabel", "relatedThreshold", "directThreshold"] as const;
const DECISION_BOUNDS = {
  timeoutMs: [1, 300000],
  maxPromptChars: [1, 4000],
  maxDescriptionChars: [1, 400],
  chunkSize: [1, 50],
  concurrency: [0, 32],
} as const;
export const SHARED_KEYS = Object.keys(defaultDecisionSettings());
export const LEGACY_TOOL_KEYS = ["threshold", "failMode", "maxDescriptionChars"] as const;
const LEGACY_TOP_KEYS = ["enabled", "globalAllowlist", "decision", "relevance", "tools", "history"] as const;

export function hasLegacyShape(raw: Record<string, unknown>): boolean {
  return LEGACY_TOP_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SettingsError(`${path} must be an integer in [${min}, ${max}]`);
  }
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

/**
 * Validates the legacy keys with their ORIGINAL rules (an invalid file stays a visible settings error and
 * fails closed), then maps them losslessly: threshold = (direct or related raw 0–2 threshold) / 2.
 */
function migrateLegacyThreshold(input: Record<string, unknown>, warnings?: string[]): number | undefined {
  if (!LEGACY_RELEVANCE_KEYS.some((key) => input[key] !== undefined)) return undefined;
  if (input.mode !== undefined && input.mode !== "score" && input.mode !== "choice") throw new SettingsError("Invalid relevance.mode");
  if (input.minLabel !== undefined && input.minLabel !== "related" && input.minLabel !== "directly_relevant") {
    throw new SettingsError("Invalid relevance.minLabel");
  }
  const raw = { relatedThreshold: 0.75, directThreshold: 1.5 };
  for (const key of ["relatedThreshold", "directThreshold"] as const) {
    const num = input[key];
    if (num === undefined) continue;
    if (typeof num !== "number" || !Number.isFinite(num) || num < 0 || num > 2) {
      throw new SettingsError(`relevance.${key} must be finite in [0, 2]`);
    }
    raw[key] = num;
  }
  if (raw.relatedThreshold > raw.directThreshold) {
    throw new SettingsError("Relevance thresholds must be ordered: relatedThreshold <= directThreshold");
  }
  if (input.threshold !== undefined) warnings?.push("Legacy relevance settings were ignored because relevance.threshold is set");
  else if (input.mode === "choice") warnings?.push("Choice scoring was removed; skill picking now uses relevance scores with the migrated threshold");
  return (input.minLabel === "directly_relevant" ? raw.directThreshold : raw.relatedThreshold) / 2;
}

/** Validate even shadowed legacy fields: explicit shared values never hide a corrupt configuration. */
function sharedValues(input: Record<string, unknown>, group: string, allowed: readonly string[] = SHARED_KEYS): Partial<DecisionSettings> {
  const result: Partial<DecisionSettings> = {};
  for (const key of allowed) {
    const value = input[key];
    if (value === undefined) continue;
    const path = `${group}.${key}`;
    if (key === "threshold") {
      if (!validThreshold(value)) throw new SettingsError(`${path} must be finite in [0, 1]`);
      result.threshold = value;
    } else if (key === "failMode") {
      result.failMode = enumValue(value, ["open", "closed"], path) as DecisionSettings["failMode"];
    } else {
      const [min, max] = DECISION_BOUNDS[key as keyof typeof DECISION_BOUNDS];
      Object.assign(result, { [key]: integer(value, path, min, max) });
    }
  }
  return result;
}

export interface ExtractedLegacyAllowlists {
  skills: string[];
  tools: string[];
  mcpServers: string[];
  found: boolean;
}

/**
 * Extracts and validates any legacy v4 global allowlists (`globalAllowlist`, `tools.alwaysAllowedTools`,
 * `tools.alwaysAllowedMcpServers`) so callers can persist them to `allowlists.json` BEFORE `settings.json`
 * is rewritten into v5 flat form.
 */
export function extractLegacyGlobalAllowlists(raw: Record<string, unknown>): ExtractedLegacyAllowlists {
  let skills: string[] = [];
  let tools: string[] = [];
  let mcpServers: string[] = [];

  if (raw.globalAllowlist !== undefined) {
    if (!Array.isArray(raw.globalAllowlist)) throw new SettingsError("Global allowlist must be an array of skill names");
    try { skills = normalizeAllowlist(raw.globalAllowlist); }
    catch { throw new SettingsError("Global allowlist names must be bounded, nonempty identifiers"); }
  }
  if (raw.tools !== undefined) {
    if (!isPlainObject(raw.tools)) throw new SettingsError("tools must be an object");
    if (raw.tools.alwaysAllowedTools !== undefined) {
      if (!Array.isArray(raw.tools.alwaysAllowedTools)) throw new SettingsError("tools.alwaysAllowedTools must be an array of names");
      try { tools = normalizeToolAllowlist(raw.tools.alwaysAllowedTools); }
      catch { throw new SettingsError("Tool allowlist names must be 1-128 characters without whitespace or control characters (at most 1000)"); }
    }
    if (raw.tools.alwaysAllowedMcpServers !== undefined) {
      if (!Array.isArray(raw.tools.alwaysAllowedMcpServers)) throw new SettingsError("tools.alwaysAllowedMcpServers must be an array of names");
      try { mcpServers = normalizeServerAllowlist(raw.tools.alwaysAllowedMcpServers); }
      catch { throw new SettingsError("MCP server / extension allowlist names must match [A-Za-z0-9_-]{1,64}, optionally after the mcp__ or ext__ prefix (at most 1000)"); }
    }
  }
  return { skills, tools, mcpServers, found: skills.length > 0 || tools.length > 0 || mcpServers.length > 0 };
}

/**
 * Strictly parses a legacy v4 (or structured `ContextDecisionsSettings`) object, validating all nested blocks
 * including shadowed pre-0.3 keys and legacy allowlists. Throws `SettingsError` on any invalid value.
 */
export function parseLegacySettingsObject(
  value: Record<string, unknown>,
  warnings?: string[],
  options?: { allowExtraTopLevel?: boolean },
): ContextDecisionsSettings {
  rejectSecrets(value);
  if (!options?.allowExtraTopLevel) {
    checkKeys(value, ["enabled", "iconStyle", "backend", "globalAllowlist", "decision", "relevance", "tools", "history"], warnings);
  }
  const result = defaultSettings();
  if (value.iconStyle !== undefined) {
    if (typeof value.iconStyle !== "string" || !(ICON_STYLES as readonly string[]).includes(value.iconStyle)) {
      throw new SettingsError("Invalid iconStyle");
    }
    result.iconStyle = value.iconStyle as IconStyle;
  }
  if (value.backend !== undefined) result.backend = validateBackendSelection(value.backend);
  if (value.globalAllowlist !== undefined) {
    if (!Array.isArray(value.globalAllowlist)) throw new SettingsError("Global allowlist must be an array of skill names");
    try { result.globalAllowlist = normalizeAllowlist(value.globalAllowlist); }
    catch { throw new SettingsError("Global allowlist names must be bounded, nonempty identifiers"); }
  }
  const block = (name: string): Record<string, unknown> => {
    if (value[name] === undefined) return {};
    if (!isPlainObject(value[name])) throw new SettingsError(`${name} must be an object`);
    return value[name];
  };
  const skill = block("relevance");
  const tool = block("tools");
  const decision = block("decision");
  const history = block("history");

  checkKeys(skill, [...Object.keys(result.relevance), ...SHARED_KEYS, ...LEGACY_RELEVANCE_KEYS, "cadence"], warnings);
  checkKeys(tool, [...Object.keys(result.tools), ...LEGACY_TOOL_KEYS], warnings);
  checkKeys(decision, SHARED_KEYS, warnings);
  checkKeys(history, ["enabled", "model", "thinkingLevel"], warnings);

  if (history.enabled !== undefined) result.history.enabled = boolean(history.enabled, "history.enabled");
  if (history.model !== undefined) {
    if (typeof history.model !== "string" || (history.model !== "" && !isValidHistoryModelString(history.model))) {
      throw new SettingsError("Invalid history.model");
    }
    result.history.model = history.model;
  }
  if (history.thinkingLevel !== undefined) {
    result.history.thinkingLevel = enumValue(history.thinkingLevel, HISTORY_THINKING_LEVELS, "history.thinkingLevel") as HistoryThinkingLevel;
  }
  if (skill.enabled !== undefined) result.relevance.enabled = boolean(skill.enabled, "relevance.enabled");
  if (skill.constantMatrix !== undefined) result.relevance.constantMatrix = boolean(skill.constantMatrix, "relevance.constantMatrix");
  if (tool.allowSubagentInheritedTools !== undefined) {
    result.tools.allowSubagentInheritedTools = boolean(tool.allowSubagentInheritedTools, "tools.allowSubagentInheritedTools");
  }
  if (tool.enabled !== undefined) result.tools.enabled = boolean(tool.enabled, "tools.enabled");
  // Accept and validate the retired skill cadence, but never persist it in the normalized settings.
  if (skill.cadence !== undefined) enumValue(skill.cadence, ["prompt", "tool-round"], "relevance.cadence");
  if (tool.cadence !== undefined) result.tools.cadence = enumValue(tool.cadence, TOOL_CADENCES, "tools.cadence") as ToolCadence;
  if (tool.mode !== undefined) result.tools.mode = enumValue(tool.mode, TOOL_FILTER_MODES, "tools.mode") as ToolFilterMode;
  for (const [input, output, group, cap] of [
    [skill, result.relevance, "relevance", "maxSkills"],
    [tool, result.tools, "tools", "maxAdded"],
  ] as const) {
    for (const key of [cap, "minCandidates"]) {
      if (input[key] !== undefined) Object.assign(output, { [key]: integer(input[key], `${group}.${key}`, 0, 1000) });
    }
  }
  if (skill.pinned !== undefined) {
    const valid = validatePinnedSkills(skill.pinned);
    if (valid !== true) throw new SettingsError(valid);
    result.relevance.pinned = [...new Set(skill.pinned as string[])];
  }
  for (const key of ["alwaysAllowedTools", "alwaysAllowedMcpServers"] as const) {
    if (tool[key] === undefined) continue;
    if (!Array.isArray(tool[key])) throw new SettingsError(`tools.${key} must be an array of names`);
    try {
      result.tools[key] = (key === "alwaysAllowedTools" ? normalizeToolAllowlist : normalizeServerAllowlist)(tool[key]);
    } catch {
      throw new SettingsError(
        key === "alwaysAllowedTools"
          ? "Tool allowlist names must be 1-128 characters without whitespace or control characters (at most 1000)"
          : "MCP server / extension allowlist names must match [A-Za-z0-9_-]{1,64}, optionally after the mcp__ or ext__ prefix (at most 1000)",
      );
    }
  }

  const migrationWarnings: string[] = [];
  const rawThreshold = migrateLegacyThreshold(skill, migrationWarnings);
  const skills = sharedValues(skill, "relevance");
  const tools = sharedValues(tool, "tools", LEGACY_TOOL_KEYS);
  const shared = sharedValues(decision, "decision");
  if (skills.threshold === undefined && rawThreshold !== undefined) skills.threshold = rawThreshold;
  // Conflicting old values cannot both survive unification. Prefer the stricter legacy policy;
  // a new explicit decision.* value is deliberate and always wins, including fail-open.
  Object.assign(result.decision, skills, tools);
  if (skills.threshold !== undefined && tools.threshold !== undefined) {
    result.decision.threshold = Math.max(skills.threshold, tools.threshold);
  }
  if (skills.maxDescriptionChars !== undefined && tools.maxDescriptionChars !== undefined) {
    result.decision.maxDescriptionChars = Math.min(skills.maxDescriptionChars, tools.maxDescriptionChars);
  }
  if (skills.failMode !== undefined && tools.failMode !== undefined) {
    result.decision.failMode = skills.failMode === "closed" || tools.failMode === "closed" ? "closed" : "open";
  }
  Object.assign(result.decision, shared);
  if (value.enabled !== undefined) {
    const enabled = boolean(value.enabled, "enabled");
    result.relevance.enabled &&= enabled;
    result.tools.enabled &&= enabled;
  }
  const migrated =
    value.enabled !== undefined ||
    SHARED_KEYS.some((key) => skill[key] !== undefined) ||
    LEGACY_TOOL_KEYS.some((key) => tool[key] !== undefined) ||
    rawThreshold !== undefined;
  if (migrated) {
    warnings?.push(
      `Legacy settings migrated to shared decision.* tuning and independent feature switches; explicit decision.* wins, conflicting legacy policies use the stricter value.${migrationWarnings.length ? ` ${migrationWarnings.join(". ")}` : ""}`,
    );
  }
  return result;
}

/**
 * Inline migration from v4 / pre-0.3 nested settings to v5 flat settings.
 * - Idempotent: when `raw` has no legacy nested/top-level blocks, returns `raw` unchanged so `migratedScopes` is `[]`.
 * - Strictly validates all legacy values (including shadowed pre-0.3 keys) and throws `SettingsError` on corrupt inputs.
 * - Drops `globalAllowlist`, `tools.alwaysAllowedTools`, and `tools.alwaysAllowedMcpServers` from the flat object
 *   (call `extractLegacyGlobalAllowlists` before persisting migration).
 */
export function migrateLegacySettings(raw: Record<string, unknown>, warnings?: string[]): Record<string, unknown> {
  if (!hasLegacyShape(raw)) return raw;
  const legacyWarnings = warnings ?? [];
  const parsed = parseLegacySettingsObject(raw, legacyWarnings, { allowExtraTopLevel: true });
  const flatFromLegacy = contextSettingsToFlat(parsed);

  // Preserve any explicit flat keys or unknown top-level keys (unknown keys will be warned & dropped by validatePartial).
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if ((LEGACY_TOP_KEYS as readonly string[]).includes(key)) continue;
    out[key] = val;
  }

  // Only set migrated keys that aren't already explicitly provided in flat form; always use normalized backend/iconStyle if present.
  const defaults = contextSettingsToFlat(defaultSettings());
  for (const [key, val] of Object.entries(flatFromLegacy)) {
    if (key === "backend" && raw.backend !== undefined) {
      out.backend = val;
      continue;
    }
    if (key === "iconStyle" && raw.iconStyle !== undefined) {
      out.iconStyle = val;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(out, key) && out[key] !== undefined) continue;
    // Write every non-default migrated value (and explicit legacy values) into the flat object so diffForScope/validatePartial sees them.
    if (JSON.stringify(val) !== JSON.stringify(defaults[key as keyof FlatContextDecisionsSettings])) {
      out[key] = val;
    }
  }
  return out;
}

export function flatToContextSettings(
  flat: FlatContextDecisionsSettings,
  globalAllowlists?: { names?: string[]; tools?: string[]; mcpServers?: string[] },
): ContextDecisionsSettings {
  return {
    iconStyle: flat.iconStyle,
    backend: flat.backend ? structuredClone(flat.backend) : null,
    globalAllowlist: [...(globalAllowlists?.names ?? [])],
    decision: {
      threshold: flat.decisionThreshold,
      failMode: flat.decisionFailMode,
      timeoutMs: flat.decisionTimeoutMs,
      maxPromptChars: flat.decisionMaxPromptChars,
      maxDescriptionChars: flat.decisionMaxDescriptionChars,
      chunkSize: flat.decisionChunkSize,
      concurrency: flat.decisionConcurrency,
    },
    relevance: {
      enabled: flat.skillFilteringEnabled,
      constantMatrix: flat.constantMatrix,
      maxSkills: flat.skillMaxAdded,
      minCandidates: flat.skillMinCandidates,
      pinned: [...flat.pinnedSkills],
    },
    tools: {
      enabled: flat.toolFilteringEnabled,
      mode: flat.toolMode,
      cadence: flat.toolCadence,
      maxAdded: flat.toolMaxAdded,
      minCandidates: flat.toolMinCandidates,
      allowSubagentInheritedTools: flat.allowSubagentInheritedTools,
      alwaysAllowedTools: [...(globalAllowlists?.tools ?? [])],
      alwaysAllowedMcpServers: [...(globalAllowlists?.mcpServers ?? [])],
    },
    history: flat.historyModel
      ? {
          enabled: flat.historyEnabled,
          model: flat.historyModel.model,
          thinkingLevel: flat.historyModel.thinkingLevel,
        }
      : {
          enabled: flat.historyEnabled,
          model: "",
          thinkingLevel: "off",
        },
  };
}

export function contextSettingsToFlat(settings: ContextDecisionsSettings): FlatContextDecisionsSettings {
  return {
    skillFilteringEnabled: settings.relevance.enabled,
    skillMaxAdded: settings.relevance.maxSkills,
    skillMinCandidates: settings.relevance.minCandidates,
    pinnedSkills: [...settings.relevance.pinned],
    toolFilteringEnabled: settings.tools.enabled,
    toolMode: settings.tools.mode,
    toolCadence: settings.tools.cadence,
    toolMaxAdded: settings.tools.maxAdded,
    toolMinCandidates: settings.tools.minCandidates,
    allowSubagentInheritedTools: settings.tools.allowSubagentInheritedTools,
    backend: settings.backend ? structuredClone(settings.backend) : null,
    decisionThreshold: settings.decision.threshold,
    decisionFailMode: settings.decision.failMode,
    decisionChunkSize: settings.decision.chunkSize,
    decisionConcurrency: settings.decision.concurrency,
    decisionTimeoutMs: settings.decision.timeoutMs,
    decisionMaxPromptChars: settings.decision.maxPromptChars,
    decisionMaxDescriptionChars: settings.decision.maxDescriptionChars,
    iconStyle: settings.iconStyle,
    constantMatrix: settings.relevance.constantMatrix,
    historyModel: settings.history.model
      ? { model: settings.history.model, thinkingLevel: settings.history.thinkingLevel }
      : null,
    historyEnabled: settings.history.enabled,
  };
}

function makeAllowlistField(
  tab: "skills" | "tools",
  scope: AllowlistScopeKind,
  kind: AllowlistCategory,
  label: string,
  description: string,
  uiHooks?: SettingsUiHooks,
) {
  return field.external<FlatContextDecisionsSettings>({
    tab,
    label,
    description,
    summary: uiHooks?.externalAllowlistSummary
      ? (ctx) => uiHooks.externalAllowlistSummary!(scope, kind, ctx)
      : "Edit…",
    openSubroute: (params) => {
      if (uiHooks?.openAllowlistSubroute) {
        return uiHooks.openAllowlistSubroute(scope, kind, params);
      }
      params.close({ saved: false, message: "Allowlist editor is unavailable in this host.", tone: "warn" });
      return undefined;
    },
    ...(uiHooks?.rpcAllowlistRun
      ? {
          rpcRun: (ctx: unknown, draft: Readonly<FlatContextDecisionsSettings>, settingsScope: SettingsScope) =>
            uiHooks.rpcAllowlistRun!(scope, kind, ctx, draft, settingsScope),
        }
      : {}),
  });
}

export function createContextDecisionsSettingsSchema(uiHooks?: SettingsUiHooks) {
  return defineSettings({
    id: "pi-context-decisions",
    title: "Context Decisions Settings",
    description: "Skill advertisement filtering, opt-in tool/MCP filtering, shared decision tuning, and lab features.",
    version: 5,
    settingsFile: "pi-context-decisions/settings.json",
    scopes: ["global"],
    defaultScope: "global",
    saveMode: "immediate",
    tabs: [
      { id: "skills", label: "Skills", description: "Skill advertisement filtering, limits, and skill allowlists." },
      { id: "tools", label: "Tools", description: "Opt-in tool, MCP server, and extension filtering." },
      { id: "decision", label: "Decision", description: "Shared decision model, scoring threshold, failure policy, and limits." },
      { id: "lab", label: "Lab", description: "Experimental features." },
    ],
    migrate: (raw) => migrateLegacySettings(raw),
    normalizeDraft: (draft, changedKey) => {
      if (changedKey === "historyModel" && draft.historyModel === null) {
        return { ...draft, historyEnabled: false };
      }
      return draft;
    },
    fields: {
      // ---- Tab 1: Skills ----
      skillFilteringEnabled: field.boolean<FlatContextDecisionsSettings>({
        tab: "skills",
        label: "Skill filtering",
        description: "Turn skill advertisement filtering on or off, independently of tool and MCP filtering.",
        default: true,
      }),
      skillMaxAdded: field.integer<FlatContextDecisionsSettings>({
        tab: "skills",
        label: "Skills · Max added per round",
        description: "0–1000 new skills added by one picking round, best first across all shards. Always-allowed and already-added skills do not count.",
        min: 0,
        max: 1000,
        default: 12,
      }),
      skillMinCandidates: field.integer<FlatContextDecisionsSettings>({
        tab: "skills",
        label: "Skills · Minimum inventory",
        description: "0–1000. Below this many skills, nothing is scored and every skill stays advertised.",
        min: 0,
        max: 1000,
        default: 8,
      }),
      globalSkillAllowlist: makeAllowlistField(
        "skills",
        "global",
        "skills",
        "Global always-allowed skills",
        "Always advertise matching user-scope skills (stored in allowlists.json).",
        uiHooks,
      ),
      projectSkillAllowlist: makeAllowlistField(
        "skills",
        "project",
        "skills",
        "Project always-allowed skills",
        "Always advertise matching project-scope skills (stored in .pi/pi-context-decisions.json).",
        uiHooks,
      ),
      statusView: field.view<FlatContextDecisionsSettings>({
        tab: "skills",
        label: "Status",
        description: "Inspect current configuration, credentials, allowlist counts, and latest decision rounds.",
        value: "Inspect…",
        format: "markdown",
        refreshable: true,
        content: (ctx) => uiHooks?.renderStatusMarkdown?.(ctx) ?? "Context decisions status is unavailable.",
      }),
      pinnedSkills: field.custom<string[], FlatContextDecisionsSettings>({
        tab: "skills",
        label: "Pinned skills",
        description: "Legacy pinned skill names managed via /decisions pin and /decisions unpin.",
        default: [],
        visibleWhen: () => false,
        validate: validatePinnedSkills,
        normalize: (raw) => [...new Set(raw as string[])],
      }),

      // ---- Tab 2: Tools ----
      toolFilteringEnabled: field.boolean<FlatContextDecisionsSettings>({
        tab: "tools",
        label: "Tool filtering",
        description: "Off by default and independent of skill filtering. When on, external tools, MCP servers or extensions are made available per prompt by the decision model; Pi's built-in tools are never filtered. Calls to unavailable tools are blocked. This is not a sandbox.",
        default: false,
      }),
      toolMode: field.enum<ToolFilterMode, FlatContextDecisionsSettings>({
        tab: "tools",
        label: "Mode",
        description: "What is decided.",
        default: "tools",
        options: [
          {
            value: "tools",
            label: "tools",
            description: "Every external tool is decided on its own, whichever MCP server or extension it comes from (default).",
          },
          {
            value: "mcp",
            label: "mcp",
            description: "Groups are decided as a whole: every MCP server and every extension (all its tools together) is on or off. Extension tools without public provenance are never filtered.",
          },
        ],
      }),
      toolCadence: field.enum<ToolCadence, FlatContextDecisionsSettings>({
        tab: "tools",
        label: "Run picker",
        description: "When more tools, servers or extensions are added. They are only ever added, never removed.",
        default: "prompt",
        options: [
          {
            value: "initial",
            label: "initial",
            description: "Pick once from your first prompt; later tools are scored against that first prompt only.",
          },
          {
            value: "prompt",
            label: "prompt",
            description: "On each new user prompt, including queued steering/follow-up messages (default).",
          },
          {
            value: "tool-round",
            label: "tool-round",
            description: "Also after each completed tool round: adds the next-best candidates for the same task from cached scores.",
          },
        ],
      }),
      toolMaxAdded: field.integer<FlatContextDecisionsSettings>({
        tab: "tools",
        label: (v) => (v.toolMode === "mcp" ? "MCP/exts · Max added per round" : "Tools · Max added per round"),
        description: (v) =>
          v.toolMode === "mcp"
            ? "0–1000 new MCP servers or extensions per round, best first. Each whole group counts once; allowlisted and already-available groups do not count."
            : "0–1000 new tools (or whole servers/extensions in group mode) per round, best first. Separate from skill advertisements; allowlisted and already-available ones do not count.",
        min: 0,
        max: 1000,
        default: 8,
      }),
      toolMinCandidates: field.integer<FlatContextDecisionsSettings>({
        tab: "tools",
        label: (v) => (v.toolMode === "mcp" ? "MCP/exts · Minimum candidates" : "Tools · Minimum candidates"),
        description: (v) =>
          v.toolMode === "mcp"
            ? "0–1000 MCP servers or extensions. Gating starts at zero by default. Below this many groups, no scoring and every tool stays available."
            : "0–1000. Tool gating starts at zero by default. Below this inventory size, no scoring and every tool stays available.",
        min: 0,
        max: 1000,
        default: 0,
      }),
      allowSubagentInheritedTools: field.boolean<FlatContextDecisionsSettings>({
        tab: "tools",
        label: "Subagents · Allow inherited tools",
        description: SUBAGENT_INHERITED_TOOLS_HELP,
        default: false,
        eligible: (values) => {
          if (values.allowSubagentInheritedTools) return true;
          if (!uiHooks?.isSubagentManagerPresent || uiHooks.isSubagentManagerPresent()) return true;
          return { eligible: false, reason: SUBAGENT_INHERITED_TOOLS_HELP };
        },
      }),
      globalToolAllowlist: makeAllowlistField(
        "tools",
        "global",
        "tools",
        "Global always-allowed tools",
        "Always allow matching user-scope external tools (stored in allowlists.json).",
        uiHooks,
      ),
      projectToolAllowlist: makeAllowlistField(
        "tools",
        "project",
        "tools",
        "Project always-allowed tools",
        "Always allow matching project-scope external tools (stored in .pi/pi-context-decisions.json).",
        uiHooks,
      ),
      globalMcpAllowlist: makeAllowlistField(
        "tools",
        "global",
        "mcp",
        "Global always-allowed MCP / extensions",
        "Always allow matching user-scope MCP servers and extensions (stored in allowlists.json).",
        uiHooks,
      ),
      projectMcpAllowlist: makeAllowlistField(
        "tools",
        "project",
        "mcp",
        "Project always-allowed MCP / extensions",
        "Always allow matching project-scope MCP servers and extensions (stored in .pi/pi-context-decisions.json).",
        uiHooks,
      ),

      // ---- Tab 3: Decision ----
      backend: field.picker<BackendSelection | null, FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Decision model",
        description: "Shared decision/classifier backend and model for skill and tool/MCP filtering. Selecting a model never enables filtering.",
        default: null,
        allowClear: true,
        clearValue: null,
        emptyLabel: "Not configured",
        emptyDescription: "Disable decision calls until a model is chosen.",
        searchable: true,
        refreshable: true,
        loadOptions: (ctx) => uiHooks?.loadBackendOptions?.(ctx) ?? [],
        validate: (raw) => {
          try {
            validateBackendSelection(raw);
            return true;
          } catch (error) {
            return error instanceof Error ? error.message : "Invalid decision backend selection";
          }
        },
        normalize: (raw) => validateBackendSelection(raw),
        ...(uiHooks?.validateBackendSelection ? { validateSelection: uiHooks.validateBackendSelection } : {}),
        format: (value) => formatBackendSelection(value),
      }),
      decisionThreshold: field.number<FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Relevance threshold",
        description: "0–1, inclusive. Skills, tools and groups qualify at or above this score. 0.375 is the default; 1 keeps only perfect scores.",
        min: 0,
        max: 1,
        step: 0.05,
        default: DEFAULT_RELEVANCE_THRESHOLD,
      }),
      decisionFailMode: field.enum<"closed" | "open", FlatContextDecisionsSettings>({
        tab: "decision",
        label: "On failure",
        description: "Shared failure policy for skill and tool picking; configuration errors and aborts always fail closed.",
        display: "picker",
        allowInlineStep: false,
        default: "closed",
        options: [
          {
            value: "closed",
            label: "closed",
            description: "Add no new skills, tools or groups when scoring fails (default, recommended).",
          },
          {
            value: "open",
            label: "open",
            tone: "warn",
            description: "WARNING: every remaining skill, tool or group is added when scoring fails. Applies framework-wide.",
          },
        ],
      }),
      decisionChunkSize: field.integer<FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Shard size",
        description: "1–50 candidates per decision request; every shard of the remaining candidates is evaluated.",
        min: 1,
        max: 50,
        default: 50,
      }),
      decisionConcurrency: field.integer<FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Concurrency",
        description: "0–32. 0 sends every shard in parallel; 1–32 limits simultaneous shards.",
        min: 0,
        max: 32,
        default: 0,
        format: (v) => (v === 0 ? "0 (all shards parallel)" : String(v)),
      }),
      decisionTimeoutMs: field.integer<FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Timeout",
        description: "1–300000 milliseconds for the whole scoring pass.",
        min: 1,
        max: 300000,
        unit: "ms",
        default: 8000,
      }),
      decisionMaxPromptChars: field.integer<FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Prompt size",
        description: "1–4000 characters of the task sent to the decision model.",
        min: 1,
        max: 4000,
        unit: "chars",
        default: 4000,
      }),
      decisionMaxDescriptionChars: field.integer<FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Description size",
        description: "1–400 characters of each candidate description sent.",
        min: 1,
        max: 400,
        unit: "chars",
        default: 400,
      }),
      iconStyle: field.enum<IconStyle, FlatContextDecisionsSettings>({
        tab: "decision",
        label: "Footer icons",
        description: "Icon set in the compact status footer (extension, skills, tools). Unicode works in regular terminal fonts, Emoji needs colour emoji support, Nerd Font needs a Nerd Font as the terminal font.",
        display: "picker",
        default: "unicode",
        options: [
          {
            value: "unicode",
            label: "ASCII / Unicode  ◇ ≡ ⚙",
            description: "Plain Unicode symbols; no patched font needed (default). A few fonts may lack some glyphs.",
          },
          {
            value: "emoji",
            label: "Emoji  🎯 📚 🔧",
            description: "Colour emoji. Needs a terminal and font with emoji support; glyph width can vary between terminals.",
          },
          {
            value: "nerd",
            label: "Nerd Font  \uf0b0 \uf02d \uf0ad",
            description: "Requires a Nerd Font (nerdfonts.com) as the terminal font; without one these glyphs show as empty boxes. Pick another set if so.",
          },
        ],
        format: (v) => ICON_STYLE_LABELS[v] ?? "ASCII / Unicode",
      }),

      // ---- Tab 4: Lab ----
      constantMatrix: field.boolean<FlatContextDecisionsSettings>({
        tab: "lab",
        label: "Skills · Constant scoring matrix",
        description: "Experimental: score all invocable skills, including already advertised skills, in a stable order. Existing skills remain advertised and do not count toward the cap. More tokens; cache hits are not guaranteed.",
        experimental: true,
        default: false,
      }),
      historyModel: field.model<FlatContextDecisionsSettings>({
        tab: "lab",
        label: "Past turn summaries · Model",
        description: "Housekeeping model used to summarize earlier visible prompts and final assistant replies as state.history for decisions. Selecting a model does not enable summaries.",
        experimental: true,
        allowClear: true,
        default: null,
        defaultThinkingLevel: "off",
        emptyLabel: "Not selected",
        emptyDescription: "Clear the housekeeping model and disable past turn summaries.",
        ...(uiHooks?.getAvailableHousekeepingModels ? { models: uiHooks.getAvailableHousekeepingModels } : {}),
      }),
      historyEnabled: field.boolean<FlatContextDecisionsSettings>({
        tab: "lab",
        label: "Past turn summaries · Enabled",
        description: "Experimental: include bounded model-written summaries of earlier visible prompts and final assistant replies as state.history for decisions.",
        experimental: true,
        default: false,
        eligible: (values) => {
          if (values.historyEnabled) return true;
          if (!values.historyModel) {
            return { eligible: false, reason: "Select a housekeeping model first." };
          }
          if (uiHooks?.isHousekeepingModelUsable && !uiHooks.isHousekeepingModelUsable(values.historyModel)) {
            return { eligible: false, reason: "Selected housekeeping model is unavailable or unauthenticated." };
          }
          return true;
        },
      }),
    },
  });
}

export const contextDecisionsSettingsSchema = createContextDecisionsSettingsSchema();
export type ContextDecisionsSettingsSchema = ReturnType<typeof createContextDecisionsSettingsSchema>;
