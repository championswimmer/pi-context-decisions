import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RegistryLike, BackendSelection } from "../core/backends/factory.ts";
import type { DecisionClient } from "../decision/api.ts";
import type { ContextDecisionsSettings, SettingsLoadResult } from "../settings.ts";
import type { DecisionUsage } from "../decision/types.ts";

export type ExtensionHost = Pick<ExtensionAPI, "on" | "registerCommand">;
export interface ExtensionRegistry extends RegistryLike {
  getProviderAuthStatus?(provider: string): { configured: boolean };
}
export interface CommandContext {
  hasUI: boolean;
  mode: ExtensionContext["mode"];
  ui: Pick<ExtensionUIContext, "select" | "input" | "notify" | "setStatus">;
  modelRegistry: ExtensionRegistry;
  signal?: AbortSignal;
}
export interface LastDecision {
  reason: string;
  candidates: number;
  kept: number;
  latencyMs: number;
  errorCode?: string;
  usage?: DecisionUsage;
}
export interface Controller {
  ensureLoaded(): Promise<void>;
  getSettings(): ContextDecisionsSettings;
  getSettingsError(): string | undefined;
  getLastDecision(): LastDecision | undefined;
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
}
