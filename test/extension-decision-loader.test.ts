// The "Deciding Context" working-row loader: Pi's own braille spinner is shown while a decision round is in flight.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { DECIDING_CONTEXT_LABEL, beginDecisionLoader, endDecisionLoader, resetDecisionLoader } from "../src/extension/decision-loader.ts";
import type { CommandContext } from "../src/extension/contracts.ts";
import { extTool, mcpTool, toolSetup } from "./helpers/tool-fixture.ts";

type RowCall = ["message", string | undefined] | ["visible", boolean];
const CORE_TOOLS = ["read", "bash"] as const;
const A = extTool("ext_a"), B = extTool("ext_b");
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
const skill = (name: string): Skill => ({
  name, description: `${name} description`, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`,
  sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "fixture", scope: "user", origin: "top-level" }, disableModelInvocation: false,
});
/** Every harness ctx is a print-mode fake: the loader needs a TUI context with a working-row-capable ui. */
function withWorkingRow(ctx: CommandContext, calls: RowCall[]): void {
  Object.assign(ctx, {
    mode: "tui" as const, isIdle: () => false,
    ui: {
      ...ctx.ui,
      setWorkingMessage(message?: string) { calls.push(["message", message]); },
      setWorkingVisible(visible: boolean) { calls.push(["visible", visible]); },
    },
  });
}
/** A recording TUI context. An omitted `idle` means the host exposes no `isIdle`. */
function recorder(options: { mode?: CommandContext["mode"]; idle?: boolean; message?: boolean; visible?: boolean } = {}) {
  const calls: RowCall[] = [];
  const ctx = {
    mode: options.mode ?? ("tui" as CommandContext["mode"]),
    ui: {
      ...(options.message === false ? {} : { setWorkingMessage(message?: string) { calls.push(["message", message]); } }),
      ...(options.visible === false ? {} : { setWorkingVisible(visible: boolean) { calls.push(["visible", visible]); } }),
    },
    ...(options.idle === undefined ? {} : { isIdle: () => options.idle! }),
  };
  return { calls, ctx };
}
const messages = (calls: RowCall[]) => calls.filter(([kind]) => kind === "message").map(([, value]) => value);
const visibility = (calls: RowCall[]) => calls.filter(([kind]) => kind === "visible").map(([, value]) => value);

test("a decision round shows the working row and restores Pi's default message on release", () => {
  resetDecisionLoader();
  const { calls, ctx } = recorder({ idle: false });
  beginDecisionLoader(ctx);
  assert.deepEqual(calls, [["message", DECIDING_CONTEXT_LABEL], ["visible", true]], "the label is set first, then the row is made visible for the prompt-time pass");
  endDecisionLoader();
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL, undefined], "no argument restores Pi's default \"Working\" message");
  assert.deepEqual(visibility(calls), [true], "the row is never hidden again: Pi has no getter for the previous value and hiding would stick for the session");
});

test("overlapping rounds hold the label until the last one finishes; an unmatched release is ignored", () => {
  resetDecisionLoader();
  const { calls, ctx } = recorder({ idle: false });
  beginDecisionLoader(ctx);
  beginDecisionLoader(ctx);
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL], "the second round is counted, not re-applied");
  endDecisionLoader();
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL], "the skill pass finishing first must not clear the tool pass's label");
  endDecisionLoader();
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL, undefined]);
  endDecisionLoader();
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL, undefined], "a release without a matching begin changes nothing");
  assert.equal(calls.length, 3);
});

test("non-TUI hosts, idle sessions, missing methods and a foreign reset are left untouched", () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    resetDecisionLoader();
    const { calls, ctx } = recorder({ mode, idle: false });
    beginDecisionLoader(ctx); endDecisionLoader();
    assert.deepEqual(calls, [], `${mode} mode never touches the working row`);
  }
  resetDecisionLoader();
  const idle = recorder({ idle: true });
  beginDecisionLoader(idle.ctx); endDecisionLoader();
  assert.deepEqual(messages(idle.calls), [DECIDING_CONTEXT_LABEL, undefined], "an idle round still restores the message it set");
  assert.deepEqual(visibility(idle.calls), [], "nothing is made visible while the run is not streaming");
  resetDecisionLoader();
  const old = recorder({ idle: false, message: false, visible: false });
  beginDecisionLoader(old.ctx); endDecisionLoader();
  assert.deepEqual(old.calls, [], "a host without the working-row methods is a no-op");
  resetDecisionLoader();
  const unknown = recorder(); // no isIdle: the row is never forced visible
  beginDecisionLoader(unknown.ctx);
  assert.deepEqual(messages(unknown.calls), [DECIDING_CONTEXT_LABEL]);
  assert.deepEqual(visibility(unknown.calls), []);
  resetDecisionLoader();
  endDecisionLoader();
  assert.equal(unknown.calls.length, 1, "after a reset the stale release is a no-op");
});

test("the prompt-time skill and tool rounds hold the working row until both finish", async (t) => {
  const h = await toolSetup(t, { skills: true, extra: [A, B], scores: { ext_a: 2 } });
  const calls: RowCall[] = [];
  withWorkingRow(h.ctx, calls);
  h.skillList.push(skill("skill-one"));
  let release!: () => void;
  h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const started = h.start("use ext_a please");
  for (let attempt = 0; attempt < 200 && h.requests.length < 2; attempt++) await tick();
  assert.equal(h.requests.length, 2, "both the skill pass and the tool pass made their decision call");
  assert.deepEqual(calls, [["message", DECIDING_CONTEXT_LABEL], ["visible", true]], "one label, set by whichever round started first");
  release();
  await started;
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL, undefined], "the first round to finish does not clear the other's label");
  assert.deepEqual(h.active(), [...CORE_TOOLS, "ext_a"], "the decision itself is unaffected");
});

test("with tool filtering off, the prompt-time skill round alone holds the working row", async (t) => {
  const h = await toolSetup(t, { skills: true, tools: { enabled: false } });
  const calls: RowCall[] = [];
  withWorkingRow(h.ctx, calls);
  h.skillList.push(skill("skill-one"));
  let release!: () => void;
  h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const started = h.start("task");
  for (let attempt = 0; attempt < 200 && h.requests.length < 1; attempt++) await tick();
  assert.equal(h.requests.length, 1, "the skill pass is the only decision call");
  assert.deepEqual(calls, [["message", DECIDING_CONTEXT_LABEL], ["visible", true]], "the prompt-time skill pass shows the row on its own, not only alongside the tool pass");
  release();
  await started;
  assert.deepEqual(messages(calls), [DECIDING_CONTEXT_LABEL, undefined], "the skill pass restores Pi's default message when it settles");
});

test("with tool filtering off, the turn_end skill round alone holds the working row", async (t) => {
  const h = await toolSetup(t, { skills: true, tools: { enabled: false } });
  const calls: RowCall[] = [];
  withWorkingRow(h.ctx, calls);
  h.skillList.push(skill("skill-one"), skill("skill-two"));
  await h.start("first task");
  const afterPrompt = calls.length;
  let release!: () => void;
  h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const before = h.requests.length;
  const ending = h.end({ pendingMessages: [{ role: "user", content: "second task", timestamp: 7 }] });
  for (let attempt = 0; attempt < 200 && h.requests.length === before; attempt++) await tick();
  assert.equal(h.requests.length, before + 1, "the queued user text starts a turn_end skill round");
  assert.deepEqual(calls.slice(afterPrompt), [["message", DECIDING_CONTEXT_LABEL], ["visible", true]], "the turn_end skill round shows the row on its own");
  release();
  await ending;
  assert.deepEqual(messages(calls.slice(afterPrompt)), [DECIDING_CONTEXT_LABEL, undefined], "and restores it when it settles");
});

test("a lazy single-flight decision for a tool call shows the working row while it scores", async (t) => {
  const h = await toolSetup(t, { extra: [A], scores: { ext_a: 2, mcp__srv__x: 2 } });
  const calls: RowCall[] = [];
  withWorkingRow(h.ctx, calls);
  await h.start("task");
  const afterStart = calls.length;
  h.sim.registerTool(mcpTool("srv", "x", "codemode"));
  let release!: () => void;
  h.behavior.gate = new Promise<void>((resolve) => { release = resolve; });
  const before = h.requests.length;
  const racing = Promise.all([h.gate("mcp__srv__x"), h.gate("mcp__srv__x")]);
  for (let attempt = 0; attempt < 200 && h.requests.length === before; attempt++) await tick();
  assert.deepEqual(calls.slice(afterStart), [["message", DECIDING_CONTEXT_LABEL], ["visible", true]], "the gate shows the row while it decides");
  release();
  assert.deepEqual(await racing, [undefined, undefined]);
  assert.deepEqual(messages(calls.slice(afterStart)), [DECIDING_CONTEXT_LABEL, undefined], "two racing calls, one shared round, one release");
  assert.equal(h.requests.length, before + 1, "single-flight is unaffected");
});

test("failing and cancelled rounds always restore the working message", async (t) => {
  const failing = await toolSetup(t, { skills: true, extra: [A], fail: true });
  const calls: RowCall[] = [];
  withWorkingRow(failing.ctx, calls);
  failing.skillList.push(skill("skill-one"));
  await failing.start("task");
  assert.deepEqual(calls[0], ["message", DECIDING_CONTEXT_LABEL], "the failing round showed the row");
  assert.deepEqual(messages(calls).at(-1), undefined, "a provider failure still releases the row");
  assert.deepEqual(visibility(calls).filter((value) => value === false), [], "the row is never hidden");

  const hanging = await toolSetup(t, { extra: [A, B], hang: true });
  const cancelled: RowCall[] = [];
  withWorkingRow(hanging.ctx, cancelled);
  const abort = new AbortController();
  hanging.ctx.signal = abort.signal;
  const started = hanging.start("task");
  for (let attempt = 0; attempt < 200 && cancelled.length === 0; attempt++) await tick();
  assert.deepEqual(cancelled[0], ["message", DECIDING_CONTEXT_LABEL], "the round had started and showed the row");
  abort.abort();
  await started;
  assert.deepEqual(messages(cancelled).at(-1), undefined, "an interrupted run restores the working message");
});
