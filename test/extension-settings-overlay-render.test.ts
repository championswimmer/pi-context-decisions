// Drives Pi's REAL main-screen renderer (TuiMainScreen) into a headless xterm while the transcript
// keeps growing underneath the floating settings dialog. This is a renderer-level test, not a
// visual terminal check: no human has looked at a real terminal in this suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as xtermModule from "@xterm/headless";
import { Container, Input, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { defaultSettings } from "../src/settings.ts";
import { dialogHeightBudget } from "../src/extension/settings-model.ts";
import { createSettingsDialogComponent, SETTINGS_OVERLAY_OPTIONS, type DialogResult, type SettingsDialogOps } from "../src/extension/settings-dialog.ts";

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
  /** Every buffer line (scrollback first, then the visible viewport) and the viewport offset. */
  snapshot() {
    const buffer = this.xterm.buffer.active; const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return { lines, viewportTop: buffer.baseY };
  }
}
class Lines implements Component { lines: string[] = []; invalidate() {} render() { return this.lines; } }
const theme = { fg: (_token: unknown, value: string) => `\x1b[36m${value}\x1b[39m`, bg: (_token: unknown, value: string) => value } as Parameters<typeof createSettingsDialogComponent>[1];

function fakeOps(): SettingsDialogOps {
  const settings = defaultSettings();
  return {
    snapshot: () => ({ settings: structuredClone(settings), hasCwd: true }),
    async projectCount() { return { count: 2 }; }, async toggleEnabled() {}, async updateSetting() {},
    async listProviders() { return []; }, async listModels() { return []; }, async selectModel() { return { message: "ok" }; },
    async statusLines() { return ["status"]; }, async allowlist(scope) { return { scope, skills: [], initial: [], locationLabel: "x", async save() {} }; },
  };
}
async function scenario(rows: number, appendCount: number) {
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
  const dialog = createSettingsDialogComponent(tui, theme, (result) => { results.push(result); tui.hideOverlay(); }, fakeOps());
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
  assert.match(viewport, /❯ Model/);
  s.dialog.close("closed"); s.tui.renderNow();
  s.tui.getFocusedComponent()!.handleInput!("x"); assert.equal(s.editor.getValue(), "x");
});
