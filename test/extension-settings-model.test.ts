import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DecisionError } from "../src/decision/errors.ts";
import { defaultSettings, SettingsError } from "../src/settings.ts";
import {
  ADVANCED_FIELDS, SKILL_FIELDS, TOOL_FIELDS, advancedRows, advancedValueText, dialogHeightBudget, describeError, fieldFor, layoutMenu, sanitizeTerminalText,
} from "../src/extension/settings-model.ts";

test("settings-model is pure: it imports no Pi or pi-tui module", () => {
  const source = readFileSync(new URL("../src/extension/settings-model.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^\.\.?\//, `non-local import ${specifier}`);
});

test("Advanced covers every relevance setting except legacy pins, and each field is typed", () => {
  const expected = Object.keys(defaultSettings().relevance).filter((key) => key !== "pinned").sort();
  assert.deepEqual([...ADVANCED_FIELDS.filter((field) => field.group === "relevance"), ...SKILL_FIELDS].map((field) => field.key).sort(), expected);
  assert.equal(new Set(ADVANCED_FIELDS.map((field) => `${field.group}.${field.key}`)).size, ADVANCED_FIELDS.length);
  for (const field of ADVANCED_FIELDS) {
    assert.ok(field.hint.length > 10, `${field.key} needs a hint`);
    if (field.kind === "options") assert.ok((field.options?.length ?? 0) >= 2, `${field.key} needs options`);
  }
  assert.equal(advancedRows(defaultSettings()).length, ADVANCED_FIELDS.length);
});

test("tool limit metadata follows the mode without changing keys, values, skill rows or static fields", () => {
  for (const enabled of [false, true]) {
    const settings = defaultSettings(); settings.tools.enabled = enabled;
    const original = structuredClone(settings);
    const toolRows = advancedRows(settings);
    settings.tools.mode = "mcp";
    const groupRows = advancedRows(settings);
    assert.deepEqual(groupRows.map(({ id, value }) => ({ id, value })), toolRows.map(({ id, value }) => ({ id, value })));
    assert.deepEqual(groupRows.filter((row) => !row.id.startsWith("tools.")), toolRows.filter((row) => !row.id.startsWith("tools.")));
    const max = groupRows.find((row) => row.id === "tools.maxAdded")!;
    const min = groupRows.find((row) => row.id === "tools.minCandidates")!;
    assert.equal(max.label, "MCP/exts · Max added per round");
    assert.equal(min.label, "MCP/exts · Minimum candidates");
    assert.match(max.description, /MCP servers or extensions per round/);
    assert.match(max.description, /whole group counts once/);
    assert.match(max.description, /allowlisted and already-available groups do not count/);
    assert.match(min.description, /Below this many groups, no scoring and every tool stays available/);
    for (const row of [max, min]) {
      const field = fieldFor("tools", row.id.split(".")[1], settings)!;
      assert.deepEqual([field.label, field.hint], [row.label, row.description], "editor metadata matches the row");
    }
    settings.tools.mode = "tools";
    assert.deepEqual(advancedRows(settings), toolRows, "switching back restores the tool wording");
    assert.deepEqual(settings, original, "metadata resolution never changes settings");
    assert.deepEqual(ADVANCED_FIELDS.filter((field) => field.group === "tools").map((field) => field.label), ["Subagents · Allow inherited tools", "Tools · Max added per round", "Tools · Minimum candidates"]);
  }
});

test("feature fields stay on their tabs; all tuning is Advanced", () => {
  assert.deepEqual(SKILL_FIELDS.map((field) => field.key), ["enabled", "cadence"]);
  assert.deepEqual(TOOL_FIELDS.map((field) => field.key), ["enabled", "mode", "cadence"]);
  assert.ok(!ADVANCED_FIELDS.some((field) => field.key === "enabled" || field.key === "cadence"));
  assert.deepEqual(ADVANCED_FIELDS.slice(0, 3).map((field) => field.key), ["threshold", "chunkSize", "maxSkills"]);
});

test("failMode open option carries a visible warning and closed is listed first", () => {
  const field = ADVANCED_FIELDS.find((item) => item.key === "failMode")!;
  assert.equal(field.options![0].value, "closed");
  assert.match(field.options!.find((option) => option.value === "open")!.description, /WARNING.*every remaining skill, tool or group is added/i);
});

test("value text: concurrency 0 explains all-parallel, booleans read On/Off", () => {
  const settings = defaultSettings();
  const field = (key: string) => [...ADVANCED_FIELDS, ...SKILL_FIELDS].find((item) => item.key === key)!;
  assert.equal(advancedValueText(field("concurrency"), settings), "0 (all shards parallel)");
  settings.decision.concurrency = 4; assert.equal(advancedValueText(field("concurrency"), settings), "4");
  assert.equal(advancedValueText(field("enabled"), settings), "On");
  settings.relevance.enabled = false; assert.equal(advancedValueText(field("enabled"), settings), "Off");
  assert.equal(advancedValueText(field("threshold"), settings), "0.375");
});

test("dialogHeightBudget matches an independent oracle for the overlay options", () => {
  for (let rows = 3; rows <= 80; rows++) {
    const seventy = Math.floor(rows * 0.7);
    const oracle = Math.max(1, Math.min(seventy, rows - 2));
    assert.equal(dialogHeightBudget(rows), oracle, `rows ${rows}`);
  }
  assert.equal(dialogHeightBudget(undefined), Number.POSITIVE_INFINITY);
  assert.equal(dialogHeightBudget(1), 1);
  assert.equal(dialogHeightBudget(Number.NaN), Number.POSITIVE_INFINITY);
});

test("layoutMenu always keeps the selected row inside the window and inside the budget", () => {
  for (let budget = 1; budget <= 30; budget++) {
    for (let count = 0; count <= 40; count += 3) {
      for (const tall of [false, true]) {
        const heights = Array.from({ length: count }, (_, i) => tall && i % 3 === 1 ? 3 : 1);
        let start = 0;
        for (let selected = 0; selected < count; selected++) {
          const layout = layoutMenu(heights, selected, budget, start);
          start = layout.start;
          assert.ok(layout.start <= selected && selected < layout.end, `selected ${selected} outside [${layout.start}, ${layout.end}) at budget ${budget}`);
          const cost = heights.slice(layout.start, layout.end).reduce((sum, height) => sum + height, 0);
          // A single row taller than the budget is still shown (never hidden).
          assert.ok(cost <= budget || layout.end - layout.start === 1, `window costs ${cost} > ${budget}`);
        }
        for (let selected = count - 1; selected >= 0; selected--) {
          const layout = layoutMenu(heights, selected, budget, start);
          start = layout.start;
          assert.ok(layout.start <= selected && selected < layout.end);
        }
      }
    }
  }
  assert.deepEqual(layoutMenu([], 0, 5), { start: 0, end: 0 });
});

test("sanitizeTerminalText removes escapes, bidi controls and bounds length; errors never echo details", () => {
  const hostile = "a\x1b[31mred\x1b]8;;https://evil\x07\u202eb\nc\u200d";
  const clean = sanitizeTerminalText(hostile, 100);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f\u202e\u200d]/u);
  assert.equal(sanitizeTerminalText("x".repeat(1000), 10).length, 10);
  assert.equal(sanitizeTerminalText(undefined), "");
  assert.equal(describeError(new SettingsError("Bad value")), "Bad value");
  assert.equal(describeError(new DecisionError("http", "SECRET provider body", { status: 429 })), "Decision operation failed (http, HTTP 429)");
  assert.equal(describeError(new Error("SECRET_KEY")), "Context-decisions operation failed");
});

test("shared decision tuning appears once, exclusively in Advanced; feature caps retain distinct defaults", () => {
  const settings = defaultSettings();
  assert.deepEqual(ADVANCED_FIELDS.filter((field) => field.group === "decision").map((field) => field.key).sort(), Object.keys(settings.decision).sort());
  assert.equal(new Set(ADVANCED_FIELDS.filter((field) => field.group === "decision").map((field) => field.key)).size, Object.keys(settings.decision).length);
  assert.ok([...SKILL_FIELDS, ...TOOL_FIELDS].every((field) => field.group !== "decision"));
  assert.deepEqual(ADVANCED_FIELDS.filter((field) => field.group !== "decision").map((field) => `${field.group}.${field.key}`),
    ["relevance.maxSkills", "relevance.minCandidates", "tools.allowSubagentInheritedTools", "tools.maxAdded", "tools.minCandidates"]);
  assert.deepEqual([settings.relevance.maxSkills, settings.tools.maxAdded, settings.relevance.minCandidates, settings.tools.minCandidates], [12, 8, 8, 0]);
});
