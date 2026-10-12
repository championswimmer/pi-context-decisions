import { buildPickerEntries, type AuthStatus, type PickerEntry } from "../catalog/picker-models.ts";
import { OPENROUTER_DECISION_SNAPSHOT } from "../catalog/openrouter-models.ts";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey, type CredentialSource } from "../core/auth.ts";
import { createDeadline } from "../core/control.ts";
import type { BackendSelection } from "../core/backends/factory.ts";
import { DecisionError } from "../decision/errors.ts";
import { SettingsError, updateSetting, validateBackendSelection } from "../settings.ts";
import type { CommandContext, Controller, ExtensionHost } from "./contracts.ts";
import { selectionLabel } from "./contracts.ts";

const COMMANDS = ["settings", "provider", "model", "status", "enable", "disable", "relevance", "pin", "unpin", "test"];
type DirectProvider = "openai" | "typesafe" | "openrouter";
function cleanLabel(value: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 400); }
function safeError(error: unknown): string {
  if (error instanceof SettingsError) return error.message;
  if (error instanceof DecisionError) return `Decision operation failed (${error.code}${error.status ? `, HTTP ${error.status}` : ""})`;
  return "Context-decisions operation failed";
}
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
async function persistModel(controller: Controller, ctx: CommandContext, selection: BackendSelection | null, env?: Record<string, string | undefined>) {
  requireNative(selection, ctx);
  await requireCredentials(selection, ctx, env);
  await controller.update((settings) => ({ ...settings, backend: selection }));
  controller.setStatus(ctx);
  controller.report(ctx, `Decision model: ${selectionLabel(selection)}. ${selection ? "Eligible prompts send bounded task text and skill name/description metadata when enabled." : "No decision calls until a model is chosen."}`);
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
interface ProviderChoice { backend: "pi" | DirectProvider; provider: string; status: AuthStatus; label: string }
async function providerChoices(ctx: CommandContext, env?: Record<string, string | undefined>): Promise<ProviderChoice[]> {
  const entries = await pickerEntries(ctx, env);
  const choices: ProviderChoice[] = [];
  for (const provider of ["typesafe", "openai", "openrouter"] as const) {
    const entry = entries.find((item) => item.selection.backend === provider);
    choices.push({ backend: provider, provider, status: entry?.authStatus ?? "missing", label: `${provider} · direct API [${authLabel(entry?.authStatus ?? "missing")}]` });
  }
  for (const entry of entries) {
    const selection = entry.selection;
    if (selection.backend !== "pi" || choices.some((choice) => choice.backend === "pi" && choice.provider === selection.provider)) continue;
    choices.push({ backend: "pi", provider: selection.provider, status: entry.authStatus, label: `${cleanLabel(selection.provider)} · Pi internal classifier pipeline [${authLabel(entry.authStatus)}]` });
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
async function status(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
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
  controller.report(ctx, [
    `Context decisions: ${settings.enabled ? "enabled" : "disabled"}; ${selectionLabel(settings.backend)}`,
    `Credentials: ${credentials}; relevance ${settings.relevance.enabled ? "on" : "off"}, ${settings.relevance.mode}, minimum ${settings.relevance.minLabel}, fail-${settings.relevance.failMode}`,
    `Scoring: batch ${settings.relevance.chunkSize}, concurrency ${settings.relevance.concurrency === 0 ? "all batches parallel (0)" : settings.relevance.concurrency}, raw thresholds related ${settings.relevance.relatedThreshold}/direct ${settings.relevance.directThreshold} (0–2), cap ${settings.relevance.maxSkills}, minimum inventory ${settings.relevance.minCandidates}, timeout ${settings.relevance.timeoutMs}ms`,
    ...(error ? [`Settings error: ${error}. Use /decisions model/settings to repair the file.`] : []),
    ...(last ? [`Last: ${last.reason}, ${last.kept}/${last.candidates} skills, ${last.latencyMs}ms${last.errorCode ? ` (${last.errorCode})` : ""}${last.usage ? `; usage ${JSON.stringify(last.usage)}${settings.backend?.backend === "pi" ? " (cost, when present, is a catalog estimate)" : ""}` : ""}`] : []),
    OPENROUTER_DECISION_SNAPSHOT.attribution,
    "Skill advertisements only; tools, MCP visibility, and explicit skill access are unchanged.",
  ].join("\n"));
}
async function settingsDialog(controller: Controller, ctx: CommandContext, env?: Record<string, string | undefined>) {
  if (!ctx.hasUI) { controller.report(ctx, JSON.stringify(controller.getSettings(), null, 2)); return; }
  for (;;) {
    const settings = controller.getSettings();
    const toggle = `Context decisions: ${settings.enabled ? "On" : "Off"}`;
    const provider = `Provider / execution: ${settings.backend?.backend === "pi" ? `Pi internal · ${cleanLabel(settings.backend.provider)}` : settings.backend ? `${settings.backend.backend} direct` : "not configured"}`;
    const model = `Model: ${selectionLabel(settings.backend)}`;
    const fields = Object.keys(settings.relevance).filter((key) => key !== "pinned").map((key) => `relevance.${key}`);
    const labels = fields.map((key) => `${key}: ${key === "relevance.concurrency" && settings.relevance.concurrency === 0 ? "0 (all batches parallel)" : String(settings.relevance[key.slice(10) as keyof typeof settings.relevance])}`);
    const pick = await ctx.ui.select("Decisions · settings", [toggle, provider, model, ...labels, "Status", "Done"], { signal: ctx.signal });
    if (!pick || pick === "Done") return;
    try {
      if (pick === toggle) {
        await controller.update((current) => ({ ...current, enabled: !current.enabled }));
        controller.setStatus(ctx); controller.report(ctx, `Context decisions ${!settings.enabled ? "enabled" : "disabled"}`);
      } else if (pick === provider) await chooseProvider(controller, ctx, [], env);
      else if (pick === model) {
        const backend = settings.backend;
        await chooseModel(controller, ctx, [], env, backend ? (entry) => entry.selection.backend === backend.backend && (entry.selection.backend !== "pi" || (backend.backend === "pi" && entry.selection.provider === backend.provider)) : undefined);
      } else if (pick === "Status") await status(controller, ctx, env);
      else {
        const index = labels.indexOf(pick);
        if (index < 0) throw new SettingsError("Invalid settings selection");
        const key = fields[index];
        const old = settings.relevance[key.slice(10) as keyof typeof settings.relevance];
        if (typeof old === "boolean") await controller.update((current) => updateSetting(current, key, String(!old)));
        else {
          const hint = key === "relevance.failMode" ? " (open retains all advertisements on failure)" : key === "relevance.concurrency" ? " (0 = all batches parallel; 1–32 = limit)" : key.endsWith("Threshold") ? " (raw 0–2, inclusive)" : "";
          const value = await ctx.ui.input(`New value for ${key}${hint}`, String(old), { signal: ctx.signal });
          if (value === undefined) continue;
          await controller.update((current) => updateSetting(current, key, value.trim()));
        }
        controller.setStatus(ctx);
      }
    } catch (error) { controller.report(ctx, safeError(error), "error"); }
  }
}
export function registerCommands(pi: ExtensionHost, controller: Controller, env?: Record<string, string | undefined>): void {
  pi.registerCommand("decisions", {
    description: "Context decisions settings: enabled, provider, model, batching, and skill-filter status",
    getArgumentCompletions(prefix) { const values = COMMANDS.filter((value) => value.startsWith(prefix)); return values.length ? values.map((value) => ({ value, label: value })) : null; },
    async handler(args, ctx) {
      await controller.ensureLoaded();
      try {
        const tokens = args.trim().split(/\s+/u).filter(Boolean);
        const action = tokens.shift();
        if (!action) { if (ctx.hasUI) await settingsDialog(controller, ctx, env); else await status(controller, ctx, env); return; }
        if (action === "model") await chooseModel(controller, ctx, tokens, env);
        else if (action === "provider") await chooseProvider(controller, ctx, tokens, env);
        else if (action === "status" && !tokens.length) await status(controller, ctx, env);
        else if ((action === "enable" || action === "disable") && !tokens.length) {
          await controller.update((current) => ({ ...current, enabled: action === "enable" }));
          controller.setStatus(ctx); controller.report(ctx, `Context decisions ${action === "enable" ? "enabled" : "disabled"}`);
        } else if (action === "settings" || action === "relevance") {
          if (!tokens.length) await settingsDialog(controller, ctx, env);
          else if (tokens.length === 2) {
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
}
