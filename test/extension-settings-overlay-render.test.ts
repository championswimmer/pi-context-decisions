// Drives Pi's REAL main-screen renderer (TuiMainScreen) into a headless xterm while the transcript
// keeps growing underneath the floating settings dialog. This is a renderer-level test, not a
// visual terminal check: no human has looked at a real terminal in this suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as xtermModule from "@xterm/headless";
import { Container, Input, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { defaultSettings } from "../src/settings.ts";
import { dialogHeightBudget } from "../src/extension/settings-model.ts";
import { createSettingsDialogComponent, SETTINGS_OVERLAY_OPTIONS, type DialogResult, type InitialRoute, type SettingsDialogOps } from "../src/extension/settings-dialog.ts";

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
class Lines implements Component { lines: string[] = []; invalidate() {} render() { return this.lines; } }
const theme = { fg: (_token: unknown, value: string) => `\x1b[36m${value}\x1b[39m`, bg: (_token: unknown, value: string) => `\x1b[48;5;24m${value}\x1b[49m` } as Parameters<typeof createSettingsDialogComponent>[1];

function fakeOps(): SettingsDialogOps {
  const settings = defaultSettings();
  return {
    snapshot: () => ({ settings: structuredClone(settings), hasCwd: true }),
    async projectCount() { return { count: 2 }; }, async toggleEnabled() {}, async updateSetting() {},
    async listProviders() { return []; }, async listModels() { return []; }, async selectModel() { return { message: "ok" }; },
    async statusLines() { return ["status"]; }, async allowlist(scope) { return { scope, skills: [], initial: [], locationLabel: "x", async save() {} }; },
  };
}
async function scenario(rows: number, appendCount: number, initialRoute?: InitialRoute, ops: SettingsDialogOps = fakeOps()) {
  const terminal = new EmulatedTerminal(80, rows);
  const tui = new TuiMainScreen(terminal, false);
  const transcript = new Lines(); const editor = new Input({ prompt: "> " });
  const base = new Container(); base.addChild(transcript); base.addChild(editor); tui.addChild(base);
  tui.setFocus(editor);
  const append = (n: number) => { transcript.lines.push(`transcript line ${String(n).padStart(3, "0")}`); };
  for (let n = 0; n < 30; n++) append(n);
  tui.renderNow(); await terminal.flush();
  const results: DialogResult[] = [];
  let handle!: ReturnType<typeof tui.showOverlay>;
  const dialog = createSettingsDialogComponent(tui, theme, (result) => { results.push(result); tui.hideOverlay(); }, ops, { initialRoute });
  handle = tui.showOverlay(dialog, SETTINGS_OVERLAY_OPTIONS);
  tui.renderNow(); await terminal.flush();
  return { terminal, tui, transcript, editor, dialog, handle, results, append, appendCount };
}
const lineOf = (n: number) => `transcript line ${String(n).padStart(3, "0")}`;

for (const rows of [24, 12]) test(`real renderer ${80}x${rows}: the dialog stays put and focused while the transcript keeps scrolling underneath`, async () => {
  const s = await scenario(rows, 60);
  const budget = dialogHeightBudget(rows);
  const first = s.handle.getBounds()!;
  assert.ok(s.handle.isFocused()); assert.equal(s.tui.getFocusedComponent(), s.dialog);
  assert.equal(first.row, 1, "anchored to the top with a one-row margin"); assert.ok(first.height <= budget && first.height >= 1);
  const redrawsAfterOpen = s.tui.fullRedraws;
  for (let n = 30; n < 90; n++) {
    s.append(n); s.tui.renderNow(); await s.terminal.flush();
    const bounds = s.handle.getBounds()!;
    assert.deepEqual({ row: bounds.row, col: bounds.col, width: bounds.width, height: bounds.height }, { row: first.row, col: first.col, width: first.width, height: first.height }, `bounds moved at line ${n}`);
    assert.ok(s.handle.isFocused(), `focus lost at line ${n}`);
  }
  assert.equal(s.tui.fullRedraws, redrawsAfterOpen, "appending lines must not force full redraws");
  const { lines, viewportTop } = s.terminal.snapshot();
  const viewport = lines.slice(viewportTop, viewportTop + rows);
  // The dialog occupies the top of the viewport...
  assert.match(viewport[1], /╭─ Decisions/); assert.match(viewport[first.row + first.height - 1], /╰─/);
  assert.ok(viewport.slice(1, 1 + first.height).some((line) => /Always allowed · Global/.test(line)) || rows < 16, "dialog content is on screen");
  // ...while the newest output stays visible below it (the editor is the last row).
  assert.match(viewport[rows - 1], /^> /); assert.equal(viewport[rows - 2].trim(), lineOf(89));
  // Scrollback holds the transcript in order and no dialog remnants.
  const scrollback = lines.slice(0, viewportTop);
  const dialogChars = /[╭╮╰╯│]|Decisions ›|Always allowed|Context decisions|Advanced…/;
  for (const [index, line] of scrollback.entries()) assert.doesNotMatch(line, dialogChars, `dialog remnant in scrollback row ${index}: ${JSON.stringify(line)}`);
  const seen = scrollback.map((line) => /transcript line (\d{3})/.exec(line)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "scrollback transcript order");
  assert.equal(new Set(seen).size, seen.length, "no duplicated scrollback lines");
  assert.equal(seen[0], 0, "the transcript starts at the first line");
  // The newest lines are visible in the rows the dialog does not cover.
  const visibleBelow = viewport.slice(1 + first.height).map((line) => /transcript line (\d{3})/.exec(line)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  assert.ok(visibleBelow.includes(89), "the newest line is visible below the dialog");
  s.dialog.dispose();
});

test("real renderer: closing returns focus to the editor, removes every dialog row and keeps the transcript intact", async () => {
  const s = await scenario(24, 0);
  for (let n = 30; n < 50; n++) { s.append(n); s.tui.renderNow(); }
  await s.terminal.flush();
  s.dialog.close("closed"); s.tui.renderNow(); await s.terminal.flush();
  assert.deepEqual(s.results, ["closed"]); assert.equal(s.tui.getFocusedComponent(), s.editor); assert.equal(s.tui.hasOverlay(), false);
  const { lines, viewportTop } = s.terminal.snapshot(); const viewport = lines.slice(viewportTop, viewportTop + 24);
  assert.ok(viewport.every((line) => !/[╭╮╰╯│]|Decisions/.test(line)), "no dialog rows remain");
  assert.equal(viewport[22].trim(), lineOf(49)); assert.match(viewport[23], /^> /);
  const all = lines.map((line) => /transcript line (\d{3})/.exec(line)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  assert.deepEqual(all, Array.from({ length: 50 }, (_, n) => n), "every transcript line appears exactly once, in order");
});

test("real renderer: keyboard input reaches the dialog while it owns focus, not the editor underneath", async () => {
  const s = await scenario(24, 0);
  // Pi forwards stdin to the focused component; emulate that path.
  s.tui.getFocusedComponent()!.handleInput!("\x1b[B"); s.tui.getFocusedComponent()!.handleInput!("\x1b[B");
  s.tui.renderNow(); await s.terminal.flush();
  assert.equal(s.editor.getValue(), "", "typing must not reach the editor while the dialog is focused");
  const viewport = s.terminal.snapshot().lines.join("\n");
  assert.match(viewport, /❯ Always allowed · Global/);
  s.dialog.close("closed"); s.tui.renderNow();
  s.tui.getFocusedComponent()!.handleInput!("x"); assert.equal(s.editor.getValue(), "x");
});

test("real renderer 80x24: the Tools tab renders inside the overlay bounds", async () => {
  const s = await scenario(24, 0, "tools");
  const { lines, viewportTop } = s.terminal.snapshot();
  const viewport = lines.slice(viewportTop, viewportTop + 24);
  assert.ok(viewport.some((line) => /Decisions › Tools/.test(line)), viewport.join("\n"));
  assert.ok(viewport.some((line) => /Skills\s+Tools/.test(line)), "tab strip is visible");
  assert.ok(viewport.some((line) => /Tool filtering\s+Off/.test(line)));
  s.dialog.dispose();
});

test("real renderer 80x24: Tab through the focused overlay switches Skills ⇄ Tools inside the same overlay bounds", async () => {
  const s = await scenario(24, 0);
  const view = () => { const { lines, viewportTop } = s.terminal.snapshot(); return lines.slice(viewportTop, viewportTop + 24); };
  assert.ok(view().some((line) => /Skills\s+Tools/.test(line) && !/\[/.test(line)));
  s.tui.getFocusedComponent()!.handleInput!("\t"); s.tui.renderNow(); await s.terminal.flush();
  assert.ok(view().some((line) => /Skills\s+Tools/.test(line)) && view().some((line) => /Tool filtering\s+Off/.test(line)), view().join("\n"));
  assert.equal(s.editor.getValue(), "", "Tab must not reach the editor underneath"); assert.equal(s.tui.hasOverlay(), true);
  s.tui.getFocusedComponent()!.handleInput!("\x1b[Z"); s.tui.renderNow(); await s.terminal.flush();
  assert.ok(view().some((line) => /Skills\s+Tools/.test(line) && !/\[/.test(line)));
  s.dialog.dispose();
});

test("real renderer: the selected tab has a real cell background (not brackets) that follows Tab, and the other tab has none", async () => {
  const s = await scenario(24, 0);
  const find = async (label: string) => {
    s.tui.renderNow(); await s.terminal.flush();
    const { lines, viewportTop } = s.terminal.snapshot();
    const row = lines.findIndex((line, i) => i >= viewportTop && /Skills\s+Tools/.test(line));
    assert.ok(row >= 0, "tab strip row");
    assert.doesNotMatch(lines[row], /[\[\]]/);
    const col = lines[row].indexOf(label);
    return { row, col, mid: s.terminal.bgAt(row, col + 2), edgeLeft: s.terminal.bgAt(row, col - 1), edgeRight: s.terminal.bgAt(row, col + label.length) };
  };
  let skill = await find("Skills"), tool = await find("Tools");
  assert.equal(skill.mid, 24, "active tab label has the background"); assert.equal(skill.edgeLeft, 24, "padding is filled too"); assert.equal(skill.edgeRight, 24);
  assert.equal(tool.mid, undefined, "inactive tab has no background");
  s.tui.getFocusedComponent()!.handleInput!("\t");
  skill = await find("Skills"); tool = await find("Tools");
  assert.equal(tool.mid, 24); assert.equal(tool.edgeLeft, 24); assert.equal(tool.edgeRight, 24); assert.equal(skill.mid, undefined);
  s.dialog.dispose();
});

test("real renderer 80x24: the nested tool editor (built-ins, collapsible MCP and extension groups, tri-state headers) stays inside the overlay bounds", async () => {
  const names = ["note_add", "note_list", "docs_s", "docs_t", "loose_tool"];
  const ops: SettingsDialogOps = { ...fakeOps(), async toolAllowlist(_list, scope) {
    return { scope, noun: "tool", skills: names.map((name) => ({ name, description: `does ${name}`, scope, disableModelInvocation: false })), initial: ["note_add"], locationLabel: "x", async save() {},
      tree: { internal: [{ name: "read", description: "Read" }], groups: [
        { key: "mcp__docs", label: "docs", type: "mcp", description: "", tools: ["docs_s", "docs_t"] },
        { key: "ext__notes", label: "notes", type: "extension", description: "", tools: ["note_add", "note_list"] }], initialGroups: ["mcp__docs"] } };
  } };
  const s = await scenario(24, 0, { allowlist: "global", list: "tools" }, ops);
  const view = () => { const { lines, viewportTop } = s.terminal.snapshot(); return lines.slice(viewportTop, viewportTop + 24); };
  const send = async (data: string) => { s.tui.getFocusedComponent()!.handleInput!(data); s.tui.renderNow(); await s.terminal.flush(); };
  for (let n = 0; n < 40 && !view().some((line) => /Built-in tools/.test(line)); n++) { await new Promise((resolve) => setTimeout(resolve, 2)); s.tui.renderNow(); await s.terminal.flush(); }
  let text = view().join("\n");
  assert.match(text, /Always allowed tools · Global/); assert.match(text, /\[x\] ▸ Built-in tools \(1\)/); assert.match(text, /\[x\] ▸ docs/); assert.match(text, /\[-\] ▸ notes/);
  assert.ok(text.indexOf("Built-in tools") < text.indexOf("docs") && text.indexOf("docs") < text.indexOf("notes"));
  await send("\x1b[B"); for (let n = 0; n < 2; n++) await send("\x1b[B"); // list focus -> notes header
  await send("\r");
  text = view().join("\n");
  assert.match(text, /\[-\] ▾ notes/); assert.match(text, /\[x\] note_add/); assert.match(text, /\[ \] note_list/);
  const bounds = s.handle.getBounds()!;
  assert.ok(bounds.height <= dialogHeightBudget(24), `${bounds.height} rows exceed the budget`);
  for (const line of view()) assert.ok(line.length <= 80);
  assert.equal(s.tui.hasOverlay(), true); s.dialog.dispose();
});

for (const rows of [12, 24]) test(`real renderer 80x${rows}: history overview and scrollable details reuse the focused overlay while the transcript grows`, async () => {
  const ops: SettingsDialogOps = { ...fakeOps(), async history() { return { batches: [{ turn: 4, answered: true,
    items: { skills: Array.from({ length: 120 }, (_, n) => `skill-${n}`), pinned: [], base: [], redelivered: [], tools: [], groups: [], noticeTools: [], noticeGroups: [] } }] }; } };
  const s = await scenario(rows, 0, "history", ops);
  const view = () => { const { lines, viewportTop } = s.terminal.snapshot(); return lines.slice(viewportTop, viewportTop + rows).join("\n"); };
  await new Promise((resolve) => setImmediate(resolve)); s.tui.renderNow(); await s.terminal.flush();
  assert.match(view(), /Before turn 4/);
  s.tui.getFocusedComponent()!.handleInput!("\r"); s.tui.renderNow(); await s.terminal.flush();
  assert.match(view(), /Before turn 4/);
  s.tui.getFocusedComponent()!.handleInput!("\x1b[F"); s.tui.renderNow(); await s.terminal.flush();
  assert.match(view(), /skill-119/);
  const bounds = s.handle.getBounds()!;
  assert.ok(bounds.height <= dialogHeightBudget(rows));
  for (let n = 30; n < 50; n++) { s.append(n); s.tui.renderNow(); await s.terminal.flush(); }
  assert.match(view(), /skill-119/); assert.match(view(), /transcript line 049/);
  assert.equal(s.tui.getFocusedComponent(), s.dialog); assert.equal(s.editor.getValue(), "");
  s.dialog.close("closed"); s.tui.renderNow(); await s.terminal.flush();
  assert.doesNotMatch(view(), /Decisions|skill-119/); assert.equal(s.tui.getFocusedComponent(), s.editor);
});

test("real renderer: Advanced is a third peer tab with a selected background, shared backend rows and no feature toggle", async () => {
  const s = await scenario(24, 0);
  for (let i = 0; i < 2; i++) s.tui.getFocusedComponent()!.handleInput!("\t");
  s.tui.renderNow(); await s.terminal.flush();
  const { lines, viewportTop } = s.terminal.snapshot();
  const view = lines.slice(viewportTop, viewportTop + 24).join("\n");
  assert.match(view, /Decisions › Advanced/); assert.match(view, /Provider \/ execution/); assert.match(view, /Relevance threshold/);
  assert.doesNotMatch(view, /Skill filtering|Tool filtering/);
  const row = lines.findIndex((line, i) => i >= viewportTop && /Skills\s+Tools\s+Advanced/.test(line));
  assert.equal(s.terminal.bgAt(row, lines[row].indexOf("Advanced") + 2), 24);
  assert.equal(s.tui.hasOverlay(), true); assert.equal(s.tui.getFocusedComponent(), s.dialog);
  s.dialog.handleInput!("\x1b"); s.tui.renderNow(); await s.terminal.flush();
  assert.deepEqual(s.results, ["closed"]); assert.equal(s.tui.hasOverlay(), false);
});
