import { lstat } from "node:fs/promises";
import {
  createSettingsStore,
  readJsonFileHardened,
  SettingsSecurityError,
  type SettingsStore,
} from "pi-extension-settings-tui/store";
import { globalAllowlistPath, loadGlobalAllowlist, saveGlobalAllowlist } from "./project-allowlist.ts";
import { SettingsError } from "./settings-error.ts";
import {
  contextDecisionsSettingsSchema,
  contextSettingsToFlat,
  createContextDecisionsSettingsSchema,
  defaultSettings,
  defaultToolSettings,
  extractLegacyGlobalAllowlists,
  flatToContextSettings,
  hasLegacyShape,
  ICON_STYLES,
  isValidHistoryModelString,
  LEGACY_RELEVANCE_KEYS,
  LEGACY_TOOL_KEYS,
  migrateLegacySettings,
  parseLegacySettingsObject,
  rejectSecrets,
  SHARED_KEYS,
  TOOL_CADENCES,
  TOOL_FILTER_MODES,
  validateBackendSelection,
  type AllowlistCategory,
  type ContextDecisionsSettings,
  type ContextDecisionsSettingsSchema,
  type DecisionSettings,
  type FlatContextDecisionsSettings,
  type IconStyle,
  type RelevanceSettings,
  type SettingsUiHooks,
  type ToolFilterMode,
  type ToolFilterSettings,
} from "./settings-schema.ts";

export {
  contextDecisionsSettingsSchema,
  contextSettingsToFlat,
  createContextDecisionsSettingsSchema,
  defaultSettings,
  defaultToolSettings,
  flatToContextSettings,
  ICON_STYLES,
  SettingsError,
  TOOL_CADENCES,
  TOOL_FILTER_MODES,
  validateBackendSelection,
};
export type {
  AllowlistCategory,
  ContextDecisionsSettings,
  ContextDecisionsSettingsSchema,
  DecisionSettings,
  FlatContextDecisionsSettings,
  IconStyle,
  RelevanceSettings,
  SettingsUiHooks,
  ToolFilterMode,
  ToolFilterSettings,
};

export type DecisionsSettingsStore = SettingsStore<ContextDecisionsSettingsSchema["fields"]>;

const MAX_BYTES = 65536;

export function createDecisionsSettingsStore(
  settingsPath: string,
  schema: ContextDecisionsSettingsSchema = contextDecisionsSettingsSchema,
): DecisionsSettingsStore {
  return createSettingsStore(schema, { globalPath: settingsPath, deleteWhenEmpty: false });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const PERSISTED_KEY_SET = new Set<string>(contextDecisionsSettingsSchema.persistedFieldKeys);

function assertStrictFlatHistoryModel(raw: Record<string, unknown>): void {
  if (raw.historyModel === undefined || raw.historyModel === null) return;
  if (!isPlainObject(raw.historyModel) || !isValidHistoryModelString(raw.historyModel.model)) {
    throw new SettingsError("Invalid historyModel");
  }
}

function parseFlatSettingsObject(value: Record<string, unknown>, warnings?: string[]): ContextDecisionsSettings {
  rejectSecrets(value);
  assertStrictFlatHistoryModel(value);
  const extra = Object.keys(value).filter((key) => !PERSISTED_KEY_SET.has(key));
  if (extra.length > 0) {
    if (!warnings) throw new SettingsError("Unknown settings fields are not allowed");
    warnings.push("Unknown settings fields were ignored");
  }
  const layer: Partial<FlatContextDecisionsSettings> = {};
  for (const key of contextDecisionsSettingsSchema.persistedFieldKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue;
    const validation = contextDecisionsSettingsSchema.validateField(key, value[key]);
    if (!validation.ok) {
      throw new SettingsError(key === "iconStyle" ? "Invalid iconStyle" : validation.error);
    }
    (layer as Record<string, unknown>)[key] = validation.value;
  }
  const effective = contextDecisionsSettingsSchema.resolveEffective({ global: layer, project: {} }, { includeProject: false });
  return flatToContextSettings(effective);
}

export function parseSettings(value: unknown, warnings?: string[]): ContextDecisionsSettings {
  rejectSecrets(value);
  if (!isPlainObject(value)) throw new SettingsError("Settings must be a JSON object");
  if (hasLegacyShape(value)) {
    return parseLegacySettingsObject(value, warnings);
  }
  return parseFlatSettingsObject(value, warnings);
}

export interface SettingsLoadResult {
  settings: ContextDecisionsSettings;
  warnings: string[];
  error?: string;
}

function mapSecurityError(error: SettingsSecurityError): SettingsError {
  switch (error.code) {
    case "SIZE_LIMIT_EXCEEDED":
      return new SettingsError("Settings file exceeds 64 KiB");
    case "SECRET_KEY_REJECTED":
      return new SettingsError("Credentials must not be stored in context-decisions settings");
    case "SYMLINK_REJECTED":
      return new SettingsError("Settings path must be a regular file, not a symlink");
    case "NOT_REGULAR_FILE":
      return new SettingsError("Settings path must be a regular file");
    default:
      return new SettingsError("Could not read valid context-decisions settings");
  }
}

async function fileExistsOnDisk(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    // Any non-ENOENT error (e.g. permission error) means treat as existing so we don't blindly overwrite.
    return true;
  }
}

