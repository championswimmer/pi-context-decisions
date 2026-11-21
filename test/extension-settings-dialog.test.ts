import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  SettingsDialogComponent,
  createSettingsStore,
  type DynamicPickerOption,
  type SettingsDialogResult,
} from "pi-extension-settings-tui";
import type { ScopedSkill } from "../src/apps/allowlist.ts";
import { FOOTER_ICONS } from "../src/extension/footer-status.ts";
import { dialogHeightBudget } from "../src/extension/settings-model.ts";
import { createAllowlistComponent, type AllowlistPickerDeps, type AllowlistTheme } from "../src/extension/allowlist-picker.ts";
import {
  createHistoryDialogComponent,
  createHistoryDialogManager,
  HISTORY_OVERLAY_OPTIONS,
  type HistoryDialogResult,
} from "../src/extension/history-dialog.ts";
import type { DecisionsHistory, HistoryTurn } from "../src/extension/decisions-history.ts";
import {
  createContextDecisionsSettingsSchema,
  loadSettings,
  type FlatContextDecisionsSettings,
  type SettingsUiHooks,
} from "../src/settings.ts";
import { loadGlobalAllowlist, loadProjectAllowlist, saveGlobalAllowlist, saveProjectAllowlist } from "../src/project-allowlist.ts";
import type { BackendSelection } from "../src/core/backends/factory.ts";

const KEY = {
  tab: "\t",
  shiftTab: "\x1b[Z",
  left: "\x1b[D",
  right: "\x1b[C",
  down: "\x1b[B",
  up: "\x1b[A",
  enter: "\r",
  esc: "\x1b",
  space: " ",
  save: "\x13",
  refresh: "\x12",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
};

