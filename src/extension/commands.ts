import { buildPickerEntries, type AuthStatus, type PickerEntry } from "../catalog/picker-models.ts";
import { OPENROUTER_DECISION_SNAPSHOT } from "../catalog/openrouter-models.ts";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey, type CredentialSource } from "../core/auth.ts";
import { createDeadline } from "../core/control.ts";
import type { BackendSelection } from "../core/backends/factory.ts";
import { DecisionError } from "../decision/errors.ts";
import { SettingsError, updateSetting, validateBackendSelection } from "../settings.ts";
import { normalizeAllowlist, normalizeServerAllowlist, normalizeToolAllowlist, type AllowlistScope, type ScopedSkill } from "../apps/allowlist.ts";
import { rankSkills } from "../apps/relevance.ts";
import { canonicalServerKey } from "../apps/tool-inventory.ts";
import { projectAllowlistPath } from "../project-allowlist.ts";
import type { AllowlistPickerDeps } from "./allowlist-picker.ts";
import type { CommandContext, Controller, ExtensionHost } from "./contracts.ts";
import { selectionLabel } from "./contracts.ts";
import { createSettingsDialogManager, type DialogLife, type InitialRoute, type ModelRow, type ProviderRow, type SettingsDialogOps } from "./settings-dialog.ts";
import { ADVANCED_FIELDS, SKILL_FIELDS, TOOL_FIELDS, describeError, fieldValue, sanitizeTerminalText, type AdvancedField, type SettingsGroup } from "./settings-model.ts";
import type { AllowlistKind } from "./settings-dialog.ts";
import type { ToolReport } from "./contracts.ts";
import { readDecisionsHistory, historyReportLines } from "./decisions-history.ts";

/**
 * Everything a setting can be changed with lives in the settings dialog (RPC: its select/input menus), so the
 * text command surface is only what the dialog cannot do: read-only reports, the explicit paid self-test and the
 * legacy `pinned` list. `tools`/`mcp` accept only `list`.
 */
const COMMANDS = ["status", "history", "test", "tools", "mcp", "pin", "unpin"];
type DirectProvider = "openai" | "typesafe" | "openrouter";
function cleanLabel(value: string): string { return sanitizeTerminalText(value, 400); }
const safeError = describeError;
/** Thrown by a dialog-scoped context after the dialog closed; callers must drop the work silently. */
export class DialogClosedError extends Error { constructor() { super("Settings dialog closed"); this.name = "DialogClosedError"; } }
/**
 * Lazy, guarded view of a command context for dialog work. `hasUI`/`mode`/`cwd` are read eagerly
 * (plain values, safe); `ui` and `modelRegistry` are read only while the dialog is open, because
 * Pi invalidates every ctx property after a reload. Never spread a ctx and never read `ctx.signal`:
 * in a command that is the agent-run signal, not the dialog's lifetime.
 */
