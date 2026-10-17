// Pure tool classification for opt-in tool/MCP filtering. No Pi imports: callers pass structural `ToolInfoLike`
// values (Pi's `ToolInfo` satisfies it). Nothing here reads schemas, arguments, results, instructions or paths
// except the public provenance fields (`sourceInfo.source`/`path`/`origin`/`baseDir`/`scope`), which are only compared or reduced to a short extension
// NAME (never forwarded as a path).
import { createHash } from "node:crypto";
import { scopeOf, type AllowlistScope } from "./allowlist-scope.ts";

export type ToolExposureLike = "direct" | "model-only" | "codemode" | "deferred" | "hidden";
export interface ToolInfoLike {
  name: string;
  description?: string;
  exposure?: ToolExposureLike | string;
  /** Pi's public `ToolNamespace`. `aliases` is read only when a host provides it. */
  namespace?: { name?: unknown; description?: unknown; aliases?: unknown };
  /** Pi's public `SourceInfo`. Only compared, or reduced to a short extension NAME (never forwarded as a path). */
  sourceInfo?: { source?: unknown; path?: unknown; origin?: unknown; baseDir?: unknown; scope?: unknown };
}
/**
 * - `internal`: Pi's own built-in tools (provenance `builtin:*` from Pi's built-in tools/extensions that is NOT an MCP
 *   server tool). Always available, never a candidate, never withheld, never blocked.
 * - `mcp`: a tool whose public `namespace.name` starts with `mcp__`. Grouped by that canonical namespace only.
 * - `extension`: everything else, including SDK host tools and extension overrides of core tool names. When Pi's public
 *   `sourceInfo` names the extension (see `extensionIdentity`), the tool belongs to that extension's group (`ext__<name>`), which is
 *   handled exactly like an MCP namespace. Tools without usable provenance stay ungrouped.
 */
export type ToolKind = "internal" | "mcp" | "extension";
export interface ClassifiedTool {
  name: string;
  description: string;
  kind: ToolKind;
  /** Built-in MCP uses names-only file origins (unknown -> global); other tools use public scope, like skills. */
  scope: AllowlistScope;
  exposure: ToolExposureLike;
  /** Direct and model-only tools are declared to the model, so `setActiveTools` governs them. */
  declarable: boolean;
  /** Canonical group key: an MCP namespace (`mcp__dev_radius`, always for `mcp`) or an extension (`ext__my_ext`). Absent for ungrouped extension tools. */
  group?: string;
  /** Internal tool that routes calls to MCP servers by a local `server` argument. */
  resource?: boolean;
}
/** A set of tools that are decided, allowlisted and promoted together: one MCP server namespace or one extension. */
export interface ToolGroup {
  key: string;
  /** Mixed-origin groups cannot be allowlisted as a whole; their tools remain individually selectable. */
  scope: AllowlistScope | "mixed";
  /** `mcp`: Pi's public `mcp__` namespace. `extension`: derived from Pi's public `sourceInfo`. */
  type: "mcp" | "extension";
  label: string;
  description: string;
  tools: string[];
  /** MCP only: at least one member is registered by Pi's built-in MCP extension (informational only). */
  verified: boolean;
}
/** Kept for the previous export name; extension groups are the same shape. */
export type McpGroup = ToolGroup;
export interface ToolInventory {
  tools: ClassifiedTool[];
  byName: Map<string, ClassifiedTool>;
  groups: Map<string, ToolGroup>;
  /** Registered `hidden` tools: never candidates. */
  hidden: number;
  /** File-configured built-in MCP origins, including resource-only servers; names/scopes only. */
  builtinMcpScopes: ReadonlyMap<string, AllowlistScope>;
}
export const MCP_NAMESPACE_PREFIX = "mcp__";
/** Canonical key prefix of an extension group (`ext__<slug of the extension name>`). Pi has no namespace for extensions, so this is ours. */
export const EXTENSION_GROUP_PREFIX = "ext__";
/** Pi's built-in MCP resource tools. They have no namespace and reach every server by their `server` argument. */
export const MCP_RESOURCE_TOOLS: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const BUILTIN_MCP_PATH = "builtin:mcp";
const EXPOSURES: readonly string[] = ["direct", "model-only", "codemode", "deferred", "hidden"];

