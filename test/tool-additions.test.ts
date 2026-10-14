import test from "node:test";
import assert from "node:assert/strict";
import { IncrementalScoreCache, scoreToolAdditions, type ToolAdditionOptions } from "../src/apps/tool-additions.ts";
import type { RelevanceClient } from "../src/apps/relevance.ts";
import type { DecisionRequest, DecisionResponse } from "../src/decision/types.ts";

const cand = (...names: string[]) => names.map((name) => ({ name, description: `${name} description` }));
const base: ToolAdditionOptions = { subject: "tool", threshold: 0.5, maxAdded: 10 };
/** Scores by candidate name; counts decision calls and the names sent in each. */
function scripted(scores: Record<string, number>, hooks: { before?: (request: DecisionRequest) => Promise<void> | void; respond?: (request: DecisionRequest) => DecisionResponse } = {}) {
  const sent: string[][] = [];
  const client: RelevanceClient = { async decide(request) {
    await hooks.before?.(request);
    if (hooks.respond) return hooks.respond(request);
    const entries = request.state.tools as Record<string, { name: string }>;
    sent.push(Object.values(entries).map((entry) => entry.name));
    return { answers: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { type: "score", score: scores[entry.name] ?? 0 }])) };
  } };
  return { client, sent, calls: () => sent.length };
}

