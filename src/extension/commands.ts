import { buildPickerEntries, type AuthStatus, type PickerEntry } from "../catalog/picker-models.ts";
import { OPENROUTER_DECISION_SNAPSHOT } from "../catalog/openrouter-models.ts";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey, type CredentialSource } from "../core/auth.ts";
import type { BackendSelection } from "../core/backends/factory.ts";
import { DecisionError } from "../decision/errors.ts";
import { SettingsError, updateSetting, validateBackendSelection } from "../settings.ts";
import type { CommandContext, Controller, ExtensionHost } from "./contracts.ts";
import { selectionLabel } from "./contracts.ts";

const COMMANDS = ["model", "settings", "status", "enable", "disable", "relevance", "pin", "unpin", "test"];
function cleanLabel(value: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 400); }
function safeError(error: unknown): string {
  if (error instanceof SettingsError) return error.message;
  if (error instanceof DecisionError) return `Decision operation failed (${error.code}${error.status ? `, HTTP ${error.status}` : ""})`;
  return "Context-decisions operation failed";
}
function oauth(ctx: CommandContext): boolean {
  try {
    const model = ctx.modelRegistry.getModelsOfType("chat", "openai")[0];
    return !!model && !!ctx.modelRegistry.isUsingOAuth?.(model);
  } catch { return true; }
}
async function directAuth(provider: "openai" | "typesafe" | "openrouter", ctx: CommandContext, env?: Record<string, string | undefined>): Promise<{ status: AuthStatus; source?: CredentialSource }> {
  const resolve = provider === "openai" ? resolveOpenAIKey : provider === "typesafe" ? resolveTypeSafeKey : resolveOpenRouterKey;
  try {
    const credential = await resolve({ registry: ctx.modelRegistry, env, signal: ctx.signal, timeoutMs: 1500 });
    // Do not retain or display keys, including in thrown errors.
    return { status: "ok", source: credential.source };
  } catch (error) {
    if (error instanceof DecisionError && error.code === "aborted") throw error;
    return { status: "missing" };
  }
}
export async function pickerEntries(ctx: CommandContext, env?: Record<string, string | undefined>): Promise<PickerEntry[]> {
  const classifiers = ctx.modelRegistry.getModelsOfType("classifier");
  const auth: Record<string, AuthStatus> = {};
  for (const model of classifiers) {
    try { const status = ctx.modelRegistry.getProviderAuthStatus?.(model.provider); auth[model.provider] = status && !status.configured ? "missing" : "unknown"; }
    catch { auth[model.provider] = "unknown"; }
  }
  await Promise.all((["openai", "typesafe", "openrouter"] as const).map(async (provider) => { auth[provider] = (await directAuth(provider, ctx, env)).status; }));
  return buildPickerEntries({ piClassifiers: classifiers, auth }).map((entry) =>
    entry.selection.backend === "pi" && entry.selection.provider === "openai" && oauth(ctx)
      ? { ...entry, authStatus: "missing", note: "OpenAI native Decisions cannot use ChatGPT login; use direct with OPENAI_API_KEY" }
      : entry);
}
function requireNative(selection: BackendSelection | null, ctx: CommandContext): void {
  if (selection?.backend === "pi" && !ctx.modelRegistry.findOfType("classifier", selection.provider, selection.id)) throw new SettingsError("Selected Pi classifier is not registered; choose a listed native model or direct backend");
}
function parseModel(tokens: string[]): BackendSelection | null {
  if (tokens.length === 1 && tokens[0] === "none") return null;
  const [backend, ...rest] = tokens;
  if (backend === "pi" && rest.length === 2) return validateBackendSelection({ backend, provider: rest[0], id: rest[1] });
  if ((backend === "typesafe" || backend === "openai") && rest.length <= 1) return validateBackendSelection({ backend, ...(rest[0] ? { model: rest[0] } : {}) });
  if (backend === "openrouter" && rest.length === 1) return validateBackendSelection({ backend, model: rest[0] });
  throw new SettingsError("Use model pi <provider> <id>, typesafe [id], openai [id], openrouter <id>, or none");
}
async function chooseModel(controller: Controller, ctx: CommandContext, tokens: string[], env?: Record<string, string | undefined>) {
  let selection: BackendSelection | null;
  if (tokens.length) selection = parseModel(tokens);
  else {
    if (!ctx.hasUI) throw new SettingsError("No dialog UI; use model <backend> <id> (Pi also requires provider)");
    controller.report(ctx, `Loading credential availability; ${OPENROUTER_DECISION_SNAPSHOT.attribution}`);
    const entries = await pickerEntries(ctx, env);
    // Include IDs to disambiguate identical display names, and ordinal to prevent label collisions.
    const labels = entries.map((entry, index) => `${index + 1}. ${cleanLabel(entry.label)} [${entry.authStatus}] · ${cleanLabel(selectionLabel(entry.selection))}`);
    const picked = await ctx.ui.select("Context decisions · select classifier (no inference yet)", [...labels, "None (no decision calls)"], { signal: ctx.signal });
    if (picked === undefined) return;
    if (picked === "None (no decision calls)") selection = null;
    else {
      const index = labels.indexOf(picked);
      if (index < 0) throw new SettingsError("Invalid picker selection");
      selection = validateBackendSelection(entries[index].selection);
      if (entries[index].authStatus !== "ok") controller.report(ctx, "Credentials are missing or unverified; configure the provider before filtering", "warning");
      if (entries[index].note) controller.report(ctx, cleanLabel(entries[index].note!));
    }
  }
  requireNative(selection, ctx);
  await controller.update((settings) => ({ ...settings, backend: selection }));
  controller.setStatus(ctx);
  controller.report(ctx, `Decision model: ${selectionLabel(selection)}. Selecting a model opts in to sending bounded prompt and skill metadata on eligible prompts.`);
}
async function status(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  const settings = controller.getSettings();
  let authLabel = "not checked";
  if (settings.backend) {
    if (settings.backend.backend === "pi") {
      requireNative(settings.backend, ctx);
      authLabel = settings.backend.provider === "openai" && oauth(ctx) ? "incompatible ChatGPT OAuth" : ctx.modelRegistry.getProviderAuthStatus?.(settings.backend.provider).configured ? "Pi configured (not verified)" : "missing or unknown";
    } else {
      const auth = await directAuth(settings.backend.backend, ctx, env);
      authLabel = auth.source === "pi" ? "Pi-resolved (may include Pi's env fallback)" : auth.source === "env" ? "environment" : "missing";
    }
  }
  const last = controller.getLastDecision();
  const error = controller.getSettingsError();
  controller.report(ctx, [
    `Context decisions: ${settings.enabled ? "enabled" : "disabled"}; ${selectionLabel(settings.backend)}`,
    `Credentials: ${authLabel}; relevance ${settings.relevance.enabled ? "on" : "off"}, ${settings.relevance.mode}, minimum ${settings.relevance.minLabel}, fail-${settings.relevance.failMode}`,
    ...(error ? [`Settings error: ${error}. Use model/settings commands to repair the file.`] : []),
    ...(last ? [`Last: ${last.reason}, ${last.kept}/${last.candidates} skills, ${last.latencyMs}ms${last.errorCode ? ` (${last.errorCode})` : ""}${last.usage ? `; usage ${JSON.stringify(last.usage)}${settings.backend?.backend === "pi" ? " (cost, when present, is a catalog estimate)" : ""}` : ""}`] : []),
    OPENROUTER_DECISION_SNAPSHOT.attribution,
    "Skill advertisements only; tools, MCP visibility, and explicit skill access are unchanged.",
  ].join("\n"));
}
async function settingsDialog(controller: Controller, ctx: CommandContext) {
  if (!ctx.hasUI) { controller.report(ctx, JSON.stringify(controller.getSettings(), null, 2)); return; }
  for (;;) {
    const settings = controller.getSettings();
    const fields = ["enabled", ...Object.keys(settings.relevance).filter((key) => key !== "pinned").map((key) => `relevance.${key}`)];
    const labels = fields.map((key) => `${key}: ${String(key === "enabled" ? settings.enabled : settings.relevance[key.slice(10) as keyof typeof settings.relevance])}`);
    const pick = await ctx.ui.select("Context decisions · settings", [...labels, "Done"], { signal: ctx.signal });
    const index = labels.indexOf(pick ?? "");
    if (index < 0) return;
    const key = fields[index];
    const value = await ctx.ui.input(`New value for ${key}${key === "relevance.failMode" ? " (open retains all advertisements on failure)" : ""}`, undefined, { signal: ctx.signal });
    if (value === undefined) continue;
    try { await controller.update((current) => updateSetting(current, key, value.trim())); controller.setStatus(ctx); }
    catch (error) { controller.report(ctx, safeError(error), "error"); }
  }
}
export function registerCommands(pi: ExtensionHost, controller: Controller, env?: Record<string, string | undefined>): void {
  pi.registerCommand("context-decisions", {
    description: "Decision classifier model, settings, and skill-filter status",
    getArgumentCompletions(prefix) { const values = COMMANDS.filter((value) => value.startsWith(prefix)); return values.length ? values.map((value) => ({ value, label: value })) : null; },
    async handler(args, ctx) {
      await controller.ensureLoaded();
      try {
        const tokens = args.trim().split(/\s+/u).filter(Boolean);
        let action = tokens.shift();
        if (!action && ctx.hasUI) action = await ctx.ui.select("Context decisions", COMMANDS, { signal: ctx.signal });
        if (!action) { if (!ctx.hasUI) await status(controller, ctx, env); return; }
        if (action === "model") await chooseModel(controller, ctx, tokens, env);
        else if (action === "status" && !tokens.length) await status(controller, ctx, env);
        else if ((action === "enable" || action === "disable") && !tokens.length) {
          await controller.update((current) => ({ ...current, enabled: action === "enable" }));
          controller.setStatus(ctx); controller.report(ctx, `Context decisions ${action === "enable" ? "enabled" : "disabled"}`);
        } else if (action === "settings" || action === "relevance") {
          if (!tokens.length) await settingsDialog(controller, ctx);
          else if (tokens.length === 2) {
            const key = action === "relevance" ? `relevance.${tokens[0]}` : tokens[0];
            await controller.update((current) => updateSetting(current, key, tokens[1]));
            controller.setStatus(ctx); controller.report(ctx, "Context-decisions settings saved");
          } else throw new SettingsError("Use settings <key> <value> or relevance <key> <value>");
        } else if ((action === "pin" || action === "unpin") && tokens.length === 1) {
          await controller.update((current) => ({ ...current, relevance: { ...current.relevance, pinned: action === "pin" ? [...new Set([...current.relevance.pinned, tokens[0]])] : current.relevance.pinned.filter((name) => name !== tokens[0]) } }));
          controller.report(ctx, "Pinned skills updated");
        } else if (action === "test" && !tokens.length) {
          if (controller.getSettingsError()) throw new SettingsError("Repair settings before testing a decision model");
          const settings = controller.getSettings();
          if (!settings.backend) throw new SettingsError("Select a decision model before testing");
          requireNative(settings.backend, ctx);
          const start = Date.now();
          const operation = controller.beginOperation();
          try {
            const signal = ctx.signal ? AbortSignal.any([ctx.signal, operation.signal]) : operation.signal;
            const result = await controller.createClient(settings.backend, ctx).bool({ task: "Synthetic extension self-test" }, { instructions: "Does state.task describe a synthetic test?" }, { signal, timeoutMs: settings.relevance.timeoutMs });
            controller.report(ctx, `Synthetic bool test: probability ${result.answer.probability}, ${Date.now() - start}ms${result.response.usage ? `; usage ${JSON.stringify(result.response.usage)}` : ""}`);
          } finally { operation.close(); }
        } else throw new SettingsError(`Use /context-decisions ${COMMANDS.join("|")}`);
      } catch (error) { controller.report(ctx, safeError(error), "error"); }
    },
  });
}