const theme = {
  fg: (_token: unknown, value: string) => value,
  bg: (_token: unknown, value: string) => value,
  bold: (value: string) => value,
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const skill = (name: string, scope: "global" | "project" = "global", description = "Fixture description"): ScopedSkill => ({
  name,
  description,
  scope,
  disableModelInvocation: false,
});

async function mountSettings(
  t: { after(fn: () => Promise<void>): void },
  options: {
    rows?: number;
    initialTab?: string;
    hooks?: SettingsUiHooks;
    themeOverride?: typeof theme;
    onApply?: (next: FlatContextDecisionsSettings) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "settings-dialog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");

  const backendOptions: DynamicPickerOption<BackendSelection | null>[] = [
    {
      id: "typesafe",
      value: { backend: "typesafe", model: "jev-latest" },
      label: "jev-latest · TypeSafe direct",
      group: "Direct API",
      badge: "configured",
      badgeTone: "success",
      description: "typesafe direct jev-latest",
    },
    {
      id: "openai",
      value: { backend: "openai", model: "gpt-6-luna" },
      label: "gpt-6-luna · OpenAI direct",
      group: "Direct API",
      badge: "missing key",
      badgeTone: "warn",
      disabled: true,
      disabledReason: "openai credentials are missing or unavailable. Set OPENAI_API_KEY in the environment or configure /login openai in Pi.",
      description: "openai direct gpt-6-luna",
    },
  ];

  const defaultHooks: SettingsUiHooks = {
    loadBackendOptions: async () => backendOptions,
    isSubagentManagerPresent: () => false,
    getAvailableHousekeepingModels: () => [{ provider: "good", id: "model", name: "Good Model", reasoning: true }],
    isHousekeepingModelUsable: (sel) => sel.model === "good/model",
    renderStatusMarkdown: async () => "## Context Decisions\n\n- **Model**: `not configured`\n- **Credentials**: not configured",
    externalAllowlistSummary: async (scope, kind) => {
      const loaded = scope === "global" ? await loadGlobalAllowlist(path) : await loadProjectAllowlist(root);
      const list = kind === "skills" ? loaded.names : kind === "tools" ? loaded.tools : loaded.mcpServers;
      return { text: String(list.length) };
    },
    openAllowlistSubroute: async (scope, kind, params) => {
      const loaded = scope === "global" ? await loadGlobalAllowlist(path) : await loadProjectAllowlist(root);
      const initial = kind === "skills" ? loaded.names : kind === "tools" ? loaded.tools : loaded.mcpServers;
      const deps: Omit<AllowlistPickerDeps, "report" | "maxRows"> = {
        scope,
        skills: [skill(`${scope}-a`, scope), skill(`${scope}-b`, scope)],
        initial,
        noun: kind === "skills" ? "skill" : kind === "tools" ? "tool" : "MCP server or extension",
        locationLabel: scope === "global" ? "allowlists.json" : ".pi/pi-context-decisions.json",
        save: async (names) => {
          const payload = kind === "skills" ? { skills: names } : kind === "tools" ? { tools: names } : { mcpServers: names };
          if (scope === "global") await saveGlobalAllowlist(path, payload);
          else await saveProjectAllowlist(root, payload);
        },
      };
      let lastReport: string | undefined;
      return createAllowlistComponent(
        { requestRender: params.requestRender, terminal: (params.tui as { terminal?: { rows: number } }).terminal },
        params.theme as AllowlistTheme,
        (saved) => params.close({ saved, ...(saved ? { message: lastReport ?? "Always-allowed list saved", tone: "success" as const } : {}) }),
        { ...deps, maxRows: params.getMaxHeight, report: (msg) => { lastReport = msg; } },
      );
    },
    ...options.hooks,
  };

  const schema = createContextDecisionsSettingsSchema(defaultHooks);
  const store = createSettingsStore(schema, { globalPath: path, deleteWhenEmpty: false });
  const initialState = await store.load();
  const results: SettingsDialogResult<FlatContextDecisionsSettings>[] = [];
  const applied: FlatContextDecisionsSettings[] = [];
  let renders = 0;
  const tui = { requestRender() { renders++; }, terminal: { rows: options.rows ?? 40 } };

  const component = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui: tui as never,
    theme: (options.themeOverride ?? theme) as never,
    keybindings: getKeybindings() as never,
    done: (result) => results.push(result),
    initialTab: options.initialTab,
    onApply: (next) => {
      applied.push(next);
      options.onApply?.(next);
    },
  });
  component.focused = true;
  t.after(async () => { component.dispose(); });

  const press = (...keys: string[]) => { for (const key of keys) component.handleInput(key); };
  const text = (width = 110) => component.render(width).join("\n");
  const until = async (pattern: RegExp, width = 110) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const rendered = text(width);
      if (pattern.test(rendered)) return rendered;
      if (Date.now() > deadline) assert.fail(`Timed out waiting for ${pattern}; last render:\n${rendered}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const selectRow = (label: RegExp, width = 110) => {
    for (let i = 0; i < 30; i++) press(KEY.up);
    for (let i = 0; i < 30; i++) {
      if (text(width).split("\n").some((line) => line.includes("❯") && label.test(line))) return;
      press(KEY.down);
    }
    assert.fail(`Could not reach row ${label}\n${text(width)}`);
  };

  return { root, path, schema, store, component, results, applied, press, text, until, selectRow, get renders() { return renders; } };
}

test("SettingsDialogComponent: 4 peer tabs (Skills, Tools, Decision, Lab), active tab chip styling, and Tab/Shift+Tab cycling", async (t) => {
  const marked = {
    fg: (token: unknown, value: string) => `<fg:${String(token)}>${value}</fg>`,
    bg: (token: unknown, value: string) => `<bg:${String(token)}>${value}</bg>`,
    bold: (value: string) => `<b>${value}</b>`,
  };
  const h = await mountSettings(t, { themeOverride: marked });
  const skillsText = h.text(220);
  assert.match(skillsText, /<bg:selectedBg>.*Skills.*<\/bg>/);
  assert.match(skillsText, /Tools/);
  assert.match(skillsText, /Decision/);
  assert.match(skillsText, /Lab/);
  assert.doesNotMatch(skillsText, /Pinned skills/, "legacy pinnedSkills is hidden from the dialog");

  h.press(KEY.tab);
  assert.match(h.text(220), /<bg:selectedBg>.*Tools.*<\/bg>/);
  assert.match(h.text(220), /Tool filtering/);
  h.press(KEY.tab);
  assert.match(h.text(220), /<bg:selectedBg>.*Decision.*<\/bg>/);
  assert.match(h.text(220), /Decision model/);
  h.press(KEY.tab);
  assert.match(h.text(220), /<bg:selectedBg>.*Lab.*<\/bg>/);
  assert.match(h.text(220), /Constant scoring matrix/);
  h.press(KEY.tab);
  assert.match(h.text(220), /<bg:selectedBg>.*Skills.*<\/bg>/);
  h.press(KEY.shiftTab);
  assert.match(h.text(220), /<bg:selectedBg>.*Lab.*<\/bg>/);
  assert.equal(h.results.length, 0);
  h.press(KEY.esc);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].closedBy, "immediate");
});

test("Skills tab: immediate toggle save, Markdown Status view, and Global/Project allowlist subroutes", async (t) => {
  const h = await mountSettings(t);
  await h.until(/Global always-allowed skills\s+0/);
  await h.until(/Project always-allowed skills\s+0/);

  // Toggle Skill filtering immediately
  h.press(KEY.enter);
  await h.until(/Skill filtering\s+(Off|Disabled)/);
  await tick();
  assert.equal((await loadSettings(h.path)).settings.relevance.enabled, false);

  // Open Markdown Status view
  h.selectRow(/Status/);
  h.press(KEY.enter);
  await h.until(/Credentials/);
  assert.match(h.text(), /not configured/);
  h.press(KEY.esc);
  await h.until(/Skill filtering/);

  // Open Global allowlist subroute, toggle & save with Ctrl+S -> allowlists.json
  h.selectRow(/Global always-allowed skills/);
  h.press(KEY.enter);
  await h.until(/global-a/);
  h.press(KEY.down, KEY.space, KEY.save);
  await h.until(/Always-allowed skills saved/);
  h.press(KEY.esc, KEY.esc);
  await h.until(/Global always-allowed skills\s+1/);
  assert.deepEqual((await loadGlobalAllowlist(h.path)).names, ["global-a"]);
  assert.deepEqual((await loadProjectAllowlist(h.root)).names, []);

  // Open Project allowlist subroute, toggle & save -> .pi/pi-context-decisions.json
  h.selectRow(/Project always-allowed skills/);
  h.press(KEY.enter);
  await h.until(/project-a/);
  h.press(KEY.down, KEY.space, KEY.save);
  await h.until(/Always-allowed skills saved/);
  h.press(KEY.esc, KEY.esc);
  await h.until(/Project always-allowed skills\s+1/);
  assert.deepEqual((await loadProjectAllowlist(h.root)).names, ["project-a"]);
});

test("Decision tab: async backend picker shows configured/missing key, enforces disabledReason, and selects/clears cleanly", async (t) => {
  const h = await mountSettings(t, { initialTab: "decision" });
  assert.match(h.text(), /Decision model\s+Not configured/);
  h.press(KEY.enter);
  await h.until(/jev-latest · TypeSafe direct/);
  assert.match(h.text(130), /configured/);
  assert.match(h.text(130), /missing key/);

  // Selecting missing-key OpenAI shows disabledReason inline and does NOT persist
  h.selectRow(/gpt-6-luna · OpenAI direct/, 130);
  h.press(KEY.enter);
  assert.match(h.text(130), /OPENAI_API_KEY/);
  assert.equal((await loadSettings(h.path)).settings.backend, null);

  // Selecting configured TypeSafe saves immediately
  h.press(KEY.up);
  h.selectRow(/jev-latest · TypeSafe direct/, 130);
  h.press(KEY.enter);
  await h.until(/typesafe direct jev-latest/);
  const deadline = Date.now() + 1000;
  while (!(await loadSettings(h.path)).settings.backend && Date.now() < deadline) await tick();
  assert.deepEqual((await loadSettings(h.path)).settings.backend, { backend: "typesafe", model: "jev-latest" });
});

test("Decision tab: decisionFailMode disables inline stepping and warns on open; Footer icons picker shows real glyphs", async (t) => {
  const h = await mountSettings(t, { initialTab: "decision" });
  h.selectRow(/On failure/);
  // Left/Right must NOT flip failMode inline (allowInlineStep: false)
  h.press(KEY.right, KEY.left);
  await tick();
  assert.equal((await loadSettings(h.path)).settings.decision.failMode, "closed");

  // Enter opens explicit picker with warning on open
  h.press(KEY.enter);
  await h.until(/WARNING.*every remaining skill, tool or group is added/i, 120);
  h.press(KEY.down, KEY.enter);
  await h.until(/On failure\s+open/);

  // Footer icons picker shows every style's glyphs
  h.selectRow(/Footer icons/);
  h.press(KEY.enter);
  const pickerText = h.text(130);
  for (const style of ["unicode", "emoji", "nerd"] as const) {
    for (const glyph of Object.values(FOOTER_ICONS[style])) {
      assert.ok(pickerText.includes(glyph), `Footer icons picker missing ${style} glyph ${JSON.stringify(glyph)}`);
    }
  }
  h.press(KEY.down, KEY.enter); // Emoji
  await h.until(/Footer icons\s+Emoji/);
});

test("Tools tab: dynamic labels follow toolMode and inherited-tools eligibility follows subagentManagerPresent", async (t) => {
  let managerPresent = false;
  const h = await mountSettings(t, {
    initialTab: "tools",
    hooks: { isSubagentManagerPresent: () => managerPresent },
  });
  assert.match(h.text(), /Tools · Max added per round/);
  assert.match(h.text(), /Tools · Minimum candidates/);

  // Subagents · Allow inherited tools is ineligible when manager is absent
  h.selectRow(/Subagents · Allow inherited tools/);
  h.press(KEY.enter);
  await tick();
  assert.equal((await loadSettings(h.path)).settings.tools.allowSubagentInheritedTools, false);
  assert.match(h.text(120), /pi-subagent-manager/);

  // Switch Mode -> mcp and verify dynamic labels update
  h.press(...Array(10).fill(KEY.up));
  h.selectRow(/Mode/);
  h.press(KEY.right);
  await h.until(/MCP\/exts · Max added per round/);
  assert.match(h.text(), /MCP\/exts · Minimum candidates/);

  // With manager present, inherited tools becomes eligible and toggles
  managerPresent = true;
  h.selectRow(/Subagents · Allow inherited tools/);
  h.press(KEY.enter);
  await h.until(/Subagents · Allow inherited tools\s+(On|Enabled)/);
});

test("Lab tab: historyEnabled requires a usable housekeeping model, and clearing model disables summaries", async (t) => {
  const h = await mountSettings(t, { initialTab: "lab" });
  assert.match(h.text(), /Constant scoring matrix/);
  assert.match(h.text(), /\[lab\]/);

  // Trying to enable summaries without a model fails eligibility
  h.selectRow(/Past turn summaries · Enabled/);
  h.press(KEY.enter);
  await tick();
  assert.equal((await loadSettings(h.path)).settings.history.enabled, false);
  assert.match(h.text(120), /Select a housekeeping model first/);

  const dialogPattern = /model.*\[good\]/;
  // Pick housekeeping model (Step 1: model, Step 2: thinking level)
  h.press(KEY.up);
  h.press(KEY.enter);
  await h.until(dialogPattern, 120);
  h.selectRow(dialogPattern, 120);
  h.press(KEY.enter);
  await h.until(/Thinking|good\/model/, 120);
  if (/Thinking/i.test(h.text(120))) h.press(KEY.enter);
  await h.until(/Past turn summaries · Model.*good\/model/, 120);

  // Now enabling summaries succeeds
  h.selectRow(/Past turn summaries · Enabled/);
  h.press(KEY.enter);
  await h.until(/Past turn summaries · Enabled.*On/);

  // Clearing the model automatically disables summaries via normalizeDraft
  h.press(KEY.up, KEY.enter);
  await h.until(/Not selected/, 120);
  h.selectRow(/Not selected/, 120);
  h.press(KEY.enter);
  await h.until(/Past turn summaries · Enabled.*Off/);
});

test("SettingsDialogComponent: abort() cancels in-flight async picker load and settles cleanly", async (t) => {
  const pending = deferred<DynamicPickerOption<BackendSelection | null>[]>();
  const signals: AbortSignal[] = [];
  const h = await mountSettings(t, {
    initialTab: "decision",
    hooks: {
      loadBackendOptions: async (ctx) => {
        signals.push(ctx.signal);
        return pending.promise;
      },
    },
  });
  h.press(KEY.enter); // start loading Decision model options
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);

  h.component.abort();
  assert.equal(signals[0].aborted, true);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].closedBy, "abort");

  // Late resolution after abort must not throw or trigger extra renders
  const rendersAfterAbort = h.renders;
  pending.resolve([]);
  await tick();
  assert.equal(h.renders, rendersAfterAbort);
});

// ---- Standalone history-dialog.ts tests ----

const historyFixture = (turn = 3, count = 1): DecisionsHistory => ({
  turns: [{
    turn,
    batches: [{
      turn,
      answered: true,
      items: {
        skills: Array.from({ length: count }, (_, n) => `skill-${n}`),
        pinned: [],
        base: [],
        redelivered: [],
        tools: [],
        groups: [],
        noticeTools: [],
        noticeGroups: [],
      },
    }],
  }],
});

function mountHistory(loadHistory: (signal: AbortSignal) => Promise<DecisionsHistory>, rows = 24) {
  const results: HistoryDialogResult[] = [];
  const tui = { requestRender() {}, terminal: { rows } };
  const component = createHistoryDialogComponent(tui, theme, (r) => results.push(r), loadHistory);
  component.focused = true;
  const press = (...keys: string[]) => { for (const key of keys) component.handleInput!(key); };
  const text = (width = 100) => component.render(width).join("\n");
  const until = async (pattern: RegExp, width = 100) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const rendered = text(width);
      if (pattern.test(rendered)) return rendered;
      if (Date.now() > deadline) assert.fail(`Timed out waiting for ${pattern}\n${rendered}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  return { component, results, press, text, until };
}

