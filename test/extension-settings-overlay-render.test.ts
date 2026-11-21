// Drives Pi's REAL main-screen renderer (TuiMainScreen) into a headless xterm while the transcript
// keeps growing underneath the floating settings dialog and history dialog overlays.
// This is a renderer-level test, not a visual terminal check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as xtermModule from "@xterm/headless";
import { Container, getKeybindings, Input, TuiMainScreen, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { SettingsDialogComponent, createSettingsStore, type SettingsDialogResult } from "pi-extension-settings-tui";
import { createContextDecisionsSettingsSchema, type FlatContextDecisionsSettings, type SettingsUiHooks } from "../src/settings.ts";
import { createAllowlistComponent, type AllowlistPickerDeps, type AllowlistTheme } from "../src/extension/allowlist-picker.ts";
import { createHistoryDialogComponent, HISTORY_OVERLAY_OPTIONS, type HistoryDialogResult } from "../src/extension/history-dialog.ts";
import { dialogHeightBudget } from "../src/extension/settings-model.ts";
import type { DecisionsHistory } from "../src/extension/decisions-history.ts";

type XTerminal = InstanceType<typeof xtermModule.Terminal>;
const XTermClass: typeof xtermModule.Terminal = (xtermModule as unknown as { Terminal?: typeof xtermModule.Terminal; default?: { Terminal: typeof xtermModule.Terminal } }).Terminal
  ?? (xtermModule as unknown as { default: { Terminal: typeof xtermModule.Terminal } }).default.Terminal;

/** A pi-tui Terminal whose output is interpreted by a real VT emulator. */
class EmulatedTerminal implements Terminal {
  readonly xterm: XTerminal;
  private pending: Promise<void>[] = [];
  writes = 0;
  readonly cols: number;
  readonly rowCount: number;
  constructor(cols: number, rowCount: number) {
    this.cols = cols; this.rowCount = rowCount;
    this.xterm = new XTermClass({ cols, rows: rowCount, scrollback: 5000, allowProposedApi: true });
  }
  start() {} stop() {} async drainInput() {}
  write(data: string) { this.writes++; this.pending.push(new Promise<void>((resolve) => this.xterm.write(data, resolve))); }
  get columns() { return this.cols; }
  get rows() { return this.rowCount; }
  get kittyProtocolActive() { return false; }
  moveBy(lines: number) { if (lines > 0) this.write(`\x1b[${lines}B`); else if (lines < 0) this.write(`\x1b[${-lines}A`); }
  hideCursor() { this.write("\x1b[?25l"); } showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[K"); } clearFromCursor() { this.write("\x1b[J"); } clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle() {} setProgress() {} setProgramStatus() {}
  async flush() { const batch = this.pending; this.pending = []; await Promise.all(batch); }
  /** Background palette index of the cell at (absolute buffer row, column), or undefined for the default background. */
  bgAt(row: number, col: number): number | undefined {
    const cell = this.xterm.buffer.active.getLine(row)?.getCell(col);
    return cell && !cell.isBgDefault() ? cell.getBgColor() : undefined;
  }
  /** Every buffer line (scrollback first, then the visible viewport) and the viewport offset. */
  snapshot() {
    const buffer = this.xterm.buffer.active; const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return { lines, viewportTop: buffer.baseY };
  }
}

class Lines implements Component { lines: string[] = []; invalidate() {} render() { return [...this.lines]; } }

const theme = {
  fg: (_token: unknown, value: string) => `\x1b[36m${value}\x1b[39m`,
  bg: (_token: unknown, value: string) => `\x1b[48;5;24m${value}\x1b[49m`,
  bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
};

const SETTINGS_OVERLAY: OverlayOptions = {
  anchor: "top-center",
  width: 76,
  minWidth: 44,
  maxHeight: "90%",
  margin: 1,
};

async function settingsScenario(
  t: { after(fn: () => Promise<void>): void },
  rows: number,
  options: { initialTab?: string; hooks?: SettingsUiHooks; initialOverrides?: Partial<FlatContextDecisionsSettings> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "overlay-render-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");

  const schema = createContextDecisionsSettingsSchema({
    externalAllowlistSummary: async () => ({ text: "2" }),
    ...options.hooks,
  });
  const store = createSettingsStore(schema, { globalPath: path, deleteWhenEmpty: false });
  if (options.initialOverrides) {
    await store.save({ ...schema.getDefaults(), ...options.initialOverrides }, { scope: "global", force: true });
  }
  const initialState = await store.load();

  const terminal = new EmulatedTerminal(80, rows);
  const tui = new TuiMainScreen(terminal, false);
  const transcript = new Lines();
  const editor = new Input({ prompt: "> " });
  const base = new Container();
  base.addChild(transcript);
  base.addChild(editor);
  tui.addChild(base);
  tui.setFocus(editor);
  const append = (n: number) => { transcript.lines.push(`transcript line ${String(n).padStart(3, "0")}`); base.invalidate(); };
  for (let n = 0; n < 30; n++) append(n);
  tui.renderNow(); await terminal.flush();

  const results: SettingsDialogResult<FlatContextDecisionsSettings>[] = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui: tui as never,
    theme: theme as never,
    keybindings: getKeybindings() as never,
    done: (result) => { results.push(result); tui.hideOverlay(); },
    initialTab: options.initialTab,
  });
  const handle = tui.showOverlay(dialog, SETTINGS_OVERLAY);
  tui.renderNow(); await terminal.flush();
  t.after(async () => { dialog.dispose(); });
  return { terminal, tui, transcript, editor, dialog, handle, results, append };
}

async function historyScenario(rows: number, history: DecisionsHistory) {
  const terminal = new EmulatedTerminal(80, rows);
  const tui = new TuiMainScreen(terminal, false);
  const transcript = new Lines();
  const editor = new Input({ prompt: "> " });
  const base = new Container();
  base.addChild(transcript);
  base.addChild(editor);
  tui.addChild(base);
  tui.setFocus(editor);
  const append = (n: number) => { transcript.lines.push(`transcript line ${String(n).padStart(3, "0")}`); base.invalidate(); };
  for (let n = 0; n < 30; n++) append(n);
  tui.renderNow(); await terminal.flush();

  const results: HistoryDialogResult[] = [];
  const dialog = createHistoryDialogComponent(
    tui,
    theme as never,
    (result) => { results.push(result); tui.hideOverlay(); },
    async () => history,
  );
  const handle = tui.showOverlay(dialog, HISTORY_OVERLAY_OPTIONS);
  tui.renderNow(); await terminal.flush();
  return { terminal, tui, transcript, editor, dialog, handle, results, append };
}

const lineOf = (n: number) => `transcript line ${String(n).padStart(3, "0")}`;

for (const rows of [24, 14]) {
  test(`real renderer 80x${rows}: settings dialog stays put and focused while transcript scrolls underneath`, async (t) => {
    const s = await settingsScenario(t, rows);
    const first = s.handle.getBounds()!;
    assert.ok(s.handle.isFocused());
    assert.equal(s.tui.getFocusedComponent(), s.dialog);
    assert.equal(first.row, 1, "anchored to the top with a one-row margin");
    assert.ok(first.height >= 1 && first.height <= rows - 2);

    const redrawsAfterOpen = s.tui.fullRedraws;
    for (let n = 30; n < 90; n++) {
      s.append(n); s.tui.renderNow(); await s.terminal.flush();
      const bounds = s.handle.getBounds()!;
      assert.deepEqual(
        { row: bounds.row, col: bounds.col, width: bounds.width, height: bounds.height },
        { row: first.row, col: first.col, width: first.width, height: first.height },
        `bounds moved at line ${n}`,
      );
      assert.ok(s.handle.isFocused(), `focus lost at line ${n}`);
    }
    assert.equal(s.tui.fullRedraws, redrawsAfterOpen, "appending lines must not force full redraws");

    const { lines, viewportTop } = s.terminal.snapshot();
    const viewport = lines.slice(viewportTop, viewportTop + rows);
    assert.match(viewport[1], /╭─/);
    assert.match(viewport[first.row + first.height - 1], /╰─/);
    assert.ok(viewport.slice(1, 1 + first.height).some((line) => /Context Decisions Settings/.test(line)));
    assert.match(viewport[rows - 1], /^> /);
    assert.equal(viewport[rows - 2].trim(), lineOf(89));

    const scrollback = lines.slice(0, viewportTop);
    const dialogChars = /[╭╮╰╯│]|Context Decisions Settings/;
    for (const [index, line] of scrollback.entries()) {
      assert.doesNotMatch(line, dialogChars, `dialog remnant in scrollback row ${index}: ${JSON.stringify(line)}`);
    }
    const seen = scrollback
      .map((line) => /transcript line (\d{3})/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "scrollback transcript order");
    assert.equal(new Set(seen).size, seen.length, "no duplicated scrollback lines");
    assert.equal(seen[0], 0, "transcript starts at the first line");
  });
}

test("real renderer: closing settings dialog returns focus to editor, removes every dialog row and keeps transcript intact", async (t) => {
  const s = await settingsScenario(t, 24);
  for (let n = 30; n < 50; n++) { s.append(n); s.tui.renderNow(); }
  await s.terminal.flush();
  s.dialog.handleInput("\x1b"); s.tui.renderNow(); await s.terminal.flush();
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].closedBy, "immediate");
  assert.equal(s.tui.getFocusedComponent(), s.editor);
  assert.equal(s.tui.hasOverlay(), false);
  const { lines, viewportTop } = s.terminal.snapshot();
  const viewport = lines.slice(viewportTop, viewportTop + 24);
  assert.ok(viewport.every((line) => !/[╭╮╰╯│]|Context Decisions Settings/.test(line)), "no dialog rows remain");
  assert.equal(viewport[22].trim(), lineOf(49));
  assert.match(viewport[23], /^> /);
  const all = lines
    .map((line) => /transcript line (\d{3})/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  assert.deepEqual(all, Array.from({ length: 50 }, (_, n) => n), "every transcript line appears once, in order");
});

