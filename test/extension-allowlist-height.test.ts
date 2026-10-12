import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAllowlistComponent, type AllowlistTheme } from "../src/extension/allowlist-picker.ts";
const theme: AllowlistTheme = { fg: (_token, value) => value, bg: (_token, value) => value };
const keys = { down: "\x1b[B", up: "\x1b[A", enter: "\r" };
function fixture(rows: number) {
  const terminal = { rows };
  const component = createAllowlistComponent({ terminal, requestRender() {} }, theme, () => {}, {
    scope: "global", skills: Array.from({ length: 30 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "漢字 😀 Long description for expanded skill navigation and stable focus visibility. ".repeat(10), scope: "global" as const, disableModelInvocation: false })),
    initial: [], locationLabel: "settings.json", rankLabel: "fixture provider · explicit paid call", async save() {}, report() {},
  });
  component.focused = true;
  return { terminal, component };
}
function visible(f: ReturnType<typeof fixture>, width: number, selected: number) {
  const height = Math.max(1, Math.floor(f.terminal.rows * 0.8));
  const lines = f.component.render(width);
  // Match Pi's overlay renderer: anything after maxHeight is discarded.
  const clipped = lines.slice(0, height).join("\n");
  assert.ok(lines.length <= height, `${lines.length} rendered lines exceed ${height}-row overlay`);
  assert.match(clipped, new RegExp(`❯ \\[ \\] skill-${String(selected).padStart(2, "0")}`));
  assert.match(clipped, /Search:/); assert.match(clipped, /Ctrl\+S save/);
  for (const line of lines) assert.ok(visibleWidth(line) <= width);
}
test("80x24 overlay keeps selected rows/footer visible with expanded descriptions while scrolling", () => {
  const f = fixture(24); f.component.handleInput!(keys.down);
  for (let i = 0; i < 20; i++) {
    f.component.handleInput!(keys.enter); // Expand the currently selected row.
    visible(f, 80, i);
    f.component.handleInput!(keys.down);
  }
  for (let i = 19; i >= 1; i--) { f.component.handleInput!(keys.up); visible(f, 80, i); }
  f.component.dispose();
});
test("short/resized terminals reserve search and save help at 40/80/120 columns", () => {
  const f = fixture(24); f.component.handleInput!(keys.down);
  for (let i = 0; i < 15; i++) f.component.handleInput!(keys.down);
  f.component.handleInput!(keys.enter);
  for (const rows of [24, 16, 12, 10, 8, 24]) {
    f.terminal.rows = rows;
    for (const width of [40, 80, 120]) visible(f, width, 15);
  }
  f.component.dispose();
});
