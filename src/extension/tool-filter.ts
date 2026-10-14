// Opt-in tool and MCP filtering. Independent of skill filtering: its own settings block, ledger entry type and caches.
//
// Host contract (Pi 1.1.0, public APIs only):
// - Declared tools (direct/model-only) are filtered with `pi.setActiveTools`, only ever REMOVING tools this extension
//   decided against and RESTORING only tools it removed. `selectedTools`, `context_with_system` and provider payloads are never touched.
// - Calls are gated in `tool_call`: that is the only control over codemode/deferred tools, which stay callable (and
//   discoverable) whether or not they are active. It is NOT a sandbox: `bash`, discovery listings, the `mcp_servers`
//   prompt section and `tool_search` results are unaffected.
// - Everything is derived from the active session branch (`context-decisions-tools` custom entries).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IncrementalScoreCache, scoreToolAdditions, type ToolAdditionResult } from "../apps/tool-additions.ts";
import { classifyTools, candidatesFor, canonicalServerKey, serverKey, type ClassifiedTool, type ToolInventory } from "../apps/tool-inventory.ts";
import { availability, baseGrowth, NO_ALLOWLISTS, reconcileActive, remaining, serverAllowlisted, type Availability, type EffectiveAllowlists } from "../apps/tool-policy.ts";
import { taskWithoutExpandedSkill, safeCode } from "../apps/skill-filter.ts";
import type { RelevanceClient } from "../apps/relevance.ts";
import type { DecisionResponse, DecisionUsage } from "../decision/types.ts";
import type { ProjectAllowlistLoad } from "../project-allowlist.ts";
import type { ContextDecisionsSettings, ToolFilterMode } from "../settings.ts";
import type { CommandContext, ExtensionHost, LastToolDecision, ToolReport } from "./contracts.ts";
import { queuedUserTask } from "./queued-task.ts";
import { TOOLS_LEDGER_ENTRY, buildToolNotice, readToolLedger, toolRecords, type ToolLedgerData, type ToolLedgerState, type ToolNotice } from "./tool-ledger.ts";

export interface ToolFilterDeps {
  pi: ExtensionHost;
  ensureLoaded(): Promise<void>;
  getSettings(): ContextDecisionsSettings;
  getSettingsError(): string | undefined;
  generation(): number;
  beginOperation(): { signal: AbortSignal; close(): void };
  /** Builds a decision client for TOOL filtering (gated only by the master switch, tool settings and a selected backend). */
  resolveClient(ctx: ExtensionContext, settings: ContextDecisionsSettings, responses: DecisionResponse[]): { client: RelevanceClient | null; error?: string };
  loadProjectAllowlist(cwd: string): Promise<ProjectAllowlistLoad>;
  sumUsage(responses: DecisionResponse[]): DecisionUsage | undefined;
  /** Called after every round and boundary so the extension can refresh the status line. */
  changed(ctx: ExtensionContext): void;
}
export interface ToolCallLike { toolName: string; input?: unknown }
interface BeforeStartLike { prompt?: unknown; messageType?: unknown }
interface TurnEndLike {
  outcome?: string; toolResults?: readonly unknown[]; entries: readonly unknown[];
  context?: { canContinue?: boolean; pendingMessages?: readonly unknown[] };
}
type Draft = { type: "custom"; customType: string; data: unknown } | ({ type: "custom_message" } & ToolNotice);
type Trigger = LastToolDecision["trigger"];
/** `ok`: nothing to do or the round completed. `failed`: a decision error (nothing added). `superseded`: cancelled or stale, nothing committed. */
type Outcome = "ok" | "failed" | "superseded";
type State = "on" | "off" | "enforce";
export interface ToolFilter {
  beforeAgentStart(event: BeforeStartLike, ctx: ExtensionContext): Promise<{ message: ToolNotice } | undefined>;
  turnEnd(event: TurnEndLike, ctx: ExtensionContext): Promise<{ entries: unknown[] } | undefined>;
  toolCall(event: ToolCallLike, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined>;
  agentEnd(ctx: ExtensionContext): void;
  /** Drop transient state (session start/tree/shutdown, settings or allowlist saves). The branch ledger is untouched. */
  reset(): void;
  /** Settings/allowlist saved: project list cache and scores are stale. */
  invalidate(): void;
  describe(ctx: CommandContext): Promise<ToolReport>;
  last(): LastToolDecision | undefined;
  /** Status-line text, or undefined when filtering is off. */
  status(): string | undefined;
}
const BLOCK_REASON_LIMIT = 300;
const clean = (value: string, limit = 80) => value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, limit);

