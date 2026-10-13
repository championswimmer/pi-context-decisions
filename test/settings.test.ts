import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSettings, loadSettings, parseSettings, saveSettings, SettingsError, updateSetting, validateBackendSelection } from "../src/settings.ts";
import { OPENROUTER_DECISION_MODELS } from "../src/catalog/openrouter-models.ts";

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "context-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("defaults are independent, disabled until a backend is chosen, fail closed, and bounded", async (t) => {
  const a = defaultSettings(); const b = defaultSettings(); a.relevance.pinned.push("one");
  assert.deepEqual(b.relevance.pinned, []); assert.equal(b.backend, null); assert.equal(b.relevance.failMode, "closed");
  assert.equal(b.relevance.maxPromptChars, 4000); assert.equal(b.relevance.maxDescriptionChars, 400); assert.equal(b.relevance.chunkSize, 50); assert.equal(b.relevance.concurrency, 0);
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
  assert.equal(parsed.enabled, false); assert.equal(parsed.relevance.cadence, "tool-round"); assert.equal(parsed.relevance.threshold, 0.375); assert.equal(warnings.length, 2);
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
  const next = { ...settings, enabled: false }; await saveSettings(next, path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, false);
});
test("invalid writes leave existing file unchanged; rename failure cleans temp", async (t) => {
  const root = await directory(t); const path = join(root, "settings.json"); await saveSettings(defaultSettings(), path);
  const original = await readFile(path, "utf8");
  await assert.rejects(saveSettings({ ...defaultSettings(), relevance: { ...defaultSettings().relevance, failMode: "bad" as "open" } }, path), SettingsError);
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
  const { relevance } = defaultSettings();
  assert.equal(relevance.threshold, 0.375); assert.equal(relevance.cadence, "prompt"); assert.equal(relevance.maxSkills, 12); assert.equal(relevance.chunkSize, 50);
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.equal(Object.hasOwn(relevance, removed), false, removed);
});
test("decimal thresholds persist, old settings receive defaults, and bad bounds/types are rejected", async (t) => {
  assert.equal(parseSettings({ relevance: { chunkSize: 5 } }).relevance.threshold, 0.375);
  const settings = updateSetting(defaultSettings(), "relevance.threshold", "0.625");
  assert.equal(settings.relevance.threshold, 0.625);
  const path = join(await directory(t), "settings.json");
  await saveSettings(settings, path); assert.equal((await loadSettings(path)).settings.relevance.threshold, 0.625);
  const text = JSON.parse(await readFile(path, "utf8")).relevance;
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.equal(Object.hasOwn(text, removed), false, `save writes only the new shape (${removed})`);
  for (const ok of [0, 1, 0.5, 0.375]) assert.equal(parseSettings({ relevance: { threshold: ok } }).relevance.threshold, ok);
  for (const value of [NaN, Infinity, -0.01, 1.01, 2, "0.5", true, null]) assert.throws(() => parseSettings({ relevance: { threshold: value } }), SettingsError);
  for (const value of ["NaN", "Infinity", "-1", "1.01", "2", "1e0", "true", "1.2.3", ""]) assert.throws(() => updateSetting(settings, "relevance.threshold", value), SettingsError);
  assert.equal(updateSetting(settings, "relevance.threshold", ".5").relevance.threshold, 0.5);
  assert.equal(updateSetting(settings, "relevance.threshold", "1").relevance.threshold, 1);
});
test("cadence is a validated enum and every picker control updates through the shared path", () => {
  const settings = defaultSettings();
  assert.equal(updateSetting(settings, "relevance.cadence", "tool-round").relevance.cadence, "tool-round");
  assert.throws(() => updateSetting(settings, "relevance.cadence", "every-token"), SettingsError);
  assert.equal(updateSetting(settings, "relevance.chunkSize", "10").relevance.chunkSize, 10);
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
    assert.equal(parsed.relevance.threshold, expected, JSON.stringify(legacy));
    assert.equal(parsed.relevance.maxSkills, 7);
    assert.deepEqual(warnings, [], "a clean migration raises no warning");
    for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.equal(Object.hasOwn(parsed.relevance, removed), false);
  }
});
test("legacy choice mode migrates to score with one safe warning; an explicit threshold beats legacy keys", () => {
  const warnings: string[] = [];
  const parsed = parseSettings({ relevance: { mode: "choice", minLabel: "directly_relevant", directThreshold: 1.5 } }, warnings);
  assert.equal(parsed.relevance.threshold, 0.75);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /Choice scoring was removed/);
  const both: string[] = [];
  assert.equal(parseSettings({ relevance: { threshold: 0.2, relatedThreshold: 1.25 } }, both).relevance.threshold, 0.2);
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
  assert.equal(loaded.error, undefined); assert.equal(loaded.settings.relevance.threshold, 0.625); assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy);
  await saveSettings(loaded.settings, path);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8")).relevance).sort(), Object.keys(defaultSettings().relevance).sort());
  assert.equal((await loadSettings(path)).settings.relevance.threshold, 0.625);
});
test("removed settings cannot be set through the UI/CLI path and point to the threshold", () => {
  for (const key of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) {
    assert.throws(() => updateSetting(defaultSettings(), `relevance.${key}`, "score"), /Removed setting.*threshold/, key);
  }
});
test("UI/CLI updates share validation, no coercive booleans or scientific/fractional limits", () => {
  const settings = defaultSettings();
  assert.equal(updateSetting(settings, "relevance.failMode", "open").relevance.failMode, "open");
  assert.equal(updateSetting(settings, "enabled", "false").enabled, false);
  assert.equal(updateSetting(settings, "relevance.minCandidates", "0").relevance.minCandidates, 0);
  for (const [key, value] of [["enabled", "yes"], ["relevance.chunkSize", "1e2"], ["relevance.maxSkills", "1.5"], ["relevance.maxPromptChars", "5000"], ["relevance.pinned", "secret"], ["backend", "openai"]]) assert.throws(() => updateSetting(settings, key, value), SettingsError);
  assert.equal(settings.enabled, true);
});
test("the shipped example config parses without warnings and uses only the new shape", async () => {
  const text = await readFile(new URL("../examples/skill-picker-demo/config/pi-context-decisions.example.json", import.meta.url), "utf8");
  const warnings: string[] = [];
  const parsed = parseSettings(JSON.parse(text), warnings);
  assert.deepEqual(warnings, []); assert.equal(parsed.relevance.threshold, 0.5); assert.equal(parsed.relevance.cadence, "prompt");
  for (const removed of ["mode", "minLabel", "relatedThreshold", "directThreshold"]) assert.doesNotMatch(text, new RegExp(`"${removed}"`));
});
