import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, ICON_STYLES, loadSettings, parseSettings, saveSettings, updateSetting } from "../src/settings.ts";
import { FOOTER_ICONS, skillFooter, toolFooter } from "../src/extension/footer-status.ts";
import type { LastDecision, LastToolDecision } from "../src/extension/contracts.ts";
import { extTool, mcpTool, toolSetup } from "./helpers/tool-fixture.ts";

const skillRound: LastDecision = { reason: "filtered", candidates: 28, kept: 5, advertised: 12, latencyMs: 230 };
const toolRound: LastToolDecision = { reason: "filtered", mode: "tools", trigger: "prompt", candidates: 120, kept: 18, available: 18, external: 120, withheld: 102, latencyMs: 180 };
function configured() {
  const settings = defaultSettings(); settings.backend = { backend: "typesafe", model: "jev-latest" }; settings.tools.enabled = true;
  return settings;
}
test("footer counts whole inventories, not remaining/new candidates; omits latency/cache/model text", () => {
  const settings = configured();
  assert.equal(skillFooter(settings, undefined, skillRound, 40), "◇ ≡ 12/40");
  assert.equal(skillFooter(settings, undefined, { ...skillRound, candidates: 0, kept: 0, cached: true }, 40), "◇ ≡ 12/40");
  assert.equal(toolFooter(settings, { supported: true, counts: { mode: "tools", available: 18, external: 120 }, last: toolRound }), "⚙ 18/120");
  settings.tools.mode = "mcp";
  assert.equal(toolFooter(settings, { supported: true, counts: { mode: "mcp", available: 3, external: 15 } }), "⚙ 3/15g");
  assert.equal(toolFooter(settings, { supported: true, counts: { mode: "tools", available: 18, external: 120 } }), "⚙ ready (g)", "a mode change never relabels stale tool counts as groups");
  assert.equal(skillFooter(settings, undefined, { ...skillRound, advertised: 0 }, 0), "◇ ≡ 0/0");
});
test("three icon styles use decision, knowledge and tool symbols consistently", () => {
  const settings = configured();
  assert.deepEqual(FOOTER_ICONS.nerd, { decisions: "\uf0b0", skills: "\uf02d", tools: "\uf0ad" }, "stick to classic Font Awesome glyphs instead of the missing scroll");
  const expected = ["◇ ≡ 12/40", "🎯 📚 12/40", "\uf0b0 \uf02d 12/40"];
  for (const [index, style] of ICON_STYLES.entries()) {
    settings.iconStyle = style;
    assert.equal(skillFooter(settings, undefined, skillRound, 40), expected[index]);
    assert.equal(toolFooter(settings, { supported: true, counts: { mode: "tools", available: 18, external: 120 } }), `${FOOTER_ICONS[style].tools} 18/120`);
  }
});
test("compact setup, disabled, ready and unsupported-host states", () => {
  const settings = configured();
  assert.equal(skillFooter(settings, undefined, undefined, 0), "◇ ≡ ready");
  assert.equal(toolFooter(settings, { supported: true }), "⚙ ready");
  assert.equal(toolFooter(settings, { supported: false }), "⚙ !host");
  settings.backend = null;
  assert.equal(skillFooter(settings, undefined, skillRound, 40), "◇ setup");
  assert.equal(toolFooter(settings, { supported: true }), "⚙ setup");
  settings.relevance.enabled = false;
  assert.equal(skillFooter(settings, undefined, skillRound, 40), "◇ ≡ off");
  assert.equal(toolFooter(settings, { supported: true }), "⚙ setup", "independent opt-in");
  settings.tools.enabled = false;
  assert.equal(toolFooter(settings, { supported: true }), undefined);
  settings.enabled = false;
  assert.equal(skillFooter(settings, undefined, skillRound, 40), "◇ off");
  assert.equal(toolFooter(settings, { supported: false }), undefined);
});
test("failure states remain explicit, safe and bounded", () => {
  const settings = configured();
  assert.equal(skillFooter(settings, "private settings error", skillRound, 40), "◇ !config");
  assert.equal(toolFooter(settings, { supported: true, settingsError: "private settings error" }), "⚙ !config");
  assert.equal(skillFooter(settings, undefined, { ...skillRound, reason: "fail-closed", errorCode: "timeout" }, 40), "◇ ≡ 12/40 !timeout");
  assert.equal(skillFooter(settings, undefined, { ...skillRound, reason: "fail-open", errorCode: "timeout" }, 40), "◇ ≡ 12/40 !open");
  assert.equal(skillFooter(settings, undefined, { ...skillRound, reason: "fail-closed", errorCode: "private\n\u001b[31m" }, 40), "◇ ≡ 12/40 !error");
  assert.equal(toolFooter(settings, { supported: true, counts: { mode: "tools", available: 18, external: 120 }, last: { ...toolRound, reason: "fail-closed", errorCode: "timeout" } }), "⚙ 18/120 !timeout");
  assert.equal(toolFooter(settings, { supported: true, counts: { mode: "tools", available: 18, external: 120 }, last: { ...toolRound, reason: "fail-open" } }), "⚙ 18/120 !open");
});
test("icon style defaults compatibly, validates, updates and persists without changing picker settings", async (t) => {
  assert.equal(parseSettings({}).iconStyle, "unicode");
  for (const invalid of [null, "ascii", "unknown", true, 1, {}, "emoji\n"]) assert.throws(() => parseSettings({ iconStyle: invalid }), /iconStyle/);
  const dir = await mkdtemp(join(tmpdir(), "decisions-footer-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json"); const initial = configured();
  for (const style of ICON_STYLES) {
    const next = updateSetting(initial, "iconStyle", style);
    assert.deepEqual(next, { ...initial, iconStyle: style });
    await saveSettings(next, path);
    const loaded = await loadSettings(path);
    assert.equal(loaded.error, undefined); assert.deepEqual(loaded.warnings, []); assert.deepEqual(loaded.settings, next);
  }
});

test("real runtime hooks wire compact tool/group counts and never write the opt-in entry while off", async (t) => {
  for (const mode of ["tools", "mcp"] as const) {
    const h = await toolSetup(t, { settings: { iconStyle: "emoji" }, tools: { mode }, extra: [extTool("one"), mcpTool("docs", "a"), mcpTool("docs", "b")], scores: { one: 2, ext__one: 2 } });
    const statuses = new Map<string, string | undefined>();
    h.ctx.hasUI = true; h.ctx.ui.setStatus = (key, value) => { statuses.set(key, value); };
    await h.start("use one");
    assert.equal(statuses.get("context-decisions"), "🎯 📚 off");
    assert.equal(statuses.get("context-decisions-tools"), mode === "tools" ? "🔧 1/3" : "🔧 1/2g");
    await h.command("status");
    assert.match(h.messages.at(-1)!, /available/);
  }
  const off = await toolSetup(t, { tools: { enabled: false }, extra: [extTool("one")] });
  const keys: string[] = []; off.ctx.hasUI = true; off.ctx.ui.setStatus = (key) => { keys.push(key); };
  await off.start("task");
  assert.ok(!keys.includes("context-decisions-tools"));
});