test("selects at or above the inclusive threshold, best first, candidate order breaking ties", async () => {
  const s = scripted({ a: 1, b: 2, c: 1, d: 0.99 });
  const result = await scoreToolAdditions("task", cand("a", "b", "c", "d"), s.client, base);
  assert.deepEqual(result.added, ["b", "a", "c"]); assert.equal(result.eligible, 3);
  assert.deepEqual({ scored: result.scored, reused: result.reused, candidates: result.candidates, errorCode: result.errorCode }, { scored: 4, reused: 0, candidates: 4, errorCode: undefined });
  assert.deepEqual(result.considered, ["a", "b", "c", "d"]); assert.deepEqual(result.batchSizes, [4]);
});
test("maxAdded is a global cap across shards (chunkSize 2), not per shard", async () => {
  const s = scripted({ a: 1, b: 1.2, c: 1.9, d: 1.1, e: 1.5 });
  const result = await scoreToolAdditions("task", cand("a", "b", "c", "d", "e"), s.client, { ...base, maxAdded: 2, chunkSize: 2 });
  assert.deepEqual(result.batchSizes.sort(), [1, 2, 2]); assert.equal(s.calls(), 3);
  assert.deepEqual(result.added, ["c", "e"]); assert.equal(result.eligible, 5);
  assert.deepEqual((await scoreToolAdditions("task", cand("a", "b"), s.client, { ...base, maxAdded: 0 })).added, []);
});
test("only cache misses are dispatched; a same-key second round reuses scores with ZERO calls and yields the next-best", async () => {
  const s = scripted({ a: 2, b: 1.5, c: 1 });
  const cache = { store: new IncrementalScoreCache(), key: "task-1" };
  const first = await scoreToolAdditions("task", cand("a", "b", "c"), s.client, { ...base, maxAdded: 1 }, cache);
  assert.deepEqual(first.added, ["a"]);
  const second = await scoreToolAdditions("task", cand("b", "c"), s.client, { ...base, maxAdded: 1 }, cache);
  assert.equal(s.calls(), 1, "no decision call for already-scored candidates");
  assert.deepEqual({ added: second.added, scored: second.scored, reused: second.reused, batchSizes: second.batchSizes }, { added: ["b"], scored: 0, reused: 2, batchSizes: [] });
  // A brand-new candidate under the same key is the only one dispatched; cached ones still compete.
  const third = await scoreToolAdditions("task", cand("c", "d"), scripted({ d: 1.9 }).client, { ...base, maxAdded: 1 }, cache);
  assert.deepEqual(third.added, ["d"]); assert.deepEqual({ scored: third.scored, reused: third.reused }, { scored: 1, reused: 1 });
});
test("a different cache key or a changed description invalidates that entry only", async () => {
  const s = scripted({ a: 2, b: 2 });
  const store = new IncrementalScoreCache();
  await scoreToolAdditions("t", cand("a", "b"), s.client, base, { store, key: "k1" });
  const changed = [{ name: "a", description: "NEW" }, { name: "b", description: "b description" }];
  const round = await scoreToolAdditions("t", changed, s.client, base, { store, key: "k1" });
  assert.deepEqual(s.sent.at(-1), ["a"]); assert.deepEqual({ scored: round.scored, reused: round.reused }, { scored: 1, reused: 1 });
  await scoreToolAdditions("t", cand("a", "b"), s.client, base, { store, key: "k2" });
  assert.deepEqual(s.sent.at(-1), ["a", "b"], "a new key re-scores everything");
  assert.equal(store.needsScoring("k2", cand("a")[0]), false); assert.equal(store.needsScoring("k1", cand("a")[0]), true);
  store.clear(); assert.equal(store.needsScoring("k2", cand("a")[0]), true);
});
test("duplicate candidate names are scored once", async () => {
  const s = scripted({ a: 2 });
  const result = await scoreToolAdditions("t", [...cand("a"), ...cand("a")], s.client, base);
  assert.deepEqual(s.sent, [["a"]]); assert.deepEqual(result.added, ["a"]);
});
test("an already-aborted signal wins even when every score is cached: no additions, no call, nothing stored", async () => {
  const s = scripted({ a: 2 });
  const cache = { store: new IncrementalScoreCache(), key: "k" };
  await scoreToolAdditions("t", cand("a"), s.client, base, cache);
  const controller = new AbortController(); controller.abort();
  const result = await scoreToolAdditions("t", cand("a"), s.client, { ...base, signal: controller.signal }, cache);
  assert.equal(result.errorCode, "aborted"); assert.deepEqual(result.added, []); assert.equal(s.calls(), 1);
});
test("an abort that lands while the decision is in flight commits no additions and does not populate the cache", async () => {
  const controller = new AbortController();
  const s = scripted({ a: 2 }, { before: () => { controller.abort(); } });
  const cache = { store: new IncrementalScoreCache(), key: "k" };
  const result = await scoreToolAdditions("t", cand("a"), s.client, { ...base, signal: controller.signal, failMode: "open" }, cache);
  assert.equal(result.errorCode, "aborted"); assert.deepEqual(result.added, [], "never fails open for an abort"); assert.equal(result.failedOpen, undefined);
  assert.equal(cache.store.needsScoring("k", cand("a")[0]), true);
});
test("an invalid response is rejected fail-closed with nothing cached; missing and extra answers both count", async () => {
  for (const respond of [
    (request: DecisionRequest): DecisionResponse => ({ answers: { [Object.keys(request.questions)[0]]: { type: "score", score: 2 } } }),
    (request: DecisionRequest): DecisionResponse => ({ answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "bool", probability: 1 }])) as never }),
    (): DecisionResponse => ({ answers: { zz: { type: "score", score: 2 } } }),
  ]) {
    const cache = { store: new IncrementalScoreCache(), key: "k" };
    const result = await scoreToolAdditions("t", cand("a", "b"), scripted({}, { respond }).client, base, cache);
    assert.equal(result.errorCode, "invalid_response"); assert.deepEqual(result.added, []); assert.equal(result.failedOpen, undefined);
    assert.equal(cache.store.needsScoring("k", cand("a")[0]), true);
  }
});
test("provider failure is fail-closed by default and reports only a safe code", async () => {
  const client: RelevanceClient = { async decide() { throw Object.assign(new Error("PRIVATE provider detail sk-secret"), { code: "http" }); } };
  const result = await scoreToolAdditions("t", cand("a"), client, base);
  assert.deepEqual({ added: result.added, errorCode: result.errorCode, scored: result.scored }, { added: [], errorCode: "http", scored: 1 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret/);
  const unknown = await scoreToolAdditions("t", cand("a"), { async decide() { throw new Error("boom"); } }, base);
  assert.equal(unknown.errorCode, "decision-failed", "unrecognized errors collapse to a generic safe code"); assert.deepEqual(unknown.added, []);
});
test("failMode open adds every candidate on a decision failure, but never for config errors or aborts", async () => {
  const failing: RelevanceClient = { async decide() { throw Object.assign(new Error("x"), { code: "timeout" }); } };
  const open = await scoreToolAdditions("t", cand("a", "b"), failing, { ...base, failMode: "open" });
  assert.deepEqual(open.added, ["a", "b"]); assert.equal(open.failedOpen, true); assert.equal(open.errorCode, "timeout"); assert.equal(open.eligible, 2);
  // Invalid response also fails open when explicitly configured.
  const invalid = await scoreToolAdditions("t", cand("a"), scripted({}, { respond: () => ({ answers: {} }) }).client, { ...base, failMode: "open" });
  assert.deepEqual(invalid.added, ["a"]); assert.equal(invalid.failedOpen, true);
  // Config errors (invalid policy) never fail open and make no call.
  const s = scripted({ a: 2 });
  for (const options of [{ threshold: 2 }, { threshold: Number.NaN }, { maxAdded: -1 }, { maxAdded: 1.5 }, { failMode: "maybe" as never }]) {
    const result = await scoreToolAdditions("t", cand("a"), s.client, { ...base, failMode: "open", ...options });
    assert.equal(result.errorCode, "config", JSON.stringify(options)); assert.deepEqual(result.added, []);
  }
  assert.equal(s.calls(), 0);
  const badSubject = await scoreToolAdditions("t", cand("a"), s.client, { ...base, failMode: "open", subject: "bogus" as never });
  assert.equal(badSubject.errorCode, "config"); assert.deepEqual(badSubject.added, []); assert.notEqual(badSubject.failedOpen, true);
  const controller = new AbortController(); controller.abort();
  const aborted = await scoreToolAdditions("t", cand("a"), s.client, { ...base, failMode: "open", signal: controller.signal });
  assert.deepEqual(aborted.added, []); assert.equal(aborted.errorCode, "aborted");
});
test("empty candidates make no call and succeed quietly", async () => {
  const s = scripted({});
  const result = await scoreToolAdditions("t", [], s.client, base);
  assert.deepEqual({ added: result.added, errorCode: result.errorCode, scored: result.scored }, { added: [], errorCode: undefined, scored: 0 });
  assert.equal(s.calls(), 0);
});
test("the mcp_server subject sends state.servers and the same machinery selects namespaces", async () => {
  const seen: string[] = [];
  const client: RelevanceClient = { async decide(request) {
    seen.push(Object.keys(request.state).join());
    const servers = request.state.servers as Record<string, { name: string }>;
    return { answers: Object.fromEntries(Object.entries(servers).map(([id, entry]) => [id, { type: "score", score: entry.name === "mcp__docs" ? 2 : 0 }])) };
  } };
  const result = await scoreToolAdditions("t", cand("mcp__docs", "mcp__x"), client, { ...base, subject: "mcp_server" });
  assert.deepEqual(result.added, ["mcp__docs"]); assert.deepEqual(seen, ["task,servers"]);
});
test("request payloads carry only the task and name/description entries (no extra metadata can leak through candidates)", async () => {
  const requests: DecisionRequest[] = [];
  const client: RelevanceClient = { async decide(request) { requests.push(request); return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "score", score: 0 }])) }; } };
  const hostile = [{ name: "a", description: "d", parameters: "SECRET-PARAMS", instructions: "SECRET-INSTR", path: "/SECRET/path" }];
  await scoreToolAdditions("task", hostile, client, base);
  assert.doesNotMatch(JSON.stringify(requests), /SECRET/);
});

test("each added identifier carries its raw score and the threshold it was selected under; fail-open adds carry none", async () => {
  const s = scripted({ a: 1, b: 2, c: 0.2 });
  const result = await scoreToolAdditions("task", cand("a", "b", "c"), s.client, base);
  assert.deepEqual([...result.picks], [["b", { score: 2, threshold: 0.5 }], ["a", { score: 1, threshold: 0.5 }]]);
  const failing = await scoreToolAdditions("task", cand("a"), scripted({}, { before: () => { throw Object.assign(new Error("boom"), { code: "http" }); } }).client, { ...base, failMode: "open" });
  assert.equal(failing.failedOpen, true);
  assert.equal(failing.picks.size, 0);
});
