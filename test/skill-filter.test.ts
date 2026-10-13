import test from "node:test";
import assert from "node:assert/strict";
import { applySkillAdvertisementFilter, DEFAULT_RELEVANCE_THRESHOLD, filterSkills, selectRelevant, validThreshold } from "../src/apps/skill-filter.ts";
import type { RelevanceClient, RelevanceItem } from "../src/apps/relevance.ts";

const skills = ["alpha", "beta", "gamma", "delta"].map((name) => ({ name, description: `${name} description`, filePath: `/${name}/SKILL.md` }));
function item(name: string, score: number): RelevanceItem {
  return { name, score, normalized: score / 2 };
}
const items = [item("alpha", 1), item("beta", 2), item("gamma", 0), item("delta", 1.5)];
const client: RelevanceClient = { decide: async (req) => ({ answers: Object.fromEntries(Object.keys(req.questions).map((id, index) => [id, { type: "score", score: index % 2 ? 2 : 0 }])) }) };

// Exact wrapper emitted by Pi 1.1.0 agent-session._expandSkillCommand.
const expandedSkill = `<skill name="private" location="/private/project/SKILL.md">\nReferences are relative to /private/project.\n\nFIXTURE_PRIVATE_SKILL_BODY\n</skill>`;
test("expanded Pi skill commands send only task arguments, never bodies or paths", async () => {
  const inventory = Array.from({ length: 8 }, (_, index) => ({ name: `skill${index}`, description: "Fixture metadata" }));
  for (const block of [expandedSkill, expandedSkill.replace("FIXTURE_PRIVATE_SKILL_BODY", "An embedded closing tag:\n</skill>\n\nFIXTURE_PRIVATE_SKILL_BODY")]) {
    let calls = 0;
    const capturing: RelevanceClient = { decide: async (request) => {
      calls++;
      assert.equal(request.state.task, "Write unit tests");
      assert.doesNotMatch(JSON.stringify(request), /FIXTURE_PRIVATE_SKILL_BODY|\/private\/project|References are relative|<skill/);
      return client.decide(request);
    } };
    const event = { prompt: `${block}\n\nWrite unit tests`, systemPromptOptions: { skills: inventory } };
    assert.equal((await applySkillAdvertisementFilter(event, capturing)).reason, "filtered");
    assert.equal(calls, 1);
    assert.equal(event.prompt, `${block}\n\nWrite unit tests`, "do not change the main agent's explicit skill access");
  }
});
test("expanded skills without remaining task and malformed wrappers make no calls", async () => {
  const never: RelevanceClient = { decide: async () => { assert.fail("private skill content must not be sent"); } };
  for (const prompt of [expandedSkill, `${expandedSkill}\n\n  `, expandedSkill.replace("\n</skill>", ""), expandedSkill.replaceAll("\n", "\r\n")]) {
    const event = { prompt, systemPromptOptions: { skills } };
    const result = await applySkillAdvertisementFilter(event, never, { minCandidates: 1 });
    assert.equal(result.reason, "skipped");
    assert.equal(result.skipReason, "empty-prompt");
    assert.equal(event.systemPromptOptions.skills, skills);
  }
});
test("a choice answer to a skill-picker question fails closed instead of advertising anything", async () => {
  const choosing: RelevanceClient = { decide: async (request) => ({ answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, { type: "choice", choice: "directly_relevant", probabilities: { irrelevant: 0, related: 0, directly_relevant: 1 }, confidence: 1 }]),
  ) }) };
  const event = { prompt: "Write tests", systemPromptOptions: { skills } };
  const result = await applySkillAdvertisementFilter(event, choosing, { minCandidates: 1 });
  assert.equal(result.reason, "fail-closed");
  assert.equal(result.errorCode, "invalid_response");
  assert.deepEqual(result.kept, []);
});
test("removed policy keys from untyped callers fail closed, even when failMode is open", async () => {
  for (const removed of [{ mode: "choice" }, { minLabel: "related" }, { relatedThreshold: 0.75 }, { directThreshold: 1.5 }]) {
    const event = { prompt: "Write tests", systemPromptOptions: { skills } };
    const result = await applySkillAdvertisementFilter(event, client, { minCandidates: 1, failMode: "open", ...removed } as never);
    assert.notEqual(result.reason, "filtered");
    assert.notEqual(result.reason, "fail-open", `${Object.keys(removed)[0]} must never opt in to fail-open`);
  }
  assert.equal(filterSkills(skills, items, { minLabel: "related" } as never).reason, "fail-closed");
});
test("normalized threshold: inclusive, default 0.375 equals the old raw 0.75, 0 and 1 are the extremes", () => {
  assert.equal(DEFAULT_RELEVANCE_THRESHOLD, 0.375);
  const scored = [item("a", 0.74), item("b", 0.75), item("c", 1.5), item("d", 2), item("e", 0)];
  assert.deepEqual(selectRelevant(scored, 0.375, 10).chosen.map((i) => i.name), ["d", "c", "b"]);
  assert.deepEqual(selectRelevant(scored, 0.375, 10).eligible, 3);
  assert.deepEqual(selectRelevant(scored, 0, 10).chosen.map((i) => i.name), ["d", "c", "b", "a", "e"]);
  assert.deepEqual(selectRelevant(scored, 1, 10).chosen.map((i) => i.name), ["d"]);
  assert.deepEqual(selectRelevant([...scored, item("f", 1.75)], 0.875, 10).chosen.map((i) => i.name), ["d", "f"], "0.875 is exactly raw 1.75");
  assert.deepEqual(selectRelevant(scored, 0.75, 10).chosen.map((i) => i.name), ["d", "c"], "0.75 is exactly raw 1.5");
  assert.equal(selectRelevant([item("x", 1.5)], 0.75, 1).chosen.length, 1, "inclusive at the boundary");
  for (const bad of [-0.01, 1.01, NaN, Infinity, "0.5", undefined, null]) assert.equal(validThreshold(bad), false);
  for (const good of [0, 0.375, 1]) assert.equal(validThreshold(good), true);
});
test("invalid threshold fails closed and never opts in to fail-open", () => {
  for (const threshold of [-0.5, 1.5, NaN]) {
    assert.equal(filterSkills(skills, items, { threshold }).reason, "fail-closed");
    assert.equal(filterSkills(skills, items, { threshold, failMode: "open" }).reason, "fail-closed");
  }
});

test("filter selects highest scores with cap and preserves original order/references", () => {
  const result = filterSkills(skills, items, { maxSkills: 2 });
  assert.deepEqual(result.kept, [skills[1], skills[3]]);
  assert.equal(result.kept[0], skills[1]);
  assert.deepEqual(result.dropped, ["alpha", "gamma"]);
  assert.equal(result.reason, "filtered");
  assert.deepEqual(filterSkills(skills, items, { threshold: 0.75 }).kept, [skills[1], skills[3]]);
  assert.deepEqual(filterSkills(skills, items, { threshold: 0.9 }).kept, [skills[1]]);
  assert.deepEqual(filterSkills(skills, items, { maxSkills: 12 }).kept, [skills[0], skills[1], skills[3]], "default threshold 0.375 keeps raw >= 0.75");
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
