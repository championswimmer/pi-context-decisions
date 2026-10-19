import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSettings, defaultToolSettings, loadSettings, parseSettings, saveSettings, SettingsError, TOOL_CADENCES, TOOL_FILTER_MODES, updateSetting, validateBackendSelection } from "../src/settings.ts";
import { OPENROUTER_DECISION_MODELS } from "../src/catalog/openrouter-models.ts";

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "context-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("defaults are independent, disabled until a backend is chosen, fail closed, and bounded", async (t) => {
  const a = defaultSettings(); const b = defaultSettings(); a.relevance.pinned.push("one");
  assert.deepEqual(b.relevance.pinned, []); assert.equal(b.backend, null); assert.equal(b.decision.failMode, "closed");
  assert.equal(b.decision.maxPromptChars, 4000); assert.equal(b.decision.maxDescriptionChars, 400); assert.equal(b.decision.chunkSize, 50); assert.equal(b.decision.concurrency, 0);
  assert.deepEqual((await loadSettings(join(await directory(t), "missing.json"))).settings, b);
});
test("every static router ID accepted by direct and native, aliases and outside-ten rejected", () => {
  for (const { id } of OPENROUTER_DECISION_MODELS) {
    assert.deepEqual(validateBackendSelection({ backend: "openrouter", model: id }), { backend: "openrouter", model: id });
    assert.deepEqual(validateBackendSelection({ backend: "pi", provider: "openrouter", id }), { backend: "pi", provider: "openrouter", id });
  }
  for (const id of ["~typesafe/jev-latest", "respan/span-01", "typesafe/jev-1.13-20260917", "unknown/model", "openai/gpt-6-luna-decisions", "inception/mercury-decide:free"]) {
    assert.throws(() => validateBackendSelection({ backend: "openrouter", model: id }), /outside the checked-in top ten/);
    assert.throws(() => validateBackendSelection({ backend: "pi", provider: "openrouter", id }), /outside the checked-in top ten/);
  }
});
test("nonrouter Pi selections remain independent; direct versions and fields validated", () => {
  assert.deepEqual(validateBackendSelection({ backend: "pi", provider: "custom", id: "nested/id" }), { backend: "pi", provider: "custom", id: "nested/id" });
  assert.deepEqual(validateBackendSelection({ backend: "typesafe" }), { backend: "typesafe", model: "jev-latest" });
  assert.deepEqual(validateBackendSelection({ backend: "openai" }), { backend: "openai", model: "gpt-6-luna" });
  for (const value of [{ backend: "openai", model: "chat-model" }, { backend: "typesafe", model: "unknown" }, { backend: "pi", provider: "x", id: "bad\nmodel" }, { backend: "openrouter", model: "typesafe/jev-1.13", url: "https://evil.invalid" }, {}]) assert.throws(() => validateBackendSelection(value), SettingsError);
});
test("partial config receives defaults, unknown read fields warn but cannot be saved", () => {
  const warnings: string[] = [];
  const parsed = parseSettings({ enabled: false, relevance: { cadence: "tool-round", mystery: 1 }, extra: 1 }, warnings);
  assert.equal(parsed.relevance.enabled, false); assert.equal(parsed.relevance.cadence, "tool-round"); assert.equal(parsed.decision.threshold, 0.375); assert.equal(warnings.length, 3);
  assert.throws(() => parseSettings({ ...defaultSettings(), mystery: 1 }), SettingsError);
});
test("invalid settings cannot enable unbounded disclosure or invalid fail-open", () => {
  for (const [key, value] of Object.entries({ maxPromptChars: 4001, maxDescriptionChars: 401, chunkSize: 51, concurrency: 33, timeoutMs: 300001, maxSkills: -1, minCandidates: 1001, cadence: "always", threshold: 1.01, failMode: true, enabled: "true", pinned: ["bad\nname"] })) {
    assert.throws(() => parseSettings({ relevance: { [key]: value } }), SettingsError, key);
  }
  for (const value of [NaN, Infinity, 1.5, "12"]) assert.throws(() => parseSettings({ relevance: { maxSkills: value } }), SettingsError);
});
test("credential fields rejected at any depth without printing values", () => {
  for (const key of ["apiKey", "token", "password", "OPENAI_API_KEY", "authorization", "credentials"]) {
    assert.throws(() => parseSettings({ relevance: { arbitrary: { [key]: "SECRET-FIXTURE" } } }), (error: unknown) => {
      assert.ok(error instanceof SettingsError); assert.doesNotMatch(error.message, /SECRET-FIXTURE/); return true;
    });
  }
});
test("atomic settings replacement roundtrips with no temporary files and mode 0600", async (t) => {
  const root = await directory(t); const path = join(root, "nested", "settings.json");
  const settings = defaultSettings(); settings.backend = { backend: "openrouter", model: "cloudflare/clef-flash" }; settings.relevance.pinned = ["one", "one"];
  await saveSettings(settings, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await loadSettings(path)).settings, { ...settings, relevance: { ...settings.relevance, pinned: ["one"] } });
  assert.deepEqual(await readdir(join(root, "nested")), ["settings.json"]);
  const next = { ...settings, relevance: { ...settings.relevance, enabled: false } }; await saveSettings(next, path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).relevance.enabled, false);
});
test("invalid writes leave existing file unchanged; rename failure cleans temp", async (t) => {
  const root = await directory(t); const path = join(root, "settings.json"); await saveSettings(defaultSettings(), path);
  const original = await readFile(path, "utf8");
  await assert.rejects(saveSettings({ ...defaultSettings(), decision: { ...defaultSettings().decision, failMode: "bad" as "open" } }, path), SettingsError);
  assert.equal(await readFile(path, "utf8"), original);
  const occupied = join(root, "occupied"); await mkdir(occupied);
  await assert.rejects(saveSettings(defaultSettings(), occupied), /Could not save/);
  assert.deepEqual((await readdir(root)).sort(), ["occupied", "settings.json"]);
});
test("stale nonallowlisted persisted router model is an explicit error with no substituted backend", async (t) => {
  const path = join(await directory(t), "settings.json");
  await writeFile(path, JSON.stringify({ ...defaultSettings(), backend: { backend: "openrouter", model: "~typesafe/jev-latest" } }));
  const result = await loadSettings(path); assert.match(result.error!, /outside the checked-in top ten/); assert.equal(result.settings.backend, null);
});
test("malformed, oversized, and secret-bearing reads fail explicitly without sensitive diagnostics", async (t) => {
  const path = join(await directory(t), "settings.json");
  for (const text of ["private invalid json", " ".repeat(65537), JSON.stringify({ token: "SECRET-FIXTURE" })]) {
    await writeFile(path, text); const result = await loadSettings(path);
    assert.ok(result.error); assert.doesNotMatch(result.error, /SECRET-FIXTURE|private invalid/); assert.equal(result.settings.backend, null);
  }
});
test("oversized valid-shaped settings cannot be written as an unreadable file", async (t) => {
  const path = join(await directory(t), "settings.json");
  const settings = defaultSettings(); settings.relevance.pinned = Array.from({ length: 1000 }, (_, i) => `${"a".repeat(60)}${String(i).padStart(4, "0")}`);
  await assert.rejects(saveSettings(settings, path), /exceeds 64 KiB/);
});
test("defaults: normalized threshold 0.375, prompt cadence, score-only shape with no legacy keys", () => {
  const { relevance, decision } = defaultSettings();
  assert.equal(decision.threshold, 0.375); assert.equal(relevance.cadence, "prompt"); assert.equal(relevance.maxSkills, 12); assert.equal(decision.chunkSize, 50);
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.equal(Object.hasOwn(relevance, removed), false, removed);
});
test("decimal thresholds persist, old settings receive defaults, and bad bounds/types are rejected", async (t) => {
  assert.equal(parseSettings({ relevance: { chunkSize: 5 } }).decision.threshold, 0.375);
  const settings = updateSetting(defaultSettings(), "decision.threshold", "0.625");
  assert.equal(settings.decision.threshold, 0.625);
  const path = join(await directory(t), "settings.json");
  await saveSettings(settings, path); assert.equal((await loadSettings(path)).settings.decision.threshold, 0.625);
  const text = JSON.parse(await readFile(path, "utf8")).relevance;
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.equal(Object.hasOwn(text, removed), false, `save writes only the new shape (${removed})`);
  for (const ok of [0, 1, 0.5, 0.375]) assert.equal(parseSettings({ decision: { threshold: ok } }).decision.threshold, ok);
  for (const value of [NaN, Infinity, -0.01, 1.01, 2, "0.5", true, null]) assert.throws(() => parseSettings({ decision: { threshold: value } }), SettingsError);
  for (const value of ["NaN", "Infinity", "-1", "1.01", "2", "1e0", "true", "1.2.3", ""]) assert.throws(() => updateSetting(settings, "decision.threshold", value), SettingsError);
  assert.equal(updateSetting(settings, "decision.threshold", ".5").decision.threshold, 0.5);
  assert.equal(updateSetting(settings, "decision.threshold", "1").decision.threshold, 1);
});
test("cadence is a validated enum and every picker control updates through the shared path", () => {
  const settings = defaultSettings();
  assert.equal(updateSetting(settings, "relevance.cadence", "tool-round").relevance.cadence, "tool-round");
  assert.throws(() => updateSetting(settings, "relevance.cadence", "every-token"), SettingsError);
  assert.equal(updateSetting(settings, "decision.chunkSize", "10").decision.chunkSize, 10);
  assert.equal(updateSetting(settings, "relevance.maxSkills", "3").relevance.maxSkills, 3);
  assert.equal(updateSetting(settings, "relevance.maxSkills", "0").relevance.maxSkills, 0);
});
test("legacy settings migrate losslessly on load: threshold = raw / 2, direct when minLabel is directly_relevant", () => {
  const cases: [Record<string, unknown>, number][] = [
    [{ mode: "score", minLabel: "related", relatedThreshold: 0.75, directThreshold: 1.5 }, 0.375], // v0.2.0 defaults
    [{ minLabel: "directly_relevant", directThreshold: 1.75 }, 0.875],
    [{ minLabel: "directly_relevant" }, 0.75],
    [{ relatedThreshold: 1.25 }, 0.625],
    [{ relatedThreshold: 0, directThreshold: 0 }, 0],
    [{ minLabel: "directly_relevant", directThreshold: 2 }, 1],
    [{ relatedThreshold: 0.8, directThreshold: 1.1 }, 0.4],
  ];
  for (const [legacy, expected] of cases) {
    const warnings: string[] = [];
    const parsed = parseSettings({ relevance: { ...legacy, maxSkills: 7 } }, warnings);
    assert.equal(parsed.decision.threshold, expected, JSON.stringify(legacy));
    assert.equal(parsed.relevance.maxSkills, 7);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /Legacy settings migrated/);
    for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.equal(Object.hasOwn(parsed.relevance, removed), false);
  }
});
test("legacy choice mode migrates to score with one safe warning; an explicit threshold beats legacy keys", () => {
  const warnings: string[] = [];
  const parsed = parseSettings({ relevance: { mode: "choice", minLabel: "directly_relevant", directThreshold: 1.5 } }, warnings);
  assert.equal(parsed.decision.threshold, 0.75);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /Choice scoring was removed/);
  const both: string[] = [];
  assert.equal(parseSettings({ relevance: { threshold: 0.2, relatedThreshold: 1.25 } }, both).decision.threshold, 0.2);
  assert.equal(both.length, 1); assert.match(both[0], /threshold is set/);
});
test("invalid legacy values stay settings errors with their original rules, so the picker fails closed", async (t) => {
  for (const legacy of [{ mode: "unknown" }, { minLabel: "irrelevant" }, { relatedThreshold: -0.1 }, { directThreshold: 2.1 }, { relatedThreshold: "1" },
    { relatedThreshold: 1.6, directThreshold: 1.5 }, { relatedThreshold: 1.8 } /* defaults direct 1.5 */, { directThreshold: 0.5 } /* default related 0.75 */]) {
    assert.throws(() => parseSettings({ relevance: legacy }), SettingsError, JSON.stringify(legacy));
  }
  const path = join(await directory(t), "settings.json");
  await writeFile(path, JSON.stringify({ relevance: { relatedThreshold: 1.6, directThreshold: 1.5 } }));
  const result = await loadSettings(path);
  assert.match(result.error!, /ordered/); assert.equal(result.settings.backend, null);
  // Loading never rewrites the file; the legacy shape stays on disk until the next save.
  assert.equal(JSON.parse(await readFile(path, "utf8")).relevance.relatedThreshold, 1.6);
});
test("migrated settings load from disk without rewriting and save in the new shape", async (t) => {
  const path = join(await directory(t), "settings.json");
  const legacy = { relevance: { mode: "score", minLabel: "related", relatedThreshold: 1.25, directThreshold: 1.75, maxSkills: 5 } };
  await writeFile(path, JSON.stringify(legacy));
  const loaded = await loadSettings(path);
  assert.equal(loaded.error, undefined); assert.equal(loaded.settings.decision.threshold, 0.625); assert.equal(loaded.warnings.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy);
  await saveSettings(loaded.settings, path);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8")).relevance).sort(), Object.keys(defaultSettings().relevance).sort());
  assert.equal((await loadSettings(path)).settings.decision.threshold, 0.625);
});
test("removed settings cannot be set through the UI/CLI path and point to the threshold", () => {
  for (const key of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) {
    assert.throws(() => updateSetting(defaultSettings(), `relevance.${key}`, "score"), /Removed setting.*threshold/, key);
  }
});
test("UI/CLI updates share validation, no coercive booleans or scientific/fractional limits", () => {
  const settings = defaultSettings();
  assert.equal(updateSetting(settings, "decision.failMode", "open").decision.failMode, "open");
  assert.equal(updateSetting(settings, "relevance.enabled", "false").relevance.enabled, false);
  assert.equal(updateSetting(settings, "relevance.minCandidates", "0").relevance.minCandidates, 0);
  for (const [key, value] of [["enabled", "yes"], ["decision.chunkSize", "1e2"], ["relevance.maxSkills", "1.5"], ["decision.maxPromptChars", "5000"], ["relevance.pinned", "secret"], ["backend", "openai"]]) assert.throws(() => updateSetting(settings, key, value), SettingsError);
  assert.equal(settings.relevance.enabled, true);
});
test("the shipped example config parses without warnings and uses only the new shape", async () => {
  const text = await readFile(new URL("../examples/skill-picker-demo/config/pi-context-decisions.example.json", import.meta.url), "utf8");
  const warnings: string[] = [];
  const parsed = parseSettings(JSON.parse(text), warnings);
  assert.deepEqual(warnings, []); assert.equal(parsed.decision.threshold, 0.5); assert.equal(parsed.relevance.cadence, "prompt");
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.doesNotMatch(text, new RegExp(`"${removed}"`));
});