test("real renderer: keyboard input reaches settings dialog while focused, not the editor underneath", async (t) => {
  const s = await settingsScenario(t, 24);
  s.tui.getFocusedComponent()!.handleInput!("\x1b[B");
  s.tui.renderNow(); await s.terminal.flush();
  assert.equal(s.editor.getValue(), "", "input must not reach the editor while dialog is focused");
  assert.match(s.terminal.snapshot().lines.join("\n"), /❯ Skills · Max added per round/);
  s.dialog.handleInput("\x1b"); s.tui.renderNow();
  s.tui.getFocusedComponent()!.handleInput!("x");
  assert.equal(s.editor.getValue(), "x");
});

test("real renderer 80x24: Tab switches across Skills, Tools, Decision, Lab with active cell background and no brackets", async (t) => {
  const s = await settingsScenario(t, 24);
  const find = async (label: string) => {
    s.tui.renderNow(); await s.terminal.flush();
    const { lines, viewportTop } = s.terminal.snapshot();
    const row = lines.findIndex((line, i) => i >= viewportTop && /Skills\s+Tools\s+Decision\s+Lab/.test(line));
    assert.ok(row >= 0, `tab strip row missing:\n${lines.slice(viewportTop, viewportTop + 24).join("\n")}`);
    const col = lines[row].indexOf(label);
    return { row, col, mid: s.terminal.bgAt(row, col + 1) };
  };
  assert.equal((await find("Skills")).mid, 24);
  assert.equal((await find("Tools")).mid, undefined);
  s.tui.getFocusedComponent()!.handleInput!("\t");
  assert.equal((await find("Tools")).mid, 24);
  assert.equal((await find("Skills")).mid, undefined);
  s.tui.getFocusedComponent()!.handleInput!("\t");
  assert.equal((await find("Decision")).mid, 24);
  s.tui.getFocusedComponent()!.handleInput!("\t");
  assert.equal((await find("Lab")).mid, 24);
  assert.equal(s.editor.getValue(), "", "Tab must not reach editor underneath");
  assert.equal(s.tui.hasOverlay(), true);
});

