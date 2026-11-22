import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { OPENROUTER_DECISION_MODELS, OPENROUTER_DECISION_SNAPSHOT, getOpenRouterDecisionModel, isAllowedOpenRouterModel } from "../src/catalog/openrouter-models.ts";
import { buildPickerEntries, type PickerSelection } from "../src/catalog/picker-models.ts";

// Provenance: .agents/research/openrouter-weekly-popularity-2026-11-21.md
// and .agents/research/openrouter-clef-d1-microsoft-perplexity-2026-11-22.md.
// Expected values intentionally independent of implementation.
const EXPECTED = [
  ["typesafe/jev-1.14", "2228772203880"],
  ["liquid/d1-ultra", "275356685190"],
  ["perplexity/pplx-decider-v1.3:free", "232109682778"],
  ["liquid/d1.1", "93715760755"],
  ["perplexity/pplx-decider-flash-v1.3:free", "60108700793"],
  ["nace-ai/drex-max", "41326695423"],
  ["google/gemini-decision-1", "39751518937"],
  ["cloudflare/clef-flash", "26557452284"],
  ["liquid/d1.2-ultra", "19599199230"],
  ["microsoft/microsoft-decision-1.1", "12876482257"],
  ["cloudflare/clef", "12243330513"],
  ["liquid/d1.2", "9525052959"],
  ["cloudflare/clef-omni", "2391884447"],
];
function selectionId(selection: PickerSelection): string | undefined {
  if (selection.backend === "openrouter") return selection.model;
  if (selection.backend === "pi" && selection.provider === "openrouter") return selection.id;
  return undefined;
}

test("checked-in catalog preserves the actual weekly ranks of both retained and added models", () => {
  assert.equal(OPENROUTER_DECISION_MODELS.length, 13);
  assert.deepEqual(OPENROUTER_DECISION_MODELS.map((m) => m.popularityRank), [2, 4, 5, 6, 8, 9, 10, 12, 14, 16, 17, 20, 26]);
  assert.deepEqual(OPENROUTER_DECISION_MODELS.map((m) => [m.id, m.weeklyTokens]), EXPECTED);
  assert.equal(new Set(OPENROUTER_DECISION_MODELS.map((m) => m.id)).size, 13);
  for (let i = 0; i < OPENROUTER_DECISION_MODELS.length; i++) {
    const model = OPENROUTER_DECISION_MODELS[i];
    assert.ok(model.name && model.canonicalSlug);
    assert.match(model.weeklyTokens, /^[1-9]\d*$/);
    if (i > 0) assert.ok(BigInt(OPENROUTER_DECISION_MODELS[i - 1].weeklyTokens) > BigInt(model.weeklyTokens));
  }
});

test("snapshot records actual token window, date and unofficial primary-source provenance", () => {
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.snapshotDate, "2026-11-21");
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.windowStart, "2026-11-14");
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.usageThrough, "2026-11-20");
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.metric, "prompt + completion tokens");
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.unofficial, true);
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.catalogUrl, "https://openrouter.ai/api/v1/models?output_modalities=decisions");
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.rankingsUrl, "https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens");
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.license, "CC BY 4.0");
  assert.match(OPENROUTER_DECISION_SNAPSHOT.attribution, /Static checked-in snapshot/);
});

test("exact ID lookup excludes removed models, aliases and unknown models", () => {
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.originalCount, 10);
  assert.equal(OPENROUTER_DECISION_SNAPSHOT.routingCheckedDate, "2026-10-12");
  assert.deepEqual(OPENROUTER_DECISION_SNAPSHOT.excludedIds, ["typesafe/jev-1.13", "perplexity/pplx-decider-v1.2", "openai/gpt-6-luna-decisions"]);
  assert.ok(Object.isFrozen(OPENROUTER_DECISION_SNAPSHOT.excludedIds));
  for (const id of [...OPENROUTER_DECISION_SNAPSHOT.excludedIds, "inception/mercury-decide:free", "~typesafe/jev-latest", "perplexity/pplx-decider-v1.3", "microsoft/microsoft-decision-1", "liquid/d1", "~liquid/d1-latest", "unknown/model", "TYPESAFE/jev-1.14", "typesafe/jev-1.14-20261014"]) {
    assert.equal(getOpenRouterDecisionModel(id), undefined);
    assert.equal(isAllowedOpenRouterModel(id), false);
  }
  for (const model of OPENROUTER_DECISION_MODELS) assert.equal(isAllowedOpenRouterModel(model.id), true);
});

test("snapshot and each model are immutable", () => {
  assert.ok(Object.isFrozen(OPENROUTER_DECISION_SNAPSHOT));
  assert.ok(Object.isFrozen(OPENROUTER_DECISION_MODELS));
  for (const model of OPENROUTER_DECISION_MODELS) assert.ok(Object.isFrozen(model));
  assert.equal(Reflect.set(OPENROUTER_DECISION_MODELS[0], "id", "other"), false);
  assert.equal(OPENROUTER_DECISION_MODELS[0].id, "typesafe/jev-1.14");
});