// ---- Opt-in tool/MCP filtering settings (`tools` block) ----

test("tools block defaults: off, tools mode, prompt cadence, fail closed, empty allowlists, independent per call", () => {
  const { tools } = defaultSettings();
  assert.deepEqual(tools, { enabled: false, mode: "tools", cadence: "prompt", maxAdded: 8, minCandidates: 0, alwaysAllowedTools: [], alwaysAllowedMcpServers: [] });
  assert.equal(defaultSettings().relevance.enabled, true, "skill filtering default is untouched");
  const a = defaultToolSettings(); a.alwaysAllowedTools.push("x"); assert.deepEqual(defaultToolSettings().alwaysAllowedTools, []);
  assert.deepEqual([...TOOL_FILTER_MODES], ["tools", "mcp"]); assert.deepEqual([...TOOL_CADENCES], ["initial", "prompt", "tool-round"]);
});
test("a settings file without `tools` loads identically, is never rewritten, and a partial block takes defaults", async (t) => {
  const path = join(await directory(t), "settings.json");
  const { tools: _omit, ...old } = defaultSettings();
  const text = JSON.stringify(old, null, 2) + "\n"; await writeFile(path, text);
  const loaded = await loadSettings(path);
  assert.equal(loaded.error, undefined); assert.deepEqual(loaded.warnings, []); assert.deepEqual(loaded.settings, defaultSettings());
  assert.equal(await readFile(path, "utf8"), text, "loading never rewrites the file");
  const partial = parseSettings({ tools: { enabled: true } });
  assert.deepEqual(partial.tools, { ...defaultToolSettings(), enabled: true });
  assert.deepEqual(parseSettings({ tools: {} }).tools, defaultToolSettings());
});
test("a saved tools block roundtrips with sorted, de-duplicated allowlists", async (t) => {
  const path = join(await directory(t), "settings.json");
  const settings = parseSettings({ ...defaultSettings(), decision: { ...defaultSettings().decision, threshold: 0.5 }, tools: { ...defaultToolSettings(), enabled: true, mode: "mcp", cadence: "tool-round", maxAdded: 3, alwaysAllowedTools: ["z_tool", "a_tool", "z_tool"], alwaysAllowedMcpServers: ["dev-radius", "docs"] } });
  await saveSettings(settings, path);
  const back = (await loadSettings(path)).settings;
  assert.deepEqual(back, settings);
  assert.deepEqual(back.tools.alwaysAllowedTools, ["a_tool", "z_tool"]); assert.deepEqual(back.tools.alwaysAllowedMcpServers, ["dev-radius", "docs"]);
});
test("every tools bound, enum and type is rejected when invalid", () => {
  const bad: Record<string, unknown[]> = {
    enabled: ["true", 1, null], mode: ["server", "", true, "TOOLS"], cadence: ["always", "tool_round", 3], failMode: ["maybe", true],
    threshold: [NaN, Infinity, -0.01, 1.01, "0.5", null, true], maxAdded: [-1, 1001, 1.5, NaN, "8"], minCandidates: [-1, 1001, 0.5, "0"], maxDescriptionChars: [0, 401, -1, 1.5, "400"],
    alwaysAllowedTools: ["x", 4, { a: 1 }], alwaysAllowedMcpServers: ["x", null],
  };
  for (const [key, values] of Object.entries(bad)) for (const value of values) assert.throws(() => parseSettings({ tools: { [key]: value } }), SettingsError, `${key}=${String(value)}`);
  for (const value of [null, [], "on", 1]) assert.throws(() => parseSettings({ tools: value }), SettingsError, "tools must be an object");
  for (const ok of [{ maxAdded: 0 }, { maxAdded: 1000 }, { minCandidates: 1000 }, { maxDescriptionChars: 1 }, { maxDescriptionChars: 400 }, { threshold: 0 }, { threshold: 1 }, ...TOOL_CADENCES.map((cadence) => ({ cadence })), ...TOOL_FILTER_MODES.map((mode) => ({ mode })), { failMode: "open" }]) {
    assert.doesNotThrow(() => parseSettings({ tools: ok }), JSON.stringify(ok));
  }
});
test("unknown tools keys warn on read and are rejected on write; credentials in the block are rejected without echo", () => {
  const warnings: string[] = [];
  assert.equal(parseSettings({ tools: { mystery: 1 } }, warnings).tools.enabled, false); assert.equal(warnings.length, 1);
  assert.throws(() => parseSettings({ tools: { ...defaultToolSettings(), mystery: 1 } }), SettingsError);
  assert.throws(() => parseSettings({ tools: { token: "SECRET-FIXTURE" } }), (error: unknown) => error instanceof SettingsError && !/SECRET-FIXTURE/.test(error.message));
});
test("tool allowlist names: 1-128 chars, no whitespace/control/format characters, at most 1000", () => {
  const parse = (names: unknown) => parseSettings({ tools: { alwaysAllowedTools: names } }).tools.alwaysAllowedTools;
  assert.deepEqual(parse(["mcp__srv__do-thing.v2", "a".repeat(128), "ünï"]), ["a".repeat(128), "mcp__srv__do-thing.v2", "ünï"]);
  for (const name of ["", "a".repeat(129), "a b", "a\tb", "a\nb", "a\u0000b", "a\u200bb", "a\u202eb", 4, null]) assert.throws(() => parse([name]), /Tool allowlist names/, JSON.stringify(name));
  assert.throws(() => parse(Array.from({ length: 1001 }, (_, i) => `t${i}`)), /Tool allowlist names/);
  assert.equal(parse(Array.from({ length: 1000 }, (_, i) => `t${i}`)).length, 1000);
});
test("MCP server allowlist names match [A-Za-z0-9_-]{1,64}; `-` and `_` spellings are one server", () => {
  const parse = (names: unknown) => parseSettings({ tools: { alwaysAllowedMcpServers: names } }).tools.alwaysAllowedMcpServers;
  assert.deepEqual(parse(["docs", "dev-radius", "dev_radius", "mcp__dev_radius", "A1"]), ["A1", "dev-radius", "docs"], "dev_radius and the canonical mcp__dev_radius fold into the first spelling");
  assert.deepEqual(parse(["dev_radius", "dev-radius"]), ["dev_radius"]);
  assert.equal(parse(["a".repeat(64)]).length, 1);
  for (const name of ["", "a".repeat(65), "a b", "a.b", "a/b", "a\nb", "ünï", "a:b", 3]) assert.throws(() => parse([name]), /MCP server \/ extension allowlist names/, JSON.stringify(name));
});
test("the canonical prefix is allowed IN ADDITION to the 64-character name bound, in settings", () => {
  const parse = (names: unknown) => parseSettings({ tools: { alwaysAllowedMcpServers: names } }).tools.alwaysAllowedMcpServers;
  const full = "x".repeat(64);
  assert.deepEqual(parse([`mcp__${full}`, full]), [`mcp__${full}`], "the canonical key and the raw name are one server");
  assert.deepEqual(parse([`ext__${full}`, "ext__Notes"]), [`ext__${full}`, "ext__notes"].sort());
  for (const name of [`mcp__${"x".repeat(65)}`, `ext__${"x".repeat(65)}`, `MCP__${full}`, `mcp_${full}x`]) assert.throws(() => parse([name]), /allowlist names/, name.length + name.slice(0, 8));
});
test("updateSetting edits tools scalars through the same validation; allowlist arrays are rejected", () => {
  const settings = defaultSettings();
  assert.equal(updateSetting(settings, "tools.mode", "mcp").tools.mode, "mcp");
  assert.equal(updateSetting(settings, "tools.enabled", "true").tools.enabled, true);
  assert.equal(updateSetting(settings, "tools.cadence", "initial").tools.cadence, "initial");
  assert.equal(updateSetting(settings, "decision.threshold", ".25").decision.threshold, 0.25);
  assert.equal(updateSetting(settings, "tools.maxAdded", "0").tools.maxAdded, 0);
  assert.equal(updateSetting(settings, "decision.failMode", "open").decision.failMode, "open");
  assert.equal(settings.tools.mode, "tools", "the input is never mutated");
  for (const [key, value] of [["tools.mode", "server"], ["tools.cadence", "sometimes"], ["tools.enabled", "yes"], ["decision.threshold", "1.5"], ["tools.maxAdded", "-1"], ["tools.maxAdded", "1001"], ["decision.maxDescriptionChars", "0"], ["tools.nope", "1"]]) {
    assert.throws(() => updateSetting(settings, key, value), SettingsError, `${key}=${value}`);
  }
  for (const key of ["tools.alwaysAllowedTools", "tools.alwaysAllowedMcpServers"]) assert.throws(() => updateSetting(settings, key, "x"), /allowlists/);
  assert.throws(() => updateSetting(settings, "tools", "x"), SettingsError);
});
test("changing a tool feature setting leaves skill policy and shared tuning alone", () => {
  const before = defaultSettings();
  const after = updateSetting(before, "tools.enabled", "true");
  assert.deepEqual({ ...after, tools: before.tools }, before);
  const skills = updateSetting(after, "relevance.enabled", "false");
  assert.equal(skills.tools.enabled, true); assert.equal(skills.relevance.enabled, false);
});