export function scopedContext(ctx: CommandContext, signal: AbortSignal | undefined, isOpen: () => boolean): CommandContext {
  const hasUI = ctx.hasUI, mode = ctx.mode, cwd = ctx.cwd;
  const guard = <T,>(read: () => T): T => { if (!isOpen()) throw new DialogClosedError(); return read(); };
  return Object.defineProperties({} as CommandContext, {
    hasUI: { value: hasUI, enumerable: true }, mode: { value: mode, enumerable: true }, cwd: { value: cwd, enumerable: true },
    ui: { get: () => guard(() => ctx.ui), enumerable: true },
    modelRegistry: { get: () => guard(() => ctx.modelRegistry), enumerable: true },
    sessionManager: { get: () => guard(() => ctx.sessionManager), enumerable: true },
    signal: { value: signal, enumerable: true },
  });
}
function statusSafely(controller: Controller, ctx: CommandContext): void { try { controller.setStatus(ctx); } catch { /* cosmetic; the dialog may have closed */ } }
function credentialGuide(provider: string, native = false): string {
  const variable = provider === "typesafe" ? "TYPESAFE_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
  return `${cleanLabel(provider)} credentials are missing or unavailable. ${variable ? `Set ${variable} in the environment or ` : ""}configure /login ${cleanLabel(provider)} in Pi.${provider === "openai" ? ` Use an OpenAI API key, not openai-codex/ChatGPT OAuth.${native ? " If Pi resolves OAuth for openai, choose OpenAI direct with OPENAI_API_KEY instead." : ""}` : ""}`;
}
async function directAuth(provider: DirectProvider, ctx: CommandContext, env?: Record<string, string | undefined>): Promise<{ status: AuthStatus; source?: CredentialSource }> {
  const resolve = provider === "openai" ? resolveOpenAIKey : provider === "typesafe" ? resolveTypeSafeKey : resolveOpenRouterKey;
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
  } catch (error) {
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
    ...(["openai", "typesafe", "openrouter"] as const).map(async (provider) => { auth[provider] = (await directAuth(provider, ctx, env)).status; }),
  ]);
  return buildPickerEntries({ piClassifiers: classifiers, auth: { ...native, ...auth } }).map((entry) => entry.selection.backend === "pi"
    ? { ...entry, authStatus: native[entry.selection.provider] ?? "missing", ...(entry.selection.provider === "openai" && native.openai !== "ok" ? { note: credentialGuide("openai", true) } : {}) }
    : entry);
}
function requireNative(selection: BackendSelection | null, ctx: CommandContext): void {
  if (selection?.backend === "pi" && !ctx.modelRegistry.findOfType("classifier", selection.provider, selection.id)) throw new SettingsError("Selected Pi classifier is not registered; choose a listed native model or direct backend");
}
async function requireCredentials(selection: BackendSelection | null, ctx: CommandContext, env?: Record<string, string | undefined>): Promise<void> {
  if (!selection) return;
  const provider = selection.backend === "pi" ? selection.provider : selection.backend;
  const status = selection.backend === "pi" ? await nativeAuth(provider, ctx) : (await directAuth(selection.backend, ctx, env)).status;
  if (status !== "ok") throw new SettingsError(credentialGuide(provider, selection.backend === "pi"));
}
function authLabel(status: AuthStatus): string { return status === "ok" ? "configured" : status === "missing" ? "missing key" : "unverified key"; }
async function saveModel(controller: Controller, ctx: CommandContext, selection: BackendSelection | null, env?: Record<string, string | undefined>): Promise<string> {
  requireNative(selection, ctx);
  await requireCredentials(selection, ctx, env);
  await controller.update((settings) => ({ ...settings, backend: selection }));
  statusSafely(controller, ctx);
  return `Decision model: ${selectionLabel(selection)}. ${selection ? "Eligible prompts send bounded task text and skill name/description metadata when enabled." : "No decision calls until a model is chosen."}`;
}
async function persistModel(controller: Controller, ctx: CommandContext, selection: BackendSelection | null, env?: Record<string, string | undefined>) {
  controller.report(ctx, await saveModel(controller, ctx, selection, env));
}
async function chooseModel(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>, filter?: (entry: PickerEntry) => boolean) {
  controller.report(ctx, `Checking credential availability; ${OPENROUTER_DECISION_SNAPSHOT.attribution}`);
  const entries = (await pickerEntries(ctx, env)).filter(filter ?? (() => true));
  if (!entries.length) throw new SettingsError("No matching registered classifiers; choose a direct provider or register a Pi classifier");
  const labels = entries.map((entry, index) => `${index + 1}. ${cleanLabel(entry.label)} [${authLabel(entry.authStatus)}] · ${cleanLabel(selectionLabel(entry.selection))}`);
  const picked = await ctx.ui.select("Decisions · select model (no inference)", [...labels, "None (no decision calls)"], { signal: ctx.signal });
  if (picked === undefined) return;
  if (picked === "None (no decision calls)") return persistModel(controller, ctx, null, env);
  const index = labels.indexOf(picked);
  if (index < 0) throw new SettingsError("Invalid picker selection");
  const entry = entries[index];
  if (entry.authStatus !== "ok") throw new SettingsError(credentialGuide(entry.selection.backend === "pi" ? entry.selection.provider : entry.selection.backend, entry.selection.backend === "pi"));
  if (entry.note) controller.report(ctx, cleanLabel(entry.note));
  await persistModel(controller, ctx, validateBackendSelection(entry.selection), env);
}
interface ProviderChoice { backend: "pi" | DirectProvider; provider: string; status: AuthStatus; label: string; name: string }
async function providerChoices(ctx: CommandContext, env?: Record<string, string | undefined>): Promise<ProviderChoice[]> {
  const entries = await pickerEntries(ctx, env);
  const choices: ProviderChoice[] = [];
  for (const provider of ["typesafe", "openai", "openrouter"] as const) {
    const entry = entries.find((item) => item.selection.backend === provider);
    choices.push({ backend: provider, provider, status: entry?.authStatus ?? "missing", name: `${provider} · direct API`, label: `${provider} · direct API [${authLabel(entry?.authStatus ?? "missing")}]` });
  }
  for (const entry of entries) {
    const selection = entry.selection;
    if (selection.backend !== "pi" || choices.some((choice) => choice.backend === "pi" && choice.provider === selection.provider)) continue;
    choices.push({ backend: "pi", provider: selection.provider, status: entry.authStatus, name: `${cleanLabel(selection.provider)} · Pi internal classifier pipeline`, label: `${cleanLabel(selection.provider)} · Pi internal classifier pipeline [${authLabel(entry.authStatus)}]` });
  }
  return choices;
}
async function chooseProvider(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  const choices = await providerChoices(ctx, env);
  const selected = await ctx.ui.select("Decisions · provider and execution path", [...choices.map((choice) => choice.label), "Cancel"], { signal: ctx.signal });
  const choice = choices.find((item) => item.label === selected);
  if (!choice) return;
  if (choice.status !== "ok") throw new SettingsError(credentialGuide(choice.provider, choice.backend === "pi"));
  await chooseModel(controller, ctx, env, (entry) => entry.selection.backend === choice.backend && (entry.selection.backend !== "pi" || entry.selection.provider === choice.provider));
}
async function statusLines(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>): Promise<string[]> {
  const settings = controller.getSettings();
  let credentials = "not configured";
  if (settings.backend) {
    const provider = settings.backend.backend === "pi" ? settings.backend.provider : settings.backend.backend;
    if (settings.backend.backend === "pi") {
      requireNative(settings.backend, ctx);
      credentials = await nativeAuth(provider, ctx) === "ok" ? "Pi configured" : credentialGuide(provider, true);
    } else {
      const auth = await directAuth(settings.backend.backend, ctx, env);
      credentials = auth.source === "pi" ? "Pi-resolved (may include Pi's env fallback)" : auth.source === "env" ? "environment" : credentialGuide(provider);
    }
  }
  const last = controller.getLastDecision();
  const error = controller.getSettingsError();
  const project = ctx.cwd ? await controller.loadProjectAllowlist(ctx.cwd) : undefined;
  return [
    `Context decisions: ${selectionLabel(settings.backend)}`,
    `Credentials: ${credentials}`,
    `Skills: ${settings.relevance.enabled ? "on" : "off"} · picker ${settings.relevance.cadence} · max ${settings.relevance.maxSkills} added per round · minimum inventory ${settings.relevance.minCandidates}. Skills are only ever added; already-added skills are never re-scored`,
    `Shared tuning (Advanced): threshold ${settings.decision.threshold} (0–1), fail-${settings.decision.failMode}; shard ${settings.decision.chunkSize}, concurrency ${settings.decision.concurrency === 0 ? "all shards parallel (0)" : settings.decision.concurrency}, timeout ${settings.decision.timeoutMs}ms, prompt ${settings.decision.maxPromptChars} chars, description ${settings.decision.maxDescriptionChars} chars. Skill/tool picking policy; limits also apply to allowlist ranking`,
    `Always-allowed lists: global ${settings.globalAllowlist.length}, project ${project?.names.length ?? 0} (${ctx.cwd ? cleanLabel(projectAllowlistPath(ctx.cwd)) : "no cwd"})`,
    ...(project?.error ? [`Project allowlist warning: ${project.error}`] : []),
    ...(error ? [`Settings error: ${error}. Repair the settings file, or choose a model in /decisions.`] : []),
    ...(last ? [`Last (${last.trigger ?? "prompt"}): ${last.reason}, +${last.kept} of ${last.candidates} candidates${last.advertised === undefined ? "" : `, ${last.advertised} advertised`}${last.redelivered ? `, ${last.redelivered} re-delivered` : ""}${last.cached ? ", cached scores (no call)" : `, ${last.latencyMs}ms`}${last.errorCode ? ` (${last.errorCode})` : ""}${last.usage ? `; usage ${JSON.stringify(last.usage)}${settings.backend?.backend === "pi" ? " (cost, when present, is a catalog estimate)" : ""}` : ""}`] : []),
    ...toolStatusLines(controller, settings),
    OPENROUTER_DECISION_SNAPSHOT.attribution,
    "Skill advertisements are additive and never change explicit skill access.",
  ];
}
/** Tool filtering status. Counts and modes only: no tool names, task text, arguments or results. */
function toolStatusLines(controller: Controller, settings: ReturnType<Controller["getSettings"]>): string[] {
  const t = settings.tools;
  if (!t.enabled) return ["Tool filtering: off (opt-in, separate from skill filtering; turn it on in the /decisions Tools tab)"];
  const last = controller.getLastToolDecision();
  return [
    `Tool filtering: on · mode ${t.mode} · picker ${t.cadence} · max ${t.maxAdded} added per round · minimum ${t.minCandidates}${settings.backend ? "" : " · no decision model selected: every tool stays available"}`,
    `Tool allowlists: tools global ${t.alwaysAllowedTools.length}, MCP servers & extensions global ${t.alwaysAllowedMcpServers.length}`,
    "Tool allowlists match public sourceInfo.scope: global = user/temporary/unknown, project = project only. Built-in MCP does not expose server config origins; its tools follow the global list.",
    ...(last ? [`Last tool round (${last.trigger}): ${last.reason}, +${last.kept} of ${last.candidates} candidates, ${last.available}/${last.external} available, ${last.withheld} withheld${last.cached ? ", cached scores (no call)" : `, ${last.latencyMs}ms`}${last.errorCode ? ` (${last.errorCode})` : ""}${last.usage ? `; usage ${JSON.stringify(last.usage)}` : ""}`] : []),
    "Tool filtering hides declared tools and blocks calls to unavailable external tools through Pi's tool pipeline. It is not a sandbox: bash, discovery listings (the mcp_servers prompt section, codemode searchTools, tool_search results) and MCP server connections are unaffected. Pi's built-in tools are never filtered. Enabling it mid-session keeps tools already registered available on that branch.",
  ];
}
async function status(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  controller.report(ctx, (await statusLines(controller, ctx, env)).join("\n"));
}
const KIND_LABEL: Record<AllowlistKind, string> = { skills: "skill", tools: "tool", mcp: "MCP server" };
function globalList(settings: ReturnType<Controller["getSettings"]>, kind: AllowlistKind): string[] {
  return kind === "skills" ? settings.globalAllowlist : kind === "tools" ? settings.tools.alwaysAllowedTools : settings.tools.alwaysAllowedMcpServers;
}
function normalizeKind(kind: AllowlistKind, values: Iterable<unknown>): string[] {
  try { return kind === "skills" ? normalizeAllowlist(values) : kind === "tools" ? normalizeToolAllowlist(values) : normalizeServerAllowlist(values); }
  catch {
    throw new SettingsError(kind === "skills" ? "Allowlist names must be bounded, nonempty identifiers (at most 1000)"
      : kind === "tools" ? "Tool names must be 1-128 characters without whitespace or control characters (at most 1000)"
      : "MCP server names, mcp__ namespace keys and ext__ extension keys must match [A-Za-z0-9_-]{1,64}, optionally after the mcp__ or ext__ prefix (at most 1000)");
  }
}
async function listNames(controller: Controller, ctx: CommandContext, scope: AllowlistScope, report = true, kind: AllowlistKind = "skills"): Promise<string[]> {
  if (scope === "global") return globalList(controller.getSettings(), kind);
  if (!ctx.cwd) throw new SettingsError("Project allowlist needs a working directory");
  const result = await controller.loadProjectAllowlist(ctx.cwd);
  if (report) for (const message of [...result.warnings, ...(result.error ? [result.error] : [])]) controller.report(ctx, message, "warning");
  return kind === "skills" ? result.names : kind === "tools" ? result.tools : result.mcpServers;
}
async function saveNames(controller: Controller, ctx: CommandContext, scope: AllowlistScope, values: Iterable<string>, kind: AllowlistKind = "skills"): Promise<void> {
  const names = normalizeKind(kind, values);
  if (scope === "global") {
    if (controller.getSettingsError()) throw new SettingsError("Repair settings before saving the global allowlist");
    await controller.update((settings) => kind === "skills" ? { ...settings, globalAllowlist: names }
      : { ...settings, tools: { ...settings.tools, ...(kind === "tools" ? { alwaysAllowedTools: names } : { alwaysAllowedMcpServers: names }) } });
  } else {
    if (!ctx.cwd) throw new SettingsError("Project allowlist needs a working directory");
    await controller.saveProjectAllowlist(ctx.cwd, kind === "skills" ? { skills: names } : kind === "tools" ? { tools: names } : { mcpServers: names });
  }
  statusSafely(controller, ctx);
}
/** The nested tool editor saves the tool list AND the group list (MCP servers and extensions) in one write per scope. */
async function saveToolLists(controller: Controller, ctx: CommandContext, scope: AllowlistScope, tools: Iterable<string>, groups: Iterable<string>): Promise<void> {
  const toolNames = normalizeKind("tools", tools);
  const groupNames = normalizeKind("mcp", groups);
  if (scope === "global") {
    if (controller.getSettingsError()) throw new SettingsError("Repair settings before saving the global allowlist");
    await controller.update((settings) => ({ ...settings, tools: { ...settings.tools, alwaysAllowedTools: toolNames, alwaysAllowedMcpServers: groupNames } }));
  } else {
    if (!ctx.cwd) throw new SettingsError("Project allowlist needs a working directory");
    await controller.saveProjectAllowlist(ctx.cwd, { tools: toolNames, mcpServers: groupNames });
  }
  statusSafely(controller, ctx);
}
/** Names-only editor items retain the public provenance scope, never the scope of the list being edited. */
function toolPickerItems(report: ToolReport, kind: Exclude<AllowlistKind, "skills">): ScopedSkill[] {
  const typeOf = (key: string) => report.groups.find((group) => group.key === key)?.type;
  if (kind === "tools") {
    return report.rows.filter((row) => row.kind !== "internal").map((row) => {
      const prefix = row.group && row.groupLabel ? `[${typeOf(row.group) === "extension" ? "extension" : "MCP server"} ${row.groupLabel}] ` : "";
      return { name: row.name, description: `${prefix}${row.description}`, scope: row.scope, disableModelInvocation: false };
    });
  }
  // One row per group, MCP server or extension alike, named by its canonical key (what the group allowlist stores).
  return report.groups.filter((group) => group.scope !== "mixed").map((group) => ({ name: group.key, label: `${group.label} (${group.type === "mcp" ? "MCP server" : "extension"})`, scope: group.scope as AllowlistScope, disableModelInvocation: false,
    description: `${group.type === "mcp" ? "MCP server" : "Extension"} ${group.label}. Tools: ${group.toolNames.join(", ")}` }));
}
/** The nested tool editor's structure: built-in tools, then each group with ALL its (not truncated) member tools. */
function toolTree(report: ToolReport, initialGroups: readonly string[], scope: AllowlistScope): NonNullable<AllowlistPickerDeps["tree"]> {
  return {
    internal: report.rows.filter((row) => row.kind === "internal").map((row) => ({ name: row.name, description: row.description })),
    groups: report.groups.filter((group) => group.scope === scope).map((group) => ({ key: group.key, label: group.label, type: group.type, description: "", tools: report.rows.filter((row) => row.group === group.key).map((row) => row.name) })),
    initialGroups,
  };
}
/**
 * Inputs for the embedded allowlist editor. Every context read goes through `scopedContext`, and
 * ranking uses its own signal (picker + dialog + operation), never `ctx.signal` or a spread ctx.
 */