export async function loadSettings(
  path: string,
  options?: { persistMigration?: boolean },
): Promise<SettingsLoadResult> {
  try {
    const rawRead = readJsonFileHardened(path, { maxBytes: MAX_BYTES, rejectSecretKeysOnRead: true });
    if (!rawRead.exists || rawRead.data === null) {
      const globalAllowlists = await loadGlobalAllowlist(path);
      const warnings = [...globalAllowlists.warnings, ...(globalAllowlists.error ? [globalAllowlists.error] : [])];
      return {
        settings: flatToContextSettings(contextDecisionsSettingsSchema.getDefaults(), globalAllowlists),
        warnings,
      };
    }

    rejectSecrets(rawRead.data);
    assertStrictFlatHistoryModel(rawRead.data);

    // Collect legacy migration warnings & validate any legacy nested blocks strictly before writing anything.
    const warnings: string[] = [];
    const legacy = hasLegacyShape(rawRead.data);
    const legacyAllowlists = legacy ? extractLegacyGlobalAllowlists(rawRead.data) : { skills: [], tools: [], mcpServers: [], found: false };
    if (legacy) {
      migrateLegacySettings(rawRead.data, warnings);
    }

    const store = createDecisionsSettingsStore(path);
    const loaded = await store.load({ persistMigration: false });

    // Strict fail-closed: any invalid known persisted field value is a settings error, never silently defaulted.
    for (const rejectedKey of loaded.rejectedKeys.global) {
      if (PERSISTED_KEY_SET.has(rejectedKey)) {
        const migratedRaw = legacy ? migrateLegacySettings(rawRead.data) : rawRead.data;
        const fieldCheck = contextDecisionsSettingsSchema.validateField(
          rejectedKey as (typeof contextDecisionsSettingsSchema.persistedFieldKeys)[number],
          migratedRaw[rejectedKey],
        );
        const detail = !fieldCheck.ok ? fieldCheck.error : `Invalid value for ${rejectedKey}`;
        throw new SettingsError(rejectedKey === "iconStyle" ? "Invalid iconStyle" : detail);
      }
    }

    const unknownKeys = loaded.rejectedKeys.global.filter((key) => !PERSISTED_KEY_SET.has(key));
    if (unknownKeys.length > 0 && !warnings.includes("Unknown settings fields were ignored")) {
      warnings.push("Unknown settings fields were ignored");
    }

    // Separate allowlist storage: load allowlists.json if it exists; otherwise migrate legacy global allowlists first!
    const allowlistsExist = await fileExistsOnDisk(globalAllowlistPath(path));
    let allowlistData: { names: string[]; tools: string[]; mcpServers: string[] };

    if (!allowlistsExist && legacyAllowlists.found) {
      allowlistData = {
        names: legacyAllowlists.skills,
        tools: legacyAllowlists.tools,
        mcpServers: legacyAllowlists.mcpServers,
      };
      if (options?.persistMigration === true) {
        // Persist allowlists.json FIRST so legacy allowlists are never lost if settings.json rewrite runs next.
        await saveGlobalAllowlist(path, {
          skills: legacyAllowlists.skills,
          tools: legacyAllowlists.tools,
          mcpServers: legacyAllowlists.mcpServers,
        });
      }
    } else {
      const globalAllowlists = await loadGlobalAllowlist(path);
      warnings.push(...globalAllowlists.warnings, ...(globalAllowlists.error ? [globalAllowlists.error] : []));
      allowlistData = globalAllowlists;
    }

    if (options?.persistMigration === true && loaded.migratedScopes.length > 0) {
      await store.load({ persistMigration: true });
    }

    return {
      settings: flatToContextSettings(loaded.effective, allowlistData),
      warnings,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { settings: defaultSettings(), warnings: [] };
    }
    const settingsError = error instanceof SettingsError
      ? error
      : error instanceof SettingsSecurityError
        ? mapSecurityError(error)
        : undefined;
    // Invalid persisted selections are visible errors, never a fallback to a different paid backend.
    return {
      settings: defaultSettings(),
      warnings: [],
      error: settingsError ? settingsError.message : "Could not read valid context-decisions settings",
    };
  }
}