test("history-dialog lists newest non-empty user turns first, drills into scrollable details, and refreshes with Ctrl+R", async () => {
  let snapshot = historyFixture(3, 1001);
  snapshot.turns.unshift(historyFixture(1).turns[0]);
  let reads = 0;
  const h = mountHistory(async () => { reads++; return snapshot; }, 24);
  assert.match(h.text(), /Reading committed branch/);
  await h.until(/Turn 3/);
  assert.match(h.text(), /❯ Turn 3/);
  assert.ok(h.text().indexOf("Turn 3") < h.text().indexOf("Turn 1"));
  h.press(KEY.enter);
  assert.match(h.text(), /Skills advertised/);
  assert.match(h.text(), /skill-0/);
  h.press(KEY.end);
  assert.match(h.text(), /skill-1000/);
  h.press(KEY.home);
  assert.match(h.text(), /Skills advertised/);
  h.press(KEY.pageDown);
  assert.doesNotMatch(h.text(), /skill-0\s/);
  h.press(KEY.esc);
  assert.match(h.text(), /❯ Turn 3/);
  snapshot = historyFixture(5);
  h.press(KEY.refresh);
  await h.until(/Turn 5/);
  assert.doesNotMatch(h.text(), /Turn 3/);
  assert.equal(reads, 2);
  h.press(KEY.esc);
  assert.deepEqual(h.results, ["closed"]);
  h.component.dispose();
});

