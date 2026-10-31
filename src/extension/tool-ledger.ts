import type { BranchEntryLike } from "./skill-ledger.ts";
import type { AdditionPick } from "../apps/skill-filter.ts";

/**
 * Per-branch tool availability ledger, derived only from the active session branch (like the skill ledger).
 * One non-context `custom` entry type carries every record; a notice `custom_message` tells the model, by name only,
 * which codemode-reachable tools or MCP servers became available.
 */
export const TOOLS_LEDGER_ENTRY = "context-decisions-tools";
export const TOOLS_NOTICE_TYPE = "context-decisions-tools-notice";
const MAX_NAMES = 1000;
const MAX_NAME_CHARS = 256;
const MAX_TASK_CHARS = 100_000;
const BASELINE_PREFIX = "Tool availability (pi-context-decisions): among the MCP servers, extensions and tools that are reached indirectly";

export interface ToolLedgerData {
  v: 1;
  /** Tool names made available (decided, allowlisted, or recorded as base). */
  tools?: string[];
  /** Group keys (MCP namespaces `mcp__x`, extensions `ext__x`) made available as a whole. */
  groups?: string[];
  /** Declared tools WE removed from the active set (so only they may be restored). */
  withheld?: string[];
  /** Withheld tools put back. */
  released?: string[];
  /** Candidates already evaluated by the `initial` pick (so catch-up never re-picks them). */
  considered?: string[];
  /** Tools/groups of THIS record that were made available by an allowlist (bypass scoring; never given a pick). */
  allowlisted?: string[];
  /** Raw score and threshold (numbers only) of each tool/group made available by a scored pick, keyed by name. */
  picks?: Record<string, AdditionPick>;
  /** The first user task after filtering became active on this branch (`initial` cadence). */
  initialTask?: string;
}
export interface ToolLedgerState {
  tools: Set<string>;
  groups: Set<string>;
  withheld: Set<string>;
  considered: Set<string>;
  initialTask?: string;
  /** At least one ledger entry exists: filtering has been active on this branch. */
  present: boolean;
  /** Names/keys announced to the model by notice messages. */
  announced: Set<string>;
  noticed: boolean;
  /** A full membership notice explaining that other indirect tools are blocked was committed. */
  baselineNoticed: boolean;
  /** The branch already contains conversation messages. */
  hasMessages: boolean;
  /** The session branch could not be read: nothing is known, so only the fail-closed gate acts. */
  unreadable?: boolean;
}
export interface ToolsLedgerSession { getBranch(): readonly BranchEntryLike[] }

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_NAME_CHARS).slice(0, MAX_NAMES);
}
/** Robust to malformed entries: anything that is not a well-formed v1 record is ignored. */
export function readToolLedger(session: ToolsLedgerSession): ToolLedgerState {
  const state: ToolLedgerState = { tools: new Set(), groups: new Set(), withheld: new Set(), considered: new Set(), present: false, announced: new Set(), noticed: false, baselineNoticed: false, hasMessages: false };
  for (const entry of session.getBranch()) {
    if (entry.type === "message") { state.hasMessages = true; continue; }
    if (entry.type === "custom_message" && entry.customType === TOOLS_NOTICE_TYPE) {
      const details = entry.details as { v?: unknown; tools?: unknown; groups?: unknown; baseline?: unknown } | undefined;
      if (details && typeof details === "object" && details.v === 1) {
        state.noticed = true;
        // Older v1 notices have no discriminator. Recognize their fixed baseline wording rather than
        // treating an additive-only legacy notice as proof that the blocking policy was delivered.
        const legacyBaseline = details.baseline === undefined && typeof entry.content === "string" && entry.content.startsWith(BASELINE_PREFIX);
        if (details.baseline === true || legacyBaseline) state.baselineNoticed = true;
        for (const name of [...names(details.tools), ...names(details.groups)]) state.announced.add(name);
      }
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== TOOLS_LEDGER_ENTRY) continue;
    const data = entry.data as ToolLedgerData | undefined;
    if (!data || typeof data !== "object" || data.v !== 1) continue;
    state.present = true;
    for (const name of names(data.tools)) state.tools.add(name);
    for (const name of names(data.groups)) state.groups.add(name);
    for (const name of names(data.considered)) state.considered.add(name);
    // Order matters: a tool may be withheld, released and withheld again.
    for (const name of names(data.released)) state.withheld.delete(name);
    for (const name of names(data.withheld)) state.withheld.add(name);
    if (state.initialTask === undefined && typeof data.initialTask === "string" && data.initialTask.trim()) state.initialTask = data.initialTask.slice(0, MAX_TASK_CHARS);
  }
  return state;
}
const unique = (values: Iterable<string>): string[] => [...new Set(values)];
export interface ToolRecordFields { tools?: Iterable<string>; groups?: Iterable<string>; withheld?: Iterable<string>; released?: Iterable<string>; considered?: Iterable<string>; allowlisted?: Iterable<string>; picks?: ReadonlyMap<string, AdditionPick>; initialTask?: string }
/**
 * Persistent records, split into chunks of at most MAX_NAMES names per list so NOTHING is ever truncated (a 1001st withheld tool must stay
 * owned, and a 1001st available/considered name must stay available). The reader applies every record in order, so chunking is lossless.
 * Returns no record when there is nothing to say.
 */
