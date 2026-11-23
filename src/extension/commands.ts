import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSettingsDialog } from "pi-extension-settings-tui/adapter";
import type { DialogRouteComponent } from "pi-extension-settings-tui/dialog";
import type { DynamicPickerOption, ModelPickerEntry } from "pi-extension-settings-tui/schema";
import { buildPickerEntries, type AuthStatus, type PickerEntry } from "../catalog/picker-models.ts";
import { resolveGeminiKey, resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey, type CredentialSource } from "../core/auth.ts";
import { createDeadline } from "../core/control.ts";
import type { BackendSelection } from "../core/backends/factory.ts";
import { DecisionError } from "../decision/errors.ts";
import {
  createContextDecisionsSettingsSchema,
  SettingsError,
  validateBackendSelection,
  type AllowlistCategory,
  type SettingsUiHooks,
} from "../settings.ts";
import {
  normalizeAllowlist,
  normalizeServerAllowlist,
  normalizeToolAllowlist,
  type AllowlistScope,
  type ScopedSkill,
} from "../apps/allowlist.ts";
import { rankSkills } from "../apps/relevance.ts";
import { canonicalServerKey } from "../apps/tool-inventory.ts";
import { globalAllowlistPath, projectAllowlistPath } from "../project-allowlist.ts";
import { createAllowlistComponent, type AllowlistPickerDeps, type AllowlistTheme } from "./allowlist-picker.ts";
import type { CommandContext, Controller, ExtensionHost, ToolReport } from "./contracts.ts";
import { selectionLabel } from "./contracts.ts";
import { historyReportLines, readDecisionsHistory } from "./decisions-history.ts";
import { createHistoryDialogManager } from "./history-dialog.ts";
import { describeError, iconStyleText, sanitizeTerminalText } from "./settings-model.ts";

/**
 * Everything a setting can be changed with lives in the settings dialog (RPC: its select/input menus), so the
 * text command surface is only what the dialog cannot do: read-only reports, the explicit paid self-test and the
 * legacy `pinned` list. `tools`/`mcp` accept only `list`.
 */
const COMMANDS = ["status", "history", "test", "tools", "mcp", "pin", "unpin"];
type DirectProvider = Exclude<BackendSelection["backend"], "pi">;

function cleanLabel(value: string): string { return sanitizeTerminalText(value, 400); }
const safeError = describeError;

/** Thrown by a dialog-scoped context after the dialog closed; callers must drop the work silently. */
class DialogClosedError extends Error {
  constructor() {
    super("Settings dialog closed");
    this.name = "DialogClosedError";
  }
}

/**
 * Lazy, guarded view of a command context for dialog work. `hasUI`/`mode`/`cwd` are read eagerly
 * (plain values, safe); `ui` and `modelRegistry` are read only while the dialog is open, because
 * Pi invalidates every ctx property after a reload. Never spread a ctx and never read `ctx.signal`:
 * in a command that is the agent-run signal, not the dialog's lifetime.
 */
function scopedContext(ctx: CommandContext, signal: AbortSignal | undefined, isOpen: () => boolean): CommandContext {
  const hasUI = ctx.hasUI, mode = ctx.mode, cwd = ctx.cwd;
  let projectTrusted = false;
  try { projectTrusted = ctx.isProjectTrusted?.() === true; } catch { /* unknown trust is untrusted */ }
  const guard = <T,>(read: () => T): T => { if (!isOpen()) throw new DialogClosedError(); return read(); };
  return Object.defineProperties({} as CommandContext, {
    hasUI: { value: hasUI, enumerable: true },
    mode: { value: mode, enumerable: true },
    cwd: { value: cwd, enumerable: true },
    ui: { get: () => guard(() => ctx.ui), enumerable: true },
    modelRegistry: { get: () => guard(() => ctx.modelRegistry), enumerable: true },
    sessionManager: { get: () => guard(() => ctx.sessionManager), enumerable: true },
    signal: { value: signal, enumerable: true },
    isProjectTrusted: { value: () => projectTrusted, enumerable: true },
  });
}

function dialogExtensionContext(
  ctx: CommandContext,
  controller: Controller,
  signal: AbortSignal,
  isOpen: () => boolean,
): ExtensionContext {
  const effectiveMode = ctx.mode === "tui" && ctx.hasUI && !ctx.ui.custom ? "rpc" : ctx.mode;
  const scoped = scopedContext(ctx, signal, isOpen);
  return Object.defineProperties({} as ExtensionContext, {
    hasUI: { value: scoped.hasUI, enumerable: true },
    mode: { value: effectiveMode, enumerable: true },
    cwd: { value: scoped.cwd, enumerable: true },
    signal: { value: signal, enumerable: true },
    isProjectTrusted: { value: scoped.isProjectTrusted, enumerable: true },
    ui: {
      get: () => {
        const raw = scoped.ui;
        return {
          ...raw,
          notify: (message: string, level?: "info" | "warning" | "error") => {
            controller.report(scoped, message, level ?? "info");
          },
        };
      },
      enumerable: true,
    },
    modelRegistry: { get: () => scoped.modelRegistry, enumerable: true },
    sessionManager: { get: () => scoped.sessionManager, enumerable: true },
    scopedModels: {
      get: () => {
        if (!isOpen()) throw new DialogClosedError();
        return (ctx as unknown as { scopedModels?: unknown }).scopedModels;
      },
      enumerable: true,
    },
  });
}

function statusSafely(controller: Controller, ctx: CommandContext): void {
  try { controller.setStatus(ctx); } catch { /* cosmetic; the dialog may have closed */ }
}

