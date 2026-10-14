import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { ScopedSkill } from "../src/apps/allowlist.ts";
import type { RelevanceItem } from "../src/apps/relevance.ts";
import { defaultSettings, SettingsError, updateSetting, type ContextDecisionsSettings } from "../src/settings.ts";
import { dialogHeightBudget } from "../src/extension/settings-model.ts";
import {
  createSettingsDialogComponent, createSettingsDialogManager, type DialogResult, type InitialRoute, type ModelRow, type ProviderRow, type SettingsDialogOps,
} from "../src/extension/settings-dialog.ts";
import type { AllowlistPickerDeps } from "../src/extension/allowlist-picker.ts";

const KEY = { tab: "\t", shiftTab: "\x1b[Z", left: "\x1b[D", right: "\x1b[C", down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", space: " ", backspace: "\x7f", save: "\x13", rank: "\x12", pageDown: "\x1b[6~" };
const theme = { fg: (_token: unknown, value: string) => value, bg: (_token: unknown, value: string) => value } as Parameters<typeof createSettingsDialogComponent>[1];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const skill = (name: string, description = "Fixture description"): ScopedSkill => ({ name, description, scope: "global", disableModelInvocation: false });
const item = (name: string, score: number): RelevanceItem => ({ name, score, normalized: score / 2 });

interface OpsFixture {
  ops: SettingsDialogOps;
  settings: ContextDecisionsSettings;
  calls: string[];
  signals: Record<string, AbortSignal[]>;
  state: { hasCwd: boolean; settingsError?: string };
}
function fakeOps(over: Partial<SettingsDialogOps> = {}, init: { hasCwd?: boolean } = {}): OpsFixture {
  const settings = defaultSettings();
  const calls: string[] = [];
  const signals: Record<string, AbortSignal[]> = {};
  const state = { hasCwd: init.hasCwd ?? true, settingsError: undefined as string | undefined };
  const record = (name: string, signal?: AbortSignal) => { calls.push(name); if (signal) (signals[name] ??= []).push(signal); };
  const ops: SettingsDialogOps = {
    snapshot: () => ({ settings: structuredClone(settings), hasCwd: state.hasCwd, ...(state.settingsError ? { settingsError: state.settingsError } : {}) }),
    async projectCount(signal) { record("projectCount", signal); return { count: 3 }; },
    async toggleEnabled() { record("toggleEnabled"); settings.enabled = !settings.enabled; },
    async updateSetting(key, text) { record(`updateSetting:${key}=${text}`); Object.assign(settings, updateSetting(settings, key, text)); },
    async listProviders(signal) { record("listProviders", signal); return providers(); },
    async listModels(filter, signal) { record(`listModels:${filter?.backend ?? "all"}`, signal); return models(); },
    async selectModel(selection, signal) { record("selectModel", signal); settings.backend = selection as ContextDecisionsSettings["backend"]; return { message: "Decision model saved" }; },
    async statusLines(signal) { record("statusLines", signal); return ["Context decisions: enabled", "Credentials: environment"]; },
    async allowlist(scope, signal) { record(`allowlist:${scope}`, signal); return allowlistDeps(scope); },
    ...over,
  };
  return { ops, settings, calls, signals, state };
}
const providers = (): ProviderRow[] => [
  { id: "typesafe", backend: "typesafe", provider: "typesafe", label: "typesafe · direct API", status: "ok" },
  { id: "openai", backend: "openai", provider: "openai", label: "openai · direct API", status: "missing", guide: "openai credentials are missing or unavailable. Set OPENAI_API_KEY in the environment or configure /login openai in Pi." },
];
const models = (): ModelRow[] => [
  { id: "a", label: "jev-latest · TypeSafe direct", selection: { backend: "typesafe", model: "jev-latest" }, status: "ok" },
  { id: "b", label: "gpt-6-luna · OpenAI direct", selection: { backend: "openai", model: "gpt-6-luna" }, status: "missing", guide: "Set OPENAI_API_KEY or configure /login openai." },
  { id: "none", label: "None (no decision calls)", selection: null, status: "none" },
];
function allowlistDeps(scope: "global" | "project", extra: Partial<AllowlistPickerDeps> = {}): Omit<AllowlistPickerDeps, "report" | "maxRows"> {
  return { scope, skills: Array.from({ length: 12 }, (_, n) => skill(`skill-${String(n).padStart(2, "0")}`)), initial: [], locationLabel: "settings.json", async save() {}, ...extra };
}

function mount(fixture: OpsFixture, options: { rows?: number; initialRoute?: InitialRoute } = {}) {
  const results: DialogResult[] = [];
  let renders = 0;
  const tui = { requestRender() { renders++; }, terminal: { rows: options.rows ?? 40 } };
  const closedHooks: number[] = [];
  const component = createSettingsDialogComponent(tui, theme, (result) => results.push(result), fixture.ops, {
    initialRoute: options.initialRoute, onClose: () => closedHooks.push(1),
  });
  component.focused = true;
  const press = (...data: string[]) => { for (const key of data) component.handleInput!(key); };
  const text = (width = 100) => component.render(width).join("\n");
  const until = async (pattern: RegExp, width = 100) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const rendered = text(width);
      if (pattern.test(rendered)) return rendered;
      if (Date.now() > deadline) assert.fail(`Timed out waiting for ${pattern}; last render:\n${rendered}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  return { component, results, press, text, until, tui, get renders() { return renders; }, closedHooks };
}
/** Skill picker rows: 0 toggle, 1 provider, 2 model, 3 global, 4 project, 5 advanced, 6 status, 7 close. */
const toRow = (h: ReturnType<typeof mount>, row: number) => { h.press(...Array(row).fill(KEY.down)); };

test("Skill picker tab shows exactly the eight concise rows; relevance knobs and the nested Tools & MCP entry are not on it", async () => {
  const f = fakeOps(); const h = mount(f); await h.until(/Always allowed · Project\s+3/);
  const labels = ["Context decisions", "Provider / execution", "Model", "Always allowed · Global", "Always allowed · Project", "Advanced…", "Status…", "Close"];
  const text = h.text(100); let at = -1;
  for (const label of labels) { const next = text.indexOf(label); assert.ok(next > at, `${label} out of order or missing`); at = next; }
  assert.doesNotMatch(text, /threshold|Batch size|Concurrency|Timeout|On failure|Scoring mode|Tools & MCP/i);
  assert.match(text, /Skill picker\s+Tool picker/, "the tab strip lists both tabs"); assert.doesNotMatch(text, /\[ (Skill|Tool) picker \]/, "no bracket selectors");
  assert.equal(h.results.length, 0); h.component.dispose();
});

test("the description yields to the list: all eight rows plus the tab strip incl. Close fit a 16-row terminal; tiny heights keep the selected row", () => {
  const f = fakeOps(); const h = mount(f, { rows: 16 });
  const text = h.text(100); assert.match(text, /Status…/); assert.match(text, /Close/);
  assert.ok(h.component.render(100).length <= dialogHeightBudget(16));
  assert.doesNotMatch(text, /Immediately enables or disables/, "with every row visible and no spare line, the description yields completely");
  assert.match(mount(fakeOps(), { rows: 18 }).text(100), /Immediately enables or disables/, "a one-line description fits when a line is spare");
  const small = mount(fakeOps(), { rows: 8 }); small.press(...Array(8).fill(KEY.down));
  assert.match(small.text(100), /❯ Close/); assert.ok(small.component.render(100).length <= dialogHeightBudget(8));
  h.component.dispose(); small.component.dispose();
});

test("toggle calls the save once even if Enter repeats; display changes only after the refreshed snapshot", async () => {
  const gate = deferred<void>(); let calls = 0;
  const f = fakeOps();
  f.ops.toggleEnabled = async () => { calls++; await gate.promise; f.settings.enabled = !f.settings.enabled; };
  const h = mount(f); await h.until(/Context decisions\s+On/);
  h.press(KEY.enter, KEY.enter, KEY.space);
  assert.equal(calls, 1); assert.match(h.text(), /saving…/); assert.match(h.text(), /Context decisions\s+On/, "no optimistic flip");
  gate.resolve(); await tick();
  assert.match(h.text(), /Context decisions\s+Off/); assert.match(h.text(), /Context decisions disabled/); assert.doesNotMatch(h.text(), /saving…/);
  assert.equal(h.results.length, 0, "a save never closes the dialog"); h.component.dispose();
});

test("a failed toggle shows a sanitized inline error and leaves the old value", async () => {
  const f = fakeOps(); f.ops.toggleEnabled = async () => { throw new Error("PRIVATE_PROVIDER_BODY"); };
  const h = mount(f); await h.until(/Always allowed · Project\s+3/);
  h.press(KEY.enter); await tick();
  assert.match(h.text(), /Context-decisions operation failed/); assert.doesNotMatch(h.text(), /PRIVATE_PROVIDER_BODY/);
  assert.match(h.text(), /Context decisions\s+On/); h.component.dispose();
});

test("provider route: leaving before the load resolves aborts it, and a late result cannot render or call ops", async () => {
  const late = deferred<ProviderRow[]>();
  const f = fakeOps({ listProviders: async (signal) => { f.calls.push("listProviders"); (f.signals.listProviders ??= []).push(signal); return late.promise; } });
  const h = mount(f); await h.until(/Always allowed · Project\s+3/); toRow(h, 1); h.press(KEY.enter);
  assert.match(h.text(), /Decisions › Provider/); assert.match(h.text(), /checking…/); assert.match(h.text(), /Checking credentials…/);
  h.press(KEY.esc);
  assert.match(h.text(), /Decisions\s/); assert.doesNotMatch(h.text(), /Decisions › Provider/);
  assert.equal(f.signals.listProviders[0].aborted, true);
  const renders = h.renders, calls = f.calls.length;
  late.resolve(providers()); await tick();
  assert.equal(h.renders, renders); assert.equal(f.calls.length, calls); assert.doesNotMatch(h.text(), /typesafe · direct API/);
  h.component.dispose();
});

test("a provider without a key shows the exact guide and never selects, persists or loads models", async () => {
  const f = fakeOps(); const h = mount(f); toRow(h, 1); h.press(KEY.enter); await h.until(/typesafe · direct API\s+configured/);
  assert.match(h.text(), /openai · direct API\s+missing key/);
  h.press(KEY.down, KEY.enter);
  const text = h.text(); assert.match(text, /OPENAI_API_KEY/); assert.match(text, /\/login openai/); assert.match(text, /Decisions › Provider/);
  assert.ok(!f.calls.some((call) => call.startsWith("listModels") || call === "selectModel")); assert.equal(f.settings.backend, null);
  h.component.dispose();
});

test("model success pops to main with a banner and never toggles the enabled switch", async () => {
  const f = fakeOps(); f.settings.enabled = false; const h = mount(f);
  toRow(h, 1); h.press(KEY.enter); await h.until(/typesafe · direct API/); h.press(KEY.enter);
  await h.until(/Decisions › Model/); await h.until(/jev-latest · TypeSafe direct/);
  assert.ok(f.calls.includes("listModels:typesafe"));
  h.press(KEY.enter); await tick();
  assert.deepEqual(f.settings.backend, { backend: "typesafe", model: "jev-latest" });
  assert.match(h.text(), /Decision model saved/); assert.doesNotMatch(h.text(), /Decisions › (?!Skill picker)/);
  assert.equal(f.settings.enabled, false); assert.ok(!f.calls.includes("toggleEnabled")); h.component.dispose();
});

test("model failure and a missing-key model both stay on the route", async () => {
  const f = fakeOps(); f.ops.selectModel = async () => { f.calls.push("selectModel"); throw new SettingsError("Selected Pi classifier is not registered"); };
  const h = mount(f, { initialRoute: "model" }); await h.until(/jev-latest · TypeSafe direct/);
  h.press(KEY.down, KEY.enter); assert.match(h.text(), /OPENAI_API_KEY/); assert.ok(!f.calls.includes("selectModel"));
  h.press(KEY.up, KEY.enter); await tick();
  assert.match(h.text(), /Selected Pi classifier is not registered/); assert.match(h.text(), /Decisions › Model/);
  h.press(KEY.esc); assert.doesNotMatch(h.text(), /Decisions › Model/); h.component.dispose();
});

test("None clears the model through selectModel(null)", async () => {
  const f = fakeOps(); f.settings.backend = { backend: "typesafe", model: "jev-latest" };
  const h = mount(f, { initialRoute: "model" }); await h.until(/None \(no decision calls\)/);
  h.press(KEY.down, KEY.down, KEY.enter); await tick(); assert.equal(f.settings.backend, null); h.component.dispose();
});

test("Advanced lists every knob, edit is prefilled, invalid values stay inline and Esc saves nothing", async () => {
  const f = fakeOps(); const h = mount(f); toRow(h, 5); h.press(KEY.enter);
  assert.match(h.text(), /Decisions › Advanced/);
  for (const label of ["Skill filtering", "Relevance threshold", "Shard size", "Max added per round", "Run picker", "On failure", "Timeout", "Concurrency", "Minimum inventory", "Prompt size", "Description size"]) {
    // Not every row fits at once: scroll through and gather.
    const seen = new Set<string>();
    for (let i = 0; i < 14; i++) { if (h.text().includes(label)) seen.add(label); h.press(KEY.down); }
    assert.ok(seen.has(label), `${label} missing from Advanced`);
  }
  h.press(...Array(20).fill(KEY.up)); h.press(...Array(2).fill(KEY.down)); // → Shard size
  h.press(KEY.enter); assert.match(h.text(), /Value: 50/);
  h.press(KEY.backspace, KEY.backspace, ..."999"); h.press(KEY.enter); await tick();
  assert.deepEqual(f.calls.filter((call) => call.startsWith("updateSetting")), ["updateSetting:relevance.chunkSize=999"]);
  assert.match(h.text(), /integer in \[1, 50\]/); assert.match(h.text(), /Value: 999/, "the text is kept after a failed save");
  h.press(KEY.esc); assert.match(h.text(), /Decisions › Advanced/); assert.doesNotMatch(h.text(), /Value:/);
  assert.equal(f.calls.filter((call) => call.startsWith("updateSetting")).length, 1);
  h.component.dispose();
});

test("a valid edit saves once and returns to Advanced with a Saved banner", async () => {
  const f = fakeOps(); const h = mount(f, { initialRoute: "advanced" });
  h.press(...Array(2).fill(KEY.down), KEY.enter); h.press(KEY.backspace, KEY.backspace, "2", "5"); h.press(KEY.enter); await tick();
  assert.equal(f.settings.relevance.chunkSize, 25); assert.match(h.text(), /Saved/); assert.match(h.text(), /Shard size\s+25/); h.component.dispose();
});

test("Advanced shows the four picking controls first; threshold edit and Run picker options persist through the shared path", async () => {
  const f = fakeOps(); const h = mount(f, { initialRoute: "advanced" });
  assert.match(h.text(100), /Skill filtering\s+On/);
  h.press(KEY.down); assert.match(h.text(100), /Relevance threshold\s+0\.375/);
  h.press(KEY.enter); assert.match(h.text(), /Value: 0\.375/);
  h.press(...Array(5).fill(KEY.backspace), ..."0.5"); h.press(KEY.enter); await tick();
  assert.equal(f.settings.relevance.threshold, 0.5); assert.match(h.text(100), /Relevance threshold\s+0\.5/);
  h.press(KEY.down, KEY.down); assert.match(h.text(100), /Max added per round\s+12/);
  h.press(KEY.down); assert.match(h.text(100), /Run picker\s+prompt/);
  h.press(KEY.enter); assert.match(h.text(100), /Decisions › Advanced › Run picker/);
  assert.match(h.text(100), /prompt\s+current/);
  h.press(KEY.down); assert.match(h.text(100).replace(/\s*│\s*\n│\s*/g, " "), /No tool names, arguments or results are sent/);
  h.press(KEY.enter); await tick();
  assert.equal(f.settings.relevance.cadence, "tool-round"); assert.match(h.text(100), /Run picker\s+tool-round/);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("updateSetting")), ["updateSetting:relevance.threshold=0.5", "updateSetting:relevance.cadence=tool-round"]);
  assert.doesNotMatch(h.text(100), /Scoring mode|Related threshold|Direct threshold|Minimum relevance/);
  h.component.dispose();
});

/** updateSetting that applies the change only when the gate opens (a deferred persistence). */
function gatedSaves() {
  const gates: { key: string; text: string; release(): void }[] = [];
  const f = fakeOps();
  f.ops.updateSetting = (key, text) => new Promise<void>((resolve, reject) => {
    f.calls.push(`updateSetting:${key}=${text}`);
    gates.push({ key, text, release: () => { try { Object.assign(f.settings, updateSetting(f.settings, key, text)); resolve(); } catch (error) { reject(error); } } });
  });
  return { f, gates };
}
const toBatchSizeEditor = (h: ReturnType<typeof mount>) => h.press(...Array(2).fill(KEY.down), KEY.enter);
const typeValue = (h: ReturnType<typeof mount>, text: string) => h.press(KEY.backspace, KEY.backspace, ...text);

test("a deferred edit save resolving after Esc×2 to Main does not close the dialog; the snapshot still refreshes", async () => {
  const { f, gates } = gatedSaves(); const h = mount(f, { initialRoute: "advanced" });
  toBatchSizeEditor(h); typeValue(h, "25"); h.press(KEY.enter);
  assert.equal(gates.length, 1); assert.match(h.text(), /saving…/);
  h.press(KEY.esc, KEY.esc); // edit → advanced → main, save still pending
  assert.match(h.text(), /Always allowed · Global/); assert.doesNotMatch(h.text(), /Decisions › (?!Skill picker)/);
  gates[0].release(); await tick();
  assert.deepEqual(h.results, [], "a late save must not close the dialog"); assert.equal(h.closedHooks.length, 0);
  assert.match(h.text(), /Always allowed · Global/); assert.doesNotMatch(h.text(), /saving…/);
  h.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
  assert.match(h.text(), /Decisions › Advanced/); assert.match(h.text(), /Shard size\s+25/, "persisted value shows after the refresh");
  h.component.dispose();
});

test("a deferred save resolving while the user edits ANOTHER field neither pops that editor nor drops its draft", async () => {
  const { f, gates } = gatedSaves(); const h = mount(f, { initialRoute: "advanced" });
  toBatchSizeEditor(h); typeValue(h, "25"); h.press(KEY.enter);
  h.press(KEY.esc); // back to advanced; the save is still in flight
  h.press(KEY.down, KEY.enter); // Max added per round editor (row after Shard size)
  assert.match(h.text(), /Decisions › Advanced › Max added per round/); h.press(KEY.backspace, KEY.backspace, "4", "2");
  gates[0].release(); await tick();
  const text = h.text();
  assert.match(text, /Decisions › Advanced › Max added per round/, "the newer editor stays open");
  assert.match(text, /Value: 42/, "its draft is preserved"); assert.deepEqual(h.results, []);
  assert.equal(f.settings.relevance.chunkSize, 25, "the save still persisted");
  h.press(KEY.enter); assert.equal(gates.length, 2, "the new editor can save once the first finished");
  h.component.dispose();
});

test("a deferred save whose origin editor is still current returns to Advanced with Saved", async () => {
  const { f, gates } = gatedSaves(); const h = mount(f, { initialRoute: "advanced" });
  toBatchSizeEditor(h); typeValue(h, "25"); h.press(KEY.enter);
  assert.match(h.text(), /Value: 25/); gates[0].release(); await tick();
  assert.match(h.text(), /Decisions › Advanced/); assert.doesNotMatch(h.text(), /Value:/); assert.match(h.text(), /Saved/);
  assert.match(h.text(), /Shard size\s+25/); assert.deepEqual(h.results, []); h.component.dispose();
});

test("a deferred options save after leaving the options route does not pop whatever screen is now open", async () => {
  const { f, gates } = gatedSaves(); const h = mount(f, { initialRoute: "advanced" });
  h.press(...Array(5).fill(KEY.down), KEY.enter, KEY.down, KEY.enter); // On failure → open (pending)
  assert.equal(gates[0].text, "open");
  h.press(KEY.esc); assert.match(h.text(), /Decisions › Advanced/); h.press(KEY.down, KEY.enter); // Timeout editor
  assert.match(h.text(), /Decisions › Advanced › Timeout/);
  gates[0].release(); await tick();
  assert.match(h.text(), /Decisions › Advanced › Timeout/); assert.equal(f.settings.relevance.failMode, "open"); assert.deepEqual(h.results, []);
  h.component.dispose();
});

test("a deferred model save resolving after the user left the model screen does not rewind to Main", async () => {
  const gate = deferred<{ message: string }>(); const f = fakeOps(); let selected = 0;
  f.ops.selectModel = (selection) => { selected++; f.settings.backend = selection as ContextDecisionsSettings["backend"]; return gate.promise; };
  const h = mount(f); toRow(h, 1); h.press(KEY.enter); await h.until(/typesafe · direct API/); h.press(KEY.enter);
  await h.until(/jev-latest · TypeSafe direct/); h.press(KEY.enter); assert.equal(selected, 1);
  h.press(KEY.esc); assert.match(h.text(), /Decisions › Provider/); // back on the provider screen
  gate.resolve({ message: "Decision model saved" }); await tick();
  assert.match(h.text(), /Decisions › Provider/, "late success must not unwind to Main"); assert.deepEqual(h.results, []);
  h.press(KEY.esc); assert.doesNotMatch(h.text(), /Decisions › (?!Skill picker)/); assert.deepEqual(f.settings.backend, { backend: "typesafe", model: "jev-latest" });
  h.component.dispose();
});

test("a deferred save that FAILS after navigation shows no stale banner on the new screen and never closes", async () => {
  const { f, gates } = gatedSaves(); const h = mount(f, { initialRoute: "advanced" });
  toBatchSizeEditor(h); typeValue(h, "999"); h.press(KEY.enter); h.press(KEY.esc, KEY.esc);
  gates[0].release(); await tick();
  assert.deepEqual(h.results, []); assert.doesNotMatch(h.text(), /integer in/); assert.match(h.text(), /Always allowed · Global/);
  h.component.dispose();
});

test("closing with an edit save pending: the save still finishes, nothing renders or closes twice", async () => {
  const { f, gates } = gatedSaves(); const h = mount(f, { initialRoute: "advanced" });
  toBatchSizeEditor(h); typeValue(h, "25"); h.press(KEY.enter);
  h.component.close("closed"); const renders = h.renders, calls = f.calls.length;
  gates[0].release(); await tick();
  assert.equal(f.settings.relevance.chunkSize, 25, "saves are not cancelled"); assert.equal(h.renders, renders);
  assert.equal(f.calls.length, calls); assert.deepEqual(h.results, ["closed"]);
});

test("boolean knobs toggle in place; concurrency 0 explains all-parallel", async () => {
  const f = fakeOps(); const h = mount(f, { initialRoute: "advanced" });
  assert.match(h.text(), /Skill filtering\s+On/); h.press(KEY.space); await tick();
  assert.equal(f.settings.relevance.enabled, false); assert.match(h.text(), /Skill filtering\s+Off/);
  h.press(...Array(7).fill(KEY.down)); assert.match(h.text(), /Concurrency\s+0 \(all shards parallel\)/); h.component.dispose();
});

test("fail-open is reachable only by explicitly choosing it, never by cycling or a default row", async () => {
  const f = fakeOps(); const h = mount(f, { initialRoute: "advanced" });
  h.press(...Array(5).fill(KEY.down), KEY.enter); assert.match(h.text(), /Decisions › Advanced › On failure/);
  assert.match(h.text(), /closed\s+current/); assert.match(h.text(), /open/);
  h.press(KEY.down); assert.match(h.text(), /WARNING/); h.press(KEY.up, KEY.space); assert.deepEqual(f.calls.filter((call) => call.startsWith("updateSetting")), [], "Space does not cycle an option");
  h.press(KEY.enter); await tick();
  assert.deepEqual(f.calls.filter((call) => call.startsWith("updateSetting")), ["updateSetting:relevance.failMode=closed"]);
  assert.equal(f.settings.relevance.failMode, "closed"); h.component.dispose();
  const g = fakeOps(); const k = mount(g, { initialRoute: "advanced" });
  k.press(...Array(5).fill(KEY.down), KEY.enter, KEY.down, KEY.enter); await tick();
  assert.equal(g.settings.relevance.failMode, "open"); assert.match(k.text(), /On failure\s+open/); k.component.dispose();
});

test("focus reaches the edit Input only in the edit route", async () => {
  const f = fakeOps(); const h = mount(f, { initialRoute: "advanced" });
  assert.ok(!h.text().includes(CURSOR_MARKER));
  h.press(KEY.down, KEY.down, KEY.down, KEY.enter);
  assert.ok(h.text().includes(CURSOR_MARKER), "the Input emits the hardware cursor marker");
  h.component.focused = false; assert.ok(!h.text().includes(CURSOR_MARKER)); h.component.focused = true;
  h.press(KEY.esc); assert.ok(!h.text().includes(CURSOR_MARKER)); h.component.dispose();
});

test("status route loads lines, scrolls and refreshes; errors render inline", async () => {
  const f = fakeOps(); const h = mount(f); toRow(h, 6); h.press(KEY.enter);
  await h.until(/Credentials: environment/); h.press(KEY.enter); await tick(); assert.equal(f.calls.filter((call) => call === "statusLines").length, 2);
  h.press(KEY.esc); assert.doesNotMatch(h.text(), /Decisions › Status/); h.component.dispose();
  const g = fakeOps({ statusLines: async () => { throw new SettingsError("Repair settings first"); } });
  const k = mount(g, { initialRoute: "main" }); toRow(k, 6); k.press(KEY.enter); await k.until(/Repair settings first/); k.component.dispose();
});

test("allowlist route embeds the editor within the dialog budget; Esc from search pops to main and cancels ranking", async () => {
  const ranks: AbortSignal[] = [];
  const f = fakeOps({ allowlist: async (scope, signal) => { f.calls.push(`allowlist:${scope}`); (f.signals.allowlist ??= []).push(signal); return allowlistDeps(scope, { rankLabel: "fixture · paid", rank: (_query, _skills, s) => { ranks.push(s); return new Promise<RelevanceItem[]>(() => {}); } }); } });
  const h = mount(f, { rows: 20 }); toRow(h, 3); h.press(KEY.enter);
  await h.until(/Search:/);
  const lines = h.component.render(100); assert.ok(lines.length <= dialogHeightBudget(20), `${lines.length} lines`);
  assert.match(h.text(), /Decisions › Always allowed · Global/);
  h.press(..."topic", KEY.rank); await tick(); assert.equal(ranks.length, 1);
  h.press(KEY.esc); // search mode: closes the embedded editor, not the dialog
  assert.equal(ranks[0].aborted, true); assert.equal(h.results.length, 0);
  assert.doesNotMatch(h.text(), /Search:/); assert.match(h.text(), /Always allowed · Global/);
  h.component.dispose();
});

test("allowlist save feedback appears as a banner on main, not as a transcript report", async () => {
  const saves: string[][] = [];
  const f = fakeOps({ allowlist: async (scope) => allowlistDeps(scope, { async save(names) { saves.push(names); } }) });
  const h = mount(f); toRow(h, 3); h.press(KEY.enter); await h.until(/Search:/);
  h.press(KEY.down, KEY.space, KEY.save); await h.until(/Always-allowed skills saved/);
  assert.deepEqual(saves, [["skill-00"]]);
  h.press(KEY.esc, KEY.esc); assert.doesNotMatch(h.text(), /Search:/);
  assert.match(h.text(), /Always-allowed global list saved/); assert.equal(h.results.length, 0); h.component.dispose();
});

test("project row is disabled without a working directory and shows the reason instead of opening", async () => {
  const f = fakeOps({}, { hasCwd: false }); const h = mount(f);
  assert.match(h.text(), /Always allowed · Project\s+n\/a/); assert.ok(!f.calls.includes("projectCount"));
  toRow(h, 4); h.press(KEY.enter); assert.match(h.text(), /No working directory/); assert.ok(!f.calls.some((call) => call.startsWith("allowlist")));
  h.component.dispose();
});

test("project warning is visible on the row without leaving the dialog", async () => {
  const f = fakeOps({ projectCount: async () => ({ count: 2, warning: "Project allowlist is malformed" }) });
  const h = mount(f); await h.until(/Always allowed · Project\s+2 ⚠/); toRow(h, 4); assert.match(h.text(), /malformed/); h.component.dispose();
});

test("settings errors render as a banner on main", () => {
  const f = fakeOps(); f.state.settingsError = "Settings file exceeds 64 KiB"; const h = mount(f);
  assert.match(h.text(), /Settings error: Settings file exceeds 64 KiB/);
  h.press(KEY.tab); assert.match(h.text(), /Settings error: Settings file exceeds 64 KiB/, "also on the Tool picker tab"); h.component.dispose();
});

test("Esc on main closes once; close is idempotent; late results cannot render or call ops after close", async () => {
  const late = deferred<{ count: number }>();
  const f = fakeOps({ projectCount: async (signal) => { f.calls.push("projectCount"); (f.signals.projectCount ??= []).push(signal); return late.promise; } });
  const h = mount(f); h.press(KEY.esc);
  assert.deepEqual(h.results, ["closed"]); assert.equal(h.closedHooks.length, 1); assert.equal(f.signals.projectCount[0].aborted, true);
  h.component.close("closed"); h.component.close("shutdown"); h.component.dispose();
  assert.deepEqual(h.results, ["closed"]); assert.equal(h.closedHooks.length, 1);
  const renders = h.renders, calls = f.calls.length; late.resolve({ count: 9 }); await tick();
  assert.equal(h.renders, renders); assert.equal(f.calls.length, calls); assert.deepEqual(h.component.render(80), []);
  h.press(KEY.down, KEY.enter); assert.equal(f.calls.length, calls);
});

test("close('shutdown') resolves once and aborts every in-flight route op", async () => {
  const f = fakeOps({ listProviders: async (signal) => { f.calls.push("listProviders"); (f.signals.listProviders ??= []).push(signal); return new Promise<ProviderRow[]>(() => {}); } });
  const h = mount(f); toRow(h, 1); h.press(KEY.enter);
  h.component.close("shutdown");
  assert.deepEqual(h.results, ["shutdown"]); assert.equal(f.signals.listProviders[0].aborted, true); assert.equal(f.signals.projectCount[0].aborted, true);
  h.component.dispose(); assert.deepEqual(h.results, ["shutdown"]);
});

test("a save in flight when the dialog closes is not cancelled, but its completion is ignored", async () => {
  const gate = deferred<void>(); let finished = false;
  const f = fakeOps(); f.ops.toggleEnabled = async () => { await gate.promise; f.settings.enabled = !f.settings.enabled; finished = true; };
  const h = mount(f); h.press(KEY.enter); h.component.close("closed");
  const renders = h.renders; gate.resolve(); await tick();
  assert.equal(finished, true); assert.equal(h.renders, renders); assert.equal(h.results.length, 1);
});

test("deep links stack main under the target, so Esc returns to main; navigate() refocuses an open dialog", async () => {
  const f = fakeOps(); const h = mount(f, { initialRoute: "provider" });
  await h.until(/typesafe · direct API/); assert.equal(f.calls.filter((call) => call === "listProviders").length, 1);
  h.press(KEY.esc); assert.doesNotMatch(h.text(), /Decisions › (?!Skill picker)/); assert.equal(h.results.length, 0);
  h.component.navigate("advanced"); assert.match(h.text(), /Decisions › Advanced/);
  h.component.navigate({ allowlist: "project" }); assert.match(h.text(), /Always allowed · Project/);
  await h.until(/Search:/); assert.ok(f.calls.includes("allowlist:project")); h.component.dispose();
});

test("rendered frame fits width and height at every size for every route, with hostile text", async () => {
  const hostile = "界界😀 é\x1b[31mred\x1b]8;;https://evil\x07\u202e " + "long ".repeat(60);
  const make = () => fakeOps({
    listProviders: async () => [{ id: "x", backend: "openai", provider: "openai", label: hostile, status: "missing", guide: hostile }, ...Array.from({ length: 25 }, (_, n) => ({ id: `p${n}`, backend: "typesafe" as const, provider: "typesafe", label: `provider-${n} ${hostile}`, status: "ok" as const }))],
    listModels: async () => Array.from({ length: 25 }, (_, n) => ({ id: `m${n}`, label: `model-${n} ${hostile}`, selection: null, status: "ok" as const, note: hostile })),
    statusLines: async () => Array.from({ length: 30 }, (_, n) => `status line ${n} ${hostile}`),
    allowlist: async (scope) => allowlistDeps(scope, { skills: Array.from({ length: 40 }, (_, n) => skill(`skill-${n}-${hostile}`.slice(0, 60), hostile)) }),
  });
  const routes: [string, (h: ReturnType<typeof mount>) => void][] = [
    ["main", () => {}], ["tools", (h) => h.component.navigate("tools")], ["advanced", (h) => h.component.navigate("advanced")], ["provider", (h) => h.component.navigate("provider")],
    ["model", (h) => h.component.navigate("model")], ["allowlist", (h) => h.component.navigate({ allowlist: "global" })],
    ["status", (h) => { toRow(h, 6); h.press(KEY.enter); }],
    ["edit", (h) => { h.component.navigate("advanced"); h.press(KEY.down, KEY.enter); }],
    ["options", (h) => { h.component.navigate("advanced"); h.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter); }],
  ];
  for (const rows of [8, 12, 24, 40]) for (const width of [40, 80, 120]) for (const [name, enter] of routes) for (const loaded of [false, true]) {
    const h = mount(make(), { rows }); enter(h);
    if (loaded) { await tick(); await tick(); }
    const budget = dialogHeightBudget(rows);
    const check = (phase: string) => {
      const lines = h.component.render(width);
      assert.ok(lines.length <= budget, `${name}/${phase} ${width}x${rows}: ${lines.length} lines > budget ${budget}`);
      assert.ok(lines.length >= 1);
      for (const line of lines) {
        assert.equal(visibleWidth(line), width, `${name}/${phase} ${width}x${rows}: width ${visibleWidth(line)} for ${JSON.stringify(line)}`);
        // SGR resets come from width-aware truncation and the cursor marker from a focused Input;
        // every other control character is a leak.
        assert.doesNotMatch(line.split(CURSOR_MARKER).join("").replace(/\x1b\[[0-9;]*m/g, ""), /[\u0000-\u001f\u007f-\u009f\u202e]/u, `${name}: control character leaked`);
      }
      return lines;
    };
    check("initial");
    if (name !== "edit" && name !== "allowlist") {
      for (let step = 0; step < 40; step++) {
        h.press(KEY.down);
        const lines = check(`down${step}`);
        if (["main", "advanced", "provider", "model", "options"].includes(name) && budget >= 3 && width >= 8 && step % 5 === 0) {
          assert.ok(lines.some((line) => line.includes("❯")), `${name} ${width}x${rows} step ${step}: selected row not visible`);
        }
      }
    }
    h.component.dispose();
  }
});

test("manager: one dialog at a time, second open focuses the first; closeAll resolves with shutdown", async () => {
  const manager = createSettingsDialogManager();
  const f = fakeOps();
  let customCalls = 0, focusCalls = 0, doneFn: ((value: DialogResult) => void) | undefined;
  let received: unknown; let component: ReturnType<typeof createSettingsDialogComponent> | undefined;
  const ctx = { ui: { async custom(factory: (...args: unknown[]) => unknown, options: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void }) {
    customCalls++; received = options;
    return new Promise((resolve) => {
      doneFn = (value) => resolve(value);
      component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, doneFn) as typeof component;
      options.onHandle?.({ focus() { focusCalls++; } });
    });
  } } } as unknown as Parameters<typeof manager.open>[0];
  let isOpen: (() => boolean) | undefined;
  const first = manager.open(ctx, (life) => { isOpen = life.isOpen; return f.ops; }, "main");
  assert.equal(manager.isOpen(), true);
  const second = await manager.open(ctx, () => { throw new Error("second ops must not be built"); }, "advanced");
  assert.equal(second, "focused-existing"); assert.equal(customCalls, 1); assert.equal(focusCalls, 1);
  assert.match(component!.render(80).join("\n"), /Decisions › Advanced/);
  assert.equal((received as { overlay: boolean }).overlay, true);
  assert.deepEqual((received as { overlayOptions: unknown }).overlayOptions, { anchor: "top-center", width: "70%", minWidth: 46, maxHeight: "70%", margin: { top: 1, right: 1, bottom: 1, left: 1 } });
  assert.equal(isOpen!(), true);
  manager.closeAll(); manager.closeAll();
  assert.equal(await first, "shutdown"); assert.equal(isOpen!(), false); assert.equal(manager.isOpen(), false);
  doneFn = undefined;
});

test("Tool picker tab: fields in order, bool toggles, options and inline edit save through tools.* keys, and the four tool/MCP allowlist rows open their editors", async () => {
  const f = fakeOps({ async toolAllowlist(list, scope, signal) { f.calls.push(`toolAllowlist:${list}:${scope}`); void signal; return { ...allowlistDeps(scope), noun: list === "tools" ? "tool" : "MCP server", skills: [{ ...skill("ext_a"), scope }] }; } });
  const h = mount(f, { rows: 40 }); await h.until(/Always allowed · Project\s+3/); h.press(KEY.tab);
  const text = await h.until(/Decisions › Tool picker/);
  assert.match(text, /Skill picker\s+Tool picker/); assert.doesNotMatch(text, /\[ (Skill|Tool) picker \]/);
  let at = -1;
  for (const label of ["Tool filtering", "Mode", "Run picker", "Relevance threshold", "Max added per round", "Minimum candidates", "On failure", "Description size", "Always allowed tools · Global", "Always allowed tools · Project", "Always allowed MCP servers & extensions · Global", "Always allowed MCP servers & extensions · Project"]) {
    const next = text.indexOf(label); assert.ok(next > at, `${label} out of order or missing`); at = next;
  }
  assert.match(text, /Tool filtering\s+Off/);
  h.press(KEY.space); await tick(); assert.deepEqual(f.calls.filter((call) => call.startsWith("updateSetting")), ["updateSetting:tools.enabled=true"]);
  assert.equal(f.settings.tools.enabled, true); assert.match(h.text(), /Tool filtering\s+On/);
  h.press(KEY.down, KEY.enter); assert.match(h.text(), /Decisions › Tool picker › Mode/);
  h.press(KEY.down, KEY.enter); await tick(); assert.equal(f.settings.tools.mode, "mcp"); assert.match(h.text(), /Decisions › Tool picker/); assert.match(h.text(), /Mode\s+mcp/);
  h.press(KEY.down, KEY.down, KEY.enter); assert.match(h.text(), /Value: 0\.375/);
  h.press(KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace, "9"); h.press(KEY.enter); await tick();
  assert.match(h.text(), /threshold must be/, "invalid values stay inline"); assert.equal(f.settings.tools.threshold, 0.375);
  h.press(KEY.esc);
  h.press(...Array(5).fill(KEY.down), KEY.enter); await h.until(/Always allowed tools · Global/); await h.until(/Search:/);
  assert.ok(f.calls.includes("toolAllowlist:tools:global")); assert.match(h.text(), /ext_a/);
  h.press(KEY.esc);
  h.component.dispose();
});
test("Tool picker tab fits the height budget at every size and survives hostile text; Esc closes the dialog", () => {
  for (const rows of [10, 14, 20, 24, 40]) {
    const f = fakeOps(); const h = mount(f, { rows, initialRoute: "tools" });
    const budget = dialogHeightBudget(rows);
    for (let i = 0; i < 14; i++) {
      const lines = h.component.render(60);
      assert.ok(lines.length <= budget, `${rows} rows: ${lines.length} > ${budget}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= 60, line);
      h.press(KEY.down);
    }
    h.press(KEY.esc); assert.deepEqual(h.results, ["closed"]); assert.equal(h.component.isClosed(), true); h.component.dispose();
  }
});