/**
 * Atomic replacement of flat v5 overrides via SettingsStore (`force: true`), mode `0o600`, never persists credentials.
 * Does NOT write global allowlists into `settings.json` (save global allowlists via `saveGlobalAllowlist`).
 */
export async function saveSettings(settings: ContextDecisionsSettings, path: string): Promise<void> {
  const validated = parseSettings(settings);
  const flat = contextSettingsToFlat(validated);
  const store = createDecisionsSettingsStore(path);
  try {
    await store.save(flat, { scope: "global", force: true });
  } catch (error) {
    if (error instanceof SettingsSecurityError) {
      if (error.code === "SIZE_LIMIT_EXCEEDED") throw new SettingsError("Settings file exceeds 64 KiB");
      if (error.code === "SECRET_KEY_REJECTED") throw new SettingsError("Credentials must not be stored in context-decisions settings");
      throw new SettingsError("Could not save context-decisions settings");
    }
    // Allow repairing a corrupt regular file on disk (malformed JSON or corrupt legacy block) without bypassing security checks.
    if (error instanceof SyntaxError || error instanceof SettingsError) {
      try {
        const diff = store.schema.diffForScope(flat, "global", { global: {}, project: {} });
        await store.adapter.writeLayer("global", diff);
        return;
      } catch (writeError) {
        if (writeError instanceof SettingsSecurityError && writeError.code === "SIZE_LIMIT_EXCEEDED") {
          throw new SettingsError("Settings file exceeds 64 KiB");
        }
        throw new SettingsError("Could not save context-decisions settings");
      }
    }
    throw new SettingsError("Could not save context-decisions settings");
  }
}

/** CLI/UI updates always pass through the same strict validation as persistence. */
export function updateSetting(settings: ContextDecisionsSettings, key: string, text: string): ContextDecisionsSettings {
  if (key === "globalAllowlist") throw new SettingsError("Edit the allowlist in the /decisions dialog");
  if (key === "tools.alwaysAllowedTools" || key === "tools.alwaysAllowedMcpServers") {
    throw new SettingsError("Edit these allowlists in the /decisions Tools tab");
  }
  const next = structuredClone(settings);
  let target: Record<string, unknown>;
  let fieldName: string;
  if (key === "enabled") throw new SettingsError("Removed master switch; use relevance.enabled or tools.enabled");
  if (key === "iconStyle") { target = next as unknown as Record<string, unknown>; fieldName = key; }
  else if (key.startsWith("decision.")) { target = next.decision as unknown as Record<string, unknown>; fieldName = key.slice(9); }
  else if (key.startsWith("relevance.")) { target = next.relevance as unknown as Record<string, unknown>; fieldName = key.slice(10); }
  else if (key.startsWith("tools.")) { target = next.tools as unknown as Record<string, unknown>; fieldName = key.slice(6); }
  else if (key === "history.enabled" || key === "history.thinkingLevel") { target = next.history as unknown as Record<string, unknown>; fieldName = key.slice(8); }
  else throw new SettingsError("Use iconStyle, a decision, relevance or tools setting; choose a backend in the /decisions dialog");
  if (target === (next.relevance as unknown) && (LEGACY_RELEVANCE_KEYS as readonly string[]).includes(fieldName)) {
    throw new SettingsError("Removed setting: skill picking is score-only. Use decision.threshold <0–1>");
  }
  if (
    (key.startsWith("relevance.") && SHARED_KEYS.includes(fieldName)) ||
    (key.startsWith("tools.") && (LEGACY_TOOL_KEYS as readonly string[]).includes(fieldName))
  ) {
    throw new SettingsError(`Removed per-feature tuning; use decision.${fieldName}`);
  }
  if (!Object.hasOwn(target, fieldName) || fieldName === "pinned") {
    throw new SettingsError("Unknown setting; use pin/unpin for pinned skills");
  }
  if (typeof target[fieldName] === "boolean") {
    if (text !== "true" && text !== "false") throw new SettingsError("Boolean setting requires true or false");
    target[fieldName] = text === "true";
  } else if (typeof target[fieldName] === "number") {
    const threshold = fieldName === "threshold";
    if (!(threshold ? /^(?:\d+(?:\.\d+)?|\.\d+)$/u : /^\d+$/u).test(text)) {
      throw new SettingsError(threshold ? "Threshold requires a decimal in [0, 1]" : "Numeric setting requires a nonnegative integer");
    }
    target[fieldName] = Number(text);
  } else {
    target[fieldName] = text;
  }
  return parseSettings(next);
}
