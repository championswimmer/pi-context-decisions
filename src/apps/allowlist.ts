/** Always-included advertisements, not a permission/restriction list. */
export type AllowlistScope = "global" | "project";
export interface ScopedSkill { name: string; description: string; scope: AllowlistScope; disableModelInvocation: boolean }
export interface Allowlists { global: readonly string[]; project: readonly string[] }
export class AllowlistError extends Error {
  readonly code = "config";
  constructor() { super("Allowlist names must be bounded, nonempty identifiers (at most 1000)"); this.name = "AllowlistError"; }
}
export function scopeOf(sourceScope: unknown): AllowlistScope { return sourceScope === "project" ? "project" : "global"; }
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
