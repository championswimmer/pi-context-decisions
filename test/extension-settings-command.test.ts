import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { simHost } from "./helpers/pi-sim.ts";
import type { Component } from "@earendil-works/pi-tui";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionHost, ExtensionRegistry } from "../src/extension/contracts.ts";
import { SETTINGS_OVERLAY_OPTIONS } from "../src/extension/settings-dialog.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";

const KEY = { down: "\x1b[B", enter: "\r", esc: "\x1b", rank: "\x12", space: " " };
const theme = { fg: (_token: unknown, value: string) => value, bg: (_token: unknown, value: string) => value };
const waitFor = async <T,>(read: () => T | undefined | false, label: string): Promise<T> => {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

async function harness(t: { after(fn: () => Promise<void>): void }, options: {
  mode?: "tui" | "rpc" | "print"; custom?: boolean; configured?: boolean; env?: Record<string, string | undefined>; pendingDecision?: boolean;
  openaiOAuth?: boolean; rejectCustom?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "settings-command-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  if (options.configured) await saveSettings({ ...defaultSettings(), backend: { backend: "typesafe", model: "jev-latest" } }, path);
  const sim = simHost();
  const commands = sim.commands;
  const pi: ExtensionHost = {
    ...sim.pi,
    getCommands() { return [
      { name: "skill:alpha", description: "Browser testing", source: "skill", sourceInfo: { path: "/private/alpha", source: "fixture", scope: "user", origin: "top-level" } },
      { name: "skill:beta", description: "Database querying", source: "skill", sourceInfo: { path: "/private/beta", source: "fixture", scope: "user", origin: "top-level" } },
    ]; },
  };
  const messages: string[] = [];
  const requests: DecisionRequest[] = [];
  const decisionSignals: AbortSignal[] = [];
  const state = { valid: true };
  const reads = { signal: 0, afterInvalid: 0 };
  const calls = { select: 0, input: 0, custom: 0, focus: 0 };
  const customOptions: unknown[] = [];
  const components: (Component & { dispose?(): void; close?(result: string): void })[] = [];
  let finish: ((value: unknown) => void) | undefined;
  const registry: ExtensionRegistry = {
    getModelsOfType() { return []; }, findOfType() { return undefined; },
    async getApiKeyForProvider() { return undefined; },
    async getProviderAuth(provider) {
      if (provider === "openai" && options.openaiOAuth) return { auth: { apiKey: "FIXTURE-OAUTH" }, source: "OAuth" };
      return undefined;
    },
    async classify() { throw new Error("no native classifier"); },
  };
  const live = <T,>(value: T): T => { if (!state.valid) { reads.afterInvalid++; throw new Error("This extension ctx is stale after session replacement or reload"); } return value; };
  const ui = {
    async select() { calls.select++; return undefined; },
    async input() { calls.input++; return undefined; },
    notify(message: string) { messages.push(message); }, setStatus() {},
    async custom(factory: (...args: unknown[]) => unknown, opts: unknown) {
      calls.custom++; customOptions.push(opts);
      if (options.rejectCustom) throw new Error("PRIVATE custom failure");
      return new Promise((resolve) => {
        finish = resolve;
        components.push(factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, resolve) as Component);
        (opts as { onHandle?(handle: unknown): void }).onHandle?.({ focus() { calls.focus++; } });
      });
    },
  };
  const mode = options.mode ?? "tui";
  const ctx = {
    hasUI: mode !== "print", mode, cwd: root,
    get ui() { return live(options.custom === false ? { ...ui, custom: undefined } : ui); },
    get modelRegistry() { return live(registry); },
    get signal() { reads.signal++; return undefined; },
  } as unknown as CommandContext;
  registerContextDecisions(pi, { settingsPath: path, env: options.env ?? {}, report(_ctx, message) { messages.push(message); },
    createClient() { return createDecisionClient({ id: "typesafe", model: "fixture", async decide(request, opts) {
      requests.push(request); if (opts?.signal) decisionSignals.push(opts.signal);
      if (options.pendingDecision) return new Promise<never>(() => {});
      return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "score", score: 1.8 }])) };
    } }); },
  });
  const command = (args: string) => commands.get("decisions")!.handler(args, ctx as ExtensionCommandContext);
  const emit = async (name: string, event: unknown = {}) => { await sim.emit(name, event, ctx); };
  const dialog = async (index = 0) => waitFor(() => components[index], "settings dialog component");
  const text = (component: Component, width = 100) => component.render(width).join("\n");
  const until = async (component: Component, pattern: RegExp) => waitFor(() => pattern.test(text(component)) && text(component), `${pattern}`);
  return { root, path, sim, commands, messages, requests, decisionSignals, state, reads, calls, customOptions, components, ctx, command, emit, dialog, text, until,
    get finish() { return finish!; } };
}

