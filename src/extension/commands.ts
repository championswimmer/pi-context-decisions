import { buildPickerEntries, type AuthStatus, type PickerEntry } from "../catalog/picker-models.ts";
import { OPENROUTER_DECISION_SNAPSHOT } from "../catalog/openrouter-models.ts";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey, type CredentialSource } from "../core/auth.ts";
import { createDeadline } from "../core/control.ts";
import type { BackendSelection } from "../core/backends/factory.ts";
import { DecisionError } from "../decision/errors.ts";
import { SettingsError, updateSetting, validateBackendSelection } from "../settings.ts";
import { normalizeAllowlist, normalizeServerAllowlist, normalizeToolAllowlist, type AllowlistScope, type ScopedSkill } from "../apps/allowlist.ts";
import { rankSkills } from "../apps/relevance.ts";
import { projectAllowlistPath } from "../project-allowlist.ts";
import type { AllowlistPickerDeps } from "./allowlist-picker.ts";
import type { CommandContext, Controller, ExtensionHost } from "./contracts.ts";
import { selectionLabel } from "./contracts.ts";
import { createSettingsDialogManager, type DialogLife, type InitialRoute, type ModelRow, type ProviderRow, type SettingsDialogOps } from "./settings-dialog.ts";
import { ADVANCED_FIELDS, TOOL_FIELDS, describeError, fieldValue, sanitizeTerminalText, toolsSummary, type AdvancedField, type SettingsGroup } from "./settings-model.ts";
import type { AllowlistKind } from "./settings-dialog.ts";
import type { ToolReport } from "./contracts.ts";
import { canonicalServerKey } from "../apps/tool-inventory.ts";

