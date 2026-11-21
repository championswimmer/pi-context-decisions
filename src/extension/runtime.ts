import { createPastTurnSummaries } from "./past-turn-summaries.ts";
import { subagentManagerPresent } from "./subagent-manager.ts";

import { MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION, MANAGER_DIAGNOSTICS_HELP, createManagerDiagnostics } from "./manager-diagnostics.ts";
import type { BeforeAgentStartEvent, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { RelevanceScoreCache, scoreAdditions, type SkillAdditionResult } from "../apps/skill-additions.ts";
import { taskWithoutExpandedSkill } from "../apps/skill-filter.ts";
import type { RelevanceClient } from "../apps/relevance.ts";
import { allowlistedNames, normalizeAllowlist, normalizeServerAllowlist, normalizeToolAllowlist, toScopedSkills, type ScopedSkill } from "../apps/allowlist.ts";
import { loadGlobalAllowlist, loadProjectAllowlist, saveGlobalAllowlist, saveProjectAllowlist, type ProjectAllowlistLists } from "../project-allowlist.ts";
import { createBackend } from "../core/backends/factory.ts";
import { createDecisionClient } from "../decision/api.ts";
import { DecisionError } from "../decision/errors.ts";
import type { DecisionResponse, DecisionUsage } from "../decision/types.ts";
import { createJsonFileStorageAdapter, createSettingsStore, ConcurrencyConflictError, type StorageAdapter } from "pi-extension-settings-tui";
import type { ContextDecisionsSettings, ContextDecisionsSettingsSchema, FlatContextDecisionsSettings } from "../settings.ts";
import { contextSettingsToFlat, createDecisionsSettingsStore, defaultSettings, flatToContextSettings, loadSettings, parseSettings, saveSettings, SettingsError } from "../settings.ts";
import { SKILL_SCORE_ENTRY } from "./skill-state.ts";
import { registerCommands } from "./commands.ts";
import { advertisedSkillNames, skillNamesFromSection } from "./skill-state.ts";
import type { Controller, ExtensionDependencies, ExtensionHost, LastDecision } from "./contracts.ts";
import { readPreviousFinalReply } from "./decision-activity.ts";
import { createToolFilter } from "./tool-filter.ts";
import { beginDecisionLoader, endDecisionLoader, resetDecisionLoader } from "./decision-loader.ts";
import { skillFooter } from "./footer-status.ts";
import { describeError } from "./settings-model.ts";

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
  const store = createDecisionsSettingsStore(deps.settingsPath);
  let writeQueue = Promise.resolve();
  let internalUpdateEpoch = 0;
  let globalAllowlistWriteQueue = Promise.resolve();
  let projectWriteQueue = Promise.resolve();
  let inventorySnapshot: ScopedSkill[] | undefined;
  const projectWarnings = new Set<string>();
  /** Scores for the current task: later rounds for the same task add the next-best skills without a call. */
  const scoreCache = new RelevanceScoreCache();
  // Pending only until Pi commits the native section and starts committing its user message.
  let pendingSkillScores: { branchLeaf: string | null; picks: Map<string, { score: number; threshold: number }> } | undefined;
  /** Full Pi skill objects from the latest prompt for inventory and status. */
  let skillRefs = new Map<string, Skill>();
  let toolsStatusShown = false;
  const history = createPastTurnSummaries(pi, () => settings);
  const abortPending = () => { for (const controller of pending) controller.abort(); pending.clear(); };
  const toolFilter = createToolFilter({
    pi, agentDir: deps.agentDir, report: (ctx, message) => controller.report(ctx, message, "warning"), ensureLoaded: () => controller.ensureLoaded(), getSettings: () => settings, getSettingsError: () => settingsError, generation: () => generation,
    beginOperation: () => controller.beginOperation(),
    resolveClient: (ctx, current, responses) => resolveClient(ctx, current, responses, "tools"),
    history: (ctx) => history.read(ctx),
    loadProjectAllowlist: (cwd) => controller.loadProjectAllowlist(cwd), sumUsage,
    changed: (ctx) => { try { controller.setStatus(ctx as unknown as Parameters<Controller["setStatus"]>[0]); } catch { /* cosmetic */ } },
  });
  const load = async () => {
    const result = deps.load
      ? await deps.load(deps.settingsPath)
      : await loadSettings(deps.settingsPath, { persistMigration: true });
    settings = result.settings; settingsError = result.error; warnings = result.warnings; loaded = true;
  };
  // Only a live versioned host capability can redirect headless reports. Persisted ownership
  // survives top-level resume/fork and must never suppress stderr.
  const managerDiagnostics = createManagerDiagnostics(pi);
  let managerNoticeShown = false;
  const warnManagerCapability = (ctx: ExtensionContext) => {
    if (managerNoticeShown || !ctx.hasUI || ctx.mode !== "tui" || !controller.subagentManagerPresent?.() || managerDiagnostics.parentAvailable()) return;
    managerNoticeShown = true;
    ctx.ui.notify(MANAGER_DIAGNOSTICS_HELP, "warning");
  };
  // Bound duplicate memory per extension instance (not module-global); explicit reports bypass it.
  const reportedHeadless = new Set<string>();
  const report = (ctx: Parameters<Controller["report"]>[0], message: string, level: "info" | "warning" | "error" = "info", explicit = false) => {
    if (deps.report) deps.report(ctx, message, level);
    else if (ctx.hasUI) ctx.ui.notify(message, level);
    else {
      if (!explicit) {
        const key = JSON.stringify([level, message]);
        if (reportedHeadless.has(key)) return;
        if (reportedHeadless.size >= 64) reportedHeadless.delete(reportedHeadless.values().next().value!);
        reportedHeadless.add(key);
        if (managerDiagnostics.send(level, message)) return;
      }
      console.error(`[context-decisions] ${message}`); // stderr, never the JSON/RPC stdout stream
    }
  };
  const controller: Controller = {
    settingsPath: deps.settingsPath,
    async ensureLoaded() {
      if (loaded) return;
      loading ??= load().finally(() => { loading = undefined; });
      await loading;
    },
    getStore: () => store,
    createDialogStore(schema: ContextDecisionsSettingsSchema) {
      let repairMode = settingsError !== undefined;
      let seenUpdateEpoch = internalUpdateEpoch;
      const useCustomSeams = deps.load !== undefined || deps.save !== undefined;
      let adapter: StorageAdapter;
      if (useCustomSeams) {
        adapter = {
          getPaths: () => ({ global: deps.settingsPath }),
          async readLayer(scope) {
            if (scope !== "global" || repairMode) return { data: null, hash: null, exists: false };
            const flat = contextSettingsToFlat(settings);
            return {
              data: flat as unknown as Record<string, unknown>,
              hash: JSON.stringify(flat),
              exists: true,
            };
          },
          async writeLayer(scope, data) {
            if (scope !== "global") return { hash: null, deleted: false };
            const nextFlat = schema.resolveEffective(
              { global: data as Partial<FlatContextDecisionsSettings>, project: {} },
              { includeProject: false },
            );
            try {
              await controller.update((current) =>
                flatToContextSettings(
                  { ...nextFlat, pinnedSkills: [...current.relevance.pinned] },
                  {
                    names: current.globalAllowlist,
                    tools: current.tools.alwaysAllowedTools,
                    mcpServers: current.tools.alwaysAllowedMcpServers,
                  },
                ),
              );
            } catch (error) {
              throw new SettingsError(describeError(error));
            }
            repairMode = false;
            return { hash: JSON.stringify(contextSettingsToFlat(settings)), deleted: false };
          },
        };
      } else {
        const baseAdapter = createJsonFileStorageAdapter(schema, {
          globalPath: deps.settingsPath,
          deleteWhenEmpty: false,
        });
        adapter = {
          getPaths: () => baseAdapter.getPaths?.() ?? { global: deps.settingsPath },
          async readLayer(scope) {
            if (scope !== "global") return { data: null, hash: null, exists: false };
            if (repairMode) return { data: null, hash: null, exists: false };
            try {
              const res = await baseAdapter.readLayer("global");
              if (res.exists && res.data && schema.config.migrate) {
                schema.config.migrate(structuredClone(res.data), "global");
              }
              return res;
            } catch {
              repairMode = true;
              return { data: null, hash: null, exists: false };
            }
          },
          async writeLayer(scope, data, writeOptions) {
            if (scope !== "global") return { hash: null, deleted: false };
            try {
              const res = await baseAdapter.writeLayer("global", data, repairMode ? undefined : writeOptions);
              repairMode = false;
              return res;
            } catch (error) {
              if (error instanceof ConcurrencyConflictError) throw error;
              throw new SettingsError(describeError(error));
            }
          },
        };
      }
      const dialogStore = createSettingsStore(schema, { adapter });
      const origLoad = dialogStore.load.bind(dialogStore);
      const origSave = dialogStore.save.bind(dialogStore);
      dialogStore.load = async (loadOptions) => {
        seenUpdateEpoch = internalUpdateEpoch;
        const loadedResult = await origLoad(loadOptions);
        if (repairMode && settingsError) {
          const banner = `Settings error: ${settingsError}. Repair the settings file, or choose a model in /decisions.`;
          return { ...loadedResult, warnings: [banner, ...loadedResult.warnings] };
        }
        return loadedResult;
      };
      if (!useCustomSeams) {
        dialogStore.save = async (nextValues, saveOptions) => {
          const run = writeQueue.then(async () => {
            const internalChanged = seenUpdateEpoch !== internalUpdateEpoch;
            const mergedValues = internalChanged
              ? { ...nextValues, pinnedSkills: [...settings.relevance.pinned] }
              : nextValues;
            const res = await origSave(
              mergedValues,
              internalChanged ? { ...saveOptions, expectedSnapshot: undefined, force: true } : saveOptions,
            );
            seenUpdateEpoch = internalUpdateEpoch;
            return res;
          });
          writeQueue = run.then(() => undefined, () => undefined);
          return run;
        };
      }
      return dialogStore;
    },
    subagentManagerPresent: () => {
      // Parent manager registers /agents with public sourceInfo. Command provenance avoids
      // getAllTools entirely while tool filtering is off, including dialogs and read-only status.
      try { if (subagentManagerPresent(pi.getCommands?.() ?? [])) return true; } catch { /* try tools only if on */ }
      if (!settings.tools.enabled) return false;
      try { return subagentManagerPresent(pi.getAllTools?.() ?? []); } catch { return false; }
    },
    managerDiagnosticsStatus: () => !controller.subagentManagerPresent?.() ? undefined
      : managerDiagnostics.parentAvailable() ? `Subagent diagnostics: parent routing available (protocol 1, manager >= ${MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION})`
      : `Subagent diagnostics unavailable: ${MANAGER_DIAGNOSTICS_HELP}`,
    getSettings: () => structuredClone(settings),
    getSettingsError: () => settingsError,
    getLastDecision: () => last ? structuredClone(last) : undefined,
    getLastToolDecision: () => toolFilter.last(),
    describeTools: (ctx) => toolFilter.describe(ctx),
    historyToolGroups: () => toolFilter.historyToolGroups(),
    getInventory() {
      if (inventorySnapshot) return structuredClone(inventorySnapshot);
      return toScopedSkills((pi.getCommands?.() ?? []).filter((command) => command.source === "skill" && command.name.startsWith("skill:")).map((command) => ({ name: command.name.slice(6), description: command.description ?? "", sourceInfo: { scope: command.sourceInfo?.scope } })));
    },
    loadGlobalAllowlist: () => (deps.loadGlobalAllowlist ?? loadGlobalAllowlist)(deps.settingsPath),
    async saveGlobalAllowlist(lists) {
      // Copy now: the caller's iterables must not change under a queued write.
      const draft: ProjectAllowlistLists = Symbol.iterator in Object(lists) ? { skills: [...(lists as Iterable<string>)] }
        : Object.fromEntries(Object.entries(lists as ProjectAllowlistLists).map(([key, value]) => [key, [...(value as Iterable<string>)]]));
      const operation = globalAllowlistWriteQueue.then(async () => {
        await controller.ensureLoaded();
        await (deps.saveGlobalAllowlist ?? saveGlobalAllowlist)(deps.settingsPath, draft);
        settings = {
          ...settings,
          globalAllowlist: draft.skills === undefined ? settings.globalAllowlist : normalizeAllowlist(draft.skills),
          tools: {
            ...settings.tools,
            alwaysAllowedTools: draft.tools === undefined ? settings.tools.alwaysAllowedTools : normalizeToolAllowlist(draft.tools),
            alwaysAllowedMcpServers: draft.mcpServers === undefined ? settings.tools.alwaysAllowedMcpServers : normalizeServerAllowlist(draft.mcpServers),
          },
        };
        abortPending(); generation++; last = undefined; scoreCache.clear(); toolFilter.invalidate();
      });
      globalAllowlistWriteQueue = operation.catch(() => {});
      await operation;
    },
    loadProjectAllowlist: (cwd) => (deps.loadProjectAllowlist ?? loadProjectAllowlist)(cwd),
    async saveProjectAllowlist(cwd, lists) {
      // Copy now: the caller's iterables must not change under a queued write.
      const draft: ProjectAllowlistLists = Symbol.iterator in Object(lists) ? { skills: [...(lists as Iterable<string>)] }
        : Object.fromEntries(Object.entries(lists as ProjectAllowlistLists).map(([key, value]) => [key, [...(value as Iterable<string>)]]));
      const operation = projectWriteQueue.then(async () => {
        await saveProjectAllowlist(cwd, draft);
        abortPending(); generation++; last = undefined; scoreCache.clear(); toolFilter.invalidate();
      });
      projectWriteQueue = operation.catch(() => {});
      await operation;
    },
    applyFlatSettings(flat) {
      const next = flatToContextSettings(flat, {
        names: settings.globalAllowlist,
        tools: settings.tools.alwaysAllowedTools,
        mcpServers: settings.tools.alwaysAllowedMcpServers,
      });
      history.reset(); abortPending(); generation++;
      settings = next; settingsError = undefined; warnings = []; last = undefined; scoreCache.clear(); toolFilter.invalidate();
    },
    async update(change) {
      const operation = writeQueue.then(async () => {
        await controller.ensureLoaded();
        const next = parseSettings(change(structuredClone(settings)));
        await (deps.save ?? saveSettings)(next, deps.settingsPath);
        internalUpdateEpoch++;
        history.reset(); abortPending(); generation++;
        settings = next; settingsError = undefined; warnings = []; last = undefined; scoreCache.clear(); toolFilter.invalidate();
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
    report,
    setStatus(ctx) {
      if (!ctx.hasUI) return;
      const total = [...skillRefs.values()].filter((skill) => !skill.disableModelInvocation).length;
      ctx.ui.setStatus("context-decisions", skillFooter(settings, settingsError, last, total));
      // Tool filtering is opt-in: while it is off (the default) nothing extra is ever written to the status bar.
      const toolsText = toolFilter.status();
      if (toolsText !== undefined || toolsStatusShown) { ctx.ui.setStatus("context-decisions-tools", toolsText); toolsStatusShown = toolsText !== undefined; }
    },
  };
  const commands = registerCommands(pi, { ...controller, report: (ctx, message, level) => report(ctx, message, level, true) }, deps.env);
  pi.on("session_start", async (_event, ctx) => {
    commands.closeDialogs(); // a dialog from a previous session must never outlive its context
    managerDiagnostics.reset();
    managerNoticeShown = false;
    resetDecisionLoader(); // a reloaded extension must not touch the previous session's working row
    pendingSkillScores = undefined; history.reset(); abortPending(); generation++; last = undefined; inventorySnapshot = undefined; projectWarnings.clear();
    scoreCache.clear(); skillRefs = new Map(); toolFilter.reset(true);
    await projectWriteQueue;
    await globalAllowlistWriteQueue;
    await writeQueue;
    await loading;
    loaded = false;
    await controller.ensureLoaded();
    await toolFilter.startSession(ctx);
    if (settingsError) controller.report(ctx, `Settings error: ${settingsError}; skill advertisements fail closed until repaired`, "error");
    for (const warning of warnings) controller.report(ctx, warning, "warning");
    warnManagerCapability(ctx);
    controller.setStatus(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    // Navigating the session tree changes the active branch: an in-flight pass was computed against the old one.
    // Everything branch-derived is re-read from the new branch at the next boundary; only transient state is dropped here.
    pendingSkillScores = undefined; history.reset(); abortPending(); generation++; last = undefined; scoreCache.clear(); skillRefs = new Map(); toolFilter.sessionTree(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    // First and synchronous: resolves the pending /decisions handler before ctx is invalidated.
    // The dialog is deliberately NOT in `pending`: settings saves abort decisions, not the dialog.
    commands.closeDialogs();
    managerDiagnostics.reset();
    resetDecisionLoader();
    pendingSkillScores = undefined; history.reset(); abortPending(); generation++; last = undefined; scoreCache.clear(); toolFilter.reset(true);
    if (ctx.hasUI) { ctx.ui.setStatus("context-decisions", undefined); if (toolsStatusShown) { ctx.ui.setStatus("context-decisions-tools", undefined); toolsStatusShown = false; } }
  });
  // Pi commits the user message after turn_start; assistant message_start is the first
  // verified public boundary where the committed prompt ID is available.
  pi.on("message_start", (event, ctx) => { if (event.message.role === "assistant") history.enqueue(ctx, "prompt"); });
  pi.on("agent_end", (_event, ctx) => { history.enqueue(ctx, "reply"); });
  const uniqueByName = <T extends { name: string }>(skills: readonly T[]): T[] => {
    const names = new Set<string>();
    return skills.filter((skill) => !names.has(skill.name) && !!names.add(skill.name));
  };
  /** `skills` is gated by the skill switch, `tools` by the tool-filtering switch: the two features are independent. */
  function resolveClient(ctx: ExtensionContext, current: ContextDecisionsSettings, responses: DecisionResponse[], feature: "skills" | "tools" = "skills"): { client: RelevanceClient | null; error?: string } {
    if (settingsError) return { client: null, error: settingsError };
    // Never construct/request a client when explicitly disabled or unconfigured.
    if (!(feature === "skills" ? current.relevance.enabled : current.tools.enabled) || !current.backend) return { client: null };
    try {
      if (current.backend.backend === "pi" && !ctx.modelRegistry.findOfType("classifier", current.backend.provider, current.backend.id)) throw new DecisionError("config", "Selected Pi classifier is not registered");
      const decision = controller.createClient(current.backend, ctx);
      const relevanceClient: RelevanceClient = decision;
      return { client: { maxQuestions: relevanceClient.maxQuestions, async decide(request, options) { const response = await decision.decide(request, options); responses.push(response); return response; } } };
    } catch { return { client: null, error: "Decision client configuration failed" }; }
  }
  const pinsFor = async (ctx: ExtensionContext, current: ContextDecisionsSettings, skills: readonly Skill[], reportWarnings: boolean): Promise<string[]> => {
    const project = ctx.cwd ? await controller.loadProjectAllowlist(ctx.cwd) : { names: [], warnings: [] as string[], error: undefined as string | undefined };
    if (reportWarnings) {
      for (const warning of [...project.warnings, ...(project.error ? [project.error] : [])]) {
        const warningKey = `${ctx.cwd ?? ""}\0${warning}`;
        if (!projectWarnings.has(warningKey)) { projectWarnings.add(warningKey); controller.report(ctx, warning, "warning"); }
      }
    }
    return [...new Set([...current.relevance.pinned, ...allowlistedNames(skills, { global: current.globalAllowlist, project: project.names })])];
  };
  const cacheKey = (task: string, current: ContextDecisionsSettings, activity: unknown = undefined) =>
    JSON.stringify([task, current.backend, current.decision.maxPromptChars, current.decision.maxDescriptionChars, activity]);
  const record = (round: SkillAdditionResult<Skill> | undefined, fields: Omit<LastDecision, "latencyMs" | "usage"> & { latencyMs?: number }, responses: DecisionResponse[], started: number) => {
    const usage = sumUsage(responses);
    last = { ...fields, latencyMs: fields.latencyMs ?? round?.latencyMs ?? Date.now() - started, ...(usage ? { usage } : {}) };
  };
  // Both decisions start together; Pi receives the tool message and the mutated native skills options.
  pi.on("before_agent_start", async (event, ctx) => {
    warnManagerCapability(ctx);
    await controller.ensureLoaded();
    const skills = skillBeforeAgentStart(event, ctx);
    const tools = toolFilter.beforeAgentStart(event as never, ctx);
    const [, result] = await Promise.all([skills, tools]);
    return result;
  });
  async function skillBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
    pendingSkillScores = undefined;
    const available = uniqueByName(event.systemPromptOptions.skills);
    inventorySnapshot = toScopedSkills(available);
    if (!available.length && !skillRefs.size) return;
    let committed: Set<string>;
    let branchLeaf: string | null;
    try {
      committed = advertisedSkillNames(ctx.sessionManager);
      branchLeaf = ctx.sessionManager.getBranch().at(-1)?.id ?? null;
    }
    catch {
      // An unreadable branch cannot prove that any skill was already advertised.
      event.systemPromptOptions.skills = available.filter((skill) => skill.disableModelInvocation);
      record(undefined, { reason: "fail-closed", candidates: available.length, kept: 0, errorCode: "history", trigger: "prompt" }, [], Date.now());
      controller.setStatus(ctx);
      return;
    }
    // Keep committed descriptions stable during this extension lifetime. On reload only skills
    // still in Pi's inventory can be reconstructed from their names.
    const retained = [...skillRefs.values()].filter((skill) => committed.has(skill.name));
    const inventory = uniqueByName([...retained, ...available]);
    skillRefs = new Map(inventory.map((skill) => [skill.name, structuredClone(skill)]));
    const task = (event as { messageType?: unknown }).messageType === "custom" || !("prompt" in event) || typeof event.prompt !== "string" ? "" : taskWithoutExpandedSkill(event.prompt);
    const currentGeneration = generation;
    const current = structuredClone(settings);
    const previousReply = task.trim() ? readPreviousFinalReply(ctx.sessionManager) : undefined;
    const historySnapshot = history.read(ctx);
    const abort = new AbortController();
    pending.add(abort);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const responses: DecisionResponse[] = [];
    const started = Date.now();
    const invocable = inventory.filter((skill) => !skill.disableModelInvocation);
    const apply = (names: ReadonlySet<string>) => {
      const selected = inventory.filter((skill) => skill.disableModelInvocation || names.has(skill.name));
      if (JSON.stringify(selected) !== JSON.stringify(event.systemPromptOptions.skills)) {
        event.systemPromptOptions.skills = selected;
      }
    };
    try {
      const pinned = await pinsFor(ctx, current, inventory, true);
      const superseded = () => currentGeneration !== generation || signal.aborted;
      const bail = () => {
        // Never expose unselected inventory when a concurrent operation cancels this pass.
        apply(new Set([...committed, ...pinned]));
        if (currentGeneration !== generation) return;
        record(undefined, { reason: "fail-closed", candidates: invocable.length, kept: 0, errorCode: "aborted", trigger: "prompt" }, responses, started);
        controller.setStatus(ctx);
      };
      if (superseded()) { bail(); return; }
      let advertised: Set<string>;
      try { advertised = advertisedSkillNames(ctx.sessionManager); }
      catch { apply(new Set(pinned)); return; }
      for (const name of pinned) advertised.add(name);
      const { client, error: configError } = resolveClient(ctx, current, responses);
      let reason: LastDecision["reason"] = "skipped";
      let errorCode: string | undefined;
      let round: SkillAdditionResult<Skill> | undefined;
      const hasReader = pi.getActiveTools().some((name) => name === "read" || name === "bash");
      if (configError) { reason = "fail-closed"; errorCode = "config"; }
      else if (!current.relevance.enabled || !client || invocable.length < current.relevance.minCandidates) {
        for (const skill of invocable) advertised.add(skill.name);
      } else if (task.trim() && hasReader) {
        const candidates = current.relevance.constantMatrix
          ? [...invocable].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
          : invocable.filter((skill) => !advertised.has(skill.name));
        // In the experiment, scores depend on the full ordered matrix, not just each individual skill.
        const activity = [previousReply, historySnapshot];
        const key = current.relevance.constantMatrix
          ? JSON.stringify([cacheKey(task, current, activity), candidates.map(({ name, description }) => [name, description]), current.decision.chunkSize])
          : cacheKey(task, current, activity);
        beginDecisionLoader(ctx);
        try {
          round = await scoreAdditions(task, candidates, client, { ...current.relevance, ...current.decision, maxQuestions: 50, signal, previousReply, history: historySnapshot, ...(current.relevance.constantMatrix ? { advertised } : {}) }, { store: scoreCache, key });
        } finally { endDecisionLoader(); }
        reason = round.failedOpen ? "fail-open" : round.errorCode ? "fail-closed" : "filtered";
        errorCode = round.errorCode;
      }
      if (superseded()) { bail(); return; }
      for (const skill of round?.added ?? []) advertised.add(skill.name);
      apply(advertised);
      if (round?.picks?.size && hasReader) pendingSkillScores = { branchLeaf, picks: new Map(round.picks) };
      record(round, {
        reason, candidates: round?.candidates ?? invocable.length, kept: round?.added.length ?? 0,
        advertised: hasReader ? invocable.filter((skill) => advertised.has(skill.name)).length : committed.size,
        ...(round?.cached ? { cached: true } : {}), trigger: "prompt", ...(errorCode ? { errorCode } : {}),
      }, responses, started);
      controller.setStatus(ctx);
      if (errorCode && errorCode !== "aborted") controller.report(ctx, `Skill advertisements ${reason} (${errorCode}); /decisions status`, "warning");
    } finally { pending.delete(abort); }
  }
  // Pi emits message_end before persisting that message. By the user event, its preceding
  // native system section is already committed; a preflight failure never reaches here.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user" || !pendingSkillScores) return;
    const pendingScores = pendingSkillScores;
    pendingSkillScores = undefined;
    try {
      const branch = ctx.sessionManager.getBranch();
      const start = pendingScores.branchLeaf === null ? 0 : branch.findIndex((entry) => entry.id === pendingScores.branchLeaf) + 1;
      if (pendingScores.branchLeaf !== null && start === 0) return;
      const sectionEntry = branch.slice(start).reverse().find((entry) => entry.type === "message" && entry.message.role === "system" && typeof entry.message.sections?.skills === "string");
      if (!sectionEntry || sectionEntry.type !== "message" || sectionEntry.message.role !== "system") return;
      const names = new Set(skillNamesFromSection(sectionEntry.message.sections?.skills ?? ""));
      const picks = Object.fromEntries([...pendingScores.picks].filter(([name]) => names.has(name)));
      if (Object.keys(picks).length) pi.appendEntry(SKILL_SCORE_ENTRY, { v: 1, sectionId: sectionEntry.id, picks });
    } catch { /* An unreadable or changed branch cannot prove the advertisement. */ }
  });
  /** Tool/MCP filtering still runs at turn boundaries independently of skills. */
  pi.on("turn_end", async (event, ctx) => (await toolFilter.turnEnd(event as never, ctx)) as never);
  pi.on("tool_call", async (event, ctx) => toolFilter.toolCall(event as never, ctx));
  pi.on("agent_end", (_event, ctx) => { toolFilter.agentEnd(ctx); });
}
