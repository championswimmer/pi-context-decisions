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
  const parsed = parseSettings({ enabled: false, relevance: { mode: "choice", mystery: 1 }, extra: 1 }, warnings);
  assert.equal(parsed.enabled, false); assert.equal(parsed.relevance.mode, "choice"); assert.equal(warnings.length, 2);
  assert.throws(() => parseSettings({ ...defaultSettings(), mystery: 1 }), SettingsError);
});
test("invalid settings cannot enable unbounded disclosure or invalid fail-open", () => {
  for (const [key, value] of Object.entries({ maxPromptChars: 4001, maxDescriptionChars: 401, chunkSize: 51, concurrency: 33, timeoutMs: 300001, maxSkills: -1, minCandidates: 1001, mode: "unknown", minLabel: "irrelevant", failMode: true, enabled: "true", pinned: ["bad\nname"] })) {
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
test("decimal thresholds persist, receive defaults in old settings, and reject bad bounds/order", async (t) => {
  assert.equal(parseSettings({ relevance: { chunkSize: 5 } }).relevance.relatedThreshold, 0.75);
  const settings = updateSetting(defaultSettings(), "relevance.relatedThreshold", "1.25");
  assert.equal(settings.relevance.relatedThreshold, 1.25);
  const path = join(await directory(t), "settings.json");
  await saveSettings(settings, path); assert.equal((await loadSettings(path)).settings.relevance.relatedThreshold, 1.25);
  assert.equal(updateSetting(settings, "relevance.directThreshold", "1.8").relevance.directThreshold, 1.8);
  for (const value of [NaN, Infinity, -0.1, 2.1, "1", true]) assert.throws(() => parseSettings({ relevance: { relatedThreshold: value } }), SettingsError);
  assert.throws(() => parseSettings({ relevance: { relatedThreshold: 1.6, directThreshold: 1.5 } }), SettingsError);
  for (const value of ["NaN", "Infinity", "-1", "2.1", "1e0", "true", "1.2.3"]) assert.throws(() => updateSetting(settings, "relevance.relatedThreshold", value), SettingsError);
});
test("UI/CLI updates share validation, no coercive booleans or scientific/fractional limits", () => {
  const settings = defaultSettings();
  assert.equal(updateSetting(settings, "relevance.failMode", "open").relevance.failMode, "open");
  assert.equal(updateSetting(settings, "enabled", "false").enabled, false);
  assert.equal(updateSetting(settings, "relevance.minCandidates", "0").relevance.minCandidates, 0);
  for (const [key, value] of [["enabled", "yes"], ["relevance.chunkSize", "1e2"], ["relevance.maxSkills", "1.5"], ["relevance.maxPromptChars", "5000"], ["relevance.pinned", "secret"], ["backend", "openai"]]) assert.throws(() => updateSetting(settings, key, value), SettingsError);
  assert.equal(settings.enabled, true);
});
