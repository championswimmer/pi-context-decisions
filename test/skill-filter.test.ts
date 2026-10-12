import test from "node:test";
import assert from "node:assert/strict";
import { applySkillAdvertisementFilter, filterSkills } from "../src/apps/skill-filter.ts";
import type { RelevanceClient, RelevanceItem } from "../src/apps/relevance.ts";

const skills = ["alpha", "beta", "gamma", "delta"].map((name) => ({ name, description: `${name} description`, filePath: `/${name}/SKILL.md` }));
function item(name: string, score: number, label: RelevanceItem["label"] = "related"): RelevanceItem {
  return { name, score, normalized: score / 2, label };
}
const items = [item("alpha", 1), item("beta", 2, "directly_relevant"), item("gamma", 0, "irrelevant"), item("delta", 1.5, "directly_relevant")];
const client: RelevanceClient = { decide: async (req) => ({ answers: Object.fromEntries(Object.keys(req.questions).map((id, index) => [id, { type: "score", score: index % 2 ? 2 : 0 }])) }) };

test("filter selects highest scores with cap and preserves original order/references", () => {
  const result = filterSkills(skills, items, { maxSkills: 2 });
  assert.deepEqual(result.kept, [skills[1], skills[3]]);
  assert.equal(result.kept[0], skills[1]);
  assert.deepEqual(result.dropped, ["alpha", "gamma"]);
  assert.equal(result.reason, "filtered");
  assert.deepEqual(filterSkills(skills, items, { minLabel: "directly_relevant" }).kept, [skills[1], skills[3]]);
});

test("explicit pins bypass threshold/cap, duplicate names first-win, manual-only skills remain untouched", () => {
  const manual = { name: "manual", description: "not automatic", disableModelInvocation: true };
  const duplicate = { ...skills[0], filePath: "/duplicate" };
  const inventory = [...skills, duplicate, manual];
  const result = filterSkills(inventory, items, { pinned: ["gamma", "unknown"], maxSkills: 1 });
  assert.deepEqual(result.kept, [skills[1], skills[2], manual]);
  assert.equal(result.kept.at(-1), manual);
  assert.deepEqual(filterSkills(inventory, items, { maxSkills: 0, pinned: ["alpha"] }).kept, [skills[0], manual]);
});

test("default failure closed hides unverified advertisements, retaining only explicit pins/manual-only", () => {
  const manual = { name: "manual", description: "manual", disableModelInvocation: true };
  const result = filterSkills([...skills, manual], null, { pinned: ["gamma"] });
  assert.equal(result.reason, "fail-closed");
  assert.deepEqual(result.kept, [skills[2], manual]);
  assert.deepEqual(filterSkills(skills, null).kept, []);
});

test("explicit fail-open retains original inventory and references, never implied by invalid options", () => {
  const result = filterSkills(skills, null, { failMode: "open" });
  assert.equal(result.reason, "fail-open");
  assert.deepEqual(result.kept, skills);
  assert.equal(result.kept[0], skills[0]);
  assert.equal(filterSkills(skills, null, { failMode: "open", maxSkills: -1 }).reason, "fail-closed");
});

test("partial, duplicated, unknown, and malformed results trigger documented failure policy", () => {
  for (const malformed of [items.slice(0, 3), [...items, items[0]], [...items, item("other", 1)],
    items.map((i) => ({ ...i, score: NaN })), items.map((i) => ({ ...i, normalized: 3 }))]) {
    assert.equal(filterSkills(skills, malformed).reason, "fail-closed");
    assert.equal(filterSkills(skills, malformed, { failMode: "open" }).reason, "fail-open");
  }
});