test("terminal /decisions opens ONE floating overlay with the shared options and never uses select/input", async (t) => {
  const h = await harness(t);
  const run = h.command("");
  const dialog = await h.dialog();
  assert.equal(h.calls.custom, 1);
  assert.deepEqual(h.customOptions[0] && { ...(h.customOptions[0] as object), onHandle: undefined }, { overlay: true, overlayOptions: SETTINGS_OVERLAY_OPTIONS, onHandle: undefined });
  assert.match(h.text(dialog), /Context decisions/);
  dialog.handleInput!(KEY.esc); await run;
  assert.equal(h.calls.select + h.calls.input, 0); assert.deepEqual(h.messages, []);
});

test("RPC mode keeps the select menus with Advanced… and never calls custom", async (t) => {
  const h = await harness(t, { mode: "rpc" }); await h.command("");
  assert.equal(h.calls.custom, 0); assert.equal(h.calls.select, 1);
});

test("a second /decisions while the first dialog is open does not open another; it focuses the first", async (t) => {
  const h = await harness(t); const first = h.command(""); const dialog = await h.dialog();
  for (let i = 0; i < 5; i++) dialog.handleInput!(KEY.down);
  dialog.handleInput!(KEY.enter); await h.until(dialog, /Decisions › Advanced/);
  await h.command("");
  assert.equal(h.calls.custom, 1); assert.equal(h.calls.focus, 1); assert.doesNotMatch(h.text(dialog), /Decisions › Advanced/, "re-running /decisions focuses the existing dialog on its main screen");
  dialog.handleInput!(KEY.esc); await first;
});

test("saves inside the dialog persist, do not close it, and later settle without touching a closed ctx", async (t) => {
  const h = await harness(t, { configured: true }); let resolved = false;
  const run = h.command("").then(() => { resolved = true; }); const dialog = await h.dialog();
  dialog.handleInput!(KEY.enter); // toggle enabled
  await h.until(dialog, /Context decisions\s+Off/);
  assert.equal((await loadSettings(h.path)).settings.enabled, false); assert.equal(resolved, false, "saving must not close the dialog");
  dialog.handleInput!(KEY.esc); await run; assert.equal(resolved, true);
});

test("choosing a model through the dialog persists it atomically and never enables filtering", async (t) => {
  const h = await harness(t, { env: { TYPESAFE_API_KEY: "FIXTURE" } });
  await saveSettings({ ...defaultSettings(), enabled: false }, h.path);
  const run = h.command(""); const dialog = await h.dialog();
  dialog.handleInput!(KEY.down); dialog.handleInput!(KEY.enter); // Provider / execution
  await h.until(dialog, /typesafe · direct API\s+configured/);
  dialog.handleInput!(KEY.enter); await h.until(dialog, /Decisions › Model/);
  await h.until(dialog, /jev-latest/); dialog.handleInput!(KEY.enter);
  await h.until(dialog, /Decision model: typesafe direct jev-latest/);
  const saved = (await loadSettings(h.path)).settings;
  assert.deepEqual(saved.backend, { backend: "typesafe", model: "jev-latest" }); assert.equal(saved.enabled, false);
  assert.equal(h.requests.length, 0, "choosing a model makes no inference call");
  dialog.handleInput!(KEY.esc); await run;
});

test("missing keys are labelled, guide to env or /login, and are never persisted; OpenAI OAuth cannot substitute", async (t) => {
  const h = await harness(t, { openaiOAuth: true, env: {} });
  const run = h.command(""); const dialog = await h.dialog();
  dialog.handleInput!(KEY.down); dialog.handleInput!(KEY.enter); // Provider / execution
  await h.until(dialog, /openai · direct API\s+missing key/);
  assert.match(h.text(dialog), /typesafe · direct API\s+missing key/); assert.match(h.text(dialog), /openrouter · direct API\s+missing key/);
  // Move to the openai row and activate it.
  for (let i = 0; i < 6; i++) { dialog.handleInput!(KEY.down); if (/❯ openai · direct API/.test(h.text(dialog))) break; }
  dialog.handleInput!(KEY.enter);
  const text = h.text(dialog, 140);
  assert.match(text, /OPENAI_API_KEY/); assert.match(text, /\/login openai/); assert.match(text, /not openai-codex/i);
  assert.equal((await loadSettings(h.path)).settings.backend, null); assert.equal(h.requests.length, 0);
  assert.deepEqual(h.messages, [], "guidance stays inside the dialog");
  dialog.handleInput!(KEY.esc); dialog.handleInput!(KEY.esc); await run;
});

