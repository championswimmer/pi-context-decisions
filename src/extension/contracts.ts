import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RegistryLike, BackendSelection } from "../core/backends/factory.ts";
import type { DecisionClient } from "../decision/api.ts";
import type { ContextDecisionsSettings, SettingsLoadResult } from "../settings.ts";
import type { DecisionUsage } from "../decision/types.ts";
import type { ScopedSkill } from "../apps/allowlist.ts";
import type { ProjectAllowlistLoad } from "../project-allowlist.ts";

/** `appendEntry` records the stable-base ledger; `getActiveTools` chooses Pi's skill-file reader for deltas. */
export type ExtensionHost = Pick<ExtensionAPI, "on" | "registerCommand" | "appendEntry" | "getActiveTools"> & Partial<Pick<ExtensionAPI, "getCommands">>;
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
export interface Controller {
  ensureLoaded(): Promise<void>;
  getSettings(): ContextDecisionsSettings;
  getSettingsError(): string | undefined;
  getLastDecision(): LastDecision | undefined;
  getInventory(): ScopedSkill[];
  loadProjectAllowlist(cwd: string): Promise<ProjectAllowlistLoad>;
  saveProjectAllowlist(cwd: string, names: Iterable<string>): Promise<void>;
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
