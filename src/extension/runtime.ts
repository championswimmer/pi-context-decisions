import { applySkillAdvertisementFilter, filterSkills, type SkillAdvertisementResult } from "../apps/skill-filter.ts";
import type { RelevanceClient } from "../apps/relevance.ts";
import { allowlistedNames, toScopedSkills, type ScopedSkill } from "../apps/allowlist.ts";
import { loadProjectAllowlist, saveProjectAllowlist } from "../project-allowlist.ts";
import { createBackend } from "../core/backends/factory.ts";
import { createDecisionClient } from "../decision/api.ts";
import { DecisionError } from "../decision/errors.ts";
import type { DecisionResponse, DecisionUsage } from "../decision/types.ts";
import { defaultSettings, loadSettings, parseSettings, saveSettings } from "../settings.ts";
import { registerCommands } from "./commands.ts";
import { selectionLabel, type Controller, type ExtensionDependencies, type ExtensionHost, type LastDecision } from "./contracts.ts";

function sumUsage(responses: DecisionResponse[]): DecisionUsage | undefined {
  if (!responses.length) return undefined;
  const result: DecisionUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cost"] as const) {
    if (responses.every((response) => response.usage?.[key] !== undefined)) result[key] = responses.reduce((sum, response) => sum + response.usage![key]!, 0);
  }
  return Object.keys(result).length ? result : undefined;
}
/** The same registration path is used by Pi and offline tests; factory starts no timers or I/O. */
export function registerContextDecisions(pi: ExtensionHost, deps: ExtensionDependencies): void {
  let settings = defaultSettings();
  let settingsError: string | undefined;
  let warnings: string[] = [];
  let loading: Promise<void> | undefined;
  let loaded = false;
  let last: LastDecision | undefined;
  let generation = 0;
  const pending = new Set<AbortController>();
  let writeQueue = Promise.resolve();
  let projectWriteQueue = Promise.resolve();
  let inventorySnapshot: ScopedSkill[] | undefined;
  const projectWarnings = new Set<string>();
  const abortPending = () => { for (const controller of pending) controller.abort(); pending.clear(); };
  const load = async () => {
    const result = await (deps.load ?? loadSettings)(deps.settingsPath);
    settings = result.settings; settingsError = result.error; warnings = result.warnings; loaded = true;
  };
  const controller: Controller = {
    async ensureLoaded() {
      if (loaded) return;
      loading ??= load().finally(() => { loading = undefined; });
      await loading;
    },
    getSettings: () => structuredClone(settings),
    getSettingsError: () => settingsError,
    getLastDecision: () => last ? structuredClone(last) : undefined,
    getInventory() {
      if (inventorySnapshot) return structuredClone(inventorySnapshot);
      return toScopedSkills((pi.getCommands?.() ?? []).filter((command) => command.source === "skill" && command.name.startsWith("skill:")).map((command) => ({ name: command.name.slice(6), description: command.description ?? "", sourceInfo: { scope: command.sourceInfo?.scope } })));
    },
    loadProjectAllowlist,
    async saveProjectAllowlist(cwd, names) {
      const draft = [...names];
      const operation = projectWriteQueue.then(async () => {
        await saveProjectAllowlist(cwd, draft);
        abortPending(); generation++; last = undefined;
      });
      projectWriteQueue = operation.catch(() => {});
      await operation;
    },
    async update(change) {
      const operation = writeQueue.then(async () => {
        await controller.ensureLoaded();
        const next = parseSettings(change(structuredClone(settings)));
        await (deps.save ?? saveSettings)(next, deps.settingsPath);
        abortPending(); generation++;
        settings = next; settingsError = undefined; warnings = []; last = undefined;
      });
      writeQueue = operation.catch(() => {});
      await operation;
    },
    createClient(selection, ctx) {
      return deps.createClient?.(selection, ctx) ?? createDecisionClient(createBackend(selection, {
        registry: ctx.modelRegistry, getRegistry: () => ctx.modelRegistry, env: deps.env,
      }));
    },
    beginOperation() {
      const abort = new AbortController(); pending.add(abort);
      return { signal: abort.signal, close() { pending.delete(abort); } };
    },
    report(ctx, message, level = "info") {
      if (deps.report) deps.report(ctx, message, level);
      else if (ctx.hasUI) ctx.ui.notify(message, level);
      else console.error(`[context-decisions] ${message}`); // stderr, not the JSON/RPC protocol stream
    },
    setStatus(ctx) {
      if (!ctx.hasUI) return;
      const state = settingsError ? "settings error · repair with /decisions model" : !settings.enabled || !settings.relevance.enabled ? "off" : !settings.backend ? "select model · /decisions model" : last
        ? `${last.reason} · ${last.kept}/${last.candidates} skills · ${last.latencyMs}ms${last.errorCode ? ` · ${last.errorCode}` : ""}`
        : selectionLabel(settings.backend);
      ctx.ui.setStatus("context-decisions", state);
    },
  };
  const commands = registerCommands(pi, controller, deps.env);
  pi.on("session_start", async (_event, ctx) => {
    commands.closeDialogs(); // a dialog from a previous session must never outlive its context
    abortPending(); generation++; last = undefined; inventorySnapshot = undefined; projectWarnings.clear();
    await projectWriteQueue;
    await writeQueue;
    await loading;
    loaded = false;
    await controller.ensureLoaded();
    if (settingsError) controller.report(ctx, `Settings error: ${settingsError}; skill advertisements fail closed until repaired`, "error");
    for (const warning of warnings) controller.report(ctx, warning, "warning");
    controller.setStatus(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    // First and synchronous: resolves the pending /decisions handler before ctx is invalidated.
    // The dialog is deliberately NOT in `pending`: settings saves abort decisions, not the dialog.
    commands.closeDialogs();
    abortPending(); generation++; last = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("context-decisions", undefined);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    inventorySnapshot = toScopedSkills(event.systemPromptOptions.skills);
    await controller.ensureLoaded();
    const currentGeneration = generation;
    const current = structuredClone(settings);
    const abort = new AbortController();
    pending.add(abort);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const responses: DecisionResponse[] = [];
    let client: RelevanceClient | null = null;
    let configError = settingsError;
    try {
      const project = ctx.cwd ? await controller.loadProjectAllowlist(ctx.cwd) : { names: [], warnings: [] };
      const pinned = [...new Set([...current.relevance.pinned, ...allowlistedNames(event.systemPromptOptions.skills, { global: current.globalAllowlist, project: project.names })])];
      if (currentGeneration !== generation) {
        // A settings/project/session change during file I/O must not start stale decisions.
        event.systemPromptOptions.skills = filterSkills(event.systemPromptOptions.skills, null, { ...current.relevance, pinned, failMode: "closed" }).kept;
        return;
      }
      for (const warning of [...project.warnings, ...(project.error ? [project.error] : [])]) {
        const warningKey = `${ctx.cwd ?? ""}\0${warning}`;
        if (!projectWarnings.has(warningKey)) { projectWarnings.add(warningKey); controller.report(ctx, warning, "warning"); }
      }
      // Never construct/request a client when explicitly disabled or unconfigured.
      if (!configError && current.enabled && current.relevance.enabled && current.backend) {
        try {
          if (current.backend.backend === "pi" && !ctx.modelRegistry.findOfType("classifier", current.backend.provider, current.backend.id)) throw new DecisionError("config", "Selected Pi classifier is not registered");
          const decision = controller.createClient(current.backend, ctx);
          const relevanceClient: RelevanceClient = decision;
          client = { maxQuestions: relevanceClient.maxQuestions, async decide(request, options) { const response = await decision.decide(request, options); responses.push(response); return response; } };
        } catch { configError = "Decision client configuration failed"; }
      }
      let result: SkillAdvertisementResult<(typeof event.systemPromptOptions.skills)[number]>;
      if (configError) {
        // Configuration failure must close ads before empty-task/expanded-skill skips.
        const started = Date.now();
        const skills = event.systemPromptOptions.skills;
        const names = new Set<string>();
        const candidates = skills.reduce((count, skill) => {
          if (names.has(skill.name)) return count;
          names.add(skill.name);
          return count + (skill.disableModelInvocation ? 0 : 1);
        }, 0);
        const filtered = filterSkills(skills, null, { ...current.relevance, pinned, failMode: "closed" });
        event.systemPromptOptions.skills = filtered.kept;
        result = { ...filtered, candidates, errorCode: "config", latencyMs: Date.now() - started };
      } else {
        result = await applySkillAdvertisementFilter(event, client, {
          ...current.relevance,
          pinned,
          enabled: current.enabled,
          relevanceEnabled: current.relevance.enabled,
          maxQuestions: 50, // app reduces the requested batch when a provider declares a lower cap
          signal,
        });
      }
      if (currentGeneration !== generation) return;
      const usage = sumUsage(responses);
      last = { reason: result.reason, candidates: result.candidates, kept: result.kept.filter((skill) => !skill.disableModelInvocation).length,
        latencyMs: result.latencyMs, ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(usage ? { usage } : {}) };
      controller.setStatus(ctx);
      if (result.errorCode && result.errorCode !== "aborted") controller.report(ctx, `Skill advertisements ${result.reason} (${result.errorCode}); /decisions status`, "warning");
    } finally { pending.delete(abort); }
  });
}