async function allowlistDeps(controller: Controller, ctx: CommandContext, scope: AllowlistScope, env: Record<string, string | undefined> | undefined,
  isOpen: () => boolean, dialogSignal: AbortSignal, kind: AllowlistKind = "skills"): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">> {
  const base = scopedContext(ctx, dialogSignal, isOpen);
  const initial = await listNames(controller, base, scope, false, kind);
  const report = kind === "skills" ? undefined : await controller.describeTools(base);
  const items = report ? toolPickerItems(report, kind as Exclude<AllowlistKind, "skills">) : controller.getInventory();
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
      return await rankSkills(query, skills.map(({ name, description }) => ({ name, description })), {
        decide: (request, options) => client.decide(request, options),
        ...(capped.maxQuestions === undefined ? {} : { maxQuestions: capped.maxQuestions }),
      }, { ...current.decision, rubric: "topic", maxQuestions: 50, signal, ...(kind === "skills" ? {} : { subject: kind === "tools" ? "tool" as const : "mcp_server" as const }) });
    } finally { operation.close(); }
  };
  return {
    scope, skills: items, initial, noun: kind === "mcp" ? "MCP server or extension" : KIND_LABEL[kind] as "skill" | "tool",
    locationLabel: scope === "global" ? "Pi agent dir: pi-context-decisions/settings.json" : projectAllowlistPath(base.cwd!),
    ...(kind !== "skills" ? { scopeNote: "Scope uses public Pi tool provenance. Built-in MCP does not expose server config origin; those tools follow the global list." } : {}),
    ...(kind === "mcp" ? { heading: "Always allowed MCP servers & extensions", normalize: canonicalServerKey } : {}),
    ...(kind === "tools" && report ? { tree: toolTree(report, initialGroups ?? [], scope), normalize: canonicalServerKey } : {}),
    save: kind === "tools" && report ? (names, groups) => saveToolLists(controller, base, scope, names, groups ?? initialGroups ?? []) : (names) => saveNames(controller, base, scope, names, kind),
    ...(rank ? { rank, rankLabel: `${selectionLabel(settings.backend)} · explicit ranking may incur charges` } : { unavailable }),
  };
}
const EDITOR_UNAVAILABLE = "The allow list editors need the terminal UI. Without it, edit globalAllowlist in the settings file or alwaysAllowed in <cwd>/.pi/pi-context-decisions.json, then /reload";
/** RPC fallback: the same grouping as the terminal dialog, built from select/input requests. */
async function fieldsMenu(controller: Controller, ctx: CommandContext, tab: "Skills" | "Tools" | "Advanced", env?: Record<string, string | undefined>) {
  const fields: readonly AdvancedField[] = tab === "Tools" ? TOOL_FIELDS : tab === "Skills" ? SKILL_FIELDS : ADVANCED_FIELDS;
  const title = `Decisions · ${tab} settings`;
  for (;;) {
    const settings = controller.getSettings();
    const labels = fields.map((field) => `${field.group}.${field.key}: ${field.key === "concurrency" && fieldValue(settings, field.group, field.key) === 0 ? "0 (all shards parallel)" : String(fieldValue(settings, field.group, field.key))}`);
    const provider = `Provider / execution: ${settings.backend?.backend ?? "not configured"}`;
    const model = `Model: ${selectionLabel(settings.backend)}`;
    const extras = tab === "Advanced" ? [provider, model] : tab === "Skills" ? ["Allow list (Global)", "Allow list (Project)", "Status"]
      : ["Always allowed tools · Global", "Always allowed tools · Project", "Always allowed MCP servers & extensions · Global", "Always allowed MCP servers & extensions · Project"];
    const pick = await ctx.ui.select(title, [...(tab === "Advanced" ? extras : []), ...labels, ...(tab !== "Advanced" ? extras : []), "Back"], { signal: ctx.signal });
    if (!pick || pick === "Back") return;
    try {
      if (pick === provider) { await chooseProvider(controller, ctx, env); continue; }
      if (pick === model) {
        const backend = settings.backend;
        await chooseModel(controller, ctx, env, backend ? (entry) => entry.selection.backend === backend.backend && (entry.selection.backend !== "pi" || (backend.backend === "pi" && entry.selection.provider === backend.provider)) : undefined);
        continue;
      }
      if (pick === "Status") { await status(controller, ctx, env); continue; }
      if (extras.includes(pick)) throw new SettingsError(EDITOR_UNAVAILABLE);
      const index = labels.indexOf(pick);
      if (index < 0) throw new SettingsError("Invalid settings selection");
      const field = fields[index];
      const group = field.group;
      const key = `${group}.${field.key}`;
      const old = fieldValue(settings, group, field.key);
      if (typeof old === "boolean") await controller.update((current) => updateSetting(current, key, String(!old)));
      else if (field.kind === "options") {
        // Same values and descriptions as the terminal dialog's option list.
        const choices = (field.options ?? []).map((option) => `${option.value} · ${option.description}`);
        const picked = await ctx.ui.select(`${field.label} (currently ${String(old)})`, [...choices, "Back"], { signal: ctx.signal });
        const at = picked === undefined ? -1 : choices.indexOf(picked);
        if (at < 0) continue;
        await controller.update((current) => updateSetting(current, key, field.options![at].value));
      } else {
        const hint = key === "decision.concurrency" ? " (0 = all shards parallel; 1–32 = limit)" : field.key === "threshold" ? " (0–1, inclusive)" : key === "relevance.maxSkills" || key === "tools.maxAdded" ? " (new items added per picking round)" : "";
        const value = await ctx.ui.input(`New value for ${key}${hint}`, String(old), { signal: ctx.signal });
        if (value === undefined) continue;
        await controller.update((current) => updateSetting(current, key, value.trim()));
      }
      controller.setStatus(ctx);
    } catch (error) { controller.report(ctx, safeError(error), "error"); }
  }
}
async function settingsMenu(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  for (;;) {
    const pick = await ctx.ui.select("Decisions · settings", ["Skills", "Tools", "Advanced", "Done"], { signal: ctx.signal });
    if (!pick || pick === "Done") return;
    if (pick === "Skills" || pick === "Tools" || pick === "Advanced") await fieldsMenu(controller, ctx, pick, env);
  }
}