function credentialGuide(provider: string, native = false): string {
  if (provider === "gemini") return "Gemini Developer API credentials are missing or unavailable. Set GEMINI_API_KEY or configure Google API-key credentials in Pi.";
  const variable = provider === "typesafe" ? "TYPESAFE_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
  return `${cleanLabel(provider)} credentials are missing or unavailable. ${variable ? `Set ${variable} in the environment or ` : ""}configure /login ${cleanLabel(provider)} in Pi.${provider === "openai" ? ` Use an OpenAI API key, not openai-codex/ChatGPT OAuth.${native ? " If Pi resolves OAuth for openai, choose OpenAI direct with OPENAI_API_KEY instead." : ""}` : ""}`;
}

async function directAuth(provider: DirectProvider, ctx: CommandContext, env?: Record<string, string | undefined>): Promise<{ status: AuthStatus; source?: CredentialSource }> {
  const resolve = provider === "openai" ? resolveOpenAIKey : provider === "typesafe" ? resolveTypeSafeKey : provider === "gemini" ? resolveGeminiKey : resolveOpenRouterKey;
  try {
    const credential = await resolve({ registry: ctx.modelRegistry, env, signal: ctx.signal, timeoutMs: 1500 });
    return { status: "ok", source: credential.source };
  } catch (error) {
    if (error instanceof DecisionError && error.code === "aborted") throw error;
    return { status: "missing" };
  }
}

/** Resolve actual Pi auth, not a cached model inventory or configured-only snapshot. */
async function nativeAuth(provider: string, ctx: CommandContext): Promise<AuthStatus> {
  const deadline = createDeadline({ signal: ctx.signal, timeoutMs: 1500 }, "pi");
  try {
    if (ctx.modelRegistry.getProviderAuth) {
      const result = await deadline.run(ctx.modelRegistry.getProviderAuth(provider, { signal: deadline.signal }));
      if (provider === "openai" && (result?.source === "OAuth" || (result?.source === undefined && ctx.modelRegistry.isUsingOAuth?.({ provider })))) return "missing";
      return result?.auth.apiKey?.trim() ? "ok" : "missing";
    }
    if (provider === "openai" && ctx.modelRegistry.isUsingOAuth?.({ provider })) return "missing";
    return (await deadline.run(ctx.modelRegistry.getApiKeyForProvider(provider)))?.trim() ? "ok" : "missing";
  } catch {
    if (ctx.signal?.aborted) throw new DecisionError("aborted", "Credential lookup aborted", { backend: "pi" });
    return "missing";
  } finally { deadline.close(); }
}

export async function pickerEntries(ctx: CommandContext, env?: Record<string, string | undefined>): Promise<PickerEntry[]> {
  const classifiers = ctx.modelRegistry.getModelsOfType("classifier");
  const providers = [...new Set(classifiers.map((model) => model.provider))];
  const native: Record<string, AuthStatus> = {};
  const auth: Record<string, AuthStatus> = {};
  await Promise.all([
    ...providers.map(async (provider) => { native[provider] = await nativeAuth(provider, ctx); }),
    ...(["openai", "typesafe", "openrouter", "gemini"] as const).map(async (provider) => { auth[provider] = (await directAuth(provider, ctx, env)).status; }),
  ]);
  return buildPickerEntries({ piClassifiers: classifiers, auth: { ...native, ...auth } }).map((entry) =>
    entry.selection.backend === "pi"
      ? { ...entry, authStatus: native[entry.selection.provider] ?? "missing", ...(entry.selection.provider === "openai" && native.openai !== "ok" ? { note: credentialGuide("openai", true) } : {}) }
      : entry,
  );
}

function requireNative(selection: BackendSelection | null, ctx: CommandContext): void {
  if (selection?.backend === "pi" && !ctx.modelRegistry.findOfType("classifier", selection.provider, selection.id)) {
    throw new SettingsError("Selected Pi classifier is not registered; choose a listed native model or direct backend");
  }
}

async function requireCredentials(selection: BackendSelection | null, ctx: CommandContext, env?: Record<string, string | undefined>): Promise<void> {
  if (!selection) return;
  const provider = selection.backend === "pi" ? selection.provider : selection.backend;
  const status = selection.backend === "pi" ? await nativeAuth(provider, ctx) : (await directAuth(selection.backend, ctx, env)).status;
  if (status !== "ok") throw new SettingsError(credentialGuide(provider, selection.backend === "pi"));
}

function authLabel(status: AuthStatus): string {
  return status === "ok" ? "configured" : status === "missing" ? "missing key" : "unverified key";
}

function availableHousekeepingModelEntries(ctx: CommandContext): ModelPickerEntry[] {
  return (ctx.modelRegistry.getAvailable?.() ?? [])
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth?.(model) === true)
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...("thinkingLevelMap" in model && model.thinkingLevelMap !== undefined
        ? { thinkingLevelMap: (model as unknown as ModelPickerEntry).thinkingLevelMap }
        : {}),
    }));
}

function availableHousekeepingModels(ctx: CommandContext): string[] {
  return availableHousekeepingModelEntries(ctx).map((model) => `${model.provider}/${model.id}`).sort();
}

async function resolveCredentialsStatus(
  backend: BackendSelection | null,
  ctx: CommandContext,
  env?: Record<string, string | undefined>,
  options?: { allowUnregisteredNative?: boolean },
): Promise<string> {
  if (!backend) return "not configured";
  const provider = backend.backend === "pi" ? backend.provider : backend.backend;
  if (backend.backend === "pi") {
    if (options?.allowUnregisteredNative && !ctx.modelRegistry.findOfType("classifier", backend.provider, backend.id)) {
      return "Selected Pi classifier is not registered; choose a listed native model or direct backend";
    }
    requireNative(backend, ctx);
    return (await nativeAuth(provider, ctx)) === "ok" ? "Pi configured" : credentialGuide(provider, true);
  }
  const auth = await directAuth(backend.backend, ctx, env);
  return auth.source === "pi"
    ? "Pi-resolved (may include Pi's env fallback)"
    : auth.source === "env"
      ? "environment"
      : credentialGuide(provider);
}

