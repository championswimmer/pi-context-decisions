import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAllowlistComponent, type AllowlistPickerDeps, type AllowlistTheme } from "../src/extension/allowlist-picker.ts";
import { rankSkills, type RelevanceItem } from "../src/apps/relevance.ts";
import type { ScopedSkill } from "../src/apps/allowlist.ts";
import type { CommandContext } from "../src/extension/contracts.ts";
const theme: AllowlistTheme = { fg: (_token, value) => value, bg: (_token, value) => value };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = { down: "\x1b[B", up: "\x1b[A", esc: "\x1b", tab: "\t", rank: "\x12", save: "\x13", clear: "\x0b", enter: "\r", space: " " };
const skill = (name: string, description = "", scope: "global" | "project" = "global"): ScopedSkill => ({ name, description, scope, disableModelInvocation: false });
const item = (name: string, score: number): RelevanceItem => ({ name, score, normalized: score / 2 });
function harness(overrides: Partial<AllowlistPickerDeps> = {}) {
  const saved: string[][] = [], closed: boolean[] = [], reports: string[] = [];
  let renders = 0;
  const component = createAllowlistComponent({ requestRender() { renders++; } }, theme, (value) => closed.push(value), {
    scope: "global", skills: [skill("zulu", "Database querying"), skill("alpha", "Browser testing"), skill("project-only", "", "project")],
    initial: ["not-loaded"], locationLabel: "fixture/settings.json", async save(names) { saved.push(names); },
    report(message) { reports.push(message); }, ...overrides,
  });
  component.focused = true;
  const input = (value: string) => { for (const char of value) component.handleInput!(char); };
  const rendered = (width = 120) => component.render(width).join("\n");
  return { component, saved, closed, reports, input, rendered, get renders() { return renders; } };
}
test("A-Z scope listing keeps unavailable saved names; fuzzy description search makes zero calls", () => {
  let calls = 0;
  const h = harness({ rank: async () => { calls++; return []; } });
  const text = h.rendered();
  assert.ok(text.indexOf("[ ] alpha") < text.indexOf("[x] not-loaded"));
  assert.ok(text.indexOf("[x] not-loaded") < text.indexOf("[ ] zulu"));
  assert.doesNotMatch(text, /project-only/);
  h.input("Browser"); assert.match(h.rendered(), /\[ \] alpha/); assert.doesNotMatch(h.rendered(), /\[ \] zulu/);
  h.component.handleInput!(keys.clear); h.input("twentycharactershere");
  h.component.handleInput!(keys.tab); h.component.handleInput!(keys.tab);
  assert.equal(calls, 0); h.component.dispose();
});
test("toggle, explicit save, and Esc discard preserve unseen selections and dirty state", async () => {
  const h = harness();
  h.component.handleInput!(keys.down); h.component.handleInput!(keys.space);
  assert.match(h.rendered(), /Global ●/); assert.deepEqual(h.saved, []);
  h.component.handleInput!(keys.save); await tick();
  assert.deepEqual(h.saved, [["alpha", "not-loaded"]]); assert.doesNotMatch(h.rendered(), /Global ●/);
  h.component.handleInput!(keys.space); h.component.handleInput!(keys.esc); h.component.handleInput!(keys.esc);
  assert.deepEqual(h.closed, [true]); assert.deepEqual(h.saved, [["alpha", "not-loaded"]]);
  const discard = harness(); discard.component.handleInput!(keys.down); discard.component.handleInput!(keys.space);
  discard.component.handleInput!(keys.esc); discard.component.handleInput!(keys.esc);
  assert.deepEqual(discard.closed, [false]); assert.deepEqual(discard.saved, []);
});
test("unloaded rows remain selectable for removal and manual-only skills are not candidates", async () => {
  const h = harness({ skills: [skill("alpha"), { ...skill("manual"), disableModelInvocation: true }], initial: ["not-loaded"] });
  assert.doesNotMatch(h.rendered(), /\[ \] manual/);
  h.input("not-loaded"); h.component.handleInput!(keys.down); h.component.handleInput!(keys.space); h.component.handleInput!(keys.save); await tick();
  assert.deepEqual(h.saved, [[]]); h.component.dispose();
});
test("rank is explicit, semantic list is not fuzzy-filtered, and changing query marks completed scores stale", async () => {
  const queries: string[] = [];
  const h = harness({ rankLabel: "fixture provider · paid call", rank: async (query, skills) => { queries.push(query); return skills.map((s) => item(s.name, s.name === "zulu" ? 2 : 0)); } });
  h.input("Browser"); assert.deepEqual(queries, []); h.component.handleInput!(keys.rank); await tick();
  assert.deepEqual(queries, ["Browser"]); const text = h.rendered();
  assert.ok(text.indexOf("[ ] zulu") < text.indexOf("[ ] alpha")); assert.match(text, /1.00 relevance/); assert.match(text, /\[x\] not-loaded/);
  h.input("x"); assert.match(h.rendered(), /stale/); assert.deepEqual(h.saved, []); h.component.dispose();
});
test("a second ranking cancels the first, stale completion cannot overwrite, close cancels and never redraws", async () => {
  const pending: { signal: AbortSignal; resolve(items: RelevanceItem[]): void }[] = [];
  const h = harness({ rank: (_query, _skills, signal) => new Promise((resolve) => pending.push({ signal, resolve })) });
  h.input("query"); h.component.handleInput!(keys.rank); h.component.handleInput!(keys.rank);
  assert.equal(pending.length, 2); assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve([item("alpha", 0), item("zulu", 2)]); await tick();
  pending[0].resolve([item("alpha", 2), item("zulu", 0)]); await tick();
  const text = h.rendered(); assert.ok(text.indexOf("[ ] zulu") < text.indexOf("[ ] alpha"));
  h.component.handleInput!(keys.rank); h.component.handleInput!(keys.esc);
  assert.equal(pending[2].signal.aborted, true); const renders = h.renders;
  pending[2].resolve([item("alpha", 2), item("zulu", 0)]); await tick(); assert.equal(h.renders, renders);
});
test("editing a query cancels in-flight ranking; empty or unavailable ranking never invokes a client", async () => {
  let signal: AbortSignal | undefined;
  const h = harness({ rank: (_query, _skills, s) => { signal = s; return new Promise(() => {}); } });
  h.component.handleInput!(keys.rank); assert.equal(signal, undefined); assert.match(h.rendered(), /Type a search term/);
  h.input("x"); h.component.handleInput!(keys.rank); h.input("y"); assert.equal((signal as AbortSignal | undefined)?.aborted, true); h.component.dispose();
  const missing = harness({ unavailable: "Set OPENAI_API_KEY or /login openai" });
  missing.input("Browser"); missing.component.handleInput!(keys.rank); assert.match(missing.rendered(), /OPENAI_API_KEY/);
  missing.component.handleInput!(keys.tab); assert.match(missing.rendered(), /\[ \] alpha/); assert.doesNotMatch(missing.rendered(), /\[ \] zulu/); missing.component.dispose();
});
test("400 scoped metadata skills rank in eight parallel batches; paths and bodies are dropped", async () => {
  const skills = Array.from({ length: 400 }, (_, i) => ({ ...skill(`s${String(i).padStart(3, "0")}`, "Fixture description"), filePath: "/private/fixture", body: "PRIVATE_BODY" }));
  const batches: number[] = [], requests: string[] = []; const finishes: (() => void)[] = [];
  const h = harness({ skills, initial: [], rank: (query, metadata, signal) => {
    assert.ok(metadata.every((s) => !Object.hasOwn(s, "filePath") && !Object.hasOwn(s, "body")));
    return rankSkills(query, metadata, { decide(request) {
      batches.push(Object.keys(request.questions).length); requests.push(JSON.stringify(request));
      return new Promise((resolve) => finishes.push(() => resolve({ answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "score", score: 1.8 }])) })));
    } }, { rubric: "topic", signal, chunkSize: 50, concurrency: 0 });
  } });
  h.input("Search topics"); h.component.handleInput!(keys.rank); await tick();
  assert.deepEqual(batches, Array(8).fill(50)); for (const request of requests) assert.doesNotMatch(request, /PRIVATE_BODY|\/private\/fixture|filePath/);
  finishes.reverse().forEach((finish) => finish()); await tick(); assert.match(h.rendered(), /0.90 relevance/); assert.deepEqual(h.saved, []); h.component.dispose();
});
test("every rendered line fits 40/80/120 columns with Unicode, ANSI-like control input and expanded text", () => {
  const h = harness({ skills: [skill("界界😀a\x1b[31m", "漢字 emoji 😀 é \x1b]8;;https://evil\x07\n".repeat(30))], initial: [], locationLabel: "\x1b[31m/private/path" });
  h.component.handleInput!(keys.down); h.component.handleInput!(keys.enter);
  for (const width of [40, 80, 120]) for (const line of h.component.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`); assert.doesNotMatch(line, /\x1b\[31m|\x1b\]8/);
  }
  h.component.dispose();
});
test("ranking/save errors use safe codes and do not expose provider messages; malformed ranking is rejected", async () => {
  const h = harness({ rank: async () => { throw { code: "auth", message: "SECRET_KEY" }; }, save: async () => { throw new Error("SECRET_KEY"); } });
  h.input("q"); h.component.handleInput!(keys.rank); await tick(); assert.match(h.rendered(), /unavailable \(auth\)/); assert.doesNotMatch(h.rendered(), /SECRET_KEY/);
  h.component.handleInput!(keys.save); await tick(); assert.match(h.rendered(), /operation-failed/); assert.doesNotMatch(h.rendered(), /SECRET_KEY/); h.component.dispose();
  const malformed = harness({ rank: async () => [item("alpha", 1)] }); malformed.input("q"); malformed.component.handleInput!(keys.rank); await tick(); assert.match(malformed.rendered(), /invalid_response/); malformed.component.dispose();
});
test("an embedding host caps rendered rows through maxRows and keeps the selected row visible", () => {
  const skills = Array.from({ length: 30 }, (_, n) => skill(`skill-${String(n).padStart(2, "0")}`, "A long description. ".repeat(20)));
  for (const cap of [30, 12, 9, 6, 4, 3, 2, 1]) {
    const component = createAllowlistComponent({ requestRender() {} }, theme, () => {}, {
      scope: "global", skills, initial: [], locationLabel: "settings.json", async save() {}, report() {}, maxRows: () => cap,
    });
    component.focused = true;
    component.handleInput!(keys.down);
    for (let n = 0; n < 12; n++) component.handleInput!(keys.down);
    component.handleInput!(keys.enter);
    const lines = component.render(80);
    assert.ok(lines.length <= cap, `${lines.length} lines exceed maxRows ${cap}`);
    if (cap >= 6) assert.match(lines.join("\n"), /❯ \[ \] skill-12/);
    component.dispose();
  }
});