/** Operations behind the floating dialog. All context access is scoped, guarded and signal-owned. */
function buildDialogOps(controller: Controller, ctx: CommandContext, env: Record<string, string | undefined> | undefined, life: DialogLife): SettingsDialogOps {
  const cwd = ctx.cwd;
  const scoped = (signal?: AbortSignal) => scopedContext(ctx, signal, life.isOpen);
  const refreshStatus = () => { if (life.isOpen()) statusSafely(controller, scoped()); };
  return {
    snapshot: () => ({ settings: controller.getSettings(), settingsError: controller.getSettingsError(), hasCwd: !!cwd }),
    async projectCount() {
      if (!cwd) return { count: 0 };
      const result = await controller.loadProjectAllowlist(cwd);
      const warning = result.error ?? result.warnings[0];
      return { count: result.names.length, tools: result.tools.length, mcpServers: result.mcpServers.length, ...(warning ? { warning: sanitizeTerminalText(warning, 300) } : {}) };
    },
    async toggleEnabled() { await controller.update((current) => ({ ...current, relevance: { ...current.relevance, enabled: !current.relevance.enabled } })); refreshStatus(); },
    async updateSetting(key, text) { await controller.update((current) => updateSetting(current, key, text)); refreshStatus(); },
    async listProviders(signal): Promise<ProviderRow[]> {
      const choices = await providerChoices(scoped(signal), env);
      return choices.map((choice) => ({
        id: `${choice.backend}:${choice.provider}`, backend: choice.backend, provider: choice.provider, label: choice.name, status: choice.status,
        ...(choice.status !== "ok" ? { guide: credentialGuide(choice.provider, choice.backend === "pi") } : {}),
      }));
    },
    async listModels(filter, signal): Promise<ModelRow[]> {
      const entries = (await pickerEntries(scoped(signal), env)).filter((entry) => !filter || (entry.selection.backend === filter.backend
        && (entry.selection.backend !== "pi" || filter.provider === undefined || entry.selection.provider === filter.provider)));
      const rows: ModelRow[] = entries.map((entry) => {
        const provider = entry.selection.backend === "pi" ? entry.selection.provider : entry.selection.backend;
        return {
          id: JSON.stringify(entry.selection), label: entry.label, selection: entry.selection as BackendSelection, status: entry.authStatus,
          ...(entry.authStatus !== "ok" ? { guide: credentialGuide(provider, entry.selection.backend === "pi") } : {}),
          ...(entry.note ? { note: entry.note } : {}),
        };
      });
      rows.push({ id: "none", label: "None (no decision calls)", selection: null, status: "none" });
      return rows;
    },
    async selectModel(selection, signal) { return { message: await saveModel(controller, scoped(signal), selection, env) }; },
    statusLines: (signal) => statusLines(controller, scoped(signal), env),
    async history(signal) {
      const session = scoped(signal).sessionManager;
      if (!session) throw new SettingsError("This Pi host does not expose session history");
      return readDecisionsHistory(session);
    },
    allowlist: (scope, signal) => allowlistDeps(controller, ctx, scope, env, life.isOpen, signal),
    toolAllowlist: (list, scope, signal) => allowlistDeps(controller, ctx, scope, env, life.isOpen, signal, list),
  };
}

