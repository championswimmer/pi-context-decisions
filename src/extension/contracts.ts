import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RegistryLike, BackendSelection } from "../core/backends/factory.ts";
import type { DecisionClient } from "../decision/api.ts";
import type { ContextDecisionsSettings, SettingsLoadResult } from "../settings.ts";
import type { DecisionUsage } from "../decision/types.ts";
import type { ScopedSkill } from "../apps/allowlist.ts";
import type { ProjectAllowlistLists, ProjectAllowlistLoad } from "../project-allowlist.ts";
import type { ToolFilterMode } from "../settings.ts";

/** `appendEntry` records the stable-base ledger; `getActiveTools` chooses Pi's skill-file reader for deltas. */
export type ExtensionHost = Pick<ExtensionAPI, "on" | "registerCommand" | "appendEntry" | "getActiveTools">
  & Partial<Pick<ExtensionAPI, "getCommands" | "getAllTools" | "setActiveTools">>;
export interface ExtensionRegistry extends RegistryLike {
  getProviderAuthStatus?(provider: string): { configured: boolean };
}
export interface CommandContext {
  hasUI: boolean;
  mode: ExtensionContext["mode"];
  cwd?: string;
  ui: Pick<ExtensionUIContext, "select" | "input" | "notify" | "setStatus"> & Partial<Pick<ExtensionUIContext, "custom">>;
  modelRegistry: ExtensionRegistry;
  signal?: AbortSignal;
  /** Present in real command contexts; used only to read the active branch's tool availability ledger. */
  sessionManager?: ExtensionContext["sessionManager"];
}
export interface LastDecision {
  reason: string;
  /** Skills scored this round: never skills that were already advertised. */
  candidates: number;
  /** Skills NEWLY added this round. */
  kept: number;
  /** Skills advertised on this branch after the round (stable base + additions). */
  advertised?: number;
  /** Skills re-delivered after compaction or edits, without being re-scored. */
  redelivered?: number;
  /** Scores were reused for the same task; no decision call was made. */
  cached?: boolean;
  /** `prompt`: a submitted prompt. `queued`: steering/follow-up user text. `tool-round`: after completed tool calls. */
  trigger?: "prompt" | "queued" | "tool-round";
  latencyMs: number;
  errorCode?: string;
  usage?: DecisionUsage;
}
/** The newest tool/MCP filtering round. Counts and safe codes only: never names, task text, arguments or results. */
export interface LastToolDecision {
  reason: "filtered" | "fail-open" | "fail-closed" | "skipped" | "restored";
  mode: ToolFilterMode;
  /** `prompt`/`queued`: new-task rounds. `tool-round`: cached next-best. `catch-up`: late candidates. `gate`: lazy score before a call. `initial`: the first-prompt pick. */
  trigger: "prompt" | "initial" | "queued" | "tool-round" | "catch-up" | "gate";
  /** Candidates scored (or reused) this round. */
  candidates: number;
  /** Newly made available. */
  kept: number;
  /** External candidates available / registered after the round. */
  available: number;
  external: number;
  /** Declared tools currently withheld from the model. */
  withheld: number;
  cached?: boolean;
  latencyMs: number;
  errorCode?: string;
  usage?: DecisionUsage;
}
export interface ToolReportRow {
  name: string; kind: "internal" | "mcp" | "extension";
  /** Canonical group key (`mcp__<server>` or `ext__<extension>`) and its label, when the tool belongs to a group. */
  group?: string; groupLabel?: string;
  /** MCP server label (only for `mcp` tools). */
  server?: string; exposure: string; state: "always" | "allowlisted" | "available" | "unavailable"; description: string;
}
export interface ToolReportGroup { key: string; type: "mcp" | "extension"; label: string; tools: number; toolNames: string[]; available: boolean; allowlisted: boolean; verified: boolean }
/** Names-only local view for `/decisions tools list|mcp list`, status and allowlist pickers. Makes no decision calls. */
export interface ToolReport {
  supported: boolean;
  /** `on`: filtering active. `off`: inactive. `enforce`: settings unreadable but this branch already filters. */
  state: "on" | "off" | "enforce";
  mode: ToolFilterMode;
  rows: ToolReportRow[];
  groups: ToolReportGroup[];
  hidden: number;
  /** Extension tools without usable public provenance: they belong to no group and (in group mode) are never filtered. */
  ungrouped: number;
  withheld: number;
}
export interface Controller {
  ensureLoaded(): Promise<void>;
  getSettings(): ContextDecisionsSettings;
  getSettingsError(): string | undefined;
  getLastDecision(): LastDecision | undefined;
  getLastToolDecision(): LastToolDecision | undefined;
  /** Local inventory + availability on the current branch. `ctx` supplies the session branch and cwd. */
  describeTools(ctx: CommandContext): Promise<ToolReport>;
  getInventory(): ScopedSkill[];
  loadProjectAllowlist(cwd: string): Promise<ProjectAllowlistLoad>;
  /** Names only: the skill list (iterable) or any subset of `{ skills, tools, mcpServers }`; omitted lists keep their value. */
  saveProjectAllowlist(cwd: string, lists: Iterable<string> | ProjectAllowlistLists): Promise<void>;
  update(change: (current: ContextDecisionsSettings) => ContextDecisionsSettings): Promise<void>;
  createClient(selection: BackendSelection, ctx: CommandContext): DecisionClient;
  beginOperation(): { signal: AbortSignal; close(): void };
  report(ctx: CommandContext, message: string, level?: "info" | "warning" | "error"): void;
  setStatus(ctx: CommandContext): void;
}
export function selectionLabel(selection: BackendSelection | null): string {
  if (!selection) return "not configured";
  if (selection.backend === "pi") return `Pi ${selection.provider}/${selection.id}`;
  return `${selection.backend} direct ${selection.model ?? (selection.backend === "typesafe" ? "jev-latest" : "gpt-6-luna")}`;
}
export interface ExtensionDependencies {
  settingsPath: string;
  env?: Record<string, string | undefined>;
  load?: (path: string) => Promise<SettingsLoadResult>;
  save?: (settings: ContextDecisionsSettings, path: string) => Promise<void>;
  createClient?: (selection: BackendSelection, ctx: CommandContext) => DecisionClient;
  report?: Controller["report"];
  /** Test seam for the project allowlist read (defaults to the real bounded file read). */
  loadProjectAllowlist?: Controller["loadProjectAllowlist"];
}
