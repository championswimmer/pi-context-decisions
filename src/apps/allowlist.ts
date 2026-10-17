import { EXTENSION_GROUP_PREFIX, canonicalServerKey } from "./tool-inventory.ts";
import { scopeOf, type AllowlistScope } from "./allowlist-scope.ts";
/** Always-included advertisements, not a permission/restriction list. */
export { scopeOf, type AllowlistScope } from "./allowlist-scope.ts";
export interface ScopedSkill {
  name: string; description: string; scope: AllowlistScope; disableModelInvocation: boolean;
  /** Display text when the stored name is not the readable form (a canonical group key). Never sent to a decision model. */
  label?: string;
}
export interface Allowlists { global: readonly string[]; project: readonly string[] }
export class AllowlistError extends Error {
  readonly code = "config";
  constructor() { super("Allowlist names must be bounded, nonempty identifiers (at most 1000)"); this.name = "AllowlistError"; }
}
export function isAllowlistName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\s\p{Cc}]/u.test(value);
}
export function normalizeAllowlist(names: Iterable<unknown>): string[] {
  const unique = new Set<string>();
  let count = 0;
  for (const name of names) {
    if (++count > 1000 || !isAllowlistName(name)) throw new AllowlistError();
    unique.add(name);
  }
  return [...unique].sort();
}
export function allowlistedNames<T extends { name: string; sourceInfo?: { scope?: unknown } }>(skills: readonly T[], lists: Allowlists): string[] {
  const global = new Set(lists.global), project = new Set(lists.project);
  // Match the first name only, just as Pi resolves duplicate skill names.
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return (scopeOf(skill.sourceInfo?.scope) === "project" ? project : global).has(skill.name);
  }).map((skill) => skill.name);
}
export function toScopedSkills<T extends { name: string; description?: string; sourceInfo?: { scope?: unknown }; disableModelInvocation?: boolean }>(skills: readonly T[]): ScopedSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name); return true;
  }).map((skill) => ({ name: skill.name, description: skill.description ?? "", scope: scopeOf(skill.sourceInfo?.scope), disableModelInvocation: skill.disableModelInvocation === true }));
}
/** Tool allowlist names: 1–128 characters, no whitespace or control characters. */
export function isToolAllowlistName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}\p{Cf}]/u.test(value);
}
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
/**
 * Group allowlist entries: a raw MCP server name (`[A-Za-z0-9_-]{1,64}`), or a canonical key, which is a `mcp__` namespace key or an `ext__` extension key
 * followed by such a name. The canonical prefix is allowed IN ADDITION to the 64-character bound on the name, so the canonical key of every valid raw
 * name (`mcp__` + up to 64 characters) is itself valid, in settings, the project file, commands and the editors alike.
 */
export function isServerAllowlistName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (SERVER_NAME.test(value)) return true;
  return (value.startsWith("mcp__") || value.startsWith("ext__")) && SERVER_NAME.test(value.slice(5));
}
function normalizeBy(names: Iterable<unknown>, valid: (value: unknown) => value is string, key: (name: string) => string, store: (name: string) => string = (name) => name): string[] {
  const unique = new Map<string, string>();
  let count = 0;
  for (const name of names) {
    if (++count > 1000 || !valid(name)) throw new AllowlistError();
    if (!unique.has(key(name))) unique.set(key(name), store(name));
  }
  return [...unique.values()].sort();
}
export function normalizeToolAllowlist(names: Iterable<unknown>): string[] { return normalizeBy(names, isToolAllowlistName, (name) => name); }
/**
 * `dev-radius` and `dev_radius` are the same MCP server in Pi: keep one. A `mcp__` prefix marks a canonical MCP namespace key exclusively and an
 * `ext__` prefix a canonical extension key exclusively; extension keys are stored in canonical (lowercase) form.
 */
export function normalizeServerAllowlist(names: Iterable<unknown>): string[] { return normalizeBy(names, isServerAllowlistName, canonicalServerKey, (name) => name.startsWith(EXTENSION_GROUP_PREFIX) ? canonicalServerKey(name) : name); }