function formatUsageTokens(
  last: NonNullable<ReturnType<Controller["getLastDecision"]> | ReturnType<Controller["getLastToolDecision"]>>,
  settings: ReturnType<Controller["getSettings"]>,
): string[] {
  const usage = last.usage;
  const tokens = usage?.totalTokens !== undefined
    ? [`${usage.totalTokens} tokens`]
    : [
        usage?.inputTokens !== undefined ? `${usage.inputTokens} input tokens` : "",
        usage?.outputTokens !== undefined ? `${usage.outputTokens} output tokens` : "",
      ].filter(Boolean);
  if (usage?.cost !== undefined) tokens.push(`$${usage.cost}${settings.backend?.backend === "pi" ? " (catalog estimate)" : ""}`);
  return tokens;
}

/** Shared, readable last-run details; never dump transport usage objects into status. */
function lastStatusLines(
  last: ReturnType<Controller["getLastDecision"]> | ReturnType<Controller["getLastToolDecision"]>,
  settings: ReturnType<Controller["getSettings"]>,
): string[] {
  if (!last) return [];
  const tokens = formatUsageTokens(last, settings);
  return [
    `  Last (${last.trigger ?? "prompt"}): ${last.reason}${last.errorCode ? ` (${last.errorCode})` : ""}`,
    `    Added ${last.kept} of ${last.candidates} candidates · ${last.cached ? "cached scores (no call)" : `${last.latencyMs}ms`}`,
    ...("available" in last
      ? [`    Available: ${last.available}/${last.external} external · ${last.withheld} withheld`]
      : [last.advertised === undefined ? "" : `    Advertised: ${last.advertised}`].filter(Boolean)),
    ...(tokens.length ? [`    Usage: ${tokens.join(" · ")}`] : []),
  ];
}