test("picker preserves all non-OpenRouter classifiers, identities, auth labels, and deduplicates", () => {
  const entries = buildPickerEntries({ piClassifiers: [
    { provider: "custom", id: "nested/model", name: "Custom" },
    { provider: "llama.cpp", id: "nested/model" },
    { provider: "custom", id: "nested/model", name: "duplicate" },
    { provider: "openai", id: "gpt-6-luna" },
    { provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" },
  ], auth: { custom: "missing", openai: "ok" } });
  const native = entries.filter((entry) => entry.group === "pi-native");
  assert.deepEqual(native.map((e) => e.selection), [
    { backend: "pi", provider: "custom", id: "nested/model" },
    { backend: "pi", provider: "llama.cpp", id: "nested/model" },
    { backend: "pi", provider: "openai", id: "gpt-6-luna" },
    { backend: "pi", provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" },
  ]);
  assert.deepEqual(native.map((e) => e.authStatus), ["missing", "unknown", "ok", "unknown"]);
});

test("router offers only retained IDs, even when excluded models are registered with Pi", () => {
  const entries = buildPickerEntries({ piClassifiers: [
    { provider: "openrouter", id: "typesafe/jev-1.14" },
    { provider: "openrouter", id: "typesafe/jev-1.14" },
    { provider: "openrouter", id: "typesafe/jev-1.13" },
    { provider: "openrouter", id: "perplexity/pplx-decider-v1.3:free" },
    { provider: "openrouter", id: "openai/gpt-6-luna-decisions" },
    { provider: "openrouter", id: "perplexity/pplx-decider-v1.3" },
    { provider: "openrouter", id: "~typesafe/jev-latest" },
    { provider: "openrouter", id: "microsoft/microsoft-decision-1" },
    { provider: "openrouter", id: "microsoft/microsoft-decision-1.1" },
    { provider: "openrouter", id: "unknown/new-decision" },
  ], auth: { openrouter: "missing" } });
  const router = entries.filter((entry) => entry.group === "openrouter-catalog");
  assert.equal(router.length, 16);
  assert.deepEqual(router.filter((entry) => entry.selection.backend === "openrouter").map((entry) => selectionId(entry.selection)), EXPECTED.map(([id]) => id));
  assert.deepEqual(router.filter((entry) => entry.selection.backend === "pi").map((entry) => selectionId(entry.selection)), ["typesafe/jev-1.14", "perplexity/pplx-decider-v1.3:free", "microsoft/microsoft-decision-1.1"]);
  assert.equal(new Set(router.map((entry) => selectionId(entry.selection))).size, 13);
  assert.match(router.find((entry) => selectionId(entry.selection) === "microsoft/microsoft-decision-1.1")?.note ?? "", /^#16 ·/);
  for (const entry of router) {
    assert.equal(entry.authStatus, "missing");
    assert.match(entry.note ?? "", /static snapshot 2026-11-21/);
    assert.match(entry.note ?? "", /unofficial OpenRouter rankings/);
    assert.match(entry.note ?? "", /2026-11-14–2026-11-20/);
  }
  assert.ok(router.some((entry) => entry.selection.backend === "openrouter" && entry.selection.model === "google/gemini-decision-1"));
  assert.ok(!router.some((entry) => entry.selection.backend === "pi" && entry.selection.id === "google/gemini-decision-1"));
});

test("direct TypeSafe/OpenAI remain selectable and caller arrays aren't mutated", () => {
  const classifiers = Object.freeze([{ provider: "openai", id: "gpt-6-luna" }]);
  const entries = buildPickerEntries({ piClassifiers: classifiers, auth: { typesafe: "ok", openai: "missing" } });
  assert.deepEqual(entries.filter((e) => e.group === "direct").map((e) => e.selection), [
    { backend: "typesafe", model: "jev-latest" },
    { backend: "typesafe", model: "jev-1.13.0" },
    { backend: "openai", model: "gpt-6-luna" },
  ]);
  assert.equal(classifiers.length, 1);
  assert.equal(entries.filter((entry) => entry.group === "openrouter-catalog").length, 13);
});

test("runtime picker/catalog do not call network or change checked-in ranking", () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Network forbidden"); };
  try {
    assert.equal(buildPickerEntries({ piClassifiers: [], auth: {} }).filter((e) => e.group === "openrouter-catalog").length, 13);
    assert.equal(getOpenRouterDecisionModel("typesafe/jev-1.14")?.weeklyTokens, "2228772203880");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("catalog scope contains no dynamic discovery, cache, or HTTP modules", async () => {
  const directory = new URL("../src/catalog/", import.meta.url);
  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, ["openrouter-models.ts", "picker-models.ts"]);
  for (const file of files) {
    const text = await readFile(new URL(file, directory), "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(|\bset(?:Timeout|Interval)\s*\(|node:(?:fs|http|https)|registerProvider\s*\(/);
  }
});
