import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { buildToolNotice, toolRecords } from "../src/extension/tool-ledger.ts";
import { simHost } from "./helpers/pi-sim.ts";
import { rpcContext } from "./helpers/settings-ui.ts";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import type { CommandContext, ExtensionHost, ExtensionRegistry } from "../src/extension/contracts.ts";
import { HISTORY_OVERLAY_OPTIONS } from "../src/extension/history-dialog.ts";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest } from "../src/decision/types.ts";

const KEY = { down: "\x1b[B", up: "\x1b[A", tab: "\t", shiftTab: "\x1b[Z", enter: "\r", esc: "\x1b", rank: "\x12", space: " " };
const theme = {
  fg: (_token: unknown, value: string) => value,
  bg: (_token: unknown, value: string) => value,
  bold: (value: string) => value,
};
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
        components.push(factory({ requestRender() {}, terminal: { rows: 30 } }, theme, getKeybindings(), resolve) as Component);
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
  t.after(async () => {
    try { await emit("session_shutdown"); } catch { /* best-effort cleanup */ }
  });
  const dialog = async (index = 0) => waitFor(() => components[index], "settings dialog component");
  const text = (component: Component, width = 100) => component.render(width).join("\n");
  const until = async (component: Component, pattern: RegExp, width = 100) => waitFor(() => pattern.test(text(component, width)) && text(component, width), `${pattern}`);
  const selectRow = (component: Component, label: RegExp, width = 120) => {
    for (let i = 0; i < 30; i++) {
      if (text(component, width).split("\n").some((line) => line.includes("❯") && label.test(line))) return;
      component.handleInput!(KEY.down);
    }
    assert.fail(`Could not select row ${label}\n${text(component, width)}`);
  };
  return { root, path, sim, commands, messages, requests, decisionSignals, state, reads, calls, customOptions, components, ctx, command, emit, dialog, text, until, selectRow,
    get finish() { return finish!; } };
}

test("terminal /decisions opens ONE floating overlay via pi-extension-settings-tui and never uses select/input", async (t) => {
  const h = await harness(t);
  const run = h.command("");
  const dialog = await h.dialog();
  assert.equal(h.calls.custom, 1);
  const opts = h.customOptions[0] as { overlay?: boolean; overlayOptions?: Record<string, unknown> };
  assert.equal(opts.overlay, true);
  assert.equal(opts.overlayOptions?.anchor, "center");
  assert.match(h.text(dialog), /Context Decisions Settings/);
  assert.match(h.text(dialog), /Skill filtering/);
  dialog.handleInput!(KEY.esc); await run;
  assert.equal(h.calls.select + h.calls.input, 0); assert.deepEqual(h.messages, []);
});

test("RPC mode uses select menus and never calls custom", async (t) => {
  const h = await harness(t, { mode: "rpc" }); await h.command("");
  assert.equal(h.calls.custom, 0); assert.equal(h.calls.select, 1);
});

