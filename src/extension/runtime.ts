import { subagentManagerPresent } from "./subagent-manager.ts";
import { MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION, MANAGER_DIAGNOSTICS_HELP, createManagerDiagnostics } from "./manager-diagnostics.ts";
import type { BeforeAgentStartEvent, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { RelevanceScoreCache, scoreAdditions, type SkillAdditionResult } from "../apps/skill-additions.ts";
import { taskWithoutExpandedSkill } from "../apps/skill-filter.ts";
import type { RelevanceClient } from "../apps/relevance.ts";
import { allowlistedNames, toScopedSkills, type ScopedSkill } from "../apps/allowlist.ts";
import { loadProjectAllowlist, saveProjectAllowlist, type ProjectAllowlistLists } from "../project-allowlist.ts";
import { createBackend } from "../core/backends/factory.ts";
import { createDecisionClient } from "../decision/api.ts";
import { DecisionError } from "../decision/errors.ts";
import type { DecisionResponse, DecisionUsage } from "../decision/types.ts";
import type { ContextDecisionsSettings } from "../settings.ts";
import { defaultSettings, loadSettings, parseSettings, saveSettings } from "../settings.ts";
import { registerCommands } from "./commands.ts";
import { advertisedSkillNames } from "./skill-state.ts";
import type { Controller, ExtensionDependencies, ExtensionHost, LastDecision } from "./contracts.ts";
import { readPreviousFinalReply } from "./decision-activity.ts";
import { createToolFilter } from "./tool-filter.ts";
import { beginDecisionLoader, endDecisionLoader, resetDecisionLoader } from "./decision-loader.ts";
import { skillFooter } from "./footer-status.ts";

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
  /** Scores for the current task: later rounds for the same task add the next-best skills without a call. */
  const scoreCache = new RelevanceScoreCache();
  /** Full Pi skill objects from the latest prompt for inventory and status. */
  let skillRefs = new Map<string, Skill>();
  let toolsStatusShown = false;
  const abortPending = () => { for (const controller of pending) controller.abort(); pending.clear(); };
  const toolFilter = createToolFilter({
    pi, agentDir: deps.agentDir, report: (ctx, message) => controller.report(ctx, message, "warning"), ensureLoaded: () => controller.ensureLoaded(), getSettings: () => settings, getSettingsError: () => settingsError, generation: () => generation,
    beginOperation: () => controller.beginOperation(),
    resolveClient: (ctx, current, responses) => resolveClient(ctx, current, responses, "tools"),
    loadProjectAllowlist: (cwd) => controller.loadProjectAllowlist(cwd), sumUsage,
    changed: (ctx) => { try { controller.setStatus(ctx as unknown as Parameters<Controller["setStatus"]>[0]); } catch { /* cosmetic */ } },
  });
  const load = async () => {
    const result = await (deps.load ?? loadSettings)(deps.settingsPath);
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
    async ensureLoaded() {
      if (loaded) return;
      loading ??= load().finally(() => { loading = undefined; });
      await loading;
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
    async update(change) {
      const operation = writeQueue.then(async () => {
        await controller.ensureLoaded();
        const next = parseSettings(change(structuredClone(settings)));
        await (deps.save ?? saveSettings)(next, deps.settingsPath);
        abortPending(); generation++;
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
    abortPending(); generation++; last = undefined; inventorySnapshot = undefined; projectWarnings.clear();
    scoreCache.clear(); skillRefs = new Map(); toolFilter.reset(true);
    await projectWriteQueue;
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
  pi.on("session_tree", () => {
    // Navigating the session tree changes the active branch: an in-flight pass was computed against the old one.
    // Everything branch-derived is re-read from the new branch at the next boundary; only transient state is dropped here.
    abortPending(); generation++; last = undefined; scoreCache.clear(); skillRefs = new Map(); toolFilter.reset();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    // First and synchronous: resolves the pending /decisions handler before ctx is invalidated.
    // The dialog is deliberately NOT in `pending`: settings saves abort decisions, not the dialog.
    commands.closeDialogs();
    managerDiagnostics.reset();
    resetDecisionLoader();
    abortPending(); generation++; last = undefined; scoreCache.clear(); toolFilter.reset(true);
    if (ctx.hasUI) { ctx.ui.setStatus("context-decisions", undefined); if (toolsStatusShown) { ctx.ui.setStatus("context-decisions-tools", undefined); toolsStatusShown = false; } }
  });
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
    const available = uniqueByName(event.systemPromptOptions.skills);
    inventorySnapshot = toScopedSkills(available);
    if (!available.length && !skillRefs.size) return;
    let committed: Set<string>;
    try { committed = advertisedSkillNames(ctx.sessionManager); }
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
    const task = (event as { messageType?: unknown }).messageType === "custom" || typeof event.prompt !== "string" ? "" : taskWithoutExpandedSkill(event.prompt);
    const currentGeneration = generation;
    const current = structuredClone(settings);
    const previousReply = task.trim() ? readPreviousFinalReply(ctx.sessionManager) : undefined;
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
        const remaining = invocable.filter((skill) => !advertised.has(skill.name));
        beginDecisionLoader(ctx);
        try {
          round = await scoreAdditions(task, remaining, client, { ...current.relevance, ...current.decision, maxQuestions: 50, signal, previousReply }, { store: scoreCache, key: cacheKey(task, current, previousReply || undefined) });
        } finally { endDecisionLoader(); }
        reason = round.failedOpen ? "fail-open" : round.errorCode ? "fail-closed" : "filtered";
        errorCode = round.errorCode;
      }
      if (superseded()) { bail(); return; }
      for (const skill of round?.added ?? []) advertised.add(skill.name);
      apply(advertised);
      record(round, {
        reason, candidates: round?.candidates ?? invocable.length, kept: round?.added.length ?? 0,
        advertised: hasReader ? invocable.filter((skill) => advertised.has(skill.name)).length : committed.size,
        ...(round?.cached ? { cached: true } : {}), trigger: "prompt", ...(errorCode ? { errorCode } : {}),
      }, responses, started);
      controller.setStatus(ctx);
      if (errorCode && errorCode !== "aborted") controller.report(ctx, `Skill advertisements ${reason} (${errorCode}); /decisions status`, "warning");
    } finally { pending.delete(abort); }
  }
  /** Tool/MCP filtering still runs at turn boundaries independently of skills. */
  pi.on("turn_end", async (event, ctx) => (await toolFilter.turnEnd(event as never, ctx)) as never);
  pi.on("tool_call", async (event, ctx) => toolFilter.toolCall(event as never, ctx));
  pi.on("agent_end", (_event, ctx) => { toolFilter.agentEnd(ctx); });
}
