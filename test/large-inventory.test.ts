import assert from "node:assert/strict";
import test from "node:test";
import { buildRelevanceRequests, rankSkills, type RelevanceClient } from "../src/apps/relevance.ts";
import { pickSkills } from "../src/apps/skill-filter.ts";
import type { DecisionRequest, DecisionResponse } from "../src/decision/types.ts";

function inventory(count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `skill-${i}`, description: `Task metadata ${i}`, body: "PRIVATE_BODY", filePath: "/PRIVATE/SKILL.md" }));
}
function response(request: DecisionRequest): DecisionResponse {
  const metadata = request.state.skills as Record<string, { name: string; description: string }>;
  assert.deepEqual(Object.keys(request.state).sort(), ["skills", "task"]);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE|body|filePath/);
  for (const entry of Object.values(metadata)) assert.deepEqual(Object.keys(entry).sort(), ["description", "name"]);
  return { answers: Object.fromEntries(Object.entries(metadata).map(([id, entry]) => [id, { type: "score", score: Number(entry.name.split("-").at(-1)) % 2 ? 0.5 : 1.75 }])) };
}
function deferredClient(maxQuestions?: number) {
  const pending: { request: DecisionRequest; signal?: AbortSignal; resolve: (value: DecisionResponse) => void; reject: (error: Error) => void }[] = [];
  const client: RelevanceClient = { ...(maxQuestions === undefined ? {} : { maxQuestions }), decide(request, options) {
    return new Promise((resolve, reject) => pending.push({ request, signal: options?.signal, resolve, reject }));
  } };
  return { client, pending };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const count of [300, 350, 400]) test(`${count} candidates default to 50-skill batches, all dispatched before a response`, async () => {
  const skills = inventory(count);
  const { client, pending } = deferredClient();
  const ranking = pickSkills("task", skills, client, { maxSkills: count, relatedThreshold: 1.5 });
  await tick();
  assert.equal(pending.length, count / 50);
  assert.deepEqual(pending.map(({ request }) => Object.keys(request.questions).length), Array(count / 50).fill(50));
  assert.ok(pending.every(({ signal }) => !signal?.aborted));
  // Later batches finish first; the application must still preserve inventory order.
  for (const operation of [...pending].reverse()) operation.resolve(response(operation.request));
  const result = await ranking;
  assert.equal(result.reason, "filtered");
  assert.equal(result.candidates, count); assert.equal(result.items?.length, count);
  assert.deepEqual(result.batchSizes, Array(count / 50).fill(50));
  assert.deepEqual(result.kept, skills.filter((_, i) => i % 2 === 0));
  assert.deepEqual(result.items?.map((item) => item.name), skills.map((skill) => skill.name));
});

test("a lower client question cap subdivides all candidates and reports actual sizes", async () => {
  const skills = inventory(400);
  const sizes: number[] = [];
  const client: RelevanceClient = { maxQuestions: 24, async decide(request) {
    sizes.push(Object.keys(request.questions).length); return response(request);
  } };
  const result = await pickSkills("task", skills, client, { maxSkills: 400 });
  assert.deepEqual(sizes, [...Array(16).fill(24), 16]);
  assert.deepEqual(result.batchSizes, sizes);
  assert.equal(result.items?.length, 400);
  const configured = await pickSkills("task", skills.slice(0, 60), client, { maxQuestions: 10 });
  assert.deepEqual(configured.batchSizes, Array(6).fill(10));
  assert.equal(configured.items?.length, 60);
});

test("bounded concurrency override stops queued batches immediately after failure and aborts siblings", async () => {
  const { client, pending } = deferredClient();
  const ranking = pickSkills("task", inventory(400), client, { concurrency: 2 });
  await tick(); assert.equal(pending.length, 2);
  pending[0].reject(new Error("PRIVATE_ERROR"));
  const result = await ranking;
  assert.equal(result.reason, "fail-closed"); assert.deepEqual(result.kept, []);
  assert.equal(pending.length, 2); assert.ok(pending.every(({ signal }) => signal?.aborted));
  assert.deepEqual(result.batchSizes, [50, 50]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR/);
});