function lastStatusMarkdown(
  last: ReturnType<Controller["getLastDecision"]> | ReturnType<Controller["getLastToolDecision"]>,
  settings: ReturnType<Controller["getSettings"]>,
): string[] {
  if (!last) return [];
  const tokens = formatUsageTokens(last, settings);
  const lines = [
    `- **Last (${last.trigger ?? "prompt"})**: \`${last.reason}\`${last.errorCode ? ` (\`${last.errorCode}\`)` : ""}`,
    `- **Round**: added ${last.kept} of ${last.candidates} candidates · ${last.cached ? "cached scores (no call)" : `${last.latencyMs}ms`}`,
  ];
  if ("available" in last) {
    lines.push(`- **Availability**: ${last.available}/${last.external} external · ${last.withheld} withheld`);
  } else if (last.advertised !== undefined) {
    lines.push(`- **Advertised**: ${last.advertised}`);
  }
  if (tokens.length) lines.push(`- **Usage**: ${tokens.join(" · ")}`);
  return lines;
}

/** Tool filtering status. Counts and modes only: no tool names, task text, arguments or results. */
function toolStatusLines(controller: Controller, settings: ReturnType<Controller["getSettings"]>): string[] {
  const t = settings.tools;
  if (!t.enabled) return ["Tool filtering: off (opt-in)", "  Enable in /decisions Tools tab; independent of Skills."];
  return [
    `Tool filtering: on · mode ${t.mode} · picker ${t.cadence}`,
    `  Limits: max ${t.maxAdded} added per round · minimum candidates ${t.minCandidates}`,
    ...(settings.backend ? [] : ["  No decision model selected: every tool stays available."]),
    `  Always allowed (global): ${t.alwaysAllowedTools.length} tools · ${t.alwaysAllowedMcpServers.length} MCP/extension groups`,
    ...lastStatusLines(controller.getLastToolDecision(), settings),
    "  Not a sandbox: built-ins, bash, discovery listings and connections are unaffected.",
    "  Enabling mid-session keeps tools already registered available.",
    "  MCP config scope is captured at session start; disk edits need /reload.",
  ];
}

async function statusLines(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>): Promise<string[]> {
  const settings = controller.getSettings();
  const credentials = await resolveCredentialsStatus(settings.backend, ctx, env);
  const error = controller.getSettingsError();
  const globalAllow = await controller.loadGlobalAllowlist();
  const project = ctx.cwd ? await controller.loadProjectAllowlist(ctx.cwd) : undefined;
  const managerStatus = controller.managerDiagnosticsStatus?.();
  const r = settings.relevance;
  const d = settings.decision;
  const historyStatus = !settings.history.enabled
    ? "off"
    : !settings.history.model
      ? "on (no housekeeping model selected)"
      : availableHousekeepingModels(ctx).includes(settings.history.model)
        ? `on · ${sanitizeTerminalText(settings.history.model, 160)}`
        : "on (model unavailable or unauthenticated)";
  return [
    "Context decisions",
    `  Model: ${selectionLabel(settings.backend)}`,
    `  Credentials: ${credentials}`,
    ...(error ? ["", `Settings error: ${error}`, "  Repair the settings file or choose a model in /decisions."] : []),
    ...(globalAllow.error ? ["", `Global allowlist warning: ${globalAllow.error}`] : []),
    ...(project?.error ? ["", `Project allowlist warning: ${project.error}`] : []),
    "",
    `Skills: ${r.enabled ? "on" : "off"} · picker prompt`,
    `  Limits: max ${r.maxSkills} added per round · minimum inventory ${r.minCandidates}`,
    `  Always allowed: global ${settings.globalAllowlist.length}, project ${project?.names.length ?? 0}`,
    "  Additive advertisements; explicit skill access is unchanged.",
    ...lastStatusLines(controller.getLastDecision(), settings),
    "",
    ...toolStatusLines(controller, settings),
    "",
    "Decision settings (Advanced)",
    `  Threshold: ${d.threshold} (0–1) · on failure: ${d.failMode}`,
    `  Shard size: ${d.chunkSize} · concurrency: ${d.concurrency === 0 ? "all shards" : d.concurrency}`,
    `  Timeout: ${d.timeoutMs}ms`,
    `  Text limits: prompt ${d.maxPromptChars} · description ${d.maxDescriptionChars} chars`,
    "",
    `[lab] Past Turn Summaries: ${historyStatus}`,
    "",
    `Subagents · Allow inherited tools: ${settings.tools.allowSubagentInheritedTools ? controller.subagentManagerPresent?.() ? "on (bridged child tools)" : "on (ineffective: pi-subagent-manager not detected)" : "off"}`,
    ...(managerStatus ? [managerStatus] : []),
  ];
}

async function statusMarkdown(
  controller: Controller,
  ctx: CommandContext,
  env?: Record<string, string | undefined>,
): Promise<string> {
  const settings = controller.getSettings();
  const credentials = await resolveCredentialsStatus(settings.backend, ctx, env, { allowUnregisteredNative: true });
  const error = controller.getSettingsError();
  const globalAllow = await controller.loadGlobalAllowlist();
  const project = ctx.cwd ? await controller.loadProjectAllowlist(ctx.cwd) : undefined;
  const managerStatus = controller.managerDiagnosticsStatus?.();
  const r = settings.relevance;
  const t = settings.tools;
  const d = settings.decision;
  const historyStatus = !settings.history.enabled
    ? "off"
    : !settings.history.model
      ? "on (no housekeeping model selected)"
      : availableHousekeepingModels(ctx).includes(settings.history.model)
        ? `on · \`${sanitizeTerminalText(settings.history.model, 160)}\` (thinking \`${settings.history.thinkingLevel}\`)`
        : "on (model unavailable or unauthenticated)";

  const warnings: string[] = [];
  if (error) {
    warnings.push(`- **Settings error**: ${sanitizeTerminalText(error, 400)} — repair the settings file or choose a model in \`/decisions\`.`);
  }
  for (const warning of [...globalAllow.warnings, ...(globalAllow.error ? [globalAllow.error] : [])]) {
    warnings.push(`- **Global allowlist warning**: ${sanitizeTerminalText(warning, 400)}`);
  }
  if (project) {
    for (const warning of [...project.warnings, ...(project.error ? [project.error] : [])]) {
      warnings.push(`- **Project allowlist warning**: ${sanitizeTerminalText(warning, 400)}`);
    }
  }

  const lines: string[] = [
    "## Context Decisions",
    "",
    `- **Model**: \`${sanitizeTerminalText(selectionLabel(settings.backend), 160)}\``,
    `- **Credentials**: ${sanitizeTerminalText(credentials, 400)}`,
  ];

  if (warnings.length) {
    lines.push("", "### Warnings", "", ...warnings);
  }

  lines.push(
    "",
    "### Skills",
    "",
    `- **Status**: **${r.enabled ? "on" : "off"}** · picker \`prompt\``,
    `- **Limits**: max \`${r.maxSkills}\` added per round · minimum inventory \`${r.minCandidates}\``,
    `- **Always allowed**: global \`${globalAllow.names.length}\`, project \`${project ? project.names.length : "n/a"}\``,
    "- Additive advertisements; explicit skill access is unchanged.",
    ...lastStatusMarkdown(controller.getLastDecision(), settings),
  );

  lines.push("", "### Tools & MCP", "");
  if (!t.enabled) {
    lines.push(
      "- **Status**: **off** (opt-in)",
      "- Enable in the `/decisions` Tools tab; independent of Skills.",
      `- **Always allowed (global)**: \`${globalAllow.tools.length}\` tools · \`${globalAllow.mcpServers.length}\` MCP/extension groups`,
      `- **Always allowed (project)**: \`${project ? project.tools.length : "n/a"}\` tools · \`${project ? project.mcpServers.length : "n/a"}\` MCP/extension groups`,
    );
  } else {
    lines.push(
      `- **Status**: **on** · mode \`${t.mode}\` · picker \`${t.cadence}\``,
      `- **Limits**: max \`${t.maxAdded}\` added per round · minimum candidates \`${t.minCandidates}\``,
      ...(settings.backend ? [] : ["- **Warning**: No decision model selected — every tool stays available."]),
      `- **Always allowed (global)**: \`${globalAllow.tools.length}\` tools · \`${globalAllow.mcpServers.length}\` MCP/extension groups`,
      `- **Always allowed (project)**: \`${project ? project.tools.length : "n/a"}\` tools · \`${project ? project.mcpServers.length : "n/a"}\` MCP/extension groups`,
      ...lastStatusMarkdown(controller.getLastToolDecision(), settings),
      "- Not a sandbox: built-ins, bash, discovery listings and connections are unaffected.",
      "- Enabling mid-session keeps tools already registered available.",
      "- MCP config scope is captured at session start; disk edits need `/reload`.",
    );
  }

  lines.push(
    "",
    "### Decision Tuning",
    "",
    `- **Threshold**: \`${d.threshold}\` (0–1) · **On failure**: \`${d.failMode}\``,
    `- **Shard size**: \`${d.chunkSize}\` · **Concurrency**: \`${d.concurrency === 0 ? "all shards" : d.concurrency}\``,
    `- **Timeout**: \`${d.timeoutMs}ms\``,
    `- **Text limits**: prompt \`${d.maxPromptChars}\` · description \`${d.maxDescriptionChars}\` chars`,
    `- **Footer icons**: \`${iconStyleText(settings)}\``,
  );

  lines.push(
    "",
    "### Lab",
    "",
    `- **[lab] Past Turn Summaries**: ${historyStatus}`,
    `- **[lab] Constant scoring matrix**: **${r.constantMatrix ? "on" : "off"}**`,
  );

  lines.push(
    "",
    "### Subagents",
    "",
    `- **Allow inherited tools**: ${t.allowSubagentInheritedTools ? (controller.subagentManagerPresent?.() ? "**on** (bridged child tools)" : "**on** (ineffective: `pi-subagent-manager` not detected)") : "**off**"}`,
    ...(managerStatus ? [`- ${sanitizeTerminalText(managerStatus, 400)}`] : []),
  );

  return lines.join("\n");
}

async function status(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  controller.report(ctx, (await statusLines(controller, ctx, env)).join("\n"));
}

const KIND_LABEL: Record<AllowlistCategory, string> = { skills: "skill", tools: "tool", mcp: "MCP server" };

function normalizeKind(kind: AllowlistCategory, values: Iterable<unknown>): string[] {
  try {
    return kind === "skills" ? normalizeAllowlist(values) : kind === "tools" ? normalizeToolAllowlist(values) : normalizeServerAllowlist(values);
  } catch {
    throw new SettingsError(
      kind === "skills"
        ? "Allowlist names must be bounded, nonempty identifiers (at most 1000)"
        : kind === "tools"
          ? "Tool names must be 1-128 characters without whitespace or control characters (at most 1000)"
          : "MCP server names, mcp__ namespace keys and ext__ extension keys must match [A-Za-z0-9_-]{1,64}, optionally after the mcp__ or ext__ prefix (at most 1000)",
    );
  }
}

async function listNames(
  controller: Controller,
  ctx: CommandContext,
  scope: AllowlistScope,
  report = true,
  kind: AllowlistCategory = "skills",
): Promise<string[]> {
  const result = scope === "global"
    ? await controller.loadGlobalAllowlist()
    : (() => {
        if (!ctx.cwd) throw new SettingsError("Project allowlist needs a working directory");
        return controller.loadProjectAllowlist(ctx.cwd);
      })();
  const loaded = await result;
  if (report) {
    for (const message of [...loaded.warnings, ...(loaded.error ? [loaded.error] : [])]) {
      controller.report(ctx, message, "warning");
    }
  }
  return kind === "skills" ? loaded.names : kind === "tools" ? loaded.tools : loaded.mcpServers;
}

async function saveNames(
  controller: Controller,
  ctx: CommandContext,
  scope: AllowlistScope,
  values: Iterable<string>,
  kind: AllowlistCategory = "skills",
): Promise<void> {
  const names = normalizeKind(kind, values);
  const payload = kind === "skills" ? { skills: names } : kind === "tools" ? { tools: names } : { mcpServers: names };
  if (scope === "global") {
    await controller.saveGlobalAllowlist(payload);
  } else {
    if (!ctx.cwd) throw new SettingsError("Project allowlist needs a working directory");
    await controller.saveProjectAllowlist(ctx.cwd, payload);
  }
  statusSafely(controller, ctx);
}

/** The nested tool editor saves the tool list AND the group list (MCP servers and extensions) in one write per scope. */
async function saveToolLists(
  controller: Controller,
  ctx: CommandContext,
  scope: AllowlistScope,
  tools: Iterable<string>,
  groups: Iterable<string>,
): Promise<void> {
  const toolNames = normalizeKind("tools", tools);
  const groupNames = normalizeKind("mcp", groups);
  if (scope === "global") {
    await controller.saveGlobalAllowlist({ tools: toolNames, mcpServers: groupNames });
  } else {
    if (!ctx.cwd) throw new SettingsError("Project allowlist needs a working directory");
    await controller.saveProjectAllowlist(ctx.cwd, { tools: toolNames, mcpServers: groupNames });
  }
  statusSafely(controller, ctx);
}

/** Names-only editor items retain the public provenance scope, never the scope of the list being edited. */
function toolPickerItems(report: ToolReport, kind: Exclude<AllowlistCategory, "skills">): ScopedSkill[] {
  const typeOf = (key: string) => report.groups.find((group) => group.key === key)?.type;
  if (kind === "tools") {
    return report.rows.filter((row) => row.kind !== "internal").map((row) => {
      const prefix = row.group && row.groupLabel ? `[${typeOf(row.group) === "extension" ? "extension" : "MCP server"} ${row.groupLabel}] ` : "";
      return { name: row.name, description: `${prefix}${row.description}`, scope: row.scope, disableModelInvocation: false };
    });
  }
  // One row per group, MCP server or extension alike, named by its canonical key (what the group allowlist stores).
  return report.groups.filter((group) => group.scope !== "mixed").map((group) => ({
    name: group.key,
    label: `${group.label} (${group.type === "mcp" ? "MCP server" : "extension"})`,
    scope: group.scope as AllowlistScope,
    disableModelInvocation: false,
    description: `${group.type === "mcp" ? "MCP server" : "Extension"} ${group.label}. Tools: ${group.toolNames.join(", ")}`,
  }));
}

/** The nested tool editor's structure: built-in tools, then each group with ALL its (not truncated) member tools. */
function toolTree(report: ToolReport, initialGroups: readonly string[], scope: AllowlistScope): NonNullable<AllowlistPickerDeps["tree"]> {
  return {
    internal: report.rows.filter((row) => row.kind === "internal").map((row) => ({ name: row.name, description: row.description })),
    groups: report.groups.filter((group) => group.scope === scope).map((group) => ({
      key: group.key,
      label: group.label,
      type: group.type,
      description: "",
      tools: report.rows.filter((row) => row.group === group.key).map((row) => row.name),
    })),
    initialGroups,
  };
}

/**
 * Inputs for the embedded allowlist editor. Every context read goes through `scopedContext`, and
 * ranking uses its own signal (picker + dialog + operation), never `ctx.signal` or a spread ctx.
 */
async function allowlistDeps(
  controller: Controller,
  ctx: CommandContext,
  scope: AllowlistScope,
  env: Record<string, string | undefined> | undefined,
  isOpen: () => boolean,
  dialogSignal: AbortSignal,
  kind: AllowlistCategory = "skills",
): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">> {
  const base = scopedContext(ctx, dialogSignal, isOpen);
  const initial = await listNames(controller, base, scope, false, kind);
  const report = kind === "skills" ? undefined : await controller.describeTools(base);
  const items = report ? toolPickerItems(report, kind as Exclude<AllowlistCategory, "skills">) : controller.getInventory();
  // The tool editor also edits the group list (MCP servers and extensions); read it together with the tool list.
  const initialGroups = kind === "tools" ? await listNames(controller, base, scope, false, "mcp") : undefined;
  const settings = controller.getSettings();
  let unavailable: string | undefined;
  if (controller.getSettingsError()) unavailable = "Repair settings before relevance ranking";
  else if (!settings.backend) unavailable = "Select a decision model in /decisions to enable relevance ranking";
  else {
    try { requireNative(settings.backend, base); await requireCredentials(settings.backend, base, env); }
    catch (error) { unavailable = safeError(error); }
  }
  const rank: AllowlistPickerDeps["rank"] = unavailable ? undefined : async (query, skills, pickerSignal) => {
    if (controller.getSettingsError()) throw new DecisionError("config", "Repair settings before relevance ranking");
    const current = controller.getSettings();
    if (!current.backend) throw new DecisionError("config", "Select a decision model before relevance ranking");
    const operation = controller.beginOperation();
    try {
      const signal = AbortSignal.any([pickerSignal, operation.signal, dialogSignal]);
      const rankingContext = scopedContext(ctx, signal, isOpen);
      requireNative(current.backend, rankingContext);
      await requireCredentials(current.backend, rankingContext, env);
      const client = controller.createClient(current.backend, rankingContext);
      const capped = client as typeof client & { maxQuestions?: number };
      return await rankSkills(
        query,
        skills.map(({ name, description }) => ({ name, description })),
        {
          decide: (request, options) => client.decide(request, options),
          ...(capped.maxQuestions === undefined ? {} : { maxQuestions: capped.maxQuestions }),
        },
        {
          ...current.decision,
          rubric: "topic",
          maxQuestions: 50,
          signal,
          ...(kind === "skills" ? {} : { subject: kind === "tools" ? "tool" as const : "mcp_server" as const }),
        },
      );
    } finally { operation.close(); }
  };
  return {
    scope,
    skills: items,
    initial,
    noun: kind === "mcp" ? "MCP server or extension" : KIND_LABEL[kind] as "skill" | "tool",
    locationLabel: scope === "global" ? globalAllowlistPath(controller.settingsPath) : projectAllowlistPath(base.cwd!),
    ...(kind !== "skills"
      ? {
          scopeNote: "Built-in MCP scope: session-start config capture, honoring project trust; disk edits require /reload. Extensions: public provenance. Unresolved origins use Global.",
          compactScopeNote: "MCP session scope; /reload config edits",
        }
      : {}),
    ...(kind === "mcp" ? { heading: "Always allowed MCP servers & extensions", normalize: canonicalServerKey } : {}),
    ...(kind === "tools" && report ? { tree: toolTree(report, initialGroups ?? [], scope), normalize: canonicalServerKey } : {}),
    save: kind === "tools" && report
      ? (names, groups) => saveToolLists(controller, base, scope, names, groups ?? initialGroups ?? [])
      : (names) => saveNames(controller, base, scope, names, kind),
    ...(rank ? { rank, rankLabel: `${selectionLabel(settings.backend)} · explicit ranking may incur charges` } : { unavailable }),
  };
}

