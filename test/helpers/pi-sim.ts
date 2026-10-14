// Offline stand-in for the slice of Pi the additive picker relies on: a branch-aware session with
// compaction/context-edit projection (mirroring session-manager.js buildContextEntries and
// buildSessionProjection), appendEntry, active tools, and Pi's before_agent_start / turn_end
// commit order. Not a Pi test: it only enforces the contracts documented in Pi 1.1.0.
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { CommandContext, ExtensionHost } from "../../src/extension/contracts.ts";
import { SKILLS_MESSAGE_TYPE, readLedger, type BranchEntryLike } from "../../src/extension/skill-ledger.ts";

export interface SimEntry extends BranchEntryLike {
  id: string; parentId: string | null; timestamp: string;
  message?: { role: string; content?: unknown; timestamp?: number };
  display?: boolean;
  firstKeptEntryId?: string; summary?: string;
  targetId?: string; replacement?: { content: unknown } | null;
}
export class SimSession {
  all: SimEntry[] = [];
  leaf: string | null = null;
  private counter = 0;
  private push(entry: Omit<SimEntry, "id" | "parentId" | "timestamp">): SimEntry {
    const created = { ...entry, id: `e${++this.counter}`, parentId: this.leaf, timestamp: new Date(1_700_000_000_000 + this.counter * 1000).toISOString() } as SimEntry;
    this.all.push(created); this.leaf = created.id;
    return created;
  }
  appendCustom(customType: string, data: unknown) { return this.push({ type: "custom", customType, data }); }
  appendCustomMessage(message: { customType: string; content: unknown; display: boolean; details?: unknown }) {
    return this.push({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
  }
  appendMessage(role: "user" | "assistant" | "toolResult" | "system", content: unknown = "") {
    return this.push({ type: "message", message: { role, content, timestamp: 1_700_000_000_000 + this.counter } });
  }
  /** Retained-from entry: everything before `firstKeptEntryId` is summarized away, as Pi's compaction does. */
  compact(firstKeptEntryId: string) { return this.push({ type: "compaction", firstKeptEntryId, summary: "SUMMARY" }); }
  edit(targetId: string, replacement: { content: unknown } | null) { return this.push({ type: "context_edit", targetId, replacement }); }
  navigate(entryId: string | null) { this.leaf = entryId; }
  fork(): SimSession {
    const copy = new SimSession();
    copy.all = this.getBranch().map((entry) => structuredClone(entry));
    copy.counter = this.counter; copy.leaf = copy.all.at(-1)?.id ?? null;
    return copy;
  }
  getBranch(): SimEntry[] {
    const byId = new Map(this.all.map((entry) => [entry.id, entry]));
    const path: SimEntry[] = [];
    for (let id = this.leaf; id; id = byId.get(id)?.parentId ?? null) { const entry = byId.get(id); if (!entry) break; path.unshift(entry); }
    return path;
  }
  private contextEntries(): SimEntry[] {
    const path = this.getBranch();
    const compaction = [...path].reverse().find((entry) => entry.type === "compaction");
    if (!compaction) return path;
    const index = path.findIndex((entry) => entry.id === compaction.id);
    const kept: SimEntry[] = [compaction];
    let found = false;
    for (const entry of path.slice(0, index)) {
      if (entry.id === compaction.firstKeptEntryId) found = true;
      if (found && !(entry.type === "message" && entry.message?.role === "system")) kept.push(entry);
    }
    return [...kept, ...path.slice(index + 1)];
  }
  buildSessionProjection() {
    const entries = this.contextEntries();
    const edits = new Map<string, SimEntry>();
    for (const entry of entries) if (entry.type === "context_edit" && entry.targetId) edits.set(entry.targetId, entry);
    const projected = entries.map((sourceEntry, index) => {
      let messages: unknown[] = [];
      if (sourceEntry.type === "message") messages = [sourceEntry.message];
      else if (sourceEntry.type === "custom_message") messages = [{ role: "custom", customType: sourceEntry.customType, content: sourceEntry.content ?? [], display: sourceEntry.display }];
      else if (sourceEntry.type === "compaction" && index === 0) messages = [{ role: "compactionSummary", summary: sourceEntry.summary }];
      const edit = edits.get(sourceEntry.id);
      if (edit && messages.length) messages = edit.replacement === null ? [] : messages.map((message) => ({ ...(message as object), content: edit.replacement!.content }));
      return { sourceEntry, messages };
    });
    return { entries: projected, messages: projected.flatMap((entry) => entry.messages) };
  }
}
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
export interface SimHost {
  pi: ExtensionHost;
  handlers: Map<string, Handler[]>;
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  /** Replace to simulate a new session/branch; the next emit hands it to the extension. */
  session: SimSession;
  tools: { active: string[] };
  /** Registered tool inventory returned by `getAllTools`, and call counters for the "off means untouched" checks. */
  registry: SimToolInfo[];
  registerTool(info: SimToolInfo, options?: { activate?: boolean }): void;
  calls: { getAllTools: number; setActiveTools: number };
  /** Dispatches `tool_call` like Pi: handlers run in order and the first `{ block: true }` wins. */
  toolCall(toolName: string, input: unknown, ctx: CommandContext, eventExtra?: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined>;
  appended: { customType: string; data: unknown }[];
  emit(event: string, value: unknown, ctx: CommandContext): Promise<unknown[]>;
  command(args: string, ctx: CommandContext): Promise<void>;
}
export interface SimToolInfo {
  name: string; description?: string; exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
  namespace?: { name: string; description?: string; instructions?: string; aliases?: string[] };
  sourceInfo?: { path: string; source: string; scope?: string; origin?: string; baseDir?: string };
  parameters?: unknown; promptGuidelines?: string[]; annotations?: unknown; reachesTools?: boolean;
}
/** Pi core/builtin provenance, as Pi's loader assigns it. */
export const builtinSource = (name: string) => ({ path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" });
export const extensionSource = (name: string) => ({ path: `/ext/${name}.ts`, source: "extension", scope: "user", origin: "top-level" });
export function simHost(session = new SimSession(), tools: string[] = ["read", "bash"]): SimHost {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const appended: { customType: string; data: unknown }[] = [];
  const state = { active: tools };
  const registry: SimToolInfo[] = tools.map((name) => ({ name, description: `core ${name}`, sourceInfo: builtinSource(name) }));
  const calls = { getAllTools: 0, setActiveTools: 0 };
  const pi: ExtensionHost = {
    getAllTools: (() => { calls.getAllTools++; return registry.map((info) => structuredClone(info)); }) as ExtensionAPI["getAllTools"],
    setActiveTools: ((names: string[]) => {
      calls.setActiveTools++;
      // Pi ignores unknown and hidden names.
      state.active = names.filter((name, index) => names.indexOf(name) === index && registry.some((info) => info.name === name && info.exposure !== "hidden"));
    }) as ExtensionAPI["setActiveTools"],
    on: ((event: string, handler: Handler) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => {}; }) as ExtensionAPI["on"],
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType: string, data?: unknown) { appended.push({ customType, data }); session.appendCustom(customType, data); },
    getActiveTools: () => [...state.active],
  };
  const host: SimHost = {
    pi, handlers, commands, session, tools: state, appended, registry, calls,
    registerTool(info, options) {
      registry.push(info);
      // Pi activates late direct/model-only registrations; other exposures are never activated.
      const exposure = info.exposure ?? "direct";
      if (options?.activate !== false && (exposure === "direct" || exposure === "model-only")) state.active = [...state.active, info.name];
    },
    async toolCall(toolName, input, ctx, eventExtra = {}) {
      (ctx as unknown as { sessionManager?: unknown }).sessionManager = host.session;
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ type: "tool_call", toolName, toolCallId: "t1", input, ...eventExtra }, ctx as ExtensionContext) as { block?: boolean; reason?: string } | undefined;
        if (result?.block) return result as { block: true; reason: string };
      }
      return undefined;
    },
    async emit(event, value, ctx) {
      (ctx as unknown as { sessionManager?: unknown }).sessionManager = host.session;
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(value, ctx as ExtensionContext));
      if (event === "before_agent_start") {
        // Pi persists the user message, then each handler message, in that order.
        const prompt = (value as { prompt?: string }).prompt;
        if (typeof prompt === "string") host.session.appendMessage("user", prompt);
        for (const result of results) {
          const message = (result as { message?: { customType: string; content: unknown; display: boolean; details?: unknown } } | undefined)?.message;
          if (message) host.session.appendCustomMessage(message);
        }
      }
      return results;
    },
    async command(args, ctx) { await commands.get("decisions")!.handler(args, ctx as never); },
  };
  return host;
}
export interface TurnEndOptions {
  toolResults?: unknown[];
  pendingMessages?: unknown[];
  canContinue?: boolean;
  outcome?: "completed" | "aborted" | "error";
  /** Drafts from earlier extensions, passed as `event.entries` exactly like Pi's emitBoundary does. */
  priorEntries?: { type: string; customType?: string; data?: unknown; content?: unknown; display?: boolean; details?: unknown }[];
}
/** Emit turn_end like Pi: assistant (+ tool results) are already persisted; returned drafts are committed. */
export async function turnEnd(host: SimHost, ctx: CommandContext, options: TurnEndOptions = {}) {
  (ctx as unknown as { sessionManager?: unknown }).sessionManager = host.session;
  const toolResults = options.toolResults ?? [];
  host.session.appendMessage("assistant", [{ type: "text", text: "assistant" }]);
  for (const result of toolResults) host.session.appendMessage("toolResult", result);
  const base = { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults, messageEntryId: "x", toolResultEntryIds: [], outcome: options.outcome ?? "completed",
    context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: options.pendingMessages ?? [], canContinue: options.canContinue ?? true } };
  type Draft = NonNullable<TurnEndOptions["priorEntries"]>[number] & { type: string; customType: string; content: unknown; display: boolean };
  // Pi's emitBoundary: each handler sees the accumulated entries, and a returned `entries` REPLACES them.
  let entries = (options.priorEntries ?? []) as Draft[];
  let continued = false;
  for (const handler of host.handlers.get("turn_end") ?? []) {
    const result = await handler({ ...base, entries, continue: continued }, ctx as ExtensionContext) as { entries?: Draft[]; continue?: boolean } | undefined;
    if (result?.entries !== undefined) entries = result.entries;
    if (result?.continue) continued = true;
  }
  for (const draft of entries) {
    if (draft.type === "custom_message") host.session.appendCustomMessage(draft);
    else if (draft.type === "custom" && draft.customType) host.session.appendCustom(draft.customType, draft.data);
  }
  const drafts = entries.filter((draft) => draft.type === "custom_message" && draft.customType === SKILLS_MESSAGE_TYPE);
  const all = entries;
  return { drafts, continued, all };
}
export const deltaMessages = (session: SimSession) =>
  session.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === SKILLS_MESSAGE_TYPE);
/** Skills the model sees on this branch: system-prompt skills of the run plus every visible delta. */
export function advertised<T extends { name: string; disableModelInvocation?: boolean }>(host: SimHost, inventory: readonly T[], runSkills: readonly T[]): string[] {
  const names = new Set([...runSkills.map((skill) => skill.name), ...readLedger(host.session).visible]);
  return inventory.filter((skill) => !skill.disableModelInvocation && names.has(skill.name)).map((skill) => skill.name);
}