test("history-dialog groups internal batches under their parent turn and handles empty/error/abort safely", async () => {
  const snapshot = historyFixture(1);
  const internal = historyFixture(2).turns[0].batches[0];
  internal.items.skills = [];
  internal.items.groups = ["mcp__exa", "ext__notes"];
  snapshot.turns[0].batches.push(internal);
  const h = mountHistory(async () => snapshot, 24);
  await h.until(/Turn 1: \(1 skills, 2 tools\/MCPs added\)/);
  assert.doesNotMatch(h.text(), /Turn 2/);
  h.press(KEY.enter, KEY.end);
  assert.match(h.text(), /Internal turn 2/);
  assert.match(h.text(), /\+ mcp__exa/);
  assert.match(h.text(), /\+ ext__notes/);
  h.component.dispose();

  // Pending load aborted by Ctrl+R refresh, error sanitized, empty state shown, shutdown drops further refresh
  const pending = deferred<DecisionsHistory>();
  const signals: AbortSignal[] = [];
  let call = 0;
  const g = mountHistory(async (signal) => {
    signals.push(signal);
    call++;
    if (call === 1) return pending.promise;
    if (call === 2) throw new Error("PRIVATE");
    return { turns: [] };
  });
  assert.match(g.text(), /Reading committed branch/);
  g.press(KEY.refresh);
  await g.until(/Context-decisions operation failed/);
  assert.equal(signals[0].aborted, true);
  assert.doesNotMatch(g.text(), /PRIVATE/);
  pending.resolve(historyFixture(999));
  await tick();
  assert.doesNotMatch(g.text(), /999/);
  g.press(KEY.refresh);
  await g.until(/No committed additions on this branch/);
  g.component.close("shutdown");
  g.press(KEY.refresh);
  await tick();
  assert.equal(call, 3);
  assert.deepEqual(g.results, ["shutdown"]);
});