/** Canonical namespace key Pi derives for a RAW server name: `mcp__` + the name with `-` folded to `_` (`dev-radius` -> `mcp__dev_radius`). */
export function serverKey(name: string): string { return MCP_NAMESPACE_PREFIX + name.replace(/-/gu, "_"); }
/**
 * Canonical key for a group allowlist ENTRY. An entry that starts with `mcp__` is exclusively a canonical MCP namespace key (`mcp__prod` is the
 * server `prod`, never the raw server named `mcp__prod`), and one that starts with `ext__` is exclusively a canonical extension key (lowercase);
 * any other entry is a raw MCP server name. A raw server literally named `mcp__x` or `ext__x` has the namespace `mcp__mcp__x` / `mcp__ext__x`,
 * so it must be allowlisted by that prefixed canonical key. `-` and `_` are the same character in all forms.
 */
export function canonicalServerKey(entry: string): string {
  if (entry.startsWith(MCP_NAMESPACE_PREFIX)) return entry.replace(/-/gu, "_");
  if (entry.startsWith(EXTENSION_GROUP_PREFIX)) return entry.toLowerCase().replace(/-/gu, "_");
  return serverKey(entry);
}
/** True when allowlist `entry` names the server whose namespace key is `key`. */
export function sameServer(entry: string, key: string): boolean { return canonicalServerKey(entry) === key; }

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function builtinProvenance(info: ToolInfoLike): boolean {
  // Provenance is assigned by Pi's loader, not by the tool's name. Both fields must say built-in.
  return info.sourceInfo?.source === "builtin" && typeof info.sourceInfo.path === "string" && info.sourceInfo.path.startsWith("builtin:");
}
const EXTENSION_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/iu;
const LABEL_LIMIT = 48;
/** Control/format characters and whitespace runs removed; NOT truncated (the group key is derived from the full name). */
const cleanName = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
/** A name worth showing: non-empty and not made only of dots (`.`/`..` are path references, never names). */
const usable = (value: string): string => { const name = cleanName(value); return /^\.*$/u.test(name) ? "" : name; };
/** Last path segment with `.`/`..` segments resolved first, so a base directory spelled `/work/pkg/..` is named after what it resolves to. */
function lastSegment(path: string): string {
  const stack: string[] = [];
  for (const part of path.split(/[\\/]+/u)) { if (!part || part === ".") continue; if (part === "..") stack.pop(); else stack.push(part); }
  return stack.pop() ?? "";
}
/** Package source (`npm:@scope/pkg@1.2.3`, `git:github.com/u/repo@v1`, `https://host/u/repo.git`, `../local-pkg`) -> short package name. `.`/`..` yield "" (resolve via baseDir). */
function packageName(source: string): string {
  const rest = source.trim().replace(/^(?:npm|git|https?|ssh|git\+[a-z]+):(?:\/\/)?/iu, "").replace(/[?#].*$/u, "").replace(/\.git(?=@|$)/iu, "");
  const parts = rest.split(/[\\/:]+/u).filter(Boolean);
  // `.` and `..` segments in a local source (`.`, `../..`, `./pkg/..`) are resolved lexically; what is left is the package directory, or nothing.
  const stack: string[] = [];
  for (const part of parts) { if (part === ".") continue; if (part === "..") stack.pop(); else stack.push(part); }
  let last = stack.pop() ?? "";
  // A trailing `@version`/`@ref` (never the leading scope marker).
  const at = last.lastIndexOf("@");
  if (at > 0) last = last.slice(0, at);
  return stack.length && stack[stack.length - 1]!.startsWith("@") ? `${stack[stack.length - 1]}/${last}` : last;
}
/**
 * The full human-readable extension name, from Pi's PUBLIC `sourceInfo` only (never tool names, private files or package guesses):
 * a package extension is named after its package (`source`, else the resolved `baseDir`); a loose extension after its file (`foo.ts` -> `foo`,
 * `foo/index.ts` -> `foo`); a synthetic path such as `<inline:name>` after its name. Built-in provenance is never an extension. Returns undefined
 * when nothing usable is exposed. Not truncated: the group key hashes this full name.
 */
export function extensionFullName(info: Pick<ToolInfoLike, "sourceInfo">): string | undefined {
  const source = info.sourceInfo;
  if (!source) return undefined;
  const path = typeof source.path === "string" ? source.path : "";
  let name = "";
  if (source.origin === "package" && typeof source.source === "string") name = usable(packageName(source.source));
  if (!name && source.origin === "package" && typeof source.baseDir === "string") name = usable(lastSegment(source.baseDir));
  if (!name && path.startsWith("<") && path.endsWith(">")) {
    // Synthetic provenance `<kind:name>`; Pi numbers unnamed inline factories (`<inline:2>`), which is not a name worth showing on its own.
    const [kind = "", ...rest] = path.slice(1, -1).split(":");
    const inner = rest.join(":");
    name = usable(!inner ? kind : /^\d+$/u.test(inner) ? `${kind}-${inner}` : inner);
  }
  if (!name && path && !path.startsWith("<")) {
    const parts = path.split(/[\\/]+/u).filter(Boolean);
    const file = (parts.pop() ?? "").replace(EXTENSION_FILE, "");
    name = usable(file.toLowerCase() === "index" ? parts.pop() ?? "" : file);
  }
  return name || undefined;
}
/** The name shown in dialogs and sent to the decision model: the full name, bounded to 48 characters. */
export function extensionName(info: Pick<ToolInfoLike, "sourceInfo">): string | undefined {
  const name = extensionFullName(info);
  return name ? name.slice(0, LABEL_LIMIT).trim() : undefined;
}
const KEY_LIMIT = 64;
const HASH_CHARS = 10;
/**
 * Canonical group key for an extension name: `ext__<name>` within the 64-character allowlist bound.
 * - A name that is already canonical up to case and `-`/`_` (the same equivalence MCP server names have) and fits is used as is: `Pi-Web` -> `ext__pi_web`.
 * - Any other name (`@acme/pi-web`, `a.b`, non-ASCII, too long) keeps a readable ASCII slug AND gets `_<hash>` of the FULL NFC name, so distinct names never
 *   share a key (`@acme/pi-web` vs `acme-pi-web`), non-ASCII names that fold to nothing still get a stable key (`ext__ext_<hash>`), and truncation of the
 *   slug or of the displayed label can never merge two names. Deterministic: the same name gives the same key in every session and on every machine.
 */
export function extensionKey(fullName: string): string | undefined {
  const name = cleanName(fullName).normalize("NFC");
  if (!name) return undefined;
  const folded = name.toLowerCase().replace(/-/gu, "_");
  const room = KEY_LIMIT - EXTENSION_GROUP_PREFIX.length;
  if (/^[a-z0-9_]+$/u.test(folded) && folded.length <= room) return EXTENSION_GROUP_PREFIX + folded;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, HASH_CHARS);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, room - HASH_CHARS - 1).replace(/_+$/u, "") || "ext";
  return `${EXTENSION_GROUP_PREFIX}${slug}_${hash}`;
}
export function classifyTools(infos: readonly ToolInfoLike[], builtinMcpScopes: ReadonlyMap<string, AllowlistScope> = new Map()): ToolInventory {
  const tools: ClassifiedTool[] = [];
  const byName = new Map<string, ClassifiedTool>();
  const groups = new Map<string, McpGroup>();
  let hidden = 0;
  for (const info of infos) {
    if (!info || typeof info.name !== "string" || !info.name || byName.has(info.name)) continue;
    const exposure = (EXPOSURES.includes(info.exposure as string) ? info.exposure : "direct") as ToolExposureLike;
    if (exposure === "hidden") { hidden++; continue; }
    const namespace = text(info.namespace?.name);
    const builtinMcp = info.sourceInfo?.source === "builtin" && info.sourceInfo.path === BUILTIN_MCP_PATH && namespace.startsWith(MCP_NAMESPACE_PREFIX);
    const base = { scope: builtinMcp ? builtinMcpScopes.get(namespace) ?? "global" : scopeOf(info.sourceInfo?.scope), name: info.name, description: text(info.description), exposure, declarable: exposure === "direct" || exposure === "model-only" };
    let tool: ClassifiedTool;
    // The MCP namespace check runs FIRST: Pi's built-in MCP extension's server tools carry built-in provenance but are external.
    if (namespace.startsWith(MCP_NAMESPACE_PREFIX) && namespace.length > MCP_NAMESPACE_PREFIX.length) {
      tool = { ...base, kind: "mcp", group: namespace };
      let group = groups.get(namespace);
      if (!group) {
        const aliases = Array.isArray(info.namespace?.aliases) ? info.namespace.aliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0) : [];
        group = { key: namespace, scope: base.scope, type: "mcp", label: aliases[0] ?? namespace.slice(MCP_NAMESPACE_PREFIX.length), description: text(info.namespace?.description), tools: [], verified: false };
        groups.set(namespace, group);
      }
      if (group.scope !== base.scope) group.scope = "mixed";
      group.tools.push(info.name);
      if (info.sourceInfo?.path === BUILTIN_MCP_PATH && info.sourceInfo.source === "builtin") group.verified = true;
    } else if (builtinProvenance(info)) {
      // Built-in tools/extensions (core tools, codemode, tool_search, MCP resource tools). Unknown or missing provenance is never internal,
      // and neither a core-looking name nor `reachesTools` grants anything: an extension or SDK host tool is external.
      tool = { ...base, kind: "internal", ...(info.sourceInfo!.path === BUILTIN_MCP_PATH && MCP_RESOURCE_TOOLS.includes(info.name) ? { resource: true } : {}) };
    } else {
      // Extensions are grouped like MCP servers, by the public provenance Pi assigned (never by parsing the tool name). Two extension files
      // with the same derived name (one package, or same-named files) share a group; tools without usable provenance stay ungrouped.
      const full = extensionFullName(info);
      const key = full ? extensionKey(full) : undefined;
      const label = full ? full.slice(0, LABEL_LIMIT).trim() : undefined;
      tool = { ...base, kind: "extension", ...(key ? { group: key } : {}) };
      if (key) {
        let group = groups.get(key);
        if (!group) { group = { key, scope: base.scope, type: "extension", label: label!, description: "", tools: [], verified: false }; groups.set(key, group); }
        if (group.scope !== base.scope) group.scope = "mixed";
        group.tools.push(info.name);
      }
    }
    tools.push(tool);
    byName.set(tool.name, tool);
  }
  return { tools, byName, groups, hidden, builtinMcpScopes };
}
export interface ToolCandidate { name: string; description: string }
/** Candidate shape: one per external tool (`tools`), or one per MCP namespace (`mcp`). */
export type ToolFilterMode = "tools" | "mcp";
function bounded(value: string, limit: number): string { return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + "…"; }
export function groupDescription(group: McpGroup, maxChars: number): string {
  const names = [...group.tools].sort();
  const head = group.description ? `${group.description}. ` : "";
  const prefix = `${group.type === "mcp" ? "MCP server" : "Extension"} ${group.label}. ${head}Tools: `;
  let list = "";
  for (const name of names) {
    const next = list ? `${list}, ${name}` : name;
    if (prefix.length + next.length > maxChars) { list = list ? `${list}, …` : "…"; break; }
    list = next;
  }
  return bounded(prefix + list, Math.max(1, maxChars));
}
/**
 * Candidates for the decision model. `tools` mode sends tool name, bounded description and the MCP server / extension label;
 * `mcp` (group) mode sends the canonical group key as the identifier plus the server or extension label, namespace description and bounded
 * tool names, MCP servers and extensions alike. Schemas, annotations, namespace instructions, provenance paths and server configs are never included.
 */
export function candidatesFor(inventory: ToolInventory, mode: ToolFilterMode, names: ReadonlySet<string>, maxDescriptionChars: number): ToolCandidate[] {
  if (mode === "mcp") {
    return [...inventory.groups.values()].filter((group) => names.has(group.key))
      .map((group) => ({ name: group.key, description: groupDescription(group, maxDescriptionChars) }));
  }
  return inventory.tools.filter((tool) => tool.kind !== "internal" && names.has(tool.name)).map((tool) => {
    const group = tool.group ? inventory.groups.get(tool.group) : undefined;
    return { name: tool.name, description: bounded(`${group ? `[${group.type === "mcp" ? "MCP server" : "extension"} ${group.label}] ` : ""}${tool.description}`, maxDescriptionChars) };
  });
}