const COMMANDS = ["settings", "provider", "model", "status", "enable", "disable", "relevance", "tools", "mcp", "allow", "allowlist", "pin", "unpin", "test"];
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
    signal: { value: signal, enumerable: true },
  });
}
function statusSafely(controller: Controller, ctx: CommandContext): void { try { controller.setStatus(ctx); } catch { /* cosmetic; the dialog may have closed */ } }
function directProvider(provider: string): provider is DirectProvider { return ["openai", "typesafe", "openrouter"].includes(provider); }
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
function parseModel(tokens: string[]): BackendSelection | null {
  if (tokens.length === 1 && tokens[0] === "none") return null;
  const [backend, ...rest] = tokens;
  if (backend === "pi" && rest.length === 2) return validateBackendSelection({ backend, provider: rest[0], id: rest[1] });
  if ((backend === "typesafe" || backend === "openai") && rest.length <= 1) return validateBackendSelection({ backend, ...(rest[0] ? { model: rest[0] } : {}) });
  if (backend === "openrouter" && rest.length === 1) return validateBackendSelection({ backend, model: rest[0] });
  throw new SettingsError("Use /decisions model pi <provider> <id>, typesafe [id], openai [id], openrouter <id>, or none");
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
async function chooseModel(controller: Controller, ctx: CommandContext, tokens: string[], env?: Record<string, string | undefined>, filter?: (entry: PickerEntry) => boolean) {
  if (tokens.length) return persistModel(controller, ctx, parseModel(tokens), env);
  if (!ctx.hasUI) throw new SettingsError("No dialog UI; use /decisions model <backend> <id> (Pi also requires provider)");
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
async function chooseProvider(controller: Controller, ctx: CommandContext, tokens: string[], env?: Record<string, string | undefined>) {
  if (tokens.length) {
    if (directProvider(tokens[0])) {
      if (tokens.length > 1 || tokens[0] !== "openrouter") return chooseModel(controller, ctx, tokens, env);
      if (!ctx.hasUI) throw new SettingsError("Use /decisions provider openrouter <model-id> or /decisions model openrouter <model-id>");
      const provider = tokens[0];
      if ((await directAuth(provider, ctx, env)).status !== "ok") throw new SettingsError(credentialGuide(provider));
      return chooseModel(controller, ctx, [], env, (entry) => entry.selection.backend === provider);
    }
    if (tokens[0] === "pi" && tokens.length === 3) return chooseModel(controller, ctx, tokens, env);
    if (tokens[0] === "pi" && tokens.length === 2 && ctx.hasUI) return chooseModel(controller, ctx, [], env, (entry) => entry.selection.backend === "pi" && entry.selection.provider === tokens[1]);
    throw new SettingsError("Use /decisions provider typesafe|openai [model], openrouter <model>, or pi <provider> <model>");
  }
  if (!ctx.hasUI) {
    const choices = await providerChoices(ctx, env);
    controller.report(ctx, choices.map((choice) => `${choice.label}${choice.status !== "ok" ? `\n  ${credentialGuide(choice.provider, choice.backend === "pi")}` : ""}`).join("\n"));
    return;
  }
  const choices = await providerChoices(ctx, env);
  const selected = await ctx.ui.select("Decisions · provider and execution path", [...choices.map((choice) => choice.label), "Cancel"], { signal: ctx.signal });
  const choice = choices.find((item) => item.label === selected);
  if (!choice) return;
  if (choice.status !== "ok") throw new SettingsError(credentialGuide(choice.provider, choice.backend === "pi"));
  await chooseModel(controller, ctx, [], env, (entry) => entry.selection.backend === choice.backend && (entry.selection.backend !== "pi" || entry.selection.provider === choice.provider));
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
    `Context decisions: ${settings.enabled ? "enabled" : "disabled"}; ${selectionLabel(settings.backend)}`,
    `Credentials: ${credentials}; relevance ${settings.relevance.enabled ? "on" : "off"}, threshold ${settings.relevance.threshold} (0–1), picker ${settings.relevance.cadence}, fail-${settings.relevance.failMode}`,
    `Scoring: shard ${settings.relevance.chunkSize}, concurrency ${settings.relevance.concurrency === 0 ? "all shards parallel (0)" : settings.relevance.concurrency}, max ${settings.relevance.maxSkills} added per round, minimum inventory ${settings.relevance.minCandidates}, timeout ${settings.relevance.timeoutMs}ms. Skills are only ever added; already-added skills are never re-scored`,
    `Always-allowed lists: global ${settings.globalAllowlist.length}, project ${project?.names.length ?? 0} (${ctx.cwd ? cleanLabel(projectAllowlistPath(ctx.cwd)) : "no cwd"})`,
    ...(project?.error ? [`Project allowlist warning: ${project.error}`] : []),
    ...(error ? [`Settings error: ${error}. Use /decisions model/settings to repair the file.`] : []),
    ...(last ? [`Last (${last.trigger ?? "prompt"}): ${last.reason}, +${last.kept} of ${last.candidates} candidates${last.advertised === undefined ? "" : `, ${last.advertised} advertised`}${last.redelivered ? `, ${last.redelivered} re-delivered` : ""}${last.cached ? ", cached scores (no call)" : `, ${last.latencyMs}ms`}${last.errorCode ? ` (${last.errorCode})` : ""}${last.usage ? `; usage ${JSON.stringify(last.usage)}${settings.backend?.backend === "pi" ? " (cost, when present, is a catalog estimate)" : ""}` : ""}`] : []),
    ...toolStatusLines(controller, settings),
    OPENROUTER_DECISION_SNAPSHOT.attribution,
    "Skill advertisements are additive and never change explicit skill access.",
  ];
}
/** Tool filtering status. Counts and modes only: no tool names, task text, arguments or results. */
function toolStatusLines(controller: Controller, settings: ReturnType<Controller["getSettings"]>): string[] {
  const t = settings.tools;
  if (!t.enabled) return ["Tool filtering: off (opt-in, separate from skill filtering; /decisions tools on)"];
  const last = controller.getLastToolDecision();
  return [
    `Tool filtering: on · mode ${t.mode} · picker ${t.cadence} · threshold ${t.threshold} · max ${t.maxAdded} added per round · minimum ${t.minCandidates} · fail-${t.failMode}${settings.backend ? "" : " · no decision model selected: every tool stays available"}`,
    `Tool allowlists: tools global ${t.alwaysAllowedTools.length}, MCP servers global ${t.alwaysAllowedMcpServers.length} (project lists: /decisions tools allow project list, /decisions mcp allow project list)`,
    ...(last ? [`Last tool round (${last.trigger}): ${last.reason}, +${last.kept} of ${last.candidates} candidates, ${last.available}/${last.external} available, ${last.withheld} withheld${last.cached ? ", cached scores (no call)" : `, ${last.latencyMs}ms`}${last.errorCode ? ` (${last.errorCode})` : ""}${last.usage ? `; usage ${JSON.stringify(last.usage)}` : ""}`] : []),
    "Tool filtering hides declared tools and blocks calls to unavailable external tools through Pi's tool pipeline. It is not a sandbox: bash, discovery listings (the mcp_servers prompt section, codemode searchTools, tool_search results) and MCP server connections are unaffected. Pi's built-in tools are never filtered. Enabling it mid-session keeps tools already registered available on that branch.",
  ];
}
async function status(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  controller.report(ctx, (await statusLines(controller, ctx, env)).join("\n"));
}
const KIND_LABEL: Record<AllowlistKind, string> = { skills: "skill", tools: "tool", mcp: "MCP server" };
const KIND_COMMAND: Record<AllowlistKind, string> = { skills: "allow", tools: "tools allow", mcp: "mcp allow" };
function globalList(settings: ReturnType<Controller["getSettings"]>, kind: AllowlistKind): string[] {
  return kind === "skills" ? settings.globalAllowlist : kind === "tools" ? settings.tools.alwaysAllowedTools : settings.tools.alwaysAllowedMcpServers;
}
function normalizeKind(kind: AllowlistKind, values: Iterable<unknown>): string[] {
  try { return kind === "skills" ? normalizeAllowlist(values) : kind === "tools" ? normalizeToolAllowlist(values) : normalizeServerAllowlist(values); }
  catch {
    throw new SettingsError(kind === "skills" ? "Allowlist names must be bounded, nonempty identifiers (at most 1000)"
      : kind === "tools" ? "Tool names must be 1-128 characters without whitespace or control characters (at most 1000)"
      : "MCP server names must match [A-Za-z0-9_-]{1,64} (at most 1000)");
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
/** Names-only editor items for tools and MCP servers. `scope` is the list's scope, not where the tool came from (that is not observable). */
function toolPickerItems(report: ToolReport, kind: Exclude<AllowlistKind, "skills">, scope: AllowlistScope): ScopedSkill[] {
  if (kind === "tools") {
    return report.rows.filter((row) => row.kind !== "internal").map((row) => ({ name: row.name, description: `${row.server ? `[MCP server ${row.server}] ` : ""}${row.description}`, scope, disableModelInvocation: false }));
  }
  return report.groups.map((group) => ({ name: /^[A-Za-z0-9_-]{1,64}$/u.test(group.label) ? group.label : group.key, scope, disableModelInvocation: false,
    description: `MCP server ${group.label}. Tools: ${group.toolNames.join(", ")}` }));
}
/**
 * Inputs for the embedded allowlist editor. Every context read goes through `scopedContext`, and
 * ranking uses its own signal (picker + dialog + operation), never `ctx.signal` or a spread ctx.
 */
async function allowlistDeps(controller: Controller, ctx: CommandContext, scope: AllowlistScope, env: Record<string, string | undefined> | undefined,
  isOpen: () => boolean, dialogSignal: AbortSignal, kind: AllowlistKind = "skills"): Promise<Omit<AllowlistPickerDeps, "report" | "maxRows">> {
  const base = scopedContext(ctx, dialogSignal, isOpen);
  const initial = await listNames(controller, base, scope, false, kind);
  const items = kind === "skills" ? controller.getInventory() : toolPickerItems(await controller.describeTools(base), kind, scope);
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
      }, { ...current.relevance, rubric: "topic", maxQuestions: 50, signal, ...(kind === "skills" ? {} : { subject: kind === "tools" ? "tool" as const : "mcp_server" as const, maxDescriptionChars: current.tools.maxDescriptionChars }) });
    } finally { operation.close(); }
  };
  return {
    scope, skills: items, initial, noun: KIND_LABEL[kind] as "skill" | "tool" | "MCP server",
    locationLabel: scope === "global" ? "Pi user context-decisions settings.json" : projectAllowlistPath(base.cwd!),
    save: (names) => saveNames(controller, base, scope, names, kind),
    ...(rank ? { rank, rankLabel: `${selectionLabel(settings.backend)} · explicit ranking may incur charges` } : { unavailable }),
  };
}
async function allowlistCommand(controller: Controller, ctx: CommandContext, tokens: string[], editor: boolean, env: Record<string, string | undefined> | undefined,
  openEditor: (scope: AllowlistScope) => Promise<void>, kind: AllowlistKind = "skills"): Promise<void> {
  const [scope, action, ...names] = tokens;
  const command = `/decisions ${KIND_COMMAND[kind]}`;
  if (scope !== "global" && scope !== "project") throw new SettingsError(`Use ${command} <global|project> list|add <name>|remove <name>|clear${kind === "skills" ? ", or allowlist <global|project>" : ""}`);
  if (editor || action === undefined) {
    if (action !== undefined) throw new SettingsError(`Use ${command.replace(" allow", " allowlist")} <global|project>`);
    await openEditor(scope); return;
  }
  const noun = KIND_LABEL[kind];
  if (action === "list" && names.length === 0) {
    const current = await listNames(controller, ctx, scope, true, kind);
    controller.report(ctx, `Always-allowed ${kind === "skills" ? "" : `${noun}s, `}${scope} (${current.length}): ${current.length ? current.map(cleanLabel).join(", ") : "none"}`); return;
  }
  let note = "";
  if (action === "clear" && names.length === 0) await saveNames(controller, ctx, scope, [], kind);
  else if ((action === "add" || action === "remove") && names.length > 0) {
    const valid = normalizeKind(kind, names);
    const current = await listNames(controller, ctx, scope, true, kind);
    const sameServer = (a: string, b: string) => kind === "mcp" ? canonicalServerKey(a) === canonicalServerKey(b) : a === b;
    await saveNames(controller, ctx, scope, action === "add" ? new Set([...current, ...valid]) : current.filter((name) => !valid.some((entry) => sameServer(entry, name))), kind);
    // In `mcp` mode a tool of an MCP server cannot be half-on: allowlisting it makes the whole server available. Say so.
    if (kind === "tools" && action === "add" && controller.getSettings().tools.mode === "mcp") {
      const report = await controller.describeTools(ctx).catch(() => undefined);
      const servers = [...new Set(valid.flatMap((name) => report?.rows.find((row) => row.name === name)?.server ?? []))];
      if (servers.length) note = ` In mcp mode this makes the whole MCP server available: ${servers.map(cleanLabel).join(", ")}.`;
    }
  } else throw new SettingsError(`Use ${command} <global|project> list|add <name>|remove <name>|clear`);
  controller.report(ctx, `Always-allowed ${kind === "skills" ? "" : `${noun} `}${scope} list saved${note ? `.${note}` : ""}`);
}
const EDITOR_UNAVAILABLE = "Allow list editor needs the terminal UI; use /decisions allow <global|project> list|add|remove|clear";
/** RPC fallback: the same grouping as the terminal dialog, built from select/input requests. */
async function fieldsMenu(controller: Controller, ctx: CommandContext, group: SettingsGroup) {
  const fields: readonly AdvancedField[] = group === "tools" ? TOOL_FIELDS : ADVANCED_FIELDS;
  const title = group === "tools" ? "Decisions · Tools & MCP settings" : "Decisions · Advanced relevance settings";
  for (;;) {
    const settings = controller.getSettings();
    const labels = fields.map((field) => `${group}.${field.key}: ${group === "relevance" && field.key === "concurrency" && settings.relevance.concurrency === 0 ? "0 (all shards parallel)" : String(fieldValue(settings, group, field.key))}`);
    const pick = await ctx.ui.select(title, [...labels, "Back"], { signal: ctx.signal });
    if (!pick || pick === "Back") return;
    try {
      const index = labels.indexOf(pick);
      if (index < 0) throw new SettingsError("Invalid settings selection");
      const field = fields[index];
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
        const hint = key === "relevance.concurrency" ? " (0 = all shards parallel; 1–32 = limit)" : field.key === "threshold" ? " (0–1, inclusive)" : key === "relevance.maxSkills" || key === "tools.maxAdded" ? " (new items added per picking round)" : "";
        const value = await ctx.ui.input(`New value for ${key}${hint}`, String(old), { signal: ctx.signal });
        if (value === undefined) continue;
        await controller.update((current) => updateSetting(current, key, value.trim()));
      }
      controller.setStatus(ctx);
    } catch (error) { controller.report(ctx, safeError(error), "error"); }
  }
}
const advancedMenu = (controller: Controller, ctx: CommandContext) => fieldsMenu(controller, ctx, "relevance");
async function settingsMenu(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  if (!ctx.hasUI) { controller.report(ctx, JSON.stringify(controller.getSettings(), null, 2)); return; }
  for (;;) {
    const settings = controller.getSettings();
    const toggle = `Context decisions: ${settings.enabled ? "On" : "Off"}`;
    const provider = `Provider / execution: ${settings.backend?.backend === "pi" ? `Pi internal · ${cleanLabel(settings.backend.provider)}` : settings.backend ? `${settings.backend.backend} direct` : "not configured"}`;
    const model = `Model: ${selectionLabel(settings.backend)}`;
    const project = ctx.cwd ? await controller.loadProjectAllowlist(ctx.cwd) : undefined;
    const globalAllow = `Allow list (Global) · ${settings.globalAllowlist.length}`;
    const projectAllow = `Allow list (Project) · ${project?.names.length ?? 0}`;
    const tools = `Tools & MCP…: ${toolsSummary(settings)}`;
    const pick = await ctx.ui.select("Decisions · settings", [toggle, provider, model, globalAllow, projectAllow, "Advanced…", tools, "Status", "Done"], { signal: ctx.signal });
    if (!pick || pick === "Done") return;
    try {
      if (pick === toggle) {
        await controller.update((current) => ({ ...current, enabled: !current.enabled }));
        controller.setStatus(ctx); controller.report(ctx, `Context decisions ${!settings.enabled ? "enabled" : "disabled"}`);
      } else if (pick === provider) await chooseProvider(controller, ctx, [], env);
      else if (pick === model) {
        const backend = settings.backend;
        await chooseModel(controller, ctx, [], env, backend ? (entry) => entry.selection.backend === backend.backend && (entry.selection.backend !== "pi" || (backend.backend === "pi" && entry.selection.provider === backend.provider)) : undefined);
      } else if (pick === globalAllow || pick === projectAllow) throw new SettingsError(EDITOR_UNAVAILABLE);
      else if (pick === "Advanced…") await advancedMenu(controller, ctx);
      else if (pick === tools) await fieldsMenu(controller, ctx, "tools");
      else if (pick === "Status") await status(controller, ctx, env);
    } catch (error) { controller.report(ctx, safeError(error), "error"); }
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
    async toggleEnabled() { await controller.update((current) => ({ ...current, enabled: !current.enabled })); refreshStatus(); },
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
    lines.push(`MCP servers (${report.groups.length}, ${state}); grouped only by Pi's public mcp__ namespace:`);
    for (const group of report.groups.slice(0, LIST_LIMIT)) lines.push(`  ${cleanLabel(group.label)} (${group.key}) · ${group.tools} tools · ${group.available ? (group.allowlisted ? "allowlisted" : "available") : "unavailable"}${group.verified ? "" : " · not registered by Pi's built-in MCP"}`);
    if (report.groups.length > LIST_LIMIT) lines.push(`  … and ${report.groups.length - LIST_LIMIT} more`);
    lines.push("Resource-only or disconnected servers with no tools are not observable: allowlist them by name with /decisions mcp allow.");
    return lines;
  }
  const external = report.rows.filter((row) => row.kind !== "internal");
  lines.push(`Tools (${external.length} external, ${report.rows.length - external.length} internal always allowed, ${report.hidden} hidden; ${state}):`);
  for (const row of external.slice(0, LIST_LIMIT)) lines.push(`  ${cleanLabel(row.name)} · ${row.kind === "mcp" ? `MCP ${cleanLabel(row.server ?? "")}` : "extension"} · ${row.exposure} · ${row.state}`);
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
  const toolsCommand = async (ctx: CommandContext, tokens: string[]): Promise<void> => {
    const [first, ...rest] = tokens;
    if (first === undefined) {
      if (terminal(ctx)) await openDialog(ctx, "tools");
      else if (ctx.hasUI) await fieldsMenu(controller, ctx, "tools");
      else controller.report(ctx, toolStatusLines(controller, controller.getSettings()).join("\n"));
      return;
    }
    if ((first === "on" || first === "off") && rest.length === 0) {
      await controller.update((current) => ({ ...current, tools: { ...current.tools, enabled: first === "on" } }));
      controller.setStatus(ctx);
      controller.report(ctx, `Tool filtering ${first === "on" ? "enabled" : "disabled"}${first === "on" && !controller.getSettings().backend ? ". No decision model is selected, so every tool stays available until you choose one with /decisions model" : ""}`);
    } else if (first === "list" && rest.length === 0) controller.report(ctx, toolListLines(await controller.describeTools(ctx), "tools").join("\n"));
    else if (first === "allow" || first === "allowlist") {
      await allowlistCommand(controller, ctx, rest, first === "allowlist", env, async (scope) => {
        if (!terminal(ctx)) throw new SettingsError("The tool allowlist editor needs the terminal UI; use /decisions tools allow <global|project> list|add|remove|clear");
        await openDialog(ctx, { allowlist: scope, list: "tools" });
      }, "tools");
    } else if (rest.length === 1) {
      await controller.update((current) => updateSetting(current, `tools.${first}`, rest[0]));
      controller.setStatus(ctx); controller.report(ctx, "Tool filtering settings saved");
    } else throw new SettingsError("Use /decisions tools [on|off|list|mode tools|mcp|cadence initial|prompt|tool-round|threshold|maxAdded|minCandidates|failMode|maxDescriptionChars <value>|allow <global|project> list|add|remove|clear]");
  };
  const mcpCommand = async (ctx: CommandContext, tokens: string[]): Promise<void> => {
    const [first, ...rest] = tokens;
    if (first === "list" && rest.length === 0) controller.report(ctx, toolListLines(await controller.describeTools(ctx), "mcp").join("\n"));
    else if (first === "allow" || first === "allowlist") {
      await allowlistCommand(controller, ctx, rest, first === "allowlist", env, async (scope) => {
        if (!terminal(ctx)) throw new SettingsError("The MCP allowlist editor needs the terminal UI; use /decisions mcp allow <global|project> list|add|remove|clear");
        await openDialog(ctx, { allowlist: scope, list: "mcp" });
      }, "mcp");
    } else throw new SettingsError("Use /decisions mcp list or /decisions mcp allow <global|project> list|add <server>|remove <server>|clear");
  };
  pi.registerCommand("decisions", {
    description: "Context decisions settings: enabled, provider, model, batching, and skill-filter status",
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
        if (action === "model") { if (!tokens.length && terminal(ctx)) await openDialog(ctx, "model"); else await chooseModel(controller, ctx, tokens, env); }
        else if (action === "provider") { if (!tokens.length && terminal(ctx)) await openDialog(ctx, "provider"); else await chooseProvider(controller, ctx, tokens, env); }
        else if (action === "status" && !tokens.length) await status(controller, ctx, env);
        else if (action === "tools") await toolsCommand(ctx, tokens);
        else if (action === "mcp") await mcpCommand(ctx, tokens);
        else if (action === "allow" || action === "allowlist") await allowlistCommand(controller, ctx, tokens, action === "allowlist", env, async (scope) => {
          if (!terminal(ctx)) throw new SettingsError(EDITOR_UNAVAILABLE);
          await openDialog(ctx, { allowlist: scope });
        });
        else if ((action === "enable" || action === "disable") && !tokens.length) {
          await controller.update((current) => ({ ...current, enabled: action === "enable" }));
          controller.setStatus(ctx); controller.report(ctx, `Context decisions ${action === "enable" ? "enabled" : "disabled"}`);
        } else if (action === "settings" || action === "relevance") {
          if (!tokens.length) {
            if (terminal(ctx)) await openDialog(ctx, action === "relevance" ? "advanced" : "main");
            else if (ctx.hasUI && action === "relevance") await advancedMenu(controller, ctx);
            else await settingsMenu(controller, ctx, env);
          } else if (tokens.length === 2) {
            const key = action === "relevance" ? `relevance.${tokens[0]}` : tokens[0];
            await controller.update((current) => updateSetting(current, key, tokens[1]));
            controller.setStatus(ctx); controller.report(ctx, "Context-decisions settings saved");
          } else throw new SettingsError("Use /decisions settings <key> <value> or relevance <key> <value>");
        } else if ((action === "pin" || action === "unpin") && tokens.length === 1) {
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
            const result = await controller.createClient(settings.backend, ctx).bool({ task: "Synthetic extension self-test" }, { instructions: "Does state.task describe a synthetic test?" }, { signal, timeoutMs: settings.relevance.timeoutMs });
            controller.report(ctx, `Synthetic bool test: probability ${result.answer.probability}, ${Date.now() - start}ms${result.response.usage ? `; usage ${JSON.stringify(result.response.usage)}` : ""}`);
          } finally { operation.close(); }
        } else throw new SettingsError(`Use /decisions ${COMMANDS.join("|")}`);
      } catch (error) { controller.report(ctx, safeError(error), "error"); }
    },
  });
  return { closeDialogs: () => dialogs.closeAll() };
}