test("the active tab is a selectedBg chip (no brackets), the inactive tab is muted, and the strip stays width-bounded when narrow", () => {
  const marked = { fg: (token: string, value: string) => `<fg:${token}>${value}</fg>`, bg: (token: string, value: string) => `<bg:${token}>${value}</bg>` } as unknown as Parameters<typeof createSettingsDialogComponent>[1];
  const strip = (width: number, route?: "tools") => {
    const component = createSettingsDialogComponent({ requestRender() {}, terminal: { rows: 40 } }, marked, () => {}, fakeOps().ops, { initialRoute: route });
    const lines = component.render(width); component.dispose();
    return lines.find((line) => line.includes("Skill picker") && line.includes("Tool picker") && !line.includes("Decisions ›"));
  };
  const skills = strip(100)!;
  assert.match(skills, /<bg:selectedBg><fg:text> {2}Skill picker {2}<\/fg><\/bg>/); assert.match(skills, /<fg:muted> {2}Tool picker {2}<\/fg>/);
  assert.doesNotMatch(skills, /\[|\]/);
  const tools = strip(100, "tools")!;
  assert.match(tools, /<bg:selectedBg><fg:text> {2}Tool picker {2}<\/fg><\/bg>/); assert.match(tools, /<fg:muted> {2}Skill picker {2}<\/fg>/);
  assert.equal(visibleWidth(skills), visibleWidth(tools), "switching tabs does not shift layout");
  assert.equal([skills, tools].filter((line) => line.includes("<bg:selectedBg>")).length, 2);
  // Narrow: every line still fits (the strip is truncated, never wrapped past the frame).
  const component = createSettingsDialogComponent({ requestRender() {}, terminal: { rows: 40 } }, theme, () => {}, fakeOps().ops);
  for (const width of [46, 30, 20]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
  component.dispose();
});

test("Skill picker and Tool picker are peer tabs: Tab, Shift+Tab, ←/→ switch only on a tab root, in one overlay, with no nested route", async () => {
  const f = fakeOps(); const h = mount(f, { rows: 40 }); await h.until(/Always allowed · Project\s+3/);
  assert.match(h.text(), /Decisions › Skill picker/); assert.doesNotMatch(h.text(), /Tool filtering/);
  h.press(KEY.tab); assert.match(h.text(), /Decisions › Tool picker/); assert.match(h.text(), /Tool filtering\s+Off/);
  assert.doesNotMatch(h.text(), /Context decisions\s+(On|Off)/);
  h.press(KEY.shiftTab); assert.match(h.text(), /Decisions › Skill picker/); assert.match(h.text(), /Context decisions\s+On/);
  h.press(KEY.right); assert.match(h.text(), /Decisions › Tool picker/);
  h.press(KEY.right); assert.match(h.text(), /Decisions › Tool picker/, "→ on the last tab stays put");
  h.press(KEY.left); assert.match(h.text(), /Decisions › Skill picker/);
  h.press(KEY.left); assert.match(h.text(), /Decisions › Skill picker/);
  assert.equal(h.results.length, 0, "switching tabs never closes the dialog");
  // Tab keys do nothing on a pushed route; Esc returns to the tab it came from.
  h.press(KEY.right); toRow(h, 0); h.press(KEY.down, KEY.enter); assert.match(h.text(), /Decisions › Tool picker › Mode/);
  h.press(KEY.tab, KEY.left, KEY.right); assert.match(h.text(), /Decisions › Tool picker › Mode/);
  h.press(KEY.esc); assert.match(h.text(), /Decisions › Tool picker/); assert.doesNotMatch(h.text(), /› Mode/);
  h.press(KEY.esc); assert.deepEqual(h.results, ["closed"]); h.component.dispose();
});

test("entering the Tool picker tab loads the project tool and MCP counts", async () => {
  const late = deferred<{ count: number; tools: number; mcpServers: number }>();
  const f = fakeOps({ async projectCount(signal) { f.calls.push("projectCount"); void signal; return late.promise; } });
  const h = mount(f, { rows: 40 }); h.press(KEY.tab); assert.match(h.text(), /Always allowed tools · Project\s+…/);
  late.resolve({ count: 1, tools: 4, mcpServers: 2 }); await tick();
  assert.match(h.text(), /Always allowed tools · Project\s+4/); assert.match(h.text(), /Always allowed MCP servers & extensions · Project\s+2/);
  h.component.dispose();
});

test("the tool picker's first row toggles tool filtering independently of the skill picker's master toggle", async () => {
  const f = fakeOps(); const h = mount(f, { rows: 40 }); await h.until(/Always allowed · Project\s+3/);
  h.press(KEY.tab, KEY.space); await tick();
  assert.deepEqual(f.calls.filter((call) => call.startsWith("updateSetting") || call === "toggleEnabled"), ["updateSetting:tools.enabled=true"]);
  assert.equal(f.settings.enabled, true); assert.equal(f.settings.tools.enabled, true);
  h.press(KEY.shiftTab); assert.match(h.text(), /Context decisions\s+On/); h.component.dispose();
});

test("deep links to the tool picker open it as the sole root; tool and MCP allowlists return to the Tool picker tab", async () => {
  const f = fakeOps({ async toolAllowlist(list, scope) { return { ...allowlistDeps(scope), noun: list === "tools" ? "tool" : "MCP server", skills: [{ ...skill("ext_a"), scope }] }; } });
  const h = mount(f, { initialRoute: "tools" });
  assert.match(h.text(), /Decisions › Tool picker/); h.press(KEY.esc); assert.deepEqual(h.results, ["closed"]); h.component.dispose();
  const g = mount(f); g.component.navigate({ allowlist: "global", list: "mcp" }); await g.until(/Search:/);
  assert.match(g.text(), /Always allowed MCP servers & extensions · Global/);
  g.press(KEY.esc); assert.match(g.text(), /Decisions › Tool picker/); assert.equal(g.results.length, 0);
  g.component.navigate("main"); assert.match(g.text(), /Decisions › Skill picker/); g.component.dispose();
});