test("initiating provider error survives synchronous sibling cancellation", async () => {
  let calls = 0;
  const result = await pickSkills("task", inventory(400), { decide(request, options) {
    const index = calls++;
    if (index === 0) return Promise.reject(Object.assign(new Error("PRIVATE_AUTH_ERROR"), { code: "auth" }));
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("PRIVATE_ABORT_ERROR"), { code: "aborted" }));
    }, { once: true }));
  } });
  assert.equal(result.reason, "fail-closed"); assert.equal(result.errorCode, "auth");
  assert.equal(calls, 8); assert.deepEqual(result.kept, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("malformed early batch cancels siblings rather than waiting for their responses", async () => {
  const { client, pending } = deferredClient();
  const ranking = pickSkills("task", inventory(400), client);
  await tick(); assert.equal(pending.length, 8);
  pending[0].resolve({ answers: {} });
  const result = await ranking;
  assert.equal(result.reason, "fail-closed"); assert.equal(result.errorCode, "invalid_response");
  assert.deepEqual(result.kept, []); assert.ok(pending.every(({ signal }) => signal?.aborted));
});

test("shared timeout and caller cancellation abort every parallel batch without partial selection", async () => {
  for (const callerAbort of [false, true]) {
    const { client, pending } = deferredClient();
    const abort = new AbortController();
    const ranking = pickSkills("task", inventory(400), client, { timeoutMs: callerAbort ? 1000 : 25, signal: abort.signal });
    await tick(); assert.equal(pending.length, 8);
    pending[0].resolve(response(pending[0].request));
    if (callerAbort) abort.abort();
    const result = await ranking;
    assert.equal(result.reason, "fail-closed"); assert.equal(result.errorCode, callerAbort ? "aborted" : "timeout");
    assert.deepEqual(result.kept, []); assert.ok(pending.every(({ signal }) => signal?.aborted));
  }
});

test("fifty-entry escaped metadata stays bounded, all candidates are retained across payload splits", async () => {
  const skills = inventory(400).map((skill) => ({ ...skill, description: '\\"'.repeat(200) }));
  const batches = buildRelevanceRequests("task", skills);
  assert.deepEqual(batches.map(({ request }) => Object.keys(request.questions).length), Array(8).fill(50));
  assert.ok(batches.every(({ request }) => JSON.stringify(request.state).length <= 65536));
  const smaller = buildRelevanceRequests("task", skills, { maxStateChars: 5000 });
  assert.equal(smaller.flatMap(({ idToName }) => Object.values(idToName)).length, 400);
  assert.ok(smaller.every(({ request }) => JSON.stringify(request.state).length <= 5000));
});

test("explicit all aliases dispatch every batch rather than accidentally starting zero workers", async () => {
  for (const concurrency of [0, "all"] as const) {
    const { client, pending } = deferredClient();
    const picking = pickSkills("task", inventory(400), client, { concurrency });
    await tick(); assert.equal(pending.length, 8);
    for (const operation of pending) operation.resolve(response(operation.request));
    const result = await picking; assert.equal(result.reason, "filtered"); assert.equal(result.items?.length, 400);
  }
});

test("invalid concurrency and lower-provider-cap values fail before any calls", async () => {
  for (const concurrency of [-1, 1.5, 1001, "invalid", NaN]) {
    let calls = 0;
    const result = await pickSkills("task", inventory(400), { async decide(request) { calls++; return response(request); } }, { concurrency: concurrency as number });
    assert.equal(result.reason, "fail-closed"); assert.equal(result.errorCode, "config"); assert.equal(calls, 0);
  }
  for (const maxQuestions of [0, -1, 1.5, 1001, NaN]) {
    let calls = 0;
    await assert.rejects(rankSkills("task", inventory(400), { maxQuestions, async decide(request) { calls++; return response(request); } }), { code: "config" });
    assert.equal(calls, 0);
  }
});
