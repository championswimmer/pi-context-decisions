import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DecisionError } from "../src/decision/errors.ts";
import { defaultSettings, SettingsError } from "../src/settings.ts";
import {
  ADVANCED_FIELDS, advancedRows, advancedValueText, dialogHeightBudget, describeError, layoutMenu, sanitizeTerminalText,
} from "../src/extension/settings-model.ts";

test("settings-model is pure: it imports no Pi or pi-tui module", () => {
  const source = readFileSync(new URL("../src/extension/settings-model.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^\.\.?\//, `non-local import ${specifier}`);
});

test("Advanced covers every relevance setting except legacy pins, and each field is typed", () => {
  const expected = Object.keys(defaultSettings().relevance).filter((key) => key !== "pinned").sort();
  assert.deepEqual(ADVANCED_FIELDS.map((field) => field.key).sort(), expected);
  assert.equal(new Set(ADVANCED_FIELDS.map((field) => field.key)).size, ADVANCED_FIELDS.length);
  for (const field of ADVANCED_FIELDS) {
    assert.ok(field.hint.length > 10, `${field.key} needs a hint`);
    if (field.kind === "options") assert.ok((field.options?.length ?? 0) >= 2, `${field.key} needs options`);
  }
  assert.equal(advancedRows(defaultSettings()).length, ADVANCED_FIELDS.length);
});

test("Advanced puts the four picking controls first, in order, and drops every choice-era row", () => {
  assert.deepEqual(ADVANCED_FIELDS.slice(0, 5).map((field) => field.key), ["enabled", "threshold", "chunkSize", "maxSkills", "cadence"]);
  assert.deepEqual(ADVANCED_FIELDS.slice(5).map((field) => field.key), ["failMode", "timeoutMs", "concurrency", "minCandidates", "maxPromptChars", "maxDescriptionChars"]);
  const labels = ADVANCED_FIELDS.map((field) => field.label);
  assert.deepEqual(labels.slice(1, 5), ["Relevance threshold", "Shard size", "Max added per round", "Run picker"]);
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.ok(!ADVANCED_FIELDS.some((field) => field.key === removed), removed);
  assert.ok(!ADVANCED_FIELDS.some((field) => field.kind === ("choice" as string)), "the option-list kind is not called choice");
  const threshold = ADVANCED_FIELDS.find((field) => field.key === "threshold")!;
  assert.equal(threshold.kind, "decimal"); assert.match(threshold.hint, /0–1/);
  const cadence = ADVANCED_FIELDS.find((field) => field.key === "cadence")!;
  assert.deepEqual(cadence.options!.map((option) => option.value), ["prompt", "tool-round"]);
  assert.match(cadence.options![1].description, /No tool names, arguments or results are sent/);
  assert.match(ADVANCED_FIELDS.find((field) => field.key === "maxSkills")!.hint, /already-added skills do not count/i);
});

test("failMode open option carries a visible warning and closed is listed first", () => {
  const field = ADVANCED_FIELDS.find((item) => item.key === "failMode")!;
  assert.equal(field.options![0].value, "closed");
  assert.match(field.options!.find((option) => option.value === "open")!.description, /WARNING.*every remaining skill is added/i);
});

test("value text: concurrency 0 explains all-parallel, booleans read On/Off", () => {
  const settings = defaultSettings();
  const field = (key: string) => ADVANCED_FIELDS.find((item) => item.key === key)!;
  assert.equal(advancedValueText(field("concurrency"), settings), "0 (all shards parallel)");
  settings.relevance.concurrency = 4; assert.equal(advancedValueText(field("concurrency"), settings), "4");
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