const EDITOR_UNAVAILABLE =
  "The allowlist editors need the interactive terminal UI. Without it, edit global allowlists in <agentDir>/pi-context-decisions/allowlists.json or project allowlists in <cwd>/.pi/pi-context-decisions.json, then /reload.";

function buildUiHooks(
  controller: Controller,
  ctx: CommandContext,
  env: Record<string, string | undefined> | undefined,
  dialogSignal: AbortSignal,
  isOpen: () => boolean,
): SettingsUiHooks {
  const cwd = ctx.cwd;
  const scoped = (signal?: AbortSignal) => scopedContext(ctx, signal ?? dialogSignal, isOpen);

  return {
    async loadBackendOptions(pickerCtx): Promise<readonly DynamicPickerOption<BackendSelection | null>[]> {
      const signal = AbortSignal.any([dialogSignal, pickerCtx.signal]);
      const entries = await pickerEntries(scoped(signal), env);
      return entries.map((entry) => {
        const provider = entry.selection.backend === "pi" ? entry.selection.provider : entry.selection.backend;
        return {
          id: JSON.stringify(entry.selection),
          value: entry.selection as BackendSelection,
          label: sanitizeTerminalText(entry.label, 120),
          group:
            entry.group === "pi-native"
              ? "Pi internal classifiers"
              : entry.group === "openrouter-catalog"
                ? "OpenRouter"
                : "Direct API",
          badge: authLabel(entry.authStatus),
          badgeTone: entry.authStatus === "ok" ? "success" : "warn",
          disabled: entry.authStatus !== "ok",
          ...(entry.authStatus !== "ok"
            ? { disabledReason: credentialGuide(provider, entry.selection.backend === "pi") }
            : {}),
          description: entry.note
            ? `${selectionLabel(entry.selection)} — ${sanitizeTerminalText(entry.note, 520)}`
            : selectionLabel(entry.selection),
        };
      });
    },

    async validateBackendSelection(option, pickerCtx) {
      if (option.value === null) return true;
      const signal = AbortSignal.any([dialogSignal, pickerCtx.signal]);
      try {
        const validated = validateBackendSelection(option.value);
        const sctx = scoped(signal);
        requireNative(validated, sctx);
        await requireCredentials(validated, sctx, env);
        return true;
      } catch (err) {
        if (err instanceof DialogClosedError || signal.aborted) return false;
        return safeError(err);
      }
    },

    isSubagentManagerPresent: () => controller.subagentManagerPresent?.() ?? false,

    getAvailableHousekeepingModels: () => availableHousekeepingModelEntries(scoped()),

    isHousekeepingModelUsable: (selection) => availableHousekeepingModels(scoped()).includes(selection.model),

    renderStatusMarkdown: (viewCtx) => {
      const signal = AbortSignal.any([dialogSignal, viewCtx.signal]);
      return statusMarkdown(controller, scoped(signal), env);
    },

    async externalAllowlistSummary(scope, kind) {
      if (scope === "project" && !cwd) {
        return { text: "n/a", tone: "muted" };
      }
      const result = scope === "global"
        ? await controller.loadGlobalAllowlist()
        : await controller.loadProjectAllowlist(cwd!);
      const list = kind === "skills" ? result.names : kind === "tools" ? result.tools : result.mcpServers;
      const hasWarning = Boolean(result.error || result.warnings.length);
      return hasWarning
        ? { text: `${list.length} ⚠`, tone: "warn" }
        : { text: String(list.length) };
    },

    async openAllowlistSubroute(scope, kind, params): Promise<DialogRouteComponent> {
      if (scope === "project" && !cwd) {
        throw new SettingsError("No working directory is available for a project list.");
      }
      const signal = AbortSignal.any([dialogSignal, params.signal]);
      const deps = await allowlistDeps(controller, ctx, scope, env, isOpen, signal, kind);
      let lastReport: string | undefined;
      const component = createAllowlistComponent(
        {
          requestRender: params.requestRender,
          terminal: (params.tui as { terminal?: { readonly rows: number } } | undefined)?.terminal,
        },
        params.theme as AllowlistTheme,
        (saved) => {
          params.close({
            saved,
            ...(saved ? { message: lastReport ?? "Always-allowed list saved", tone: "success" as const } : {}),
          });
        },
        {
          ...deps,
          maxRows: params.getMaxHeight,
          report: (message) => {
            lastReport = sanitizeTerminalText(message, 200);
          },
        },
      );
      return component;
    },

    async rpcAllowlistRun(_scope, _kind, rpcCtx) {
      const target = rpcCtx && typeof rpcCtx === "object" && "ui" in rpcCtx
        ? (rpcCtx as CommandContext)
        : scoped();
      controller.report(target, EDITOR_UNAVAILABLE, "warning");
    },
  };
}

