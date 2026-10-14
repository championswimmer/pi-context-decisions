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
import { SKILLS_BASE_ENTRY, buildSkillsDelta, readLedger, skillReader, type LedgerState, type SkillsDelta } from "./skill-ledger.ts";
import { selectionLabel, type Controller, type ExtensionDependencies, type ExtensionHost, type LastDecision } from "./contracts.ts";
import { queuedUserTask } from "./queued-task.ts";
import { createToolFilter } from "./tool-filter.ts";
import { beginDecisionLoader, endDecisionLoader, resetDecisionLoader } from "./decision-loader.ts";

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
  /** Full Pi skill objects from the latest before_agent_start; deltas need their canonical locations. */
  let skillRefs = new Map<string, Skill>();
  /** Latest bounded user task. Never assistant text, tool names, arguments or results. */
  let runTask: string | undefined;
  let failedKey: string | undefined;
  const seenQueued = new Set<string>();
  let busy = false;
  let toolsStatusShown = false;
  const abortPending = () => { for (const controller of pending) controller.abort(); pending.clear(); };
  const toolFilter = createToolFilter({
    pi, ensureLoaded: () => controller.ensureLoaded(), getSettings: () => settings, getSettingsError: () => settingsError, generation: () => generation,
    beginOperation: () => controller.beginOperation(),
    resolveClient: (ctx, current, responses) => resolveClient(ctx, current, responses, "tools"),
    loadProjectAllowlist: (cwd) => controller.loadProjectAllowlist(cwd), sumUsage,
    changed: (ctx) => { try { controller.setStatus(ctx as unknown as Parameters<Controller["setStatus"]>[0]); } catch { /* cosmetic */ } },
  });
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
    getLastToolDecision: () => toolFilter.last(),
    describeTools: (ctx) => toolFilter.describe(ctx),
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
        settings = next; settingsError = undefined; warnings = []; last = undefined; scoreCache.clear(); failedKey = undefined; toolFilter.invalidate();
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
      const state = settingsError ? "settings error · open /decisions to repair" : !settings.enabled || !settings.relevance.enabled ? "off" : !settings.backend ? "select model · /decisions" : last
        ? `${last.reason} · +${last.kept} of ${last.candidates} candidates${last.advertised === undefined ? "" : ` · ${last.advertised} advertised`}${last.cached ? " · cached" : ` · ${last.latencyMs}ms`}${last.errorCode ? ` · ${last.errorCode}` : ""}`
        : selectionLabel(settings.backend);
      ctx.ui.setStatus("context-decisions", state);
      // Tool filtering is opt-in: while it is off (the default) nothing extra is ever written to the status bar.
      const toolsText = toolFilter.status();
      if (toolsText !== undefined || toolsStatusShown) { ctx.ui.setStatus("context-decisions-tools", toolsText); toolsStatusShown = toolsText !== undefined; }
    },
  };
  const commands = registerCommands(pi, controller, deps.env);
  pi.on("session_start", async (_event, ctx) => {
    commands.closeDialogs(); // a dialog from a previous session must never outlive its context
    resetDecisionLoader(); // a reloaded extension must not touch the previous session's working row
    abortPending(); generation++; last = undefined; inventorySnapshot = undefined; projectWarnings.clear();
    scoreCache.clear(); skillRefs = new Map(); runTask = undefined; failedKey = undefined; seenQueued.clear(); toolFilter.reset();
    await projectWriteQueue;
    await writeQueue;
    await loading;
    loaded = false;
    await controller.ensureLoaded();
    if (settingsError) controller.report(ctx, `Settings error: ${settingsError}; skill advertisements fail closed until repaired`, "error");
    for (const warning of warnings) controller.report(ctx, warning, "warning");
    controller.setStatus(ctx);
  });
  pi.on("session_tree", () => {
    // Navigating the session tree changes the active branch: an in-flight pass was computed against the old one.
    // Everything branch-derived is re-read from the new branch at the next boundary; only transient state is dropped here.
    abortPending(); generation++; last = undefined; scoreCache.clear(); runTask = undefined; failedKey = undefined; seenQueued.clear(); toolFilter.reset();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    // First and synchronous: resolves the pending /decisions handler before ctx is invalidated.
    // The dialog is deliberately NOT in `pending`: settings saves abort decisions, not the dialog.
    commands.closeDialogs();
    resetDecisionLoader();
    abortPending(); generation++; last = undefined; scoreCache.clear(); toolFilter.reset();
    if (ctx.hasUI) { ctx.ui.setStatus("context-decisions", undefined); if (toolsStatusShown) { ctx.ui.setStatus("context-decisions-tools", undefined); toolsStatusShown = false; } }
  });
  const uniqueByName = <T extends { name: string }>(skills: readonly T[]): T[] => {
    const names = new Set<string>();
    return skills.filter((skill) => !names.has(skill.name) && !!names.add(skill.name));
  };
  const ledgerFor = (ctx: ExtensionContext): LedgerState => {
    try { return readLedger(ctx.sessionManager); }
    catch { return { base: new Set(), added: new Set(), visible: new Set(), lost: [] }; }
  };
  /** `skills` is gated by the skill switch, `tools` by the tool-filtering switch: the two features are independent. */
  function resolveClient(ctx: ExtensionContext, current: ContextDecisionsSettings, responses: DecisionResponse[], feature: "skills" | "tools" = "skills"): { client: RelevanceClient | null; error?: string } {
    if (settingsError) return { client: null, error: settingsError };
    // Never construct/request a client when explicitly disabled or unconfigured.
    if (!current.enabled || !(feature === "skills" ? current.relevance.enabled : current.tools.enabled) || !current.backend) return { client: null };
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
  const cacheKey = (task: string, current: ContextDecisionsSettings) =>
    JSON.stringify([task, current.backend, current.relevance.maxPromptChars, current.relevance.maxDescriptionChars]);
  const record = (round: SkillAdditionResult<Skill> | undefined, fields: Omit<LastDecision, "latencyMs" | "usage"> & { latencyMs?: number }, responses: DecisionResponse[], started: number) => {
    const usage = sumUsage(responses);
    last = { ...fields, latencyMs: fields.latencyMs ?? round?.latencyMs ?? Date.now() - started, ...(usage ? { usage } : {}) };
  };
  /**
   * Additive advertisement. The system prompt carries only a STABLE base (always-allowed skills, or the whole
   * inventory once filtering was off/unconfigured/below minimum on this branch). New skills are appended as
   * user-role custom messages built with Pi's public formatSkillsForPrompt, never removed, never re-scored.
   */
  /**
   * The tool handler is registered FIRST and starts the skill pass before awaiting its own, so both decision calls are in flight
   * together (two handlers are needed for two hidden messages). The skill handler then awaits that same promise.
   */
  let skillPass: Promise<{ message: SkillsDelta } | undefined> | undefined;
  const toolsActive = () => settings.enabled && settings.tools.enabled;
  pi.on("before_agent_start", async (event, ctx) => {
    skillPass = undefined;
    await controller.ensureLoaded();
    if (toolsActive() || settingsError) {
      skillPass = skillBeforeAgentStart(event, ctx);
      skillPass.catch(() => {}); // surfaced by the skill handler below; never an unhandled rejection here
    }
    return toolFilter.beforeAgentStart(event as never, ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const started = skillPass; skillPass = undefined;
    return started ?? skillBeforeAgentStart(event, ctx);
  });
  async function skillBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<{ message: SkillsDelta } | undefined> {
    const inventory = uniqueByName(event.systemPromptOptions.skills);
    inventorySnapshot = toScopedSkills(event.systemPromptOptions.skills);
    skillRefs = new Map(inventory.map((skill) => [skill.name, skill]));
    await controller.ensureLoaded();
    // Runs started by a custom message (pi.sendMessage with triggerTurn) have no user prompt: base and re-delivery only.
    const task = (event as { messageType?: unknown }).messageType === "custom" || typeof event.prompt !== "string" ? "" : taskWithoutExpandedSkill(event.prompt);
    runTask = task.trim() ? task : undefined;
    failedKey = undefined;
    const currentGeneration = generation;
    const current = structuredClone(settings);
    const abort = new AbortController();
    pending.add(abort);
    busy = true;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const responses: DecisionResponse[] = [];
    const started = Date.now();
    try {
      // Pi omits the skills section when neither `read` nor `bash` is declared, so nothing is exposed then:
      // record no base at all (a later run with a reader must still score and advertise those skills).
      const reader = skillReader(pi.getActiveTools());
      const inventoryNames = new Set(inventory.map((skill) => skill.name));
      const invocable = inventory.filter((skill) => !skill.disableModelInvocation);
      const setSystemSkills = (names: ReadonlySet<string>) => {
        if (!reader) return; // no section is rendered; leave Pi's array alone
        const base = inventory.filter((skill) => skill.disableModelInvocation || names.has(skill.name));
        // Nothing to hide: keep Pi's own array (and its prompt section) untouched.
        if (base.length !== event.systemPromptOptions.skills.length) event.systemPromptOptions.skills = base;
      };
      const pinned = await pinsFor(ctx, current, event.systemPromptOptions.skills, true);
      /**
       * Nothing may be recorded or applied for a superseded pass (settings/allowlist save, session replacement,
       * branch navigation) or a cancelled run: guard BEFORE any base mutation after an await. The system skills
       * come from the CURRENT branch's base plus the effective always-allowed skills; no entry is appended, so
       * nothing from the old pass can leak onto the new branch.
       */
      const superseded = () => currentGeneration !== generation || signal.aborted;
      const supersededBase = () => new Set([...ledgerFor(ctx).base, ...pinned]);
      const bail = () => {
        setSystemSkills(supersededBase());
        // A cancelled run (same generation) is still reported as aborted; a superseded one is silent.
        if (currentGeneration !== generation) return;
        record(undefined, { reason: "fail-closed", candidates: invocable.length, kept: 0, errorCode: "aborted", trigger: "prompt" }, responses, started);
        controller.setStatus(ctx);
      };
      if (superseded()) { bail(); return; }
      const ledger = ledgerFor(ctx);
      const growBase = (names: Iterable<string>, pinnedNames = false) => {
        if (!reader) return;
        const fresh = [...new Set(names)].filter((name) => inventoryNames.has(name) && !ledger.base.has(name));
        if (!fresh.length) return;
        pi.appendEntry(SKILLS_BASE_ENTRY, pinnedNames ? { v: 1, names: fresh, pinned: true } : { v: 1, names: fresh });
        for (const name of fresh) ledger.base.add(name);
      };
      const applyBase = () => setSystemSkills(ledger.base);
      growBase(pinned, true); // allowlist removals never shrink the base: advertisements are only ever added
      const lostSkills = reader ? ledger.lost.flatMap((name) => skillRefs.get(name) ?? []) : [];
      const { client, error: configError } = resolveClient(ctx, current, responses);
      let reason: LastDecision["reason"] = "skipped";
      let errorCode: string | undefined;
      let round: SkillAdditionResult<Skill> | undefined;
      const pinnedSet = new Set(pinned);
      if (configError) { reason = "fail-closed"; errorCode = "config"; }
      else if (!current.enabled || !current.relevance.enabled || !client || invocable.length < current.relevance.minCandidates) {
        // Today's semantics, made additive: disabled/unconfigured/below-minimum keep EVERYTHING advertised, and
        // the branch remembers that, so enabling filtering later can never drop a skill the model already saw.
        growBase(invocable.map((skill) => skill.name));
      } else if (task.trim() && reader) {
        const remaining = invocable.filter((skill) => !ledger.base.has(skill.name) && !ledger.added.has(skill.name) && !pinnedSet.has(skill.name));
        // Pi's own braille working row shows "Deciding Context" for as long as the round is in flight.
        beginDecisionLoader(ctx);
        try {
          round = await scoreAdditions(task, remaining, client, { ...current.relevance, maxQuestions: 50, signal }, { store: scoreCache, key: cacheKey(task, current) });
        } finally { endDecisionLoader(); }
        reason = round.failedOpen ? "fail-open" : round.errorCode ? "fail-closed" : "filtered";
        errorCode = round.errorCode;
        if (round.errorCode && round.errorCode !== "aborted") failedKey = cacheKey(task, current);
      }
      if (superseded()) { bail(); return; }
      applyBase();
      // Re-check cancellation right before committing: cached scores or restoration must not slip past an abort.
      const cancelled = signal.aborted;
      const added = cancelled ? [] : round?.added ?? [];
      const delta = reader && !cancelled ? buildSkillsDelta(added, lostSkills, reader, round?.picks) : undefined;
      const advertised = new Set([...ledger.base, ...ledger.added, ...added.map((skill) => skill.name)]);
      record(round, {
        reason, candidates: round?.candidates ?? invocable.length, kept: added.length,
        advertised: invocable.filter((skill) => advertised.has(skill.name)).length, redelivered: delta?.details.redelivered.length ?? 0,
        ...(round?.cached ? { cached: true } : {}), trigger: "prompt", ...(errorCode ? { errorCode } : {}),
      }, responses, started);
      controller.setStatus(ctx);
      if (errorCode && errorCode !== "aborted") controller.report(ctx, `Skill advertisements ${reason} (${errorCode}); /decisions status`, "warning");
      return delta ? { message: delta } : undefined;
    } finally { pending.delete(abort); busy = false; }
  }
  /**
   * Between model requests inside a run. Only adds: re-delivers skills that compaction/edits removed from model
   * context (no scoring), and, for queued steering/follow-up user text or the opt-in `tool-round` cadence after
   * completed tool calls, adds the next-best remaining skills. Nothing but the latest bounded user task and
   * candidate names/descriptions is ever sent to the decision model, and the loop is never continued here.
   */
  pi.on("turn_end", async (event, ctx) => {
    if (busy || event.outcome !== "completed" || event.context?.canContinue !== true) return;
    const reader = skillReader(pi.getActiveTools());
    if (!reader) return;
    await controller.ensureLoaded();
    const queued = queuedUserTask(event.context.pendingMessages);
    const fresh = queued && !seenQueued.has(queued.id) ? queued : undefined;
    const current = structuredClone(settings);
    const toolRound = current.relevance.cadence === "tool-round" && event.toolResults.length > 0 && runTask !== undefined;
    const ledger = ledgerFor(ctx);
    const lostSkills = ledger.lost.flatMap((name) => skillRefs.get(name) ?? []);
    if (fresh) { seenQueued.add(fresh.id); runTask = fresh.text; failedKey = undefined; }
    const task = fresh?.text ?? (toolRound ? runTask : undefined);
    if (!task && !lostSkills.length) return;
    const currentGeneration = generation;
    const abort = new AbortController();
    pending.add(abort);
    busy = true;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const responses: DecisionResponse[] = [];
    const started = Date.now();
    try {
      let round: SkillAdditionResult<Skill> | undefined;
      const key = task ? cacheKey(task, current) : undefined;
      if (task && key !== undefined && (fresh || key !== failedKey)) {
        const { client } = resolveClient(ctx, current, responses);
        if (client) {
          const skills = [...skillRefs.values()];
          const pinnedSet = new Set(await pinsFor(ctx, current, skills, false));
          if (currentGeneration !== generation || signal.aborted) return; // superseded while reading the allowlist: score nothing
          const remaining = skills.filter((skill) => !skill.disableModelInvocation && !ledger.base.has(skill.name) && !ledger.added.has(skill.name) && !pinnedSet.has(skill.name));
          beginDecisionLoader(ctx);
          try {
            round = await scoreAdditions(task, remaining, client, { ...current.relevance, maxQuestions: 50, signal }, { store: scoreCache, key });
          } finally { endDecisionLoader(); }
          if (round.errorCode && round.errorCode !== "aborted") failedKey = key;
        }
      }
      if (currentGeneration !== generation || signal.aborted) return; // stale or cancelled (even with cached scores): commit nothing
      const added = round?.added ?? [];
      const delta = buildSkillsDelta(added, lostSkills, reader, round?.picks);
      if (round) {
        const advertised = new Set([...ledger.base, ...ledger.added, ...added.map((skill) => skill.name)]);
        record(round, {
          reason: round.failedOpen ? "fail-open" : round.errorCode ? "fail-closed" : "filtered", candidates: round.candidates, kept: added.length,
          advertised: [...skillRefs.values()].filter((skill) => !skill.disableModelInvocation && advertised.has(skill.name)).length,
          redelivered: delta?.details.redelivered.length ?? 0, ...(round.cached ? { cached: true } : {}),
          trigger: fresh ? "queued" : "tool-round", ...(round.errorCode ? { errorCode: round.errorCode } : {}),
        }, responses, started);
        controller.setStatus(ctx as unknown as Parameters<Controller["setStatus"]>[0]);
      }
      // Pi's boundary dispatch REPLACES the accumulated drafts with whatever a handler returns, so keep every
      // earlier extension's custom/context_edit/compaction drafts and append ours.
      return delta ? { entries: [...event.entries, { type: "custom_message" as const, ...delta }] } : undefined;
    } finally { pending.delete(abort); busy = false; }
  });
  /**
   * Tool/MCP filtering at the turn boundary. Registered AFTER the skill handler: Pi hands each handler the drafts accumulated so far, so
   * this one appends to `event.entries` (the skill delta and any other extension's drafts stay).
   */
  pi.on("turn_end", async (event, ctx) => (await toolFilter.turnEnd(event as never, ctx)) as never);
  pi.on("tool_call", async (event, ctx) => toolFilter.toolCall(event as never, ctx));
  pi.on("agent_end", (_event, ctx) => { toolFilter.agentEnd(ctx); });
}
