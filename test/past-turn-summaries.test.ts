import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultSettings } from "../src/settings.ts";
import { createPastTurnSummaries, readPastTurnSummaries } from "../src/extension/past-turn-summaries.ts";
import type { ExtensionHost } from "../src/extension/contracts.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }, { type: "image", data: "PRIVATE IMAGE" }] } });
const reply = (id: string, text: string) => ({ type: "message", id, message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "PRIVATE THINKING" }, { type: "text", text }] } });
function harness() {
  const settings = defaultSettings();
  const branch: any[] = [];
  const calls: { text: string; options: any; resolve: (value: any) => void }[] = [];
  const model: any = { reasoning: false };
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "session" }, modelRegistry: {
    find: () => model, hasConfiguredAuth: () => true,
    streamSimple: (_model: unknown, prompt: any, options: any) => ({ result: () => new Promise((resolve) => calls.push({ text: prompt.messages[0].content[0].text, options, resolve })) }),
  } } as unknown as ExtensionContext;
  const pi = { appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `e${branch.length}`, customType, data }) } as unknown as ExtensionHost;
  const subject = createPastTurnSummaries(pi, () => settings);
  const finish = (index: number, text: string) => calls[index].resolve({ stopReason: "stop", content: [{ type: "text", text }] });
  return { settings, branch, calls, model, ctx, subject, finish };
}
test("housekeeping reasoning is forwarded only when supported and clamped to model levels", async () => {
  const h = harness(); h.settings.history = { enabled: true, model: "provider/model", thinkingLevel: "high" };
  h.branch.push(user("u1", "first")); h.subject.enqueue(h.ctx, "prompt");
  assert.equal(h.calls[0].options.reasoning, undefined);
  h.finish(0, "first"); await tick();
  h.model.reasoning = true; h.model.thinkingLevelMap = { high: null, xhigh: null, max: null };
  h.branch.push(user("u2", "second")); h.subject.enqueue(h.ctx, "prompt");
  assert.equal(h.calls[1].options.reasoning, "medium");
  h.finish(1, "second"); await tick();
});
test("disabled or unselected housekeeping does not call a model", async () => {
  const h = harness(); h.branch.push(user("u1", "task"));
  h.subject.enqueue(h.ctx, "prompt"); h.settings.history.enabled = true; h.subject.enqueue(h.ctx, "prompt");
  await tick(); assert.equal(h.calls.length, 0);
});
test("background summaries are bounded, serial and contain only visible text", async () => {
  const h = harness(); h.settings.history = { ...h.settings.history, enabled: true, model: "provider/model" };
  h.branch.push(user("u1", "first task")); h.subject.enqueue(h.ctx, "prompt");
  h.branch.push(reply("a1", "final answer")); h.subject.enqueue(h.ctx, "reply");
  // Enqueue and reads return immediately even while the first model promise never resolves.
  assert.equal(h.calls.length, 1); assert.deepEqual(h.subject.read(h.ctx), []);
  assert.equal(h.calls[0].text, "first task");
  h.finish(0, "task summary"); await tick(); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].text, "final answer"); h.finish(1, "reply summary"); await tick();
  assert.deepEqual(h.subject.read(h.ctx), [{ kind: "prompt", text: "task summary" }, { kind: "reply", text: "reply summary" }]);
  h.subject.enqueue(h.ctx, "reply"); await tick(); assert.equal(h.calls.length, 2);
});
test("expanded skill bodies and paths never go to housekeeping", async () => {
  const h = harness(); h.settings.history = { ...h.settings.history, enabled: true, model: "provider/model" };
  h.branch.push(user("u1", "<skill name=\"demo\" location=\"/private/SKILL.md\">\nSECRET BODY\n</skill>\n\nactual task"));
  h.subject.enqueue(h.ctx, "prompt");
  assert.equal(h.calls[0].text, "actual task");
  h.subject.reset(); await tick();
});
test("only the pending user suffix is queued, deduplicated, and invalidated together", async () => {
  const h = harness(); h.settings.history = { ...h.settings.history, enabled: true, model: "provider/model" };
  h.branch.push(user("old", "old unrecorded"), reply("intervening", "prior reply"), user("u1", "first queued"), user("u2", "second queued"));
  h.subject.enqueue(h.ctx, "prompt"); h.subject.enqueue(h.ctx, "prompt");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].text, "first queued");
  h.finish(0, "first summary"); await tick();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].text, "second queued");
  h.subject.reset(); h.finish(1, "stale second"); await tick();
  assert.deepEqual(h.subject.read(h.ctx), [{ kind: "prompt", text: "first summary" }]);
  assert.equal(h.calls.length, 2, "neither the old transcript nor duplicate callbacks cause calls");
});
test("reset prevents a late completion from writing and permits new work", async () => {
  const h = harness(); h.settings.history = { ...h.settings.history, enabled: true, model: "provider/model" };
  h.branch.push(user("u1", "first task")); h.subject.enqueue(h.ctx, "prompt"); h.subject.reset();
  h.subject.enqueue(h.ctx, "prompt"); h.finish(0, "stale"); await tick();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.subject.read(h.ctx), []);
  h.finish(1, "fresh"); await tick(); assert.deepEqual(h.subject.read(h.ctx), [{ kind: "prompt", text: "fresh" }]);
});
test("branch order, deduplication, ownership and retention are independent of completion order", () => {
  const h = harness(); h.branch.push(user("u1", "x"), reply("a1", "y"),
    { type: "custom", customType: "context-decisions-past-turn-summary", data: { sourceId: "a1", kind: "reply", text: "second" } },
    { type: "custom", customType: "context-decisions-past-turn-summary", data: { sourceId: "u1", kind: "prompt", text: "first" } },
    { type: "custom", customType: "context-decisions-past-turn-summary", data: { sourceId: "u1", kind: "prompt", text: "duplicate" } },
    { type: "custom", customType: "context-decisions-past-turn-summary", data: { sourceId: "other-branch", kind: "reply", text: "foreign" } });
  assert.deepEqual(readPastTurnSummaries(h.ctx), [{ kind: "prompt", text: "first" }, { kind: "reply", text: "second" }]);
});
