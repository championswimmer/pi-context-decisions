import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionActivity, previousFinalReply } from "../src/extension/decision-activity.ts";
import { buildRelevanceRequests } from "../src/apps/relevance.ts";

test("activity uses only recent assistant text and direct calls after the latest user, bounded and excluding results and thinking", () => {
  const user = (content: string) => ({ type: "message", message: { role: "user", content } });
  const assistant = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
  const activity = decisionActivity([user("old"), assistant([{ type: "text", text: "OLD" }]), user("new"),
    assistant([{ type: "thinking", thinking: "THINKING" }, { type: "text", text: "working" }, { type: "toolCall", name: "read", arguments: { path: "db.sql" } }]),
    { type: "message", message: { role: "toolResult", content: "RESULT" } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(activity)), [{ type: "text", text: "working" }, { type: "toolCall", name: "read", arguments: { path: "db.sql" } }]);
  const request = buildRelevanceRequests("new", [{ name: "database", description: "SQL" }], { activity })[0].request;
  assert.deepEqual(request.state.activity, activity);
  assert.doesNotMatch(JSON.stringify(request), /OLD|THINKING|RESULT/);
  assert.ok(!("activity" in buildRelevanceRequests("new", [{ name: "database", description: "SQL" }])[0].request.state));
  assert.deepEqual(decisionActivity([assistant([{ type: "text", text: "no user" }])]), []);
  const many = decisionActivity([user("x"), assistant(Array.from({ length: 100 }, (_, i) => ({ type: "toolCall", name: `tool${i}`, arguments: { data: "x".repeat(100000) } })))]);
  assert.ok(JSON.stringify(many).length <= 3000);
  assert.match(JSON.stringify(many), /tool99/);
});

test("previous reply is only the immediately preceding run's final visible assistant text", () => {
  const user = { type: "message", message: { role: "user", content: "USER" } };
  const assistant = (stopReason: string, content: unknown[]) => ({ type: "message", message: { role: "assistant", stopReason, content } });
  const final = assistant("stop", [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "FINAL" }]);
  const intermediate = assistant("toolUse", [{ type: "text", text: "INTERMEDIATE" }, { type: "toolCall", name: "read" }]);
  const result = { type: "message", message: { role: "toolResult", content: "RESULT" } };
  assert.equal(previousFinalReply([]), undefined);
  assert.deepEqual(previousFinalReply([user, final]), { text: "FINAL" });
  assert.equal(previousFinalReply([user, final, user, intermediate, result]), undefined);
  assert.deepEqual(previousFinalReply([user, final, user, intermediate, result], true), { text: "FINAL" });
  assert.equal(previousFinalReply([user, assistant("stop", [{ type: "text", text: "BAD" }, { type: "toolCall", name: "x" }])]), undefined);
  const bounded = previousFinalReply([user, assistant("stop", [{ type: "text", text: "\u0000".repeat(5000) }])])!;
  assert.ok(JSON.stringify(bounded).length <= 3000);
  const state = buildRelevanceRequests("goal", [{ name: "x", description: "y" }], { previousReply: { text: "FINAL" } })[0].request.state;
  assert.equal(state.task, "goal"); assert.deepEqual(state.previousReply, { text: "FINAL" });
});
