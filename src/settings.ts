import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackendSelection } from "./core/backends/factory.ts";
import { isAllowedOpenRouterModel } from "./catalog/openrouter-models.ts";

export interface RelevanceSettings {
  enabled: boolean;
  mode: "score" | "choice";
  minLabel: "related" | "directly_relevant";
  /** Raw 0–2 expected rubric-index thresholds; selection uses minLabel. */
  relatedThreshold: number;
  directThreshold: number;
  maxSkills: number;
  minCandidates: number;
  failMode: "open" | "closed";
  timeoutMs: number;
  maxPromptChars: number;
  maxDescriptionChars: number;
  chunkSize: number;
  concurrency: number;
  pinned: string[];
}
export interface ContextDecisionsSettings {
  enabled: boolean;
  backend: BackendSelection | null;
  relevance: RelevanceSettings;
}
export function defaultSettings(): ContextDecisionsSettings {
  return { enabled: true, backend: null, relevance: {
    enabled: true, mode: "score", minLabel: "related", relatedThreshold: 0.75, directThreshold: 1.5,
    maxSkills: 12, minCandidates: 8,
    failMode: "closed", timeoutMs: 8000, maxPromptChars: 4000, maxDescriptionChars: 400,
    chunkSize: 24, concurrency: 2, pinned: [],
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
const NUMERIC_BOUNDS = {
  maxSkills: [0, 1000], minCandidates: [0, 1000], timeoutMs: [1, 300000],
  maxPromptChars: [1, 4000], maxDescriptionChars: [1, 400], chunkSize: [1, 24], concurrency: [1, 4],
} as const;
export function parseSettings(value: unknown, warnings?: string[]): ContextDecisionsSettings {
  rejectSecrets(value);
  if (!object(value)) throw new SettingsError("Settings must be a JSON object");
  keys(value, ["enabled", "backend", "relevance"], warnings);
  const result = defaultSettings();
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new SettingsError("enabled must be a boolean");
    result.enabled = value.enabled;
  }
  if (value.backend !== undefined) result.backend = validateBackendSelection(value.backend);
  if (value.relevance === undefined) return result;
  if (!object(value.relevance)) throw new SettingsError("relevance must be an object");
  const input = value.relevance;
  keys(input, Object.keys(result.relevance), warnings);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new SettingsError("relevance.enabled must be a boolean");
    result.relevance.enabled = input.enabled;
  }
  const enums = { mode: ["score", "choice"], minLabel: ["related", "directly_relevant"], failMode: ["open", "closed"] } as const;
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
  for (const key of ["relatedThreshold", "directThreshold"] as const) {
    const number = input[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 2) throw new SettingsError(`relevance.${key} must be finite in [0, 2]`);
    result.relevance[key] = number;
  }
  if (result.relevance.relatedThreshold > result.relevance.directThreshold) throw new SettingsError("Relevance thresholds must be ordered: relatedThreshold <= directThreshold");
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
  const next = structuredClone(settings);
  let target: Record<string, unknown>;
  let field: string;
  if (key === "enabled") { target = next as unknown as Record<string, unknown>; field = key; }
  else if (key.startsWith("relevance.")) { target = next.relevance as unknown as Record<string, unknown>; field = key.slice(10); }
  else throw new SettingsError("Use enabled or a relevance setting; use model to choose a backend");
  if (!Object.hasOwn(target, field) || field === "pinned") throw new SettingsError("Unknown setting; use pin/unpin for pinned skills");
  if (typeof target[field] === "boolean") {
    if (text !== "true" && text !== "false") throw new SettingsError("Boolean setting requires true or false");
    target[field] = text === "true";
  } else if (typeof target[field] === "number") {
    const threshold = field === "relatedThreshold" || field === "directThreshold";
    if (!(threshold ? /^(?:\d+(?:\.\d+)?|\.\d+)$/u : /^\d+$/u).test(text)) throw new SettingsError(threshold ? "Threshold requires a nonnegative decimal in [0, 2]" : "Numeric setting requires a nonnegative integer");
    target[field] = Number(text);
  } else target[field] = text;
  return parseSettings(next);
}