export interface RegisteredCommands {
  /** Synchronously closes any open settings or history dialogs; resolves pending command handlers. */
  closeDialogs(): void;
}

const LIST_LIMIT = 100;

/** Local, names-only inventory view. Makes no decision calls. */
function toolListLines(report: ToolReport, which: "tools" | "mcp"): string[] {
  if (!report.supported) return ["This Pi host does not expose getAllTools/setActiveTools: tool filtering is inert."];
  const state = report.state === "on"
    ? `filtering on · mode ${report.mode}`
    : report.state === "enforce"
      ? "settings unreadable: enforcing this branch's ledger"
      : "filtering off: everything is available";
  const lines: string[] = [];
  if (which === "mcp") {
    lines.push(`MCP servers and extensions (${report.groups.length}, ${state}); grouped only by Pi's public metadata (mcp__ namespace for servers, sourceInfo for extensions):`);
    for (const group of report.groups.slice(0, LIST_LIMIT)) {
      lines.push(`  ${group.type === "mcp" ? "MCP" : "extension"} ${cleanLabel(group.label)} (${group.key}) · ${group.tools} tools · ${group.available ? (group.allowlisted ? "allowlisted" : "available") : "unavailable"}${group.type === "mcp" && !group.verified ? " · not registered by Pi's built-in MCP" : ""}`);
    }
    if (report.groups.length > LIST_LIMIT) lines.push(`  … and ${report.groups.length - LIST_LIMIT} more`);
    lines.push("Resource-only or disconnected servers with no tools are not editor candidates: the Tools tab cannot add them. Pin file-configured names in their defining scope (global allowlists.json alwaysAllowedMcpServers or project .pi/pi-context-decisions.json). Unknown origins use Global; then /reload.");
    if (report.ungrouped) lines.push(`${report.ungrouped} extension tools expose no usable provenance: they belong to no group and are never filtered in mcp mode.`);
    return lines;
  }
  const external = report.rows.filter((row) => row.kind !== "internal");
  lines.push(`Tools (${external.length} external, ${report.rows.length - external.length} internal always allowed, ${report.hidden} hidden; ${state}):`);
  for (const row of external.slice(0, LIST_LIMIT)) {
    lines.push(`  ${cleanLabel(row.name)} · ${row.kind === "mcp" ? `MCP ${cleanLabel(row.server ?? "")}` : row.groupLabel ? `extension ${cleanLabel(row.groupLabel)}` : "extension"} · ${row.exposure} · ${row.state}`);
  }
  if (external.length > LIST_LIMIT) lines.push(`  … and ${external.length - LIST_LIMIT} more`);
  if (report.withheld) lines.push(`${report.withheld} declared tools are currently withheld from the model on this branch.`);
  return lines;
}

