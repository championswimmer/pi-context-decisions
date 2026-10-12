import assert from "node:assert/strict";
import test from "node:test";
import { createBackend, createDecisionClient, pickSkills } from "../src/index.ts";
import type { BackendSelection, RegistryLike, JsonValue } from "../src/index.ts";

const skills = Array.from({ length: 30 }, (_, index) => ({
  name: `demo-skill-${index}`, description: `Specialized task guidance ${index}`,
  filePath: `/PRIVATE/${index}/SKILL.md`, body: "PRIVATE_BODY", extra: "PRIVATE_EXTRA",
}));
const prompt = "Implement a user interface and test it";
function value(name: string): number { return [0, 0.5, 1, 1.25, 1.5, 2][Number(name.split("-").at(-1)) % 6]; }
function metadata(state: Record<string, JsonValue>) {
  assert.deepEqual(Object.keys(state).sort(), ["skills", "task"]);
  assert.equal(state.task, prompt);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|filePath|body|extra/);
  const entries = state.skills as Record<string, { name: string; description: string }>;
  for (const entry of Object.values(entries)) assert.deepEqual(Object.keys(entry).sort(), ["description", "name"]);
  return entries;
}
function fixture(selection: BackendSelection, wait?: () => Promise<void>) {
  const batches: number[] = [];
  const observed: string[] = [];
  const capture = (state: Record<string, JsonValue>) => {
    const entries = metadata(state); batches.push(Object.keys(entries).length);
    observed.push(...Object.values(entries).map((entry) => entry.name)); return entries;
  };
  const registry: RegistryLike = {
    getModelsOfType: () => [], findOfType: () => ({ provider: "fixture", id: "classifier" }),
    getApiKeyForProvider: async () => "FIXTURE_KEY",
    async classify(_model, request) {
      const entries = capture(request.state);
      await wait?.();
      assert.ok(Object.values(request.questions).every((q) => q.type === "score" && q.criteria.length === 3));
      return { stopReason: "stop", answers: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { type: "score", score: value(entry.name) }])) };
    },
  };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const wire = JSON.parse(init!.body as string);
    assert.doesNotMatch(init!.body as string, /PRIVATE/);
    if (selection.backend === "openai") {
      const entries = capture(JSON.parse(wire.input));
      await wait?.();
      assert.equal(wire.questions.length, Object.keys(entries).length);
      return Response.json({ answers: wire.questions.map((q: { name: string; type: string; levels: unknown[] }) => {
        assert.equal(q.type, "score"); assert.equal(q.levels.length, 3);
        return { name: q.name, type: "score", score: value(entries[q.name].name) };
      }) });
    }
    const entries = capture(wire.state);
    await wait?.();
    assert.deepEqual(Object.keys(wire.questions), Object.keys(entries));
    return Response.json({ answers: Object.fromEntries(Object.entries(entries).map(([id, entry]) => {
      const score = value(entry.name);
      return [id, { type: "score", score, ...(selection.backend === "typesafe" ? {
        confidence: 0.9, probabilities: { "0": 1 - score / 2, "1": 0, "2": score / 2 },
        legend: { "0": "Irrelevant", "1": "Related", "2": "Directly relevant" },
      } : {}) }];
    })) });
  };
  const client = createDecisionClient(createBackend(selection, { registry, getRegistry: () => registry, env: {}, http: { fetch } }));
  return { client, batches, observed };
}
const selections: BackendSelection[] = [
  { backend: "pi", provider: "fixture", id: "classifier" }, { backend: "typesafe" },
  { backend: "openai" }, { backend: "openrouter", model: "typesafe/jev-1.13" },
];
for (const selection of selections) test(`${selection.backend} core selects the same relevant skills across all 30 metadata-only candidates`, async () => {
  const { client, batches, observed } = fixture(selection);
  const result = await pickSkills(prompt, skills, client, { chunkSize: 7, maxQuestions: 5, concurrency: 2, relatedThreshold: 1.25, directThreshold: 1.5, maxSkills: 6 });
  assert.equal(result.reason, "filtered"); assert.equal(result.candidates, 30); assert.equal(result.items!.length, 30);
  assert.deepEqual(batches, [5, 5, 5, 5, 5, 5]); assert.deepEqual(observed, skills.map((skill) => skill.name));
  assert.deepEqual(result.kept.map((skill) => skill.name), ["demo-skill-4", "demo-skill-5", "demo-skill-11", "demo-skill-17", "demo-skill-23", "demo-skill-29"]);
  assert.equal(result.kept[0], skills[4]); assert.equal(skills.length, 30);
});
test("explicit pick has no minimum inventory, honors inclusive raw threshold and batch-size changes", async () => {
  const { client, batches } = fixture({ backend: "openai" });
  const broad = await pickSkills(prompt, skills, client, { chunkSize: 8, relatedThreshold: 1.25, maxSkills: 30 });
  assert.deepEqual(batches, [8, 8, 8, 6]); assert.equal(broad.kept.length, 15);
  const strict = await pickSkills(prompt, skills, client, { chunkSize: 3, relatedThreshold: 1.5, directThreshold: 1.5, maxSkills: 30 });
  assert.equal(strict.kept.length, 10); assert.deepEqual(batches.slice(4), Array(10).fill(3));
  const tiny = await pickSkills(prompt, skills.slice(4, 6), client, { maxSkills: 1 });
  assert.deepEqual(tiny.kept, [skills[5]]);
});
test("picker failures stay closed and malformed options never imply fail-open", async () => {
  const { client } = fixture({ backend: "openrouter", model: "typesafe/jev-1.13" });
  const invalid = await pickSkills(prompt, skills, client, { relatedThreshold: 2.1 });
  assert.equal(invalid.reason, "fail-closed"); assert.deepEqual(invalid.kept, []); assert.equal(invalid.errorCode, "config");
  const absent = await pickSkills(prompt, skills, null); assert.equal(absent.skipReason, "unconfigured");
  assert.deepEqual(absent.kept, skills);
});
for (const selection of selections) test(`${selection.backend} transport dispatches eight actual 50-question requests for 400 skills in parallel`, async () => {
  const largeSkills = Array.from({ length: 400 }, (_, index) => ({
    name: `demo-skill-${index}`, description: `Specialized task guidance ${index}`,
    filePath: `/PRIVATE/${index}/SKILL.md`, body: "PRIVATE_BODY", extra: "PRIVATE_EXTRA",
  }));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { client, batches, observed } = fixture(selection, () => pending);
  const picking = pickSkills(prompt, largeSkills, client, { maxSkills: 400, relatedThreshold: 1.25 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  // The real adapter/codec sees all eight full endpoint requests before any succeeds.
  assert.deepEqual(batches, Array(8).fill(50));
  assert.deepEqual(observed, largeSkills.map((skill) => skill.name));
  release();
  const result = await picking;
  assert.equal(result.reason, "filtered"); assert.equal(result.items?.length, 400);
  assert.deepEqual(result.batchSizes, Array(8).fill(50));
  assert.deepEqual(result.kept, largeSkills.filter((skill) => value(skill.name) >= 1.25));
});
