// Pure tool classification for opt-in tool/MCP filtering. No Pi imports: callers pass structural `ToolInfoLike`
// values (Pi's `ToolInfo` satisfies it). Nothing here reads schemas, arguments, results, instructions or paths
// except the two provenance fields (`sourceInfo.source`/`path`), which are only compared, never forwarded.

export type ToolExposureLike = "direct" | "model-only" | "codemode" | "deferred" | "hidden";
export interface ToolInfoLike {
  name: string;
  description?: string;
  exposure?: ToolExposureLike | string;
  /** Pi's public `ToolNamespace`. `aliases` is read only when a host provides it. */
  namespace?: { name?: unknown; description?: unknown; aliases?: unknown };
  sourceInfo?: { source?: unknown; path?: unknown };
}
/**
 * - `internal`: Pi's own built-in tools (provenance `builtin:*` from Pi's built-in tools/extensions that is NOT an MCP
 *   server tool). Always available, never a candidate, never withheld, never blocked.
 * - `mcp`: a tool whose public `namespace.name` starts with `mcp__`. Grouped by that canonical namespace only.
 * - `extension`: everything else, including SDK host tools and extension overrides of core tool names.
 */
export type ToolKind = "internal" | "mcp" | "extension";
export interface ClassifiedTool {
  name: string;
  description: string;
  kind: ToolKind;
  exposure: ToolExposureLike;
  /** Direct and model-only tools are declared to the model, so `setActiveTools` governs them. */
  declarable: boolean;
  /** Canonical MCP namespace key (for example `mcp__dev_radius`). Present only for `mcp`. */
  group?: string;
  /** Internal tool that routes calls to MCP servers by a local `server` argument. */
  resource?: boolean;
}
export interface McpGroup {
  key: string;
  label: string;
  description: string;
  tools: string[];
  /** At least one member is registered by Pi's built-in MCP extension (informational only). */
  verified: boolean;
}
export interface ToolInventory {
  tools: ClassifiedTool[];
  byName: Map<string, ClassifiedTool>;
  groups: Map<string, McpGroup>;
  /** Registered `hidden` tools: never candidates. */
  hidden: number;
}
export const MCP_NAMESPACE_PREFIX = "mcp__";
/** Pi's built-in MCP resource tools. They have no namespace and reach every server by their `server` argument. */
export const MCP_RESOURCE_TOOLS: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const BUILTIN_MCP_PATH = "builtin:mcp";
const EXPOSURES: readonly string[] = ["direct", "model-only", "codemode", "deferred", "hidden"];

/** Canonical namespace key Pi derives for a RAW server name: `mcp__` + the name with `-` folded to `_` (`dev-radius` -> `mcp__dev_radius`). */
export function serverKey(name: string): string { return MCP_NAMESPACE_PREFIX + name.replace(/-/gu, "_"); }
/**
 * Canonical key for an allowlist ENTRY. An entry that starts with `mcp__` is exclusively a canonical namespace key (`mcp__prod` is the server
 * `prod`, never the raw server named `mcp__prod`); any other entry is a raw server name. A raw server literally named `mcp__x` has the
 * namespace `mcp__mcp__x`, so it must be allowlisted by that doubled canonical key. `-` and `_` are the same character in both forms.
 */
