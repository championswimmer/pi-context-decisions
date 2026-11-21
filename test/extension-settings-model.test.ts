import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DecisionError } from "../src/decision/errors.ts";
import {
  contextDecisionsSettingsSchema,
  contextSettingsToFlat,
  createContextDecisionsSettingsSchema,
  defaultSettings,
  flatToContextSettings,
  SettingsError,
} from "../src/settings.ts";
import {
  backendLabel,
  describeError,
  dialogHeightBudget,
  iconStyleText,
  layoutMenu,
  modelLabel,
  sanitizeTerminalText,
  toolsSummary,
} from "../src/extension/settings-model.ts";

test("settings-model is pure: it imports no Pi or pi-tui module", () => {
  const source = readFileSync(new URL("../src/extension/settings-model.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^\.\.?\//, `non-local import ${specifier}`);
});

test("schema defines four peer tabs (Skills, Tools, Decision, Lab) and covers every persisted setting", () => {
  const schema = contextDecisionsSettingsSchema;
  assert.deepEqual(schema.tabs.map((tab) => tab.id), ["skills", "tools", "decision", "lab"]);
  assert.deepEqual(schema.tabs.map((tab) => tab.label), ["Skills", "Tools", "Decision", "Lab"]);
  assert.equal(schema.saveMode, "immediate");
  assert.deepEqual(schema.scopes, ["global"]);

  const defaults = schema.getDefaults();
  assert.deepEqual(flatToContextSettings(defaults), defaultSettings());
  assert.deepEqual(contextSettingsToFlat(defaultSettings()), defaults);

  // Legacy pinnedSkills is persisted but hidden from the dialog UI.
  assert.equal(schema.fields.pinnedSkills.visibleWhen?.(defaults), false);
  // Every tab has its expected primary fields.
  assert.deepEqual(
    schema.getFieldsForTab("skills").map((entry) => entry.key),
    ["skillFilteringEnabled", "skillMaxAdded", "skillMinCandidates", "globalSkillAllowlist", "projectSkillAllowlist", "statusView", "pinnedSkills"],
  );
  assert.deepEqual(
    schema.getFieldsForTab("tools").map((entry) => entry.key),
    ["toolFilteringEnabled", "toolMode", "toolCadence", "toolMaxAdded", "toolMinCandidates", "allowSubagentInheritedTools", "globalToolAllowlist", "projectToolAllowlist", "globalMcpAllowlist", "projectMcpAllowlist"],
  );
  assert.deepEqual(
    schema.getFieldsForTab("decision").map((entry) => entry.key),
    ["backend", "decisionThreshold", "decisionFailMode", "decisionChunkSize", "decisionConcurrency", "decisionTimeoutMs", "decisionMaxPromptChars", "decisionMaxDescriptionChars", "iconStyle"],
  );
  assert.deepEqual(
    schema.getFieldsForTab("lab").map((entry) => entry.key),
    ["constantMatrix", "historyModel", "historyEnabled"],
  );
});

test("tool limit labels and descriptions follow toolMode dynamically without mutating settings", () => {
  const schema = contextDecisionsSettingsSchema;
  const base = schema.getDefaults();
  assert.equal(schema.getFieldLabel("toolMaxAdded", base), "Tools · Max added per round");
  assert.equal(schema.getFieldLabel("toolMinCandidates", base), "Tools · Minimum candidates");

  const mcp = { ...base, toolMode: "mcp" as const };
  assert.equal(schema.getFieldLabel("toolMaxAdded", mcp), "MCP/exts · Max added per round");
  assert.equal(schema.getFieldLabel("toolMinCandidates", mcp), "MCP/exts · Minimum candidates");
  assert.match(schema.getFieldDescription("toolMaxAdded", mcp) ?? "", /MCP servers or extensions per round/);
  assert.match(schema.getFieldDescription("toolMaxAdded", mcp) ?? "", /whole group counts once/);
  assert.match(schema.getFieldDescription("toolMaxAdded", mcp) ?? "", /allowlisted and already-available groups do not count/);
  assert.match(schema.getFieldDescription("toolMinCandidates", mcp) ?? "", /Below this many groups, no scoring and every tool stays available/);
});

test("decisionFailMode disables inline stepping, lists closed first, and warns loudly on open", () => {
  const def = contextDecisionsSettingsSchema.fields.decisionFailMode;
  assert.equal(def.kind, "enum");
  assert.equal(def.display, "picker");
  assert.equal(def.allowInlineStep, false);
  assert.equal(def.options[0].value, "closed");
  const open = def.options.find((opt) => opt.value === "open")!;
  assert.equal(open.tone, "warn");
  assert.match(open.description ?? "", /WARNING.*every remaining skill, tool or group is added/i);
});

test("eligibility gates subagent inherited tools and past turn summaries; normalizeDraft disables history when model cleared", () => {
  let managerPresent = false;
  let usableModel = false;
  const schema = createContextDecisionsSettingsSchema({
    isSubagentManagerPresent: () => managerPresent,
    isHousekeepingModelUsable: () => usableModel,
  });
  const defaults = schema.getDefaults();

  // Subagents · Allow inherited tools
  assert.equal(schema.getFieldEligibility("allowSubagentInheritedTools", defaults).eligible, false);
  assert.match(schema.getFieldEligibility("allowSubagentInheritedTools", defaults).reason ?? "", /pi-subagent-manager/);
  // Already enabled can always be toggled off even when manager is absent.
  assert.equal(schema.getFieldEligibility("allowSubagentInheritedTools", { ...defaults, allowSubagentInheritedTools: true }).eligible, true);
  managerPresent = true;
  assert.equal(schema.getFieldEligibility("allowSubagentInheritedTools", defaults).eligible, true);

  // Past turn summaries · Enabled
  assert.equal(schema.getFieldEligibility("historyEnabled", defaults).eligible, false);
  assert.match(schema.getFieldEligibility("historyEnabled", defaults).reason ?? "", /Select a housekeeping model first/);
  const withModel = { ...defaults, historyModel: { model: "openai/gpt-5-mini", thinkingLevel: "off" as const } };
  assert.equal(schema.getFieldEligibility("historyEnabled", withModel).eligible, false);
  assert.match(schema.getFieldEligibility("historyEnabled", withModel).reason ?? "", /unavailable or unauthenticated/);
  usableModel = true;
  assert.equal(schema.getFieldEligibility("historyEnabled", withModel).eligible, true);
  // Already enabled can always be turned off.
  usableModel = false;
  assert.equal(schema.getFieldEligibility("historyEnabled", { ...withModel, historyEnabled: true }).eligible, true);

  // normalizeDraft: clearing historyModel forces historyEnabled = false
  const cleared = schema.normalizeDraft!(
    { ...defaults, historyModel: null, historyEnabled: true },
    "historyModel",
    { ...withModel, historyEnabled: true },
  );
  assert.equal(cleared.historyEnabled, false);
});

test("field formatting: concurrency 0 explains all-parallel, iconStyle shows plain label, backend formats cleanly", () => {
  const schema = contextDecisionsSettingsSchema;
  const defaults = schema.getDefaults();
  assert.equal(schema.formatFieldValue("decisionConcurrency", 0, defaults), "0 (all shards parallel)");
  assert.equal(schema.formatFieldValue("decisionConcurrency", 4, defaults), "4");
  assert.equal(schema.formatFieldValue("decisionThreshold", 0.375, defaults), "0.375");
  assert.equal(schema.formatFieldValue("iconStyle", "unicode", defaults), "ASCII / Unicode");
  assert.equal(schema.formatFieldValue("iconStyle", "emoji", defaults), "Emoji");
  assert.equal(schema.formatFieldValue("iconStyle", "nerd", defaults), "Nerd Font");
  assert.equal(schema.formatFieldValue("backend", null, defaults), "Not configured");
  assert.equal(schema.formatFieldValue("backend", { backend: "typesafe", model: "jev-latest" }, defaults), "typesafe direct jev-latest");
  assert.equal(schema.formatFieldValue("backend", { backend: "pi", provider: "custom", id: "cls" }, defaults), "Pi custom/cls");
});

test("summary helpers format icon style, tools summary and backend/model labels safely", () => {
  const settings = defaultSettings();
  assert.equal(iconStyleText(settings), "ASCII / Unicode");
  settings.iconStyle = "nerd";
  assert.equal(iconStyleText(settings), "Nerd Font");
  assert.equal(toolsSummary(settings), "Off");
  settings.tools.enabled = true;
  settings.tools.mode = "mcp";
  settings.tools.cadence = "tool-round";
  assert.equal(toolsSummary(settings), "On · mcp · tool-round");
  assert.equal(backendLabel(null), "not configured");
  assert.equal(backendLabel({ backend: "pi", provider: "custom", id: "m" }), "Pi internal · custom");
  assert.equal(backendLabel({ backend: "openai", model: "gpt-6-luna" }), "openai direct");
  assert.equal(modelLabel({ backend: "openai", model: "gpt-6-luna" }), "openai direct gpt-6-luna");
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
        const heights = Array.from({ length: count }, (_, i) => (tall && i % 3 === 1 ? 3 : 1));
        let start = 0;
        for (let selected = 0; selected < count; selected++) {
          const layout = layoutMenu(heights, selected, budget, start);
          start = layout.start;
          assert.ok(layout.start <= selected && selected < layout.end, `selected ${selected} outside [${layout.start}, ${layout.end}) at budget ${budget}`);
          const cost = heights.slice(layout.start, layout.end).reduce((sum, height) => sum + height, 0);
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