test("dialog work never reads ctx.signal (the agent-run signal), even through status, models and ranking", async (t) => {
  const h = await harness(t, { configured: true, env: { TYPESAFE_API_KEY: "FIXTURE" } });
  const run = h.command(""); const dialog = await h.dialog();
  for (let i = 0; i < 3; i++) dialog.handleInput!(KEY.down); dialog.handleInput!(KEY.enter); // Always allowed · Global
  await h.until(dialog, /Search:/);
  for (const char of "topic") dialog.handleInput!(char);
  dialog.handleInput!(KEY.rank); await h.until(dialog, /0\.90 relevance/);
  assert.equal(h.requests.length, 1);
  dialog.handleInput!(KEY.esc); await h.until(dialog, /Decisions\s/);
  dialog.handleInput!("\x1b[A"); dialog.handleInput!(KEY.enter); // Model route (the cursor stayed on Global)
  await h.until(dialog, /Decisions › Model/); await h.until(dialog, /jev-latest/); dialog.handleInput!(KEY.esc);
  for (let i = 0; i < 4; i++) dialog.handleInput!(KEY.down); dialog.handleInput!(KEY.enter); // Status…
  await h.until(dialog, /Credentials:/); dialog.handleInput!(KEY.esc); dialog.handleInput!(KEY.esc); await run;
  assert.equal(h.reads.signal, 0, "the dialog must own its signal");
});

test("session_shutdown while open resolves the handler, aborts ranking and never touches a stale ctx", async (t) => {
  const h = await harness(t, { configured: true, pendingDecision: true, env: { TYPESAFE_API_KEY: "FIXTURE" } });
  let resolved = false;
  const run = h.command("").then(() => { resolved = true; });
  const dialog = await h.dialog();
  for (let i = 0; i < 3; i++) dialog.handleInput!(KEY.down); dialog.handleInput!(KEY.enter); // Always allowed · Global
  await h.until(dialog, /Search:/);
  for (const char of "topic") dialog.handleInput!(char);
  dialog.handleInput!(KEY.rank); await waitFor(() => h.decisionSignals[0], "pending ranking request");
  const messagesBefore = h.messages.length;
  await h.emit("session_shutdown"); h.state.valid = false; // Pi invalidates ctx right after shutdown handlers
  await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("handler still pending after session_shutdown")), 1000))]);
  assert.equal(resolved, true); assert.equal(h.decisionSignals[0].aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.reads.afterInvalid, 0, "no ctx property may be read after shutdown");
  assert.equal(h.messages.length, messagesBefore, "no report after shutdown"); assert.equal(h.reads.signal, 0);
});

test("a fresh session_start closes a dialog left over from the previous session", async (t) => {
  const h = await harness(t); let resolved = false;
  const run = h.command("").then(() => { resolved = true; }); await h.dialog();
  await h.emit("session_start", { type: "session_start", reason: "reload" }); await run; assert.equal(resolved, true);
});

test("an open dialog does not block or swallow later hook activity", async (t) => {
  const h = await harness(t, { configured: true }); const run = h.command(""); const dialog = await h.dialog();
  const event = { type: "before_agent_start", prompt: "task", systemPrompt: "s", systemPromptOptions: { cwd: h.root, skills: Array.from({ length: 3 }, (_, n) => ({ name: `s${n}`, description: "d", filePath: "/p", baseDir: "/b", sourceInfo: { path: "/p", source: "x", scope: "user", origin: "top-level" }, disableModelInvocation: false })), selectedTools: [], sections: {}, hiddenTools: [], toolSnippets: {}, toolGuidelines: [], promptGuidelines: [], contextFiles: [] } };
  await h.emit("before_agent_start", event);
  assert.match(h.text(dialog), /Context decisions/); dialog.handleInput!(KEY.esc); await run;
});