export interface RegisteredCommands {
  /** Synchronously closes any open settings dialog; resolves its pending command handler. */
  closeDialogs(): void;
}
const LIST_LIMIT = 100;
/** Local, names-only inventory view. Makes no decision calls. */
function toolListLines(report: ToolReport, which: "tools" | "mcp"): string[] {
  if (!report.supported) return ["This Pi host does not expose getAllTools/setActiveTools: tool filtering is inert."];
  const state = report.state === "on" ? `filtering on · mode ${report.mode}` : report.state === "enforce" ? "settings unreadable: enforcing this branch's ledger" : "filtering off: everything is available";
  const lines: string[] = [];
  if (which === "mcp") {
    lines.push(`MCP servers and extensions (${report.groups.length}, ${state}); grouped only by Pi's public metadata (mcp__ namespace for servers, sourceInfo for extensions):`);
    for (const group of report.groups.slice(0, LIST_LIMIT)) lines.push(`  ${group.type === "mcp" ? "MCP" : "extension"} ${cleanLabel(group.label)} (${group.key}) · ${group.tools} tools · ${group.available ? (group.allowlisted ? "allowlisted" : "available") : "unavailable"}${group.type === "mcp" && !group.verified ? " · not registered by Pi's built-in MCP" : ""}`);
    if (report.groups.length > LIST_LIMIT) lines.push(`  … and ${report.groups.length - LIST_LIMIT} more`);
    lines.push("Resource-only or disconnected servers with no tools are not observable: the Tools tab cannot add them. Missing scope follows the global list: allowlist by name in tools.alwaysAllowedMcpServers (Pi agent settings.json), not project .pi/pi-context-decisions.json, then /reload.");
    if (report.ungrouped) lines.push(`${report.ungrouped} extension tools expose no usable provenance: they belong to no group and are never filtered in mcp mode.`);
    return lines;
  }
  const external = report.rows.filter((row) => row.kind !== "internal");
  lines.push(`Tools (${external.length} external, ${report.rows.length - external.length} internal always allowed, ${report.hidden} hidden; ${state}):`);
  for (const row of external.slice(0, LIST_LIMIT)) lines.push(`  ${cleanLabel(row.name)} · ${row.kind === "mcp" ? `MCP ${cleanLabel(row.server ?? "")}` : row.groupLabel ? `extension ${cleanLabel(row.groupLabel)}` : "extension"} · ${row.exposure} · ${row.state}`);
  if (external.length > LIST_LIMIT) lines.push(`  … and ${external.length - LIST_LIMIT} more`);
  if (report.withheld) lines.push(`${report.withheld} declared tools are currently withheld from the model on this branch.`);
  return lines;
}
export function registerCommands(pi: ExtensionHost, controller: Controller, env?: Record<string, string | undefined>): RegisteredCommands {
  const dialogs = createSettingsDialogManager();
  const terminal = (ctx: CommandContext) => ctx.mode === "tui" && !!ctx.ui.custom;
  const openDialog = async (ctx: CommandContext, route: InitialRoute): Promise<void> => {
    // After "shutdown" the context may be invalid: return without touching it.
    await dialogs.open(ctx, (life) => buildDialogOps(controller, ctx, env, life), route);
  };
  /** Read-only inventory reports: `tools list` / `mcp list`. Everything editable lives in the dialog. */
  const listCommand = async (ctx: CommandContext, which: "tools" | "mcp", tokens: string[]): Promise<void> => {
    if (tokens.length !== 1 || tokens[0] !== "list") throw new SettingsError(`Use /decisions ${which} list. Change tool and MCP settings and allowlists in the /decisions Tools tab`);
    controller.report(ctx, toolListLines(await controller.describeTools(ctx), which).join("\n"));
  };
  pi.registerCommand("decisions", {
    description: "Context decisions settings dialog (also: status, history, test, tools list, mcp list)",
    getArgumentCompletions(prefix) { const values = COMMANDS.filter((value) => value.startsWith(prefix)); return values.length ? values.map((value) => ({ value, label: value })) : null; },
    async handler(args, ctx) {
      await controller.ensureLoaded();
      try {
        const tokens = args.trim().split(/\s+/u).filter(Boolean);
        const action = tokens.shift();
        if (!action) {
          if (terminal(ctx)) await openDialog(ctx, "main");
          else if (ctx.hasUI) await settingsMenu(controller, ctx, env);
          else await status(controller, ctx, env);
          return;
        }
        if (action === "status" && !tokens.length) await status(controller, ctx, env);
        else if (action === "history" && !tokens.length) {
          if (terminal(ctx)) await openDialog(ctx, "history");
          else {
            if (!ctx.sessionManager) throw new SettingsError("This Pi host does not expose session history");
            controller.report(ctx, historyReportLines(readDecisionsHistory(ctx.sessionManager)).join("\n"));
          }
        }
        else if (action === "tools" || action === "mcp") await listCommand(ctx, action, tokens);
        else if ((action === "pin" || action === "unpin") && tokens.length === 1) {
          await controller.update((current) => ({ ...current, relevance: { ...current.relevance, pinned: action === "pin" ? [...new Set([...current.relevance.pinned, tokens[0]])] : current.relevance.pinned.filter((name) => name !== tokens[0]) } }));
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
            const result = await controller.createClient(settings.backend, ctx).bool({ task: "Synthetic extension self-test" }, { instructions: "Does state.task describe a synthetic test?" }, { signal, timeoutMs: settings.decision.timeoutMs });
            controller.report(ctx, `Synthetic bool test: probability ${result.answer.probability}, ${Date.now() - start}ms${result.response.usage ? `; usage ${JSON.stringify(result.response.usage)}` : ""}`);
          } finally { operation.close(); }
        } else throw new SettingsError(`Use /decisions ${COMMANDS.join("|")}`);
      } catch (error) { controller.report(ctx, safeError(error), "error"); }
    },
  });
  return { closeDialogs: () => dialogs.closeAll() };
}