test("RPC menu exposes Footer icons on the Decision tab: persists iconStyle and refreshes footer status; cancelling changes nothing", async (t) => {
  const h = await harness(t, { mode: "rpc" });
  const status: [string, unknown][] = []; const titles: string[] = []; let mainMenu: string[] = [];
  let picked = false; let choice: (options: string[]) => string | undefined = () => undefined;
  const ctx = rpcContext(h.ctx, {
    setStatus: (key: string, text: unknown) => status.push([key, text]),
    async select(title: string, options: string[]) {
      titles.push(title);
      if (title === "Context Decisions Settings") {
        if (!picked) { mainMenu = options; picked = true; return options.find((o) => o.includes("[Decision] Footer icons:")); }
        return "Done";
      }
      return choice(options);
    },
  });
  choice = (options) => options.find((option) => option.startsWith("Emoji"));
  await h.commands.get("decisions")!.handler("", ctx as ExtensionCommandContext);
  assert.ok(mainMenu.some((o) => o.startsWith("[Decision] Footer icons: ASCII / Unicode")));
  assert.ok(!mainMenu.some((o) => o.startsWith("[Skills] Footer icons") || o.startsWith("[Tools] Footer icons")));
  assert.ok(titles.includes("Footer icons"));
  assert.equal((await loadSettings(h.path)).settings.iconStyle, "emoji");
  assert.ok(status.some(([key]) => key === "context-decisions"), "status refreshed right after the save");

  picked = false; titles.length = 0; status.length = 0; mainMenu = [];
  let offered: string[] = [];
  choice = (options) => { offered = options; return undefined; };
  const again = rpcContext(h.ctx, { setStatus: (key: string, text: unknown) => status.push([key, text]), select: (title: string, options: string[]) => ctx.ui.select(title, options) });
  await h.commands.get("decisions")!.handler("", again as ExtensionCommandContext);
  assert.ok(mainMenu.some((o) => o.startsWith("[Decision] Footer icons: Emoji")));
  assert.deepEqual(offered.slice(0, 3).map((option) => option.split("  ")[0]), ["ASCII / Unicode", "Emoji", "Nerd Font"]);
  assert.match(offered[2], /Requires a Nerd Font/);
  assert.equal((await loadSettings(h.path)).settings.iconStyle, "emoji");
  assert.deepEqual(status, []);
});

test("a second /decisions while the first dialog is open does not open another; it focuses the first", async (t) => {
  const h = await harness(t); const first = h.command(""); const dialog = await h.dialog();
  dialog.handleInput!(KEY.shiftTab); await h.until(dialog, /Constant scoring matrix/);
  await h.command("");
  assert.equal(h.calls.custom, 1); assert.equal(h.calls.focus, 1);
  dialog.handleInput!(KEY.esc); await first;
});

const waitForAsync = async <T,>(read: () => Promise<T | undefined | false>, label: string): Promise<T> => {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test("saves inside the dialog persist immediately, do not close it, and later settle cleanly", async (t) => {
  const h = await harness(t, { configured: true }); let resolved = false;
  const run = h.command("").then(() => { resolved = true; }); const dialog = await h.dialog();
  dialog.handleInput!(KEY.enter); // toggle Skill filtering
  await h.until(dialog, /Skill filtering\s+(Off|Disabled)/);
  await waitForAsync(async () => (await loadSettings(h.path)).settings.relevance.enabled === false, "persisted skillFilteringEnabled=false");
  assert.equal(resolved, false, "saving must not close the dialog");
  dialog.handleInput!(KEY.esc); await run; assert.equal(resolved, true);
});

test("choosing a model through the dialog persists it atomically and never enables filtering", async (t) => {
  const h = await harness(t, { env: { TYPESAFE_API_KEY: "FIXTURE" } });
  await saveSettings({ ...defaultSettings(), relevance: { ...defaultSettings().relevance, enabled: false } }, h.path);
  const run = h.command(""); const dialog = await h.dialog();
  dialog.handleInput!(KEY.tab); dialog.handleInput!(KEY.tab); // Skills -> Tools -> Decision
  await h.until(dialog, /Decision model/);
  dialog.handleInput!(KEY.enter); // open async backend picker
  await h.until(dialog, /jev-latest · TypeSafe direct/, 120);
  h.selectRow(dialog, /jev-latest · TypeSafe direct/, 120);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /typesafe direct jev-latest/, 120);
  const saved = await waitForAsync(async () => {
    const s = (await loadSettings(h.path)).settings;
    return s.backend ? s : undefined;
  }, "persisted backend selection");
  assert.deepEqual(saved.backend, { backend: "typesafe", model: "jev-latest" });
  assert.equal(saved.relevance.enabled, false);
  assert.equal(h.requests.length, 0, "choosing a model makes no inference call");
  dialog.handleInput!(KEY.esc); await run;
});