test("real renderer 80x24: Tools tab renders dynamic MCP/exts labels when toolMode is mcp", async (t) => {
  const s = await settingsScenario(t, 24, { initialTab: "tools", initialOverrides: { toolMode: "mcp" } });
  const view = s.terminal.snapshot().lines.slice(s.terminal.snapshot().viewportTop, s.terminal.snapshot().viewportTop + 24).join("\n");
  assert.match(view, /MCP\/exts · Max added/);
  assert.match(view, /MCP\/exts · Minimum/);
});

test("real renderer 80x24: nested tool allowlist subroute (built-ins, collapsible groups, tri-state headers) fits overlay bounds", async (t) => {
  const names = ["note_add", "note_list", "docs_s", "docs_t", "loose_tool"];
  const s = await settingsScenario(t, 24, {
    initialTab: "tools",
    hooks: {
      openAllowlistSubroute: async (scope, _kind, params) => {
        const deps: Omit<AllowlistPickerDeps, "report" | "maxRows"> = {
          scope,
          noun: "tool",
          skills: names.map((name) => ({ name, description: `does ${name}`, scope, disableModelInvocation: false })),
          initial: ["note_add"],
          locationLabel: "Pi agent dir: pi-context-decisions/allowlists.json",
          scopeNote: "Built-in MCP scope: session-start config capture.",
          compactScopeNote: "MCP session scope; /reload config edits",
          async save() {},
          tree: {
            internal: [{ name: "read", description: "Read" }],
            groups: [
              { key: "mcp__docs", label: "docs", type: "mcp", description: "", tools: ["docs_s", "docs_t"] },
              { key: "ext__notes", label: "notes", type: "extension", description: "", tools: ["note_add", "note_list"] },
            ],
            initialGroups: ["mcp__docs"],
          },
        };
        return createAllowlistComponent(
          { requestRender: params.requestRender, terminal: (params.tui as { terminal?: { rows: number } }).terminal },
          params.theme as AllowlistTheme,
          (saved) => params.close({ saved }),
          { ...deps, maxRows: params.getMaxHeight, report() {} },
        );
      },
    },
  });
  const view = () => { const snap = s.terminal.snapshot(); return snap.lines.slice(snap.viewportTop, snap.viewportTop + 24); };
  const send = async (data: string) => { s.tui.getFocusedComponent()!.handleInput!(data); s.tui.renderNow(); await s.terminal.flush(); };
  // Navigate to Global always-allowed tools and open subroute
  for (let i = 0; i < 12 && !view().some((line) => /❯ Global always-allowed tools/.test(line)); i++) await send("\x1b[B");
  await send("\r");
  for (let n = 0; n < 40 && !view().some((line) => /Built-in tools/.test(line)); n++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    s.tui.renderNow(); await s.terminal.flush();
  }
  let text = view().join("\n");
  assert.match(text, /\[x\] ▸ Built-in tools \(1\)/);
  assert.match(text, /\[x\] ▸ docs/);
  assert.match(text, /\[-\] ▸ notes/);
  assert.ok(text.indexOf("Built-in tools") < text.indexOf("docs") && text.indexOf("docs") < text.indexOf("notes"));
  await send("\x1b[B");
  for (let n = 0; n < 2; n++) await send("\x1b[B"); // move to notes header
  await send("\r");
  text = view().join("\n");
  assert.match(text, /\[-\] ▾ notes/);
  assert.match(text, /\[x\] note_add/);
  assert.match(text, /\[ \] note_list/);
  for (const line of view()) assert.ok(line.length <= 80);
  assert.equal(s.tui.hasOverlay(), true);
});