export function toolRecords(fields: ToolRecordFields): ToolLedgerData[] {
  const lists = (["tools", "groups", "withheld", "released", "considered"] as const).map((key) => [key, fields[key] ? unique(fields[key]!) : []] as const);
  const allowed = new Set(fields.allowlisted ?? []);
  const count = Math.max(0, ...lists.map(([, list]) => Math.ceil(list.length / MAX_NAMES)));
  const initialTask = fields.initialTask?.trim() ? fields.initialTask.slice(0, MAX_TASK_CHARS) : undefined;
  const records: ToolLedgerData[] = [];
  for (let index = 0; index < Math.max(count, initialTask ? 1 : 0); index++) {
    const data: ToolLedgerData = { v: 1 };
    const placed = new Set<string>();
    for (const [key, list] of lists) {
      const chunk = list.slice(index * MAX_NAMES, (index + 1) * MAX_NAMES);
      if (chunk.length) data[key] = chunk;
      if (key === "tools" || key === "groups") for (const name of chunk) placed.add(name);
    }
    // Picks and allowlist marks travel in the record that lists their name (never split from it), so chunking stays lossless and the reader needs no cross-record lookup.
    const picks = [...placed].filter((name) => fields.picks?.has(name)).map((name) => [name, { ...fields.picks!.get(name)! }] as const);
    if (picks.length) data.picks = Object.fromEntries(picks);
    const allowlisted = [...placed].filter((name) => allowed.has(name));
    if (allowlisted.length) data.allowlisted = allowlisted;
    if (index === 0 && initialTask) data.initialTask = initialTask;
    records.push(data);
  }
  return records;
}
export interface ToolNotice {
  customType: typeof TOOLS_NOTICE_TYPE;
  content: string;
  display: false;
  details: { v: 1; tools: string[]; groups: string[]; baseline: boolean };
}
const NOTICE_LIMIT = 100;
function safeName(value: string): string { return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, "_").slice(0, 128); }
function list(values: readonly string[]): string {
  const shown = values.slice(0, NOTICE_LIMIT).map(safeName).join(", ");
  return values.length > NOTICE_LIMIT ? `${shown}, and ${values.length - NOTICE_LIMIT} more` : shown;
}
/**
 * Names-only notice. `baseline` states the whole available set once per branch; later notices only add. It exists because
 * codemode/deferred MCP tools are discoverable but not declared, and Pi's `mcp_servers` section cannot be pruned.
 */
export function buildToolNotice(newTools: readonly string[], newGroups: readonly string[], baseline: boolean): ToolNotice | undefined {
  if (!baseline && !newTools.length && !newGroups.length) return undefined;
  const parts: string[] = [];
  const servers = newGroups.filter((key) => !key.startsWith("ext__"));
  const extensions = newGroups.filter((key) => key.startsWith("ext__"));
  if (servers.length) parts.push(`MCP servers: ${list(servers)}`);
  if (extensions.length) parts.push(`extensions: ${list(extensions)}`);
  if (newTools.length) parts.push(`tools: ${list(newTools)}`);
  // Scoped to what the filter actually withholds: tools reached INDIRECTLY (codemode scripts, tool_search). Direct declarations are Pi's own.
  const content = baseline
    ? `${BASELINE_PREFIX} (through codemode or tool search, not declared to you directly), only these are available now: ${parts.length ? parts.join("; ") : "none"}. Other indirect ones are unavailable unless a later notice adds them, and calls to them are blocked. Tools declared to you directly, built-in tools and unfiltered extension tools are unaffected.`
    : `Tool availability (pi-context-decisions): these indirect MCP servers, extensions or tools are now also available: ${parts.join("; ")}.`;
  return { customType: TOOLS_NOTICE_TYPE, content, display: false, details: { v: 1, tools: unique(newTools).slice(0, MAX_NAMES), groups: unique(newGroups).slice(0, MAX_NAMES), baseline } };
}
