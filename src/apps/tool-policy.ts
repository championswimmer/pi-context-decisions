// Pure availability policy for opt-in tool/MCP filtering. No Pi imports.
import { canonicalServerKey, MCP_NAMESPACE_PREFIX, sameServer, type ClassifiedTool, type ToolFilterMode, type ToolInventory } from "./tool-inventory.ts";

/** What this branch already made available (the additive ledger, plus not-yet-flushed in-memory additions). */
export interface AvailabilityLedger { tools: ReadonlySet<string>; groups: ReadonlySet<string> }
/** Scope-resolved grants for the current inventory. Server entries are matched with `sameServer` (`-`/`_` folding). */
export interface EffectiveAllowlists { tools: ReadonlySet<string>; servers: ReadonlySet<string> }
export interface Availability {
  /** Registered groups (MCP namespaces and extensions) that are available as a whole. */
  groups: Set<string>;
  /** Groups made available only because one of their tools is allowlisted or already available, in `mcp` (group) mode. */
  promoted: Set<string>;
  isAvailable(tool: ClassifiedTool): boolean;
  isGroupAvailable(key: string): boolean;
}
/** Resolve names-only lists against public provenance, never config files or path guesses.
 * Unobservable MCP groups (resource-only/disconnected servers) follow missing-scope skill semantics: global only.
 * Absent extensions wait until their scope is observable; a saved name alone grants nothing.
 * Mixed-scope groups cannot safely grant the whole group from either list; use scoped tool names instead.
 */
export function effectiveToolAllowlists(inventory: ToolInventory, global: EffectiveAllowlists, project: EffectiveAllowlists): EffectiveAllowlists {
  const tools = new Set(inventory.tools.filter((tool) => (tool.scope === "project" ? project : global).tools.has(tool.name)).map((tool) => tool.name));
  const servers = new Set<string>();
  for (const [scope, list] of [["global", global], ["project", project]] as const) for (const entry of list.servers) {
    const key = canonicalServerKey(entry), group = inventory.groups.get(key);
    if (group ? group.scope === scope : scope === "global" && key.startsWith(MCP_NAMESPACE_PREFIX)) servers.add(entry);
  }
  return { tools, servers };
}
const none: ReadonlySet<string> = new Set();
export function serverAllowlisted(allow: EffectiveAllowlists, key: string): boolean {
  for (const entry of allow.servers) if (sameServer(entry, key)) return true;
  return false;
}
/**
 * Groups are MCP namespaces AND extensions (`ext__<name>`, from Pi's public `sourceInfo`); both follow the same rules.
 * - internal: always available.
 * - `mcp` (group) mode: a group is available when it is in the ledger, it is allowlisted, or ANY of its tools is allowlisted / already
 *   available (the whole group is promoted, except mixed-scope groups: individual grants never cross origins). Only extension tools
 *   without usable provenance (no group) are never filtered here.
 * - `tools` mode: a tool is available when it, or its whole group, is in the ledger or an allowlist.
 * A late member of an available group is available without scoring.
 */
export function availability(inventory: ToolInventory, mode: ToolFilterMode, ledger: AvailabilityLedger, allow: EffectiveAllowlists): Availability {
  const groups = new Set<string>();
  const promoted = new Set<string>();
  for (const group of inventory.groups.values()) {
    if (ledger.groups.has(group.key) || serverAllowlisted(allow, group.key)) { groups.add(group.key); continue; }
    if (mode === "mcp" && group.scope !== "mixed" && group.tools.some((name) => ledger.tools.has(name) || allow.tools.has(name))) { groups.add(group.key); promoted.add(group.key); }
  }
  const isGroupAvailable = (key: string) => groups.has(key);
  const isAvailable = (tool: ClassifiedTool): boolean => {
    if (tool.kind === "internal") return true;
    if (tool.group) return isGroupAvailable(tool.group) || ((mode === "tools" || inventory.groups.get(tool.group)?.scope === "mixed") && (ledger.tools.has(tool.name) || allow.tools.has(tool.name)));
    // Ungrouped (no usable provenance) extension tool.
    return mode === "mcp" || ledger.tools.has(tool.name) || allow.tools.has(tool.name);
  };
  return { groups, promoted, isAvailable, isGroupAvailable };
}
/** Identifiers still to be decided: tool names (`tools` mode) or group keys (`mcp` mode). */
export function remaining(inventory: ToolInventory, mode: ToolFilterMode, avail: Availability): Set<string> {
  if (mode === "mcp") return new Set([...inventory.groups.keys()].filter((key) => !avail.isGroupAvailable(key)));
  return new Set(inventory.tools.filter((tool) => tool.kind !== "internal" && !avail.isAvailable(tool)).map((tool) => tool.name));
}
/**
 * Identifiers that belong in the ledger as "base" so that availability only ever grows: allowlisted tools/groups
 * that are registered (removing an allowlist entry later never takes availability away) and, in `mcp` mode, every
 * ungrouped extension tool (a later switch to `tools` mode must not remove them; grouped ones are covered by their group).
 */
export function baseGrowth(inventory: ToolInventory, mode: ToolFilterMode, ledger: AvailabilityLedger, allow: EffectiveAllowlists, avail: Availability): { tools: string[]; groups: string[] } {
  const groups = [...avail.groups].filter((key) => !ledger.groups.has(key));
  const tools = inventory.tools.filter((tool) => tool.kind !== "internal" && !ledger.tools.has(tool.name)
    && (allow.tools.has(tool.name) || (mode === "mcp" && tool.kind === "extension" && !tool.group))).map((tool) => tool.name);
  return { tools, groups };
}
/** Declared (active) external tools that are not available, and which tools we previously withheld may return. */
export function reconcileActive(inventory: ToolInventory, avail: Availability, active: readonly string[], withheld: ReadonlySet<string>):
  { withhold: string[]; restore: string[] } {
  const activeSet = new Set(active);
  const withhold = active.filter((name) => {
    const tool = inventory.byName.get(name);
    return !!tool && tool.kind !== "internal" && tool.declarable && !avail.isAvailable(tool);
  });
  // Only tools WE withheld are ever re-activated: `defaultActive` is not observable, so nothing else is guessed.
  const restore = [...withheld].filter((name) => {
    const tool = inventory.byName.get(name);
    return !!tool && tool.kind !== "internal" && tool.declarable && !activeSet.has(name) && avail.isAvailable(tool);
  });
  return { withhold, restore };
}
export const NO_ALLOWLISTS: EffectiveAllowlists = { tools: none, servers: none };