test("shared decision migration merges legacy policies conservatively, warns once, and never rewrites on load", async (t) => {
  const path = join(await directory(t), "settings.json");
  const legacy = { enabled: false, relevance: { enabled: true, threshold: 0.25, failMode: "open", maxDescriptionChars: 200, chunkSize: 3, concurrency: 2, timeoutMs: 1200, maxPromptChars: 90, maxSkills: 7 },
    tools: { enabled: true, threshold: 0.75, failMode: "closed", maxDescriptionChars: 60, maxAdded: 4 } };
  const text = JSON.stringify(legacy); await writeFile(path, text);
  const loaded = await loadSettings(path);
  assert.equal(loaded.error, undefined); assert.equal(loaded.warnings.length, 1); assert.match(loaded.warnings[0], /Legacy settings migrated/);
  assert.deepEqual(loaded.settings.decision, { threshold: 0.75, failMode: "closed", maxDescriptionChars: 60, chunkSize: 3, concurrency: 2, timeoutMs: 1200, maxPromptChars: 90 });
  assert.deepEqual([loaded.settings.relevance.enabled, loaded.settings.tools.enabled], [false, false]);
  assert.deepEqual([loaded.settings.relevance.maxSkills, loaded.settings.tools.maxAdded], [7, 4]);
  assert.equal(await readFile(path, "utf8"), text);
  const independent = updateSetting(loaded.settings, "tools.enabled", "true");
  assert.deepEqual([independent.relevance.enabled, independent.tools.enabled], [false, true]);
  await saveSettings(independent, path);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.hasOwn(saved, "enabled"), false);
  for (const group of [saved.relevance, saved.tools]) for (const key of Object.keys(defaultSettings().decision)) assert.equal(Object.hasOwn(group, key), false, key);
  assert.deepEqual((await loadSettings(path)).warnings, []);
});

