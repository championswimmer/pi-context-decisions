/** Public Pi source scopes, shared by skill and tool allowlists. Missing/temporary provenance follows the global list. */
export type AllowlistScope = "global" | "project";
export function scopeOf(sourceScope: unknown): AllowlistScope { return sourceScope === "project" ? "project" : "global"; }