export function canonicalServerKey(entry: string): string { return entry.startsWith(MCP_NAMESPACE_PREFIX) ? entry.replace(/-/gu, "_") : serverKey(entry); }
/** True when allowlist `entry` names the server whose namespace key is `key`. */
export function sameServer(entry: string, key: string): boolean { return canonicalServerKey(entry) === key; }

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function builtinProvenance(info: ToolInfoLike): boolean {
  // Provenance is assigned by Pi's loader, not by the tool's name. Both fields must say built-in.
  return info.sourceInfo?.source === "builtin" && typeof info.sourceInfo.path === "string" && info.sourceInfo.path.startsWith("builtin:");
}
export function classifyTools(infos: readonly ToolInfoLike[]): ToolInventory {
  const tools: ClassifiedTool[] = [];
  const byName = new Map<string, ClassifiedTool>();
  const groups = new Map<string, McpGroup>();
  let hidden = 0;
  for (const info of infos) {
    if (!info || typeof info.name !== "string" || !info.name || byName.has(info.name)) continue;
    const exposure = (EXPOSURES.includes(info.exposure as string) ? info.exposure : "direct") as ToolExposureLike;
    if (exposure === "hidden") { hidden++; continue; }
    const namespace = text(info.namespace?.name);
    const base = { name: info.name, description: text(info.description), exposure, declarable: exposure === "direct" || exposure === "model-only" };
    let tool: ClassifiedTool;
    // The MCP namespace check runs FIRST: Pi's built-in MCP extension's server tools carry built-in provenance but are external.
    if (namespace.startsWith(MCP_NAMESPACE_PREFIX) && namespace.length > MCP_NAMESPACE_PREFIX.length) {
      tool = { ...base, kind: "mcp", group: namespace };
      let group = groups.get(namespace);
      if (!group) {
        const aliases = Array.isArray(info.namespace?.aliases) ? info.namespace.aliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0) : [];
        group = { key: namespace, label: aliases[0] ?? namespace.slice(MCP_NAMESPACE_PREFIX.length), description: text(info.namespace?.description), tools: [], verified: false };
        groups.set(namespace, group);
      }
      group.tools.push(info.name);
      if (info.sourceInfo?.path === BUILTIN_MCP_PATH && info.sourceInfo.source === "builtin") group.verified = true;
    } else if (builtinProvenance(info)) {
      // Built-in tools/extensions (core tools, codemode, tool_search, MCP resource tools). Unknown or missing provenance is never internal,
      // and neither a core-looking name nor `reachesTools` grants anything: an extension or SDK host tool is external.
      tool = { ...base, kind: "internal", ...(info.sourceInfo!.path === BUILTIN_MCP_PATH && MCP_RESOURCE_TOOLS.includes(info.name) ? { resource: true } : {}) };
    } else tool = { ...base, kind: "extension" };
    tools.push(tool);
    byName.set(tool.name, tool);
  }
  return { tools, byName, groups, hidden };
}
export interface ToolCandidate { name: string; description: string }
/** Candidate shape: one per external tool (`tools`), or one per MCP namespace (`mcp`). */
export type ToolFilterMode = "tools" | "mcp";
function bounded(value: string, limit: number): string { return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + "…"; }
export function groupDescription(group: McpGroup, maxChars: number): string {
  const names = [...group.tools].sort();
  const head = group.description ? `${group.description}. ` : "";
  const prefix = `MCP server ${group.label}. ${head}Tools: `;
  let list = "";
  for (const name of names) {
    const next = list ? `${list}, ${name}` : name;
    if (prefix.length + next.length > maxChars) { list = list ? `${list}, …` : "…"; break; }
    list = next;
  }
  return bounded(prefix + list, Math.max(1, maxChars));
}
/**
 * Candidates for the decision model. `tools` mode sends tool name, bounded description and the MCP server label;
 * `mcp` mode sends the canonical namespace key as the identifier plus server label, namespace description and bounded
 * tool names. Schemas, annotations, namespace instructions, provenance paths and server configs are never included.
 */
export function candidatesFor(inventory: ToolInventory, mode: ToolFilterMode, names: ReadonlySet<string>, maxDescriptionChars: number): ToolCandidate[] {
  if (mode === "mcp") {
    return [...inventory.groups.values()].filter((group) => names.has(group.key))
      .map((group) => ({ name: group.key, description: groupDescription(group, maxDescriptionChars) }));
  }
  return inventory.tools.filter((tool) => tool.kind !== "internal" && names.has(tool.name)).map((tool) => {
    const label = tool.group ? inventory.groups.get(tool.group)?.label : undefined;
    return { name: tool.name, description: bounded(`${label ? `[MCP server ${label}] ` : ""}${tool.description}`, maxDescriptionChars) };
  });
}