test("disabled/unconfigured/empty-prompt/below-minimum leave array identity unchanged and make no calls", async () => {
  const never: RelevanceClient = { decide: async () => { throw new Error("should not call"); } };
  const cases = [
    { options: { enabled: false }, prompt: "task", client: never, reason: "disabled" },
    { options: { relevanceEnabled: false }, prompt: "task", client: never, reason: "disabled" },
    { options: {}, prompt: "task", client: null, reason: "unconfigured" },
    { options: {}, prompt: "  ", client: never, reason: "empty-prompt" },
    { options: {}, prompt: "task", client: never, reason: "below-minimum" },
  ];
  for (const entry of cases) {
    const event = { prompt: entry.prompt, systemPromptOptions: { skills } };
    const result = await applySkillAdvertisementFilter(event, entry.client, entry.options);
    assert.equal(result.reason, "skipped");
    assert.equal(result.skipReason, entry.reason);
    assert.equal(event.systemPromptOptions.skills, skills);
    assert.equal(result.kept, skills);
  }
});

test("threshold counts deduped automatic candidates, not manual-only inventory", async () => {
  const event = { prompt: "task", systemPromptOptions: { skills: [...skills, skills[0], { name: "manual", description: "manual", disableModelInvocation: true }] } };
  const result = await applySkillAdvertisementFilter(event, { decide: async () => { throw new Error("should not call"); } }, { minCandidates: 5 });
  assert.equal(result.candidates, 4);
  assert.equal(result.skipReason, "below-minimum");
});

test("early helper changes ONLY skills, later observer sees selection, all other state stays identical", async () => {
  const selectedTools = ["read", "bash"];
  const sections = { mcp_servers: "MCP inventory", other: "do not alter" };
  const manual = { name: "manual", description: "manual", disableModelInvocation: true };
  const event = { prompt: "task", systemPrompt: "original", systemPromptOptions: { skills: [...skills, manual], selectedTools, sections } };
  const result = await applySkillAdvertisementFilter(event, client, { minCandidates: 1 });
  assert.equal(result.reason, "filtered");
  assert.deepEqual(event.systemPromptOptions.skills, [skills[1], skills[3], manual]);
  assert.equal(event.systemPromptOptions.selectedTools, selectedTools);
  assert.equal(event.systemPromptOptions.sections, sections);
  assert.equal(event.systemPrompt, "original");
  assert.equal(event.prompt, "task");
  const laterObserver = () => event.systemPromptOptions.skills;
  assert.equal(laterObserver(), result.kept);
  assert.equal(skills.length, 4, "source inventory remains intact for manual resolution/next turn");
});

test("decision failure produces explicit safe code and closed advertisements, optional open is explicit", async () => {
  const failing: RelevanceClient = { decide: async () => { throw Object.assign(new Error("PRIVATE api key and prompt"), { code: "auth" }); } };
  const event = { prompt: "task", systemPromptOptions: { skills } };
  const result = await applySkillAdvertisementFilter(event, failing, { minCandidates: 1 });
  assert.equal(result.reason, "fail-closed");
  assert.equal(result.errorCode, "auth");
  assert.deepEqual(event.systemPromptOptions.skills, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|api key/);
  const openEvent = { prompt: "task", systemPromptOptions: { skills } };
  const opened = await applySkillAdvertisementFilter(openEvent, failing, { minCandidates: 1, failMode: "open" });
  assert.equal(opened.reason, "fail-open");
  assert.deepEqual(openEvent.systemPromptOptions.skills, skills);
});

test("malformed decision, timeout, aborted and bad configuration do not report success or leak full inventory", async () => {
  const cases = [
    { client: { decide: async () => ({ answers: {} }) }, options: {}, code: "invalid_response" },
    { client: { decide: async () => new Promise<never>(() => {}) }, options: { timeoutMs: 10 }, code: "timeout" },
    { client, options: { minCandidates: -1 }, code: "config" },
  ];
  for (const entry of cases) {
    const event = { prompt: "task", systemPromptOptions: { skills } };
    const result = await applySkillAdvertisementFilter(event, entry.client, { minCandidates: 1, ...entry.options });
    assert.equal(result.reason, "fail-closed");
    assert.equal(result.errorCode, entry.code);
    assert.deepEqual(event.systemPromptOptions.skills, []);
  }
  const abort = new AbortController(); abort.abort();
  const event = { prompt: "task", systemPromptOptions: { skills } };
  const result = await applySkillAdvertisementFilter(event, client, { minCandidates: 1, signal: abort.signal });
  assert.equal(result.errorCode, "aborted");
  assert.equal(result.reason, "fail-closed");
});