test("Lab housekeeping picker persists only an available authenticated model", async (t) => {
  const h = await harness(t);
  Object.assign(h.ctx.modelRegistry, {
    getAvailable: () => [{ provider: "good", id: "model" }, { provider: "bad", id: "model" }],
    hasConfiguredAuth: (model: { provider: string }) => model.provider === "good",
  });
  const run = h.command(""); const dialog = await h.dialog();
  dialog.handleInput!(KEY.shiftTab); // Skills -> Lab
  await h.until(dialog, /Past turn summaries · Model/);
  h.selectRow(dialog, /Past turn summaries · Model/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /model.*\[good\]/, 120);
  assert.doesNotMatch(h.text(dialog, 120), /\[bad\]/);
  h.selectRow(dialog, /model.*\[good\]/, 120);
  dialog.handleInput!(KEY.enter); // Step 1 -> Step 2 (thinking level) or apply
  await h.until(dialog, /Thinking|good\/model/, 120);
  if (/Thinking/i.test(h.text(dialog, 120))) {
    dialog.handleInput!(KEY.enter);
  }
  const saved = await waitForAsync(async () => {
    const s = (await loadSettings(h.path)).settings;
    return s.history.model === "good/model" ? s : undefined;
  }, "persisted housekeeping model");
  assert.deepEqual(saved.history, { enabled: false, model: "good/model", thinkingLevel: "off" });
  assert.equal(h.requests.length, 0);
  dialog.handleInput!(KEY.esc); await run;
});

test("missing keys are labelled, guide to env or /login, and are never persisted; OpenAI OAuth cannot substitute", async (t) => {
  const h = await harness(t, { openaiOAuth: true, env: {} });
  const run = h.command(""); const dialog = await h.dialog();
  dialog.handleInput!(KEY.tab); dialog.handleInput!(KEY.tab); // Decision tab
  await h.until(dialog, /Decision model/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /gpt-6-luna · OpenAI direct/, 140);
  assert.match(h.text(dialog, 140), /missing key/);
  h.selectRow(dialog, /gpt-6-luna · OpenAI direct/, 140);
  dialog.handleInput!(KEY.enter);
  const text = h.text(dialog, 140);
  assert.match(text, /OPENAI_API_KEY/); assert.match(text, /\/login openai/); assert.match(text, /not openai-codex/i);
  assert.equal((await loadSettings(h.path)).settings.backend, null); assert.equal(h.requests.length, 0);
  assert.deepEqual(h.messages, [], "guidance stays inside the dialog");
  dialog.handleInput!(KEY.esc); dialog.handleInput!(KEY.esc); await run;
});