for (const rows of [12, 24]) {
  test(`real renderer 80x${rows}: history overlay overview and scrollable details stay focused while transcript grows`, async () => {
    const history: DecisionsHistory = {
      turns: [{
        turn: 4,
        batches: [
          {
            turn: 4,
            answered: true,
            items: {
              skills: Array.from({ length: 119 }, (_, n) => `skill-${n}`),
              pinned: [], base: [], redelivered: [], tools: [], groups: [], noticeTools: [], noticeGroups: [],
            },
          },
          {
            turn: 7,
            answered: true,
            marks: { skills: new Map([["skill-119", "score 1.6 / ≥0.75"]]) },
            items: {
              skills: ["skill-119"],
              pinned: [], base: [], redelivered: [], tools: [], groups: [], noticeTools: [], noticeGroups: [],
            },
          },
        ],
      }],
    };
    const s = await historyScenario(rows, history);
    const view = () => { const snap = s.terminal.snapshot(); return snap.lines.slice(snap.viewportTop, snap.viewportTop + rows).join("\n"); };
    await new Promise((resolve) => setImmediate(resolve)); s.tui.renderNow(); await s.terminal.flush();
    assert.match(view(), /Turn 4: \(120 skills, 0 tools\/MCPs added\)/);
    assert.doesNotMatch(view(), /Turn 7/);
    s.tui.getFocusedComponent()!.handleInput!("\r"); s.tui.renderNow(); await s.terminal.flush();
    assert.match(view(), /Turn 4/);
    s.tui.getFocusedComponent()!.handleInput!("\x1b[F"); s.tui.renderNow(); await s.terminal.flush();
    assert.match(view(), /skill-119/);
    assert.match(view(), /Internal turn 7/);
    assert.match(view(), /skill-119  score 1\.6 \/ ≥0\.75/);
    const bounds = s.handle.getBounds()!;
    assert.ok(bounds.height <= dialogHeightBudget(rows));
    for (let n = 30; n < 50; n++) { s.append(n); s.tui.renderNow(); await s.terminal.flush(); }
    assert.match(view(), /skill-119/);
    assert.match(view(), /transcript line 049/);
    assert.equal(s.tui.getFocusedComponent(), s.dialog);
    assert.equal(s.editor.getValue(), "");
    s.dialog.close("closed"); s.tui.renderNow(); await s.terminal.flush();
    assert.doesNotMatch(view(), /Decisions|skill-119/);
    assert.equal(s.tui.getFocusedComponent(), s.editor);
  });
}