export function createToolFilter(deps: ToolFilterDeps): ToolFilter {
  const { pi } = deps;
  const cache = new IncrementalScoreCache();
  /** Not-yet-flushed ledger additions (lazy gate rounds, a round whose turn was cut short). Dropped on branch change. */
  const fresh = () => ({ marker: false, tools: new Set<string>(), groups: new Set<string>(), considered: new Set<string>(), withheld: new Set<string>(), released: new Set<string>(), initialTask: undefined as string | undefined });
  let pend = fresh();
  let runTask: string | undefined;
  let failedKey: string | undefined;
  let last: LastToolDecision | undefined;
  let counts: { available: number; external: number; withheld: number; mode: ToolFilterMode } | undefined;
  let projectCache: { cwd: string; tools: string[]; servers: string[] } | undefined;
  let inflight: { key: string; promise: Promise<void> } | undefined;
  let activeState: State = "off";
  const seenQueued = new Set<string>();
  const supported = () => typeof pi.getAllTools === "function" && typeof pi.setActiveTools === "function";

  const stateOf = (settings: ContextDecisionsSettings, error: string | undefined, ledger: ToolLedgerState): State => {
    // An unreadable settings file must not silently drop filtering a branch already has: keep enforcing its ledger, add nothing.
    if (error) return ledger.present || ledger.unreadable ? "enforce" : "off";
    if (!settings.enabled || !settings.tools.enabled) return "off";
    return ledger.unreadable ? "enforce" : "on";
  };
  const readLedger = (ctx: ExtensionContext): ToolLedgerState => {
    try { return readToolLedger(ctx.sessionManager); }
    // Never invent evidence: an unreadable branch is not "mid-session" (that would grant every tool). It is unreadable, and only the fail-closed gate acts.
    catch { return { tools: new Set(), groups: new Set(), withheld: new Set(), considered: new Set(), present: false, announced: new Set(), noticed: false, hasMessages: false, unreadable: true }; }
  };
  /** The branch ledger plus additions not yet flushed. */
  const merged = (ctx: ExtensionContext): ToolLedgerState => {
    const ledger = readLedger(ctx);
    for (const name of pend.tools) ledger.tools.add(name);
    for (const name of pend.groups) ledger.groups.add(name);
    for (const name of pend.considered) ledger.considered.add(name);
    for (const name of pend.released) ledger.withheld.delete(name);
    for (const name of pend.withheld) ledger.withheld.add(name);
    ledger.initialTask ??= pend.initialTask;
    return ledger;
  };
  /** Last provenance-classified registry read; the gate falls back to it when `getAllTools` fails (the registry is global, not per branch). */
  let snapshot: ToolInventory | undefined;
  const classify = (): ToolInventory => { const inv = classifyTools(pi.getAllTools!()); snapshot = inv; return inv; };
  /**
   * What ONE pass added to the shared pending overlay, so a superseded pass can take back exactly its own additions and nothing else:
   * never other passes' pending names, and never anything on a different branch (a reset replaces the overlay; deleting from the old
   * sets is harmless). A snapshot restore would resurrect state that a reset or flush legitimately discarded.
   */
  const journal = () => {
    const undo: (() => void)[] = [];
    return {
      add(set: Set<string>, value: string) { if (!set.has(value)) { set.add(value); undo.push(() => { set.delete(value); }); } },
      marker() { const owner = pend; if (!owner.marker) { owner.marker = true; undo.push(() => { owner.marker = false; }); } },
      initialTask(task: string) { const owner = pend; if (owner.initialTask === undefined) { owner.initialTask = task; undo.push(() => { if (owner.initialTask === task) owner.initialTask = undefined; }); } },
      undo() { while (undo.length) undo.pop()!(); },
    };
  };
  type Journal = ReturnType<typeof journal>;
  /** Bumped by reset/invalidate: an in-flight project read that started before it must never populate the cache afterwards. */
  let cacheEpoch = 0;
  const allowlists = async (ctx: ExtensionContext, settings: ContextDecisionsSettings, refresh: boolean): Promise<EffectiveAllowlists> => {
    let project = projectCache && projectCache.cwd === (ctx.cwd ?? "") ? projectCache : undefined;
    if ((refresh || !project) && ctx.cwd) {
      const epoch = cacheEpoch, generation = deps.generation();
      // A throwing read keeps the last good cache, else only the global lists apply: never more than the user allowed.
      try {
        const loaded = await deps.loadProjectAllowlist(ctx.cwd);
        const read = { cwd: ctx.cwd, tools: loaded.tools, servers: loaded.mcpServers };
        // An obsolete read (settings/allowlist save, reset, branch change while it was pending) is returned to its caller, who revalidates,
        // but never cached.
        if (epoch === cacheEpoch && generation === deps.generation()) projectCache = read;
        project = read;
      } catch { /* keep `project` as is */ }
    }
    return { tools: new Set([...settings.tools.alwaysAllowedTools, ...(project?.tools ?? [])]), servers: new Set([...settings.tools.alwaysAllowedMcpServers, ...(project?.servers ?? [])]) };
  };
  const cacheKey = (task: string, settings: ContextDecisionsSettings) =>
    JSON.stringify([settings.tools.mode, task, settings.backend, settings.relevance.maxPromptChars, settings.tools.maxDescriptionChars]);
  /** Cadence task for catch-up and lazy scoring: the first task for `initial`, the latest otherwise. */
  const cadenceTask = (settings: ContextDecisionsSettings, ledger: ToolLedgerState): string | undefined =>
    settings.tools.cadence === "initial" ? ledger.initialTask : runTask;
  const externalCount = (inv: ToolInventory, mode: ToolFilterMode) => mode === "mcp" ? inv.groups.size : inv.tools.filter((tool) => tool.kind !== "internal").length;

  interface Frame { inv: ToolInventory; settings: ContextDecisionsSettings; mode: ToolFilterMode; ledger: ToolLedgerState; allow: EffectiveAllowlists; avail: Availability }
  const view = (inv: ToolInventory, settings: ContextDecisionsSettings, ledger: ToolLedgerState, allow: EffectiveAllowlists): Frame => {
    const mode = settings.tools.mode;
    return { inv, settings, mode, ledger, allow, avail: availability(inv, mode, ledger, allow) };
  };
  const addAvailable = (mode: ToolFilterMode, names: Iterable<string>, j?: Journal) => { for (const name of names) { const set = mode === "mcp" ? pend.groups : pend.tools; if (j) j.add(set, name); else set.add(name); } };

  /**
   * Score undecided candidates. `only` narrows to specific identifiers; `needScore` restricts to candidates a decision call would be
   * needed for under the task key (catch-up and gate), as opposed to also re-selecting cached next-best ones (`tool-round`).
   */
  const decide = async (ctx: ExtensionContext, c: Frame, task: string, trigger: Trigger, options: { signal: AbortSignal; generation: number; needScoreOnly: boolean; excludeConsidered: boolean; recordConsidered: boolean; journal?: Journal }): Promise<Outcome> => {
    const { settings, mode } = c;
    const key = cacheKey(task, settings);
    let names = remaining(c.inv, mode, c.avail);
    if (options.excludeConsidered) names = new Set([...names].filter((name) => !c.ledger.considered.has(name)));
    let candidates = candidatesFor(c.inv, mode, names, settings.tools.maxDescriptionChars);
    if (options.needScoreOnly) candidates = candidates.filter((candidate) => cache.needsScoring(key, candidate));
    const responses: DecisionResponse[] = [];
    const { client, error } = deps.resolveClient(ctx, settings, responses);
    const started = Date.now();
    const base = () => ({ mode, trigger, available: 0, external: externalCount(c.inv, mode), withheld: c.ledger.withheld.size });
    if (!candidates.length) return "ok";
    if (error) { last = { ...base(), reason: "fail-closed", candidates: candidates.length, kept: 0, errorCode: "config", latencyMs: Date.now() - started }; return "failed"; }
    if (!client) return "failed";
    if (key === failedKey && trigger !== "prompt" && trigger !== "queued" && trigger !== "initial") return "failed";
    let round: ToolAdditionResult;
    try {
      round = await scoreToolAdditions(task, candidates, client, {
        subject: mode === "mcp" ? "mcp_server" : "tool", threshold: settings.tools.threshold, maxAdded: settings.tools.maxAdded, failMode: settings.tools.failMode,
        maxPromptChars: settings.relevance.maxPromptChars, maxDescriptionChars: settings.tools.maxDescriptionChars, chunkSize: settings.relevance.chunkSize,
        concurrency: settings.relevance.concurrency, timeoutMs: settings.relevance.timeoutMs, maxQuestions: 50, signal: options.signal,
      }, { store: cache, key });
    } catch (error2) {
      round = { added: [], eligible: 0, candidates: candidates.length, scored: 0, reused: 0, latencyMs: Date.now() - started, batchSizes: [], considered: [], errorCode: safeCode(error2) };
    }
    // A superseded (settings/allowlist save, branch change, session replacement) or cancelled round commits nothing.
    if (options.generation !== deps.generation() || options.signal.aborted) return "superseded";
    if (round.errorCode && round.errorCode !== "aborted") failedKey = key;
    addAvailable(mode, round.added, options.journal);
    if (options.recordConsidered && !round.errorCode) for (const name of round.considered) { if (options.journal) options.journal.add(pend.considered, name); else pend.considered.add(name); }
    const usage = deps.sumUsage(responses);
    last = {
      ...base(), reason: round.failedOpen ? "fail-open" : round.errorCode ? "fail-closed" : "filtered", candidates: round.candidates, kept: round.added.length,
      ...(round.scored === 0 && !round.errorCode ? { cached: true } : {}), latencyMs: round.latencyMs, ...(round.errorCode ? { errorCode: round.errorCode } : {}), ...(usage ? { usage } : {}),
    };
    return round.errorCode ? "failed" : "ok";
  };

  /** Withhold/restore declared tools and grow the base, then summarize what to persist and announce. */
  /** `on`: full boundary. `enforce`/`reconcile`: withhold/restore only (no growth or notice). `restore`: filtering was turned off. */
  const finish = (ctx: ExtensionContext, inv: ToolInventory, settings: ContextDecisionsSettings, allow: EffectiveAllowlists, how: "on" | "enforce" | "reconcile" | "restore"): { pending: Pending; drafts: Draft[]; message?: ToolNotice } => {
    const enabled = how !== "restore";
    const mode = settings.tools.mode;
    let ledger = merged(ctx);
    let avail = availability(inv, mode, ledger, allow);
    // Additive base: allowlisted names, promoted namespaces and (mcp mode) extension tools are recorded, so allowlist removal or a mode switch never removes availability.
    if (how === "on") {
      const growth = baseGrowth(inv, mode, ledger, allow, avail);
      for (const name of growth.tools) pend.tools.add(name);
      for (const key of growth.groups) pend.groups.add(key);
      // Allowlisted servers with no registered tools (resource-only) are recorded by canonical key too, so removing the allowlist entry later
      // does not revoke access that was available on this branch.
      for (const entry of allow.servers) { const key = canonicalServerKey(entry); if (!ledger.groups.has(key)) pend.groups.add(key); }
      ledger = merged(ctx); avail = availability(inv, mode, ledger, allow);
    }
    const active = pi.getActiveTools();
    const { withhold, restore } = enabled ? reconcileActive(inv, avail, active, ledger.withheld) : { withhold: [], restore: [...ledger.withheld].filter((name) => { const tool = inv.byName.get(name); return !!tool && tool.declarable && !active.includes(name); }) };
    if (withhold.length || restore.length) {
      const hold = new Set(withhold);
      try { pi.setActiveTools!([...active.filter((name) => !hold.has(name)), ...restore]); }
      catch { withhold.length = 0; restore.length = 0; } // stale host: record nothing we did not do
      for (const name of withhold) { pend.withheld.add(name); pend.released.delete(name); }
      for (const name of restore) { pend.released.add(name); pend.withheld.delete(name); }
    }
    ledger = merged(ctx);
    // Notice: only codemode/deferred candidates need one; direct tools are declared (or not) by Pi's own transcript deltas.
    const announce = new Set<string>();
    let hiddenUnavailable = false;
    if (how === "on") {
      for (const group of inv.groups.values()) {
        if (!group.tools.some((name) => !inv.byName.get(name)!.declarable)) continue;
        if (avail.isGroupAvailable(group.key)) announce.add(group.key); else hiddenUnavailable = true;
      }
      // In `mcp` mode only namespaces are decided; non-MCP extension tools are never filtered and need no mention.
      if (mode === "tools") {
        for (const tool of inv.tools) {
          if (tool.kind === "internal" || tool.declarable || (tool.group && avail.isGroupAvailable(tool.group))) continue;
          if (avail.isAvailable(tool)) announce.add(tool.name); else hiddenUnavailable = true;
        }
      }
    }
    const newItems = [...announce].filter((name) => !ledger.announced.has(name));
    const baseline = how === "on" && !ledger.noticed && hiddenUnavailable;
    const notice = how === "on" && (baseline || (ledger.noticed && newItems.length))
      ? buildToolNotice(newItems.filter((name) => !inv.groups.has(name)), newItems.filter((name) => inv.groups.has(name)), baseline)
      : undefined;
    const pending = flushRecord();
    const drafts: Draft[] = [];
    if (notice) drafts.push({ type: "custom_message", ...notice });
    const ext = inv.tools.filter((tool) => tool.kind !== "internal");
    counts = { mode, external: externalCount(inv, mode), available: mode === "mcp" ? avail.groups.size : ext.filter((tool) => avail.isAvailable(tool)).length, withheld: ledger.withheld.size };
    if (last) last = { ...last, available: counts.available, external: counts.external, withheld: counts.withheld };
    return { pending, drafts, ...(notice ? { message: notice } : {}) };
  };
  type Pending = ReturnType<typeof fresh>;
  /** Hands the pending additions over (they are about to be persisted) and empties the overlay. */
  const flushRecord = (): Pending => { const taken = pend; pend = fresh(); return taken; };
  /**
   * Turn pending additions into ledger records: reduced to what the branch does not already know (a quiet boundary writes nothing) and
   * split into chunks, never truncated. `marker`: the first active boundary on a fresh branch always leaves a record, so a tool that
   * registers later in the same run is never mistaken for "filtering was enabled mid-session" (which would record it as already seen).
   */
  const toRecords = (taken: Pending, ledger: ToolLedgerState): ToolLedgerData[] => {
    const records = toolRecords({
      tools: [...taken.tools].filter((name) => !ledger.tools.has(name)), groups: [...taken.groups].filter((key) => !ledger.groups.has(key)),
      considered: [...taken.considered].filter((name) => !ledger.considered.has(name)),
      withheld: [...taken.withheld].filter((name) => !ledger.withheld.has(name)), released: [...taken.released].filter((name) => ledger.withheld.has(name)),
      initialTask: ledger.initialTask === undefined ? taken.initialTask : undefined,
    });
    const had = taken.marker || taken.tools.size + taken.groups.size + taken.considered.size + taken.withheld.size + taken.released.size > 0 || taken.initialTask !== undefined;
    return records.length || ledger.present || !had ? records : [{ v: 1 }];
  };
  const commit = (ctx: ExtensionContext, result: { pending: Pending; drafts: Draft[]; message?: ToolNotice }, baseLedger: ToolLedgerState): Draft[] => [
    ...toRecords(result.pending, baseLedger).map((data): Draft => ({ type: "custom", customType: TOOLS_LEDGER_ENTRY, data })), ...result.drafts,
  ];

  /**
   * Enabling mid-session: the model may already have seen every registered tool, so on a branch with conversation but no ledger they stay
   * available (recorded as base). Filtering then affects tools that register later, or new sessions. Documented limitation.
   */
  const ensureBase = (ctx: ExtensionContext, inv: ToolInventory, ledger: ToolLedgerState, j: Journal): ToolLedgerState => {
    if (ledger.present || !ledger.hasMessages) return ledger;
    for (const tool of inv.tools) if (tool.kind !== "internal") j.add(pend.tools, tool.name);
    for (const key of inv.groups.keys()) j.add(pend.groups, key);
    return merged(ctx);
  };
  const joinSignal = (ctx: ExtensionContext, operation: { signal: AbortSignal }) => ctx.signal ? AbortSignal.any([ctx.signal, operation.signal]) : operation.signal;

  const STALE = Symbol("stale");
  /**
   * The call gate. Policy when the registry cannot be read (`pi.getAllTools` throws): classification falls back to the last
   * provenance-classified inventory SNAPSHOT taken at any successful boundary/gate/status read. With a snapshot, tools it knows as
   * internal pass, known external tools follow the ledger and allowlists as usual, and anything it does not know is blocked. With NO
   * snapshot nothing can be verified, so every call is blocked until the registry recovers (fail closed). A throwing project-allowlist
   * read falls back to the last good cache, else to the global lists only (fewer allowed, never more). `generation` is captured by the
   * caller before any await; a verdict is returned only if it is still current, otherwise STALE (the caller re-evaluates).
   */
  const evaluateCall = async (event: ToolCallLike, ctx: ExtensionContext, generation: number): Promise<{ block: true; reason: string } | undefined | typeof STALE> => {
      let blockable: ClassifiedTool | undefined;
      const unverified = () => ({ block: true as const, reason: `Tool "${clean(event.toolName, 128)}" could not be verified: pi-context-decisions tool filtering cannot read the tool registry, so calls are blocked until it recovers.`.slice(0, BLOCK_REASON_LIMIT) });
      try {
        const settings = deps.getSettings();
        const error = deps.getSettingsError();
        const ledger0 = readLedger(ctx);
        const state = stateOf(settings, error, ledger0);
        if (state === "off" || !supported()) return undefined;
        let inv: ToolInventory;
        let degraded = false;
        try { inv = classify(); }
        catch {
          if (!snapshot) return unverified();
          inv = snapshot; degraded = true;
        }
        const tool = inv.byName.get(event.toolName);
        if (!tool) return degraded ? unverified() : undefined; // a live registry that does not know it: Pi cannot run it
        const allow = await allowlists(ctx, settings, false);
        if (generation !== deps.generation()) return STALE; // the settings/branch/allowlists changed while the read was pending
        const mode = settings.tools.mode;
        let c = view(inv, settings, merged(ctx), allow);
        if (tool.resource) {
          // Explicit routing policy, NOT an exception to "internal tools are always allowed": the resource tools stay declared and
          // callable, but a call is routed by its local `server` argument, so a whole-server decision cannot be bypassed through them.
          const server = typeof (event.input as { server?: unknown } | undefined)?.server === "string" ? (event.input as { server: string }).server : undefined;
          const usable = (key: string): boolean => {
            // Durable and additive: a canonical key recorded on this branch (allowlisted resource-only servers included) stays usable.
            if (c.ledger.groups.has(key)) return true;
            if (serverAllowlisted(allow, key)) { if (state === "on") pend.groups.add(key); return true; }
            const group = inv.groups.get(key);
            if (!group) return false; // unknown or resource-only server: fail closed unless allowlisted or previously recorded
            return c.avail.isGroupAvailable(key) || (mode === "tools" && group.tools.some((name) => c.avail.isAvailable(inv.byName.get(name)!)));
          };
          if (server !== undefined) {
            if (usable(serverKey(server))) return undefined;
            return { block: true, reason: `MCP resource access to server "${clean(server, 64)}" is unavailable: filtering has not enabled it. Ask the user to add it to tools.alwaysAllowedMcpServers (settings.json) or alwaysAllowedMcpServers (project .pi/pi-context-decisions.json), then /reload.`.slice(0, BLOCK_REASON_LIMIT) };
          }
          if (tool.name === "read_mcp_resource") return undefined; // Pi rejects a read without a server; nothing to route
          // Unscoped listing: the complete server inventory (resource-only and disconnected servers included) is not observable, so it can never be
          // verified as fully allowed. Fail closed while filtering is on; the model must name a server.
          return { block: true, reason: "Listing MCP resources across all servers is unavailable while filtering is on (servers cannot be fully verified): pass an available server, or ask the user to add one to tools.alwaysAllowedMcpServers (settings.json) or alwaysAllowedMcpServers (project .pi/pi-context-decisions.json), then /reload.".slice(0, BLOCK_REASON_LIMIT) };
        }
        if (tool.kind === "internal" || c.avail.isAvailable(tool)) return undefined;
        if (state === "on" && (!settings.backend || externalCount(inv, mode) < settings.tools.minCandidates)) {
          // Unconfigured or below the minimum: filtering decides nothing, so a late arrival stays available (and is recorded at the next flush).
          addAvailable(mode, remaining(inv, mode, c.avail));
          return undefined;
        }
        blockable = tool;
        // Late arrival: score it (one shared round) before deciding. Never when the registry is degraded, the task is unknown, the backend unusable or the key already failed.
        const key = tool.kind === "mcp" && mode === "mcp" ? tool.group! : tool.name;
        const task = cadenceTask(settings, c.ledger);
        if (state === "on" && !degraded && settings.backend && task) {
          const taskKey = cacheKey(task, settings);
          const candidate = candidatesFor(inv, mode, new Set([key]), settings.tools.maxDescriptionChars)[0];
          const eligible = !!candidate && cache.needsScoring(taskKey, candidate) && taskKey !== failedKey && !(settings.tools.cadence === "initial" && c.ledger.considered.has(key));
          if (eligible) {
            if (inflight?.key !== taskKey) {
              const operation = deps.beginOperation();
              const generation = deps.generation();
              const run = (async () => {
                try {
                  const signal = joinSignal(ctx, operation);
                  const latest = view(inv, settings, merged(ctx), allow);
                  await decide(ctx, latest, task, "gate", { signal, generation, needScoreOnly: true, excludeConsidered: settings.tools.cadence === "initial", recordConsidered: settings.tools.cadence === "initial" });
                } finally { operation.close(); }
              })();
              const promise = run.catch(() => {}).finally(() => { if (inflight?.promise === promise) inflight = undefined; });
              inflight = { key: taskKey, promise };
            }
            await inflight.promise;
            if (generation !== deps.generation()) return STALE;
            c = view(classify(), settings, merged(ctx), allow);
            if (c.avail.isAvailable(c.inv.byName.get(tool.name) ?? tool)) { deps.changed(ctx); return undefined; }
          }
        }
        const server = tool.kind === "mcp" && mode === "mcp" ? inv.groups.get(tool.group!)?.label : undefined;
        const reason = server
          ? `MCP server "${clean(server)}" is unavailable: pi-context-decisions tool filtering has not enabled it for this task. Continue without it, or ask the user to allow it in the /decisions Tool picker tab (Always allowed MCP servers).`
          : `Tool "${clean(tool.name, 128)}" is unavailable: pi-context-decisions tool filtering has not enabled it for this task. Continue without it, or ask the user to allow it in the /decisions Tool picker tab (Always allowed tools).`;
        return { block: true, reason: reason.slice(0, BLOCK_REASON_LIMIT) };
      } catch {
        // Unexpected error. A known unavailable external candidate is blocked; a tool the last snapshot verified as internal passes;
        // anything else cannot be verified and is blocked (fail closed).
        if (blockable) return { block: true, reason: `Tool "${clean(blockable.name, 128)}" is unavailable: tool filtering could not verify it.`.slice(0, BLOCK_REASON_LIMIT) };
        const known = snapshot?.byName.get(event.toolName);
        return known && known.kind === "internal" && !known.resource ? undefined : unverified();
      }
  };

  const filter: ToolFilter = {
    async beforeAgentStart(event, ctx) {
      await deps.ensureLoaded();
      const settings = deps.getSettings();
      const error = deps.getSettingsError();
      const task = event.messageType === "custom" || typeof event.prompt !== "string" ? "" : taskWithoutExpandedSkill(event.prompt).trim();
      runTask = task || undefined;
      failedKey = undefined;
      const ledger0 = readLedger(ctx);
      const state = stateOf(settings, error, ledger0);
      activeState = state;
      if (state === "off" && !ledger0.present) { counts = undefined; last = undefined; deps.changed(ctx); return undefined; }
      // An unreadable branch cannot be reconciled or written: only the call gate (which fails closed) acts.
      if (!supported() || ledger0.unreadable) { deps.changed(ctx); return undefined; }
      const operation = deps.beginOperation();
      const generation = deps.generation();
      const j = journal();
      const freshBranch = !ledger0.present && !ledger0.hasMessages;
      /** Superseded (settings/allowlist save, branch change, session replacement): NO mutation of any kind, no matter what this pass prepared. */
      const stale = () => generation !== deps.generation();
      try {
        const signal = joinSignal(ctx, operation);
        const inv = classify();
        const allow = await allowlists(ctx, settings, true);
        if (stale()) { j.undo(); return undefined; }
        /**
         * Same generation but the run was cancelled: reconcile the active set from what the branch has COMMITTED plus the current allowlists,
         * with no base growth, additions, notice or initial task from this pass. The fresh-branch marker is kept so a late tool is still scored.
         */
        const reconcileOnly = (candidates: number): undefined => {
          j.undo();
          if (freshBranch && state === "on") pend.marker = true;
          const before = readLedger(ctx);
          const result = finish(ctx, inv, settings, allow, "reconcile");
          for (const draft of commit(ctx, result, before)) if (draft.type === "custom") pi.appendEntry(draft.customType, draft.data);
          last = { reason: "fail-closed", mode: settings.tools.mode, trigger: "prompt", candidates, kept: 0, available: counts?.available ?? 0, external: counts?.external ?? 0, withheld: counts?.withheld ?? 0, latencyMs: 0, errorCode: "aborted" };
          deps.changed(ctx);
          return undefined;
        };
        if (signal.aborted) return reconcileOnly(0);
        if (state === "off") {
          // Filtering was turned off on a branch that has a ledger: give back what we withheld and remember everything as available.
          for (const tool of inv.tools) if (tool.kind !== "internal") pend.tools.add(tool.name);
          for (const key of inv.groups.keys()) pend.groups.add(key);
          const before = readLedger(ctx);
          const result = finish(ctx, inv, settings, allow, "restore");
          const entries = commit(ctx, result, before);
          for (const draft of entries) if (draft.type === "custom") pi.appendEntry(draft.customType, draft.data);
          if (entries.length) last = { reason: "restored", mode: settings.tools.mode, trigger: "prompt", candidates: 0, kept: 0, available: 0, external: 0, withheld: 0, latencyMs: 0 };
          deps.changed(ctx);
          return undefined;
        }
        const mode = settings.tools.mode;
        const tools = settings.tools;
        let ledger = merged(ctx);
        if (state === "on") {
          ledger = ensureBase(ctx, inv, ledger, j);
          if (!ledger.present) j.marker();
        }
        const c = view(inv, settings, ledger, allow);
        const candidateCount = remaining(inv, mode, c.avail).size;
        let outcome: Outcome = "ok";
        const total = externalCount(inv, mode);
        const initial = tools.cadence === "initial";
        if (state === "enforce") { /* settings unreadable: add nothing */ }
        else if (!settings.backend || total < tools.minCandidates) {
          // Unconfigured or below the minimum: nothing is scored and everything stays available (recorded on the branch), like skills.
          addAvailable(mode, remaining(inv, mode, c.avail), j);
          last = { reason: "skipped", mode, trigger: "prompt", candidates: 0, kept: 0, available: 0, external: total, withheld: ledger.withheld.size, latencyMs: 0 };
        } else if (initial) {
          if (task && !ledger.initialTask) {
            // The initial pick follows the user's first prompt after filtering became active; a custom-message run never supplies it.
            // A failed pick records nothing, so the next user prompt retries it.
            outcome = await decide(ctx, c, task, "initial", { signal, generation, needScoreOnly: false, excludeConsidered: false, recordConsidered: true, journal: j });
            if (outcome === "ok") j.initialTask(task);
          } else if (ledger.initialTask && candidateCount) {
            // Catch-up only: candidates that did not exist at the initial pick, scored against the FIRST task. No new-task round.
            outcome = await decide(ctx, c, ledger.initialTask, "catch-up", { signal, generation, needScoreOnly: true, excludeConsidered: true, recordConsidered: true, journal: j });
          }
        } else if (task && candidateCount) outcome = await decide(ctx, c, task, "prompt", { signal, generation, needScoreOnly: false, excludeConsidered: false, recordConsidered: false, journal: j });
        if (stale()) { j.undo(); return undefined; }
        if (outcome === "superseded" || signal.aborted) return reconcileOnly(candidateCount);
        const before = readLedger(ctx);
        const result = finish(ctx, inv, settings, allow, state === "on" ? "on" : "enforce");
        for (const draft of commit(ctx, result, before)) if (draft.type === "custom") pi.appendEntry(draft.customType, draft.data);
        deps.changed(ctx);
        return result.message ? { message: result.message } : undefined;
      } finally { operation.close(); }
    },

    async turnEnd(event, ctx) {
      if (event.outcome !== "completed" || event.context?.canContinue !== true || !supported()) return undefined;
      await deps.ensureLoaded();
      const settings = deps.getSettings();
      const ledger0 = readLedger(ctx);
      const state = stateOf(settings, deps.getSettingsError(), ledger0);
      activeState = state;
      if (ledger0.unreadable) return undefined;
      if (state === "off") {
        // Filtering was turned off mid-run on a branch that has a ledger: restore what we withheld at this continuing boundary, not only at
        // the next prompt. A branch that never had filtering is left completely untouched (zero footprint).
        if (!ledger0.present) return undefined;
        const generation = deps.generation();
        const inv = classify();
        if (generation !== deps.generation()) return undefined;
        for (const tool of inv.tools) if (tool.kind !== "internal") pend.tools.add(tool.name);
        for (const key of inv.groups.keys()) pend.groups.add(key);
        const drafts = commit(ctx, finish(ctx, inv, settings, NO_ALLOWLISTS, "restore"), ledger0);
        deps.changed(ctx);
        return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
      }
      const queued = queuedUserTask(event.context?.pendingMessages);
      const newText = queued && !seenQueued.has(queued.id) ? queued : undefined;
      if (newText) seenQueued.add(newText.id);
      const tools = settings.tools;
      if (newText && tools.cadence !== "initial") { runTask = newText.text; failedKey = undefined; }
      const operation = deps.beginOperation();
      const generation = deps.generation();
      const j = journal();
      const stale = () => generation !== deps.generation();
      try {
        const signal = joinSignal(ctx, operation);
        const inv = classify();
        const allow = await allowlists(ctx, settings, false);
        if (stale()) { j.undo(); return undefined; }
        const reconcileOnly = () => {
          j.undo();
          const before = readLedger(ctx);
          const drafts = commit(ctx, finish(ctx, inv, settings, allow, "reconcile"), before);
          deps.changed(ctx);
          return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
        };
        if (signal.aborted) return reconcileOnly();
        let ledger = state === "on" ? ensureBase(ctx, inv, merged(ctx), j) : merged(ctx);
        const c = view(inv, settings, ledger, allow);
        let outcome: Outcome = "ok";
        const initial = tools.cadence === "initial";
        if (state === "on" && (!settings.backend || externalCount(inv, settings.tools.mode) < tools.minCandidates)) {
          // The same policy as the first boundary: unconfigured or below the minimum makes no calls and keeps late arrivals available (recorded).
          addAvailable(settings.tools.mode, remaining(inv, settings.tools.mode, c.avail), j);
        } else if (state === "on" && remaining(inv, settings.tools.mode, c.avail).size) {
          const toolRound = tools.cadence === "tool-round" && !newText && (event.toolResults?.length ?? 0) > 0 && runTask !== undefined;
          if (newText && !initial) outcome = await decide(ctx, c, newText.text, "queued", { signal, generation, needScoreOnly: false, excludeConsidered: false, recordConsidered: false, journal: j });
          else if (toolRound) outcome = await decide(ctx, c, runTask!, "tool-round", { signal, generation, needScoreOnly: false, excludeConsidered: false, recordConsidered: false, journal: j });
          else {
            const task = cadenceTask(settings, ledger);
            if (task) outcome = await decide(ctx, c, task, "catch-up", { signal, generation, needScoreOnly: true, excludeConsidered: initial, recordConsidered: initial, journal: j });
          }
        }
        if (stale()) { j.undo(); return undefined; }
        if (outcome === "superseded" || signal.aborted) return reconcileOnly();
        ledger = readLedger(ctx);
        const result = finish(ctx, inv, settings, allow, state === "on" ? "on" : "enforce");
        const drafts = commit(ctx, result, ledger);
        deps.changed(ctx);
        // Pi's boundary dispatch REPLACES accumulated drafts with what a handler returns: keep every earlier draft.
        return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
      } finally { operation.close(); }
    },

    async toolCall(event, ctx) {
      // The verdict is only valid for the settings, branch and allowlists it was computed from. If any of them changes while it awaits (a
      // project read, a lazy score), it is discarded and re-evaluated from the CURRENT state before any grant or pending mutation.
      for (let attempt = 0; attempt < 3; attempt++) {
        const verdict = await evaluateCall(event, ctx, deps.generation());
        if (verdict !== STALE) return verdict;
      }
      return { block: true, reason: `Tool "${clean(event.toolName, 128)}" could not be verified: tool filtering settings kept changing while the call was checked.`.slice(0, BLOCK_REASON_LIMIT) };
    },
    agentEnd(ctx) {
      // A lazy gate addition (or a round whose turn was cut short) that no turn_end flushed.
      if (activeState === "off" || !supported()) return;
      for (const data of toRecords(flushRecord(), readLedger(ctx))) pi.appendEntry(TOOLS_LEDGER_ENTRY, data);
    },
    reset() { cacheEpoch++; pend = fresh(); runTask = undefined; failedKey = undefined; last = undefined; counts = undefined; projectCache = undefined; inflight = undefined; cache.clear(); seenQueued.clear(); },
    invalidate() { cacheEpoch++; projectCache = undefined; failedKey = undefined; last = undefined; inflight = undefined; cache.clear(); },
    last: () => last ? structuredClone(last) : undefined,
    status() {
      const settings = deps.getSettings();
      if (!settings.enabled || !settings.tools.enabled) return undefined;
      if (!supported()) return "tools: host lacks tool APIs";
      if (deps.getSettingsError()) return "tools: settings error";
      if (!settings.backend) return "tools: select model · /decisions";
      if (!counts) return `tools: ${settings.tools.mode} · ${settings.tools.cadence}`;
      return `tools: ${counts.available}/${counts.external} ${counts.mode === "mcp" ? "servers" : "tools"} available${last ? (last.cached ? " · cached" : last.errorCode ? ` · ${last.errorCode}` : ` · ${last.latencyMs}ms`) : ""}`;
    },
    async describe(ctx) {
      const settings = deps.getSettings();
      const mode = settings.tools.mode;
      const empty: ToolReport = { supported: supported(), state: "off", mode, rows: [], groups: [], hidden: 0, ungrouped: 0, withheld: 0 };
      if (!supported()) return empty;
      const session = (ctx as { sessionManager?: ExtensionContext["sessionManager"] }).sessionManager;
      let ledger: ToolLedgerState;
      try { ledger = session ? readToolLedger(session) : readToolLedger({ getBranch: () => [] }); } catch { ledger = readToolLedger({ getBranch: () => [] }); }
      for (const name of pend.tools) ledger.tools.add(name);
      for (const key of pend.groups) ledger.groups.add(key);
      const state = stateOf(settings, deps.getSettingsError(), ledger);
      const inv = classify();
      let project = { tools: [] as string[], servers: [] as string[] };
      if (ctx.cwd) { const loaded = await deps.loadProjectAllowlist(ctx.cwd); project = { tools: loaded.tools, servers: loaded.mcpServers }; }
      const allow: EffectiveAllowlists = state === "off" ? NO_ALLOWLISTS : { tools: new Set([...settings.tools.alwaysAllowedTools, ...project.tools]), servers: new Set([...settings.tools.alwaysAllowedMcpServers, ...project.servers]) };
      const avail = availability(inv, mode, ledger, allow);
      const rows = inv.tools.map((tool): ToolReport["rows"][number] => ({
        name: tool.name, kind: tool.kind, exposure: tool.exposure, description: tool.description,
        ...(tool.group ? { server: inv.groups.get(tool.group)?.label } : {}),
        state: tool.kind === "internal" ? "always" : state === "off" ? "available"
          : allow.tools.has(tool.name) || (tool.group && [...allow.servers].some((entry) => canonicalServerKey(entry) === tool.group)) ? "allowlisted"
          : avail.isAvailable(tool) ? "available" : "unavailable",
      }));
      const groups = [...inv.groups.values()].map((group) => ({
        key: group.key, label: group.label, tools: group.tools.length, toolNames: [...group.tools].sort().slice(0, 50), verified: group.verified,
        available: state === "off" || avail.isGroupAvailable(group.key), allowlisted: [...allow.servers].some((entry) => canonicalServerKey(entry) === group.key),
      }));
      return { supported: true, state, mode, rows, groups, hidden: inv.hidden, ungrouped: inv.tools.filter((tool) => tool.kind === "extension").length, withheld: ledger.withheld.size };
    },
  };
  return filter;
}