test("printed status has short, separated sections and the dialog opens a refreshable Markdown Status view", async (t) => {
  const h = await harness(t);
  await h.command("status");
  const report = h.messages.at(-1)!;
  const sections = report.split("\n\n");
  assert.equal(sections.length, 6);
  assert.match(sections[0]!, /^Context decisions\n  Model: not configured\n  Credentials: not configured$/);
  assert.match(sections[1]!, /^Skills: on · picker prompt\n  Limits:/);
  assert.match(sections[2]!, /^Tool filtering: off \(opt-in\)/);
  assert.match(sections[3]!, /^Decision settings \(Advanced\)\n  Threshold:/);
  assert.match(sections[4]!, /^\[lab\] Past Turn Summaries: off$/);
  assert.match(sections[5]!, /^Subagents · Allow inherited tools: off$/);
  assert.ok(report.split("\n").every((line) => line.length <= 90), "default report should not need long lines");
  assert.doesNotMatch(report, /\{"|Top models|token window/);

  const run = h.command(""); const dialog = await h.dialog();
  h.selectRow(dialog, /Status/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /Credentials/, 100);
  const screens: string[] = [];
  for (let i = 0; i < 40; i++) {
    screens.push(h.text(dialog, 80));
    dialog.handleInput!(KEY.down);
  }
  const visible = screens.join("\n");
  assert.match(visible, /Context Decisions/);
  assert.match(visible, /0\.375/);
  assert.match(visible, /50/);
  assert.match(visible, /not configured/);
  dialog.handleInput!(KEY.esc); dialog.handleInput!(KEY.esc); await run;
  assert.equal(h.requests.length, 0, "status never makes decision calls");
});

test("dialog work never reads ctx.signal (the agent-run signal), even through status, models and ranking", async (t) => {
  const h = await harness(t, { configured: true, env: { TYPESAFE_API_KEY: "FIXTURE" } });
  const run = h.command(""); const dialog = await h.dialog();
  h.selectRow(dialog, /Global always-allowed skills/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /Search:/);
  for (const char of "topic") dialog.handleInput!(char);
  dialog.handleInput!(KEY.rank); await h.until(dialog, /0\.90 relevance/, 120);
  assert.equal(h.requests.length, 1);
  dialog.handleInput!(KEY.esc); await h.until(dialog, /Context Decisions Settings/);
  dialog.handleInput!(KEY.tab); dialog.handleInput!(KEY.tab); // Decision tab
  await h.until(dialog, /Decision model/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /jev-latest/, 120); dialog.handleInput!(KEY.esc);
  dialog.handleInput!(KEY.tab); dialog.handleInput!(KEY.tab); // Lab -> Skills
  await h.until(dialog, /Skill filtering/);
  h.selectRow(dialog, /Status/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /Credentials/); dialog.handleInput!(KEY.esc); dialog.handleInput!(KEY.esc); await run;
  assert.equal(h.reads.signal, 0, "the dialog must own its signal");
});

test("session_shutdown while open resolves the handler, aborts ranking and never touches a stale ctx", async (t) => {
  const h = await harness(t, { configured: true, pendingDecision: true, env: { TYPESAFE_API_KEY: "FIXTURE" } });
  let resolved = false;
  const run = h.command("").then(() => { resolved = true; });
  const dialog = await h.dialog();
  h.selectRow(dialog, /Global always-allowed skills/);
  dialog.handleInput!(KEY.enter);
  await h.until(dialog, /Search:/);
  for (const char of "topic") dialog.handleInput!(char);
  dialog.handleInput!(KEY.rank); await waitFor(() => h.decisionSignals[0], "pending ranking request");
  const messagesBefore = h.messages.length;
  await h.emit("session_shutdown"); h.state.valid = false;
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
  const event = { type: "before_agent_start", messageType: "user", prompt: "task", systemPrompt: "s", systemPromptOptions: { cwd: h.root, skills: Array.from({ length: 3 }, (_, n) => ({ name: `s${n}`, description: "d", filePath: "/p", baseDir: "/b", sourceInfo: { path: "/p", source: "x", scope: "user", origin: "top-level" }, disableModelInvocation: false })), selectedTools: [], sections: {}, hiddenTools: [], toolSnippets: {}, toolGuidelines: [], promptGuidelines: [], contextFiles: [] } };
  await h.emit("before_agent_start", event);
  assert.match(h.text(dialog), /Skill filtering/); dialog.handleInput!(KEY.esc); await run;
});

test("a custom() failure is reported as a safe error and does not wedge later opens", async (t) => {
  const h = await harness(t, { rejectCustom: true });
  await h.command(""); assert.match(h.messages.at(-1)!, /Context-decisions operation failed/); assert.doesNotMatch(h.messages.join("\n"), /PRIVATE/);
  await h.command(""); assert.equal(h.calls.custom, 2);
});

test("headless commands keep their text output without a dialog", async (t) => {
  const h = await harness(t, { mode: "print", custom: false });
  await h.command("status"); assert.match(h.messages.at(-1)!, /Context decisions\n  Model: not configured/);
  await h.command(""); assert.match(h.messages.at(-1)!, /Context decisions\n  Model: not configured/, "no arguments: the status, never a dialog");
  await h.command("pin alpha"); assert.match(h.messages.at(-1)!, /Pinned skills updated/);
  await h.command("tools list"); assert.match(h.messages.at(-1)!, /Tools \(/);
  assert.equal(h.calls.custom + h.calls.select + h.calls.input, 0);
});

test("/decisions history opens the standalone history overlay, reuses it on repeat open, shows committed additions and never scores or reads agent signal", async (t) => {
  const h = await harness(t, { configured: true });
  const session = SessionManager.inMemory(h.root);
  h.ctx.sessionManager = session;
  session.appendCustomMessageEntry("context-decisions-skills", "PRIVATE description", false, { v: 1, added: ["alpha"], redelivered: [] });
  const first = h.command("history"); const dialog = await h.dialog();
  assert.deepEqual(
    h.customOptions[0] && { ...(h.customOptions[0] as object), onHandle: undefined },
    { overlay: true, overlayOptions: HISTORY_OVERLAY_OPTIONS, onHandle: undefined },
  );
  await h.until(dialog, /Turn 1/);
  await h.command("history");
  assert.equal(h.calls.custom, 1); assert.equal(h.calls.focus, 1);
  dialog.handleInput!(KEY.enter); await h.until(dialog, /Skills advertised/);
  assert.match(h.text(dialog), /alpha/); assert.doesNotMatch(h.text(dialog), /PRIVATE/);
  dialog.handleInput!(KEY.esc); await h.until(dialog, /Decisions › History/);
  dialog.handleInput!(KEY.esc); await first;
  assert.equal(h.reads.signal, 0); assert.equal(h.requests.length, 0);
  assert.equal(h.calls.select + h.calls.input, 0);
  assert.deepEqual(h.sim.calls, { getAllTools: 0, setActiveTools: 0 });
});

for (const mode of ["rpc", "print"] as const) test(`/decisions history in ${mode} is a read-only report, never terminal UI`, async (t) => {
  const h = await harness(t, { mode });
  const session = SessionManager.inMemory(h.root); h.ctx.sessionManager = session;
  session.appendCustomEntry("context-decisions-tools", { v: 1, considered: ["not-picked"] });
  await h.command("history"); assert.match(h.messages.at(-1)!, /No committed additions/);
  session.appendMessage({ role: "user", content: "PRIVATE user", timestamp: 0 });
  session.appendCustomMessageEntry("context-decisions-skills", "PRIVATE", false, { v: 1, added: ["alpha\x1b\r\n\u202e"], redelivered: [] });
  session.appendMessage(fauxAssistantMessage([fauxText("PRIVATE assistant")]));
  for (const data of toolRecords({ groups: ["mcp__exa", "ext__notes"], picks: new Map([
    ["mcp__exa", { score: 1.6, threshold: 0.375 }], ["ext__notes", { score: 1.4, threshold: 0.375 }],
  ]) })) session.appendCustomEntry("context-decisions-tools", data);
  const notice = buildToolNotice([], ["mcp__exa", "ext__notes"], true)!;
  session.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  session.appendMessage(fauxAssistantMessage([fauxText("PRIVATE assistant")]));
  session.appendMessage({ role: "user", content: "PRIVATE followup", timestamp: 0 });
  session.appendCustomMessageEntry("context-decisions-skills", "PRIVATE", false, { v: 1, added: ["beta"], redelivered: [] });
  const before = session.getBranch().length;
  await h.command("history");
  const report = h.messages.at(-1)!;
  assert.match(report, /Turn 1: \(1 skills, 2 tools\/MCPs added\)/);
  assert.match(report, /Internal turn 2/);
  assert.match(report, /Turn 3: \(1 skills, 0 tools\/MCPs added\)/);
  assert.match(report, /alpha/);
  assert.match(report, /\+ mcp__exa  score 1\.6 \/ ≥0\.75 · notice/);
  assert.match(report, /\+ ext__notes  score 1\.4 \/ ≥0\.75 · notice/);
  assert.doesNotMatch(report, /PRIVATE|Tool availability|among the MCP servers|not-picked|\x1b|\r|\u202e/);
  assert.equal(session.getBranch().length, before, "reading never appends history records");
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