test("history-dialog stays sanitized and width/height-bounded at narrow and tiny terminal sizes", async () => {
  const turn: HistoryTurn = historyFixture(2).turns[0];
  const batch = turn.batches[0];
  batch.items.skills = ["界".repeat(180) + "\x1b\n\u202e"];
  batch.items.tools = ["name\r\x07"];
  batch.marks = {
    skills: new Map([[batch.items.skills[0], "score 1.4166666666666667 / ≥0.75"]]),
    tools: new Map([[batch.items.tools[0], "score 1.6 / ≥0.75\x1b\r\x07\u202e"]]),
  };
  for (const rows of [4, 10, 16, 24, 40]) {
    const h = mountHistory(async () => ({ turns: [turn] }), rows);
    await tick();
    assert.match(h.text(30), /Turn 2/);
    for (const details of [false, true]) {
      if (details) h.press(KEY.enter);
      for (const width of [1, 7, 16, 30, 60, 120]) {
        const lines = h.component.render(width);
        assert.ok(lines.length <= dialogHeightBudget(rows), `${rows}x${width}: ${lines.length}`);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
          assert.doesNotMatch(stripTerminalSequences(line), /\x1b|\r|\x07|\u202e/);
        }
      }
    }
    h.component.dispose();
  }
});

test("createHistoryDialogManager: one overlay at a time, repeat open focuses existing, closeAll resolves with shutdown", async () => {
  const manager = createHistoryDialogManager();
  let customCalls = 0;
  let focusCalls = 0;
  let received: unknown;
  const ctx = {
    ui: {
      async custom(factory: (...args: unknown[]) => unknown, options: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void }) {
        customCalls++;
        received = options;
        return new Promise((resolve) => {
          factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, resolve);
          options.onHandle?.({ focus() { focusCalls++; } });
        });
      },
    },
  } as unknown as Parameters<typeof manager.open>[0];

  let isOpen: (() => boolean) | undefined;
  const first = manager.open(ctx, (life) => {
    isOpen = life.isOpen;
    return async () => historyFixture(1);
  });
  assert.equal(manager.isOpen(), true);
  const second = await manager.open(ctx, () => { throw new Error("second loader must not be built"); });
  assert.equal(second, "focused-existing");
  assert.equal(customCalls, 1);
  assert.equal(focusCalls, 1);
  assert.equal((received as { overlay: boolean }).overlay, true);
  assert.deepEqual((received as { overlayOptions: unknown }).overlayOptions, HISTORY_OVERLAY_OPTIONS);
  assert.equal(isOpen!(), true);
  manager.closeAll();
  manager.closeAll();
  assert.equal(await first, "shutdown");
  assert.equal(isOpen!(), false);
  assert.equal(manager.isOpen(), false);
});
