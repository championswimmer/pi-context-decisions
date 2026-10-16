// Shared tuning must reach both real runtime pipelines, not just the settings dialog.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { advertised } from "./helpers/pi-sim.ts";
import { extTool, toolSetup, type ToolHarness } from "./helpers/tool-fixture.ts";

function skills(h: ToolHarness) {
  const list: Skill[] = ["skill_high", "skill_low"].map((name) => ({ name, description: "Long skill description", filePath: `/private/${name}/SKILL.md`, baseDir: `/private/${name}`,
    sourceInfo: { path: `/private/${name}/SKILL.md`, source: "fixture", scope: "user", origin: "top-level" }, disableModelInvocation: false }));
  h.skillList.push(...list);
  return list;
}

test("one Advanced tuning set drives both pipelines: threshold, shards, concurrency and metadata limits", async (t) => {
  const h = await toolSetup(t, { skills: true, extra: [extTool("tool_high"), extTool("tool_low")],
    decision: { threshold: 0.75, chunkSize: 1, concurrency: 1, maxPromptChars: 6, maxDescriptionChars: 8 },
    scores: { skill_high: 2, skill_low: 1, tool_high: 2, tool_low: 1 } });
  const inventory = skills(h);
  let release!: () => void;
  h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const run = h.start("a long bounded task");
  const deadline = Date.now() + 2000;
  while (h.requests.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(h.requests.length, 2, "one shard from each concurrent feature pass");
  assert.equal(h.behavior.peak, 2, "concurrency=1 applies to each pipeline's shard pool");
  release(); const { e } = await run;
  assert.equal(h.requests.length, 4);
  for (const request of h.requests) {
    assert.equal(Object.keys(request.questions).length, 1);
    assert.equal(request.state.task, "a long");
    const candidates = (request.state.skills ?? request.state.tools) as Record<string, { description: string }>;
    assert.ok(Object.values(candidates).every((item) => item.description.length === 8));
  }
  assert.deepEqual(advertised(h.sim, inventory, e.systemPromptOptions.skills), ["skill_high"]);
  assert.equal(await h.gate("tool_high"), undefined); assert.equal((await h.gate("tool_low"))?.block, true);
  // A single Advanced save changes BOTH features on the next new task, without touching their switches.
  await h.set("decision.threshold", "0.5");
  const next = await h.start("another task");
  assert.deepEqual(advertised(h.sim, inventory, next.e.systemPromptOptions.skills), ["skill_high", "skill_low"]);
  assert.equal(await h.gate("tool_low"), undefined);
});

for (const failMode of ["closed", "open"] as const) test(`shared fail-${failMode} applies to skills and tools`, async (t) => {
  const h = await toolSetup(t, { skills: true, fail: true, decision: { failMode }, extra: [extTool("tool_high")] });
  const inventory = skills(h); const { e } = await h.start("task");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(advertised(h.sim, inventory, e.systemPromptOptions.skills), failMode === "open" ? inventory.map((skill) => skill.name) : []);
  assert.equal((await h.gate("tool_high"))?.block ?? false, failMode === "closed");
});

test("shared timeout bounds both passes and still fails closed by default", async (t) => {
  const h = await toolSetup(t, { skills: true, hang: true, decision: { timeoutMs: 20 }, extra: [extTool("tool_high")] });
  const inventory = skills(h); const { e } = await h.start("task");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(advertised(h.sim, inventory, e.systemPromptOptions.skills), []);
  assert.equal((await h.gate("tool_high"))?.block, true);
  await h.command("status");
  assert.match(h.messages.at(-1)!, /Last \(prompt\).*timeout/);
  assert.match(h.messages.at(-1)!, /Last tool round \(prompt\).*timeout/);
});