export function registerCommands(pi: ExtensionHost, controller: Controller, env?: Record<string, string | undefined>): RegisteredCommands {
  const activeAborts = new Set<AbortController>();
  const historyDialogs = createHistoryDialogManager();
  const terminal = (ctx: CommandContext) => ctx.mode === "tui" && !!ctx.ui.custom;

  const openSettings = async (ctx: CommandContext): Promise<void> => {
    const dialogAbort = new AbortController();
    activeAborts.add(dialogAbort);
    let open = true;
    const isOpen = () => open && !dialogAbort.signal.aborted;
    const scoped = (signal?: AbortSignal) => scopedContext(ctx, signal ?? dialogAbort.signal, isOpen);
    try {
      const uiHooks = buildUiHooks(controller, ctx, env, dialogAbort.signal, isOpen);
      const schema = createContextDecisionsSettingsSchema(uiHooks);
      const store = controller.createDialogStore(schema);
      const result = await openSettingsDialog(dialogExtensionContext(ctx, controller, dialogAbort.signal, isOpen), {
        schema,
        store,
        cwd: ctx.cwd,
        onApply: (nextFlat) => {
          controller.applyFlatSettings(nextFlat);
          if (isOpen()) statusSafely(controller, scoped());
        },
      });
      if (result.closedBy === "headless") {
        await status(controller, ctx, env);
      }
    } finally {
      open = false;
      activeAborts.delete(dialogAbort);
      dialogAbort.abort();
    }
  };

  const openHistory = async (ctx: CommandContext): Promise<void> => {
    if (terminal(ctx)) {
      await historyDialogs.open(ctx, (life) => async (signal) => {
        const session = scopedContext(ctx, signal, life.isOpen).sessionManager;
        if (!session) throw new SettingsError("This Pi host does not expose session history");
        return readDecisionsHistory(session, controller.historyToolGroups());
      });
      return;
    }
    if (!ctx.sessionManager) throw new SettingsError("This Pi host does not expose session history");
    controller.report(ctx, historyReportLines(readDecisionsHistory(ctx.sessionManager, controller.historyToolGroups())).join("\n"));
  };

  /* Read-only inventory reports: `tools list` / `mcp list`. Everything editable lives in the dialog. */
  const listCommand = async (ctx: CommandContext, which: "tools" | "mcp", tokens: string[]): Promise<void> => {
    if (tokens.length !== 1 || tokens[0] !== "list") {
      throw new SettingsError(`Use /decisions ${which} list. Change tool and MCP settings and allowlists in the /decisions Tools tab`);
    }
    controller.report(ctx, toolListLines(await controller.describeTools(ctx), which).join("\n"));
  };

  pi.registerCommand("decisions", {
    description: "Context decisions settings dialog (also: status, history, test, tools list, mcp list)",
    getArgumentCompletions(prefix) {
      const values = COMMANDS.filter((value) => value.startsWith(prefix));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      await controller.ensureLoaded();
      try {
        const tokens = args.trim().split(/\s+/u).filter(Boolean);
        const action = tokens.shift();
        if (!action) {
          await openSettings(ctx);
          return;
        }
        if (action === "status" && !tokens.length) await status(controller, ctx, env);
        else if (action === "history" && !tokens.length) await openHistory(ctx);
        else if (action === "tools" || action === "mcp") await listCommand(ctx, action, tokens);
        else if ((action === "pin" || action === "unpin") && tokens.length === 1) {
          await controller.update((current) => ({
            ...current,
            relevance: {
              ...current.relevance,
              pinned: action === "pin"
                ? [...new Set([...current.relevance.pinned, tokens[0]])]
                : current.relevance.pinned.filter((name) => name !== tokens[0]),
            },
          }));
          controller.report(ctx, "Pinned skills updated");
        } else if (action === "test" && !tokens.length) {
          if (controller.getSettingsError()) throw new SettingsError("Repair settings before testing a decision model");
          const settings = controller.getSettings();
          if (!settings.backend) throw new SettingsError("Select a decision model before testing");
          requireNative(settings.backend, ctx);
          await requireCredentials(settings.backend, ctx, env);
          const start = Date.now();
          const operation = controller.beginOperation();
          try {
            const signal = ctx.signal ? AbortSignal.any([ctx.signal, operation.signal]) : operation.signal;
            const result = await controller.createClient(settings.backend, ctx).bool(
              { task: "Synthetic extension self-test" },
              { instructions: "Does state.task describe a synthetic test?" },
              { signal, timeoutMs: settings.decision.timeoutMs },
            );
            controller.report(ctx, `Synthetic bool test: probability ${result.answer.probability}, ${Date.now() - start}ms${result.response.usage ? `; usage ${JSON.stringify(result.response.usage)}` : ""}`);
          } finally { operation.close(); }
        } else {
          throw new SettingsError(`Use /decisions ${COMMANDS.join("|")}`);
        }
      } catch (error) {
        if (error instanceof DialogClosedError) return;
        controller.report(ctx, safeError(error), "error");
      }
    },
  });

  return {
    closeDialogs() {
      for (const abort of [...activeAborts]) abort.abort();
      historyDialogs.closeAll();
    },
  };
}