test("a custom() failure is reported as a safe error and does not wedge later opens", async (t) => {
  const h = await harness(t, { rejectCustom: true });
  await h.command(""); assert.match(h.messages.at(-1)!, /Context-decisions operation failed/); assert.doesNotMatch(h.messages.join("\n"), /PRIVATE/);
  await h.command(""); assert.equal(h.calls.custom, 2);
});

test("headless commands keep their text output without a dialog", async (t) => {
  const h = await harness(t, { mode: "print", custom: false });
  await h.command("status"); assert.match(h.messages.at(-1)!, /Context decisions: enabled; not configured/);
  await h.command(""); assert.match(h.messages.at(-1)!, /Context decisions: enabled; not configured/, "no arguments: the status, never a dialog");
  await h.command("pin alpha"); assert.match(h.messages.at(-1)!, /Pinned skills updated/);
  await h.command("tools list"); assert.match(h.messages.at(-1)!, /Tools \(/);
  assert.equal(h.calls.custom + h.calls.select + h.calls.input, 0);
});

test("/decisions history reuses the settings overlay, shows committed additions and never scores or reads the agent signal", async (t) => {
  const h = await harness(t, { configured: true });
  const session = SessionManager.inMemory(h.root);
  h.ctx.sessionManager = session;
  session.appendCustomMessageEntry("context-decisions-skills", "PRIVATE description", false, { v: 1, added: ["alpha"], redelivered: [] });
  const first = h.command(""); const dialog = await h.dialog();
  await h.command("history"); await h.until(dialog, /Before turn 1/);
  assert.equal(h.calls.custom, 1); assert.equal(h.calls.focus, 1);
  dialog.handleInput!(KEY.enter); await h.until(dialog, /Skills advertised/);
  assert.match(h.text(dialog), /alpha/); assert.doesNotMatch(h.text(dialog), /PRIVATE/);
  dialog.handleInput!(KEY.esc); await h.until(dialog, /Decisions › History/);
  dialog.handleInput!(KEY.esc); await h.until(dialog, /Context decisions/);
  dialog.handleInput!(KEY.esc); await first;
  assert.equal(h.reads.signal, 0); assert.equal(h.requests.length, 0);
  assert.equal(h.calls.select + h.calls.input, 0);
  assert.deepEqual(h.sim.calls, { getAllTools: 0, setActiveTools: 0 });
});

for (const mode of ["rpc", "print"] as const) test(`/decisions history in ${mode} is a read-only report, never terminal UI`, async (t) => {
  const h = await harness(t, { mode });
  const session = SessionManager.inMemory(h.root); h.ctx.sessionManager = session;
  session.appendCustomEntry("context-decisions-tools", { v: 1, considered: ["not-picked"] });
  const before = session.getBranch().length;
  await h.command("history"); assert.match(h.messages.at(-1)!, /No committed additions/);
  session.appendCustomMessageEntry("context-decisions-skills", "PRIVATE", false, { v: 1, added: ["alpha\x1b\r\n\u202e"], redelivered: [] });
  await h.command("history");
  assert.match(h.messages.at(-1)!, /alpha/); assert.doesNotMatch(h.messages.at(-1)!, /PRIVATE|not-picked|\x1b|\r|\u202e/);
  assert.equal(session.getBranch().length, before + 1, "reading never appends history records");
  assert.equal(h.requests.length, 0); assert.equal(h.calls.custom + h.calls.select + h.calls.input, 0);
  assert.deepEqual(h.commands.get("decisions")!.getArgumentCompletions!("hist"), [{ value: "history", label: "history" }]);
  await h.command("history clear"); assert.match(h.messages.at(-1)!, /Use \/decisions/);
  assert.equal((await loadSettings(h.path)).settings.backend, null);
});

test("history's session access is guarded after shutdown, and an unreadable branch stays an inline safe error", async (t) => {
  const h = await harness(t);
  Object.defineProperty(h.ctx, "sessionManager", { configurable: true, get() { if (!h.state.valid) h.reads.afterInvalid++; throw new Error("PRIVATE branch read"); }, set() {} });
  const run = h.command("history"); const dialog = await h.dialog();
  await h.until(dialog, /Context-decisions operation failed/);
  assert.deepEqual(h.messages, []); assert.doesNotMatch(h.text(dialog), /PRIVATE/);
  await h.emit("session_shutdown"); h.state.valid = false;
  await run;
  dialog.handleInput!("\x12"); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.afterInvalid, 0); assert.equal(h.reads.signal, 0);
});