test("explicit shared values win per field; a lone legacy feature value migrates, and omitted fields keep defaults", () => {
  assert.deepEqual(parseSettings({ tools: { threshold: 0.5, failMode: "open", maxDescriptionChars: 50 } }).decision,
    { ...defaultSettings().decision, threshold: 0.5, failMode: "open", maxDescriptionChars: 50 });
  const warnings: string[] = [];
  const parsed = parseSettings({ relevance: { threshold: 0.9, maxPromptChars: 123, maxDescriptionChars: 90, failMode: "closed" },
    tools: { threshold: 0.8, maxDescriptionChars: 40 }, decision: { threshold: 0.2, maxDescriptionChars: 150, failMode: "open" } }, warnings);
  assert.deepEqual(parsed.decision, { ...defaultSettings().decision, threshold: 0.2, maxPromptChars: 123, maxDescriptionChars: 150, failMode: "open" });
  assert.equal(warnings.length, 1);
  assert.deepEqual(parseSettings({ enabled: true, relevance: { enabled: false }, tools: { enabled: true } }).relevance.enabled, false);
});

test("shadowed legacy values and all shared bounds stay errors; shared saves cannot retain old scalar setters", () => {
  for (const [key, bad] of Object.entries({ threshold: 1.1, chunkSize: 51, concurrency: 33, timeoutMs: 0, maxPromptChars: 4001, maxDescriptionChars: 401, failMode: "maybe" })) {
    assert.throws(() => parseSettings({ decision: { [key]: bad } }), SettingsError, key);
    assert.throws(() => parseSettings({ relevance: { [key]: bad }, decision: defaultSettings().decision }), SettingsError, key);
  }
  for (const [key, bad] of Object.entries({ threshold: -1, failMode: true, maxDescriptionChars: 0 })) {
    assert.throws(() => parseSettings({ tools: { [key]: bad }, decision: defaultSettings().decision }), SettingsError, key);
  }
  for (const enabled of ["false", null, 0]) assert.throws(() => parseSettings({ enabled }), SettingsError);
  for (const key of Object.keys(defaultSettings().decision)) assert.throws(() => updateSetting(defaultSettings(), `relevance.${key}`, "1"), /use decision/);
  for (const key of ["threshold", "failMode", "maxDescriptionChars"]) assert.throws(() => updateSetting(defaultSettings(), `tools.${key}`, "1"), /use decision/);
  assert.throws(() => updateSetting(defaultSettings(), "enabled", "false"), /Removed master switch/);
});

test("settings documentation canonical defaults stay valid, warning-free and in sync", async () => {
  const settingsDoc = await readFile(new URL("../docs/settings.md", import.meta.url), "utf8");
  const json = /Canonical settings shape \(defaults\):\s+```json\n([\s\S]*?)\n```/.exec(settingsDoc)?.[1];
  assert.ok(json);
  const warnings: string[] = [];
  assert.deepEqual(parseSettings(JSON.parse(json), warnings), defaultSettings());
  assert.deepEqual(warnings, []);
});
