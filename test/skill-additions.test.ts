import test from "node:test";
import assert from "node:assert/strict";
import { RelevanceScoreCache, scoreAdditions } from "../src/apps/skill-additions.ts";
import type { RelevanceClient } from "../src/apps/relevance.ts";
import type { DecisionRequest } from "../src/decision/types.ts";

const skills = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, description: `desc ${i}`, filePath: `/PRIVATE/${i}/SKILL.md` }));
/** Score by skill number: s9 → 1.8, s8 → 1.6 … lower numbers lower, s0..s3 below the default threshold. */
const scores = (name: string) => Number(name.slice(1)) * 0.2;
function recording() {
  const requests: DecisionRequest[] = [];
  const client: RelevanceClient = { async decide(request) {
    requests.push(request);
    const metadata = request.state.skills as Record<string, { name: string }>;
    return { answers: Object.fromEntries(Object.entries(metadata).map(([id, skill]) => [id, { type: "score", score: scores(skill.name) }])) };
  } };
  return { client, requests, names: () => requests.flatMap((r) => Object.values(r.state.skills as Record<string, { name: string }>).map((s) => s.name)) };
}

test("only the given candidates are scored, in shards, and nothing but the task and name/description is sent", async () => {
  const { client, requests, names } = recording();
  const candidates = skills.slice(3); // s0..s2 were "already advertised": never passed in, never sent
  const result = await scoreAdditions("do the task", candidates, client, { chunkSize: 3, threshold: 0.375, maxSkills: 12 });
  assert.deepEqual(requests.map((r) => Object.keys(r.questions).length), [3, 3, 1]);
  assert.deepEqual(names(), candidates.map((s) => s.name));
  assert.ok(!names().some((name) => ["s0", "s1", "s2"].includes(name)));
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|SKILL\.md|filePath/);
  assert.ok(requests.every((r) => r.state.task === "do the task"));
  assert.equal(result.candidates, 7); assert.equal(result.cached, false); assert.deepEqual(result.batchSizes, [3, 3, 1]);
});
test("maxSkills caps NEW additions globally across shards, best first, not per shard or by inventory order", async () => {
  const { client } = recording();
  const result = await scoreAdditions("t", skills, client, { chunkSize: 2, threshold: 0, maxSkills: 3 });
  assert.deepEqual(result.added.map((s) => s.name), ["s9", "s8", "s7"]);
  assert.equal(result.eligible, 10, "eligible counts everything at or above the threshold before the cap");
  assert.equal(result.added[0], skills[9], "original references are returned");
  assert.deepEqual((await scoreAdditions("t", skills, client, { threshold: 0, maxSkills: 0 })).added, []);
});
test("normalized threshold is inclusive: raw 0.75 passes at 0.375 and 1.8 fails at 0.91", async () => {
  const { client } = recording();
  const at = await scoreAdditions("t", [{ name: "s3", description: "d" }, { name: "s4", description: "d" }], client, { threshold: 0.375 }); // 0.6 and 0.8
  assert.deepEqual(at.added.map((s) => s.name), ["s4"]);
  assert.deepEqual((await scoreAdditions("t", skills, client, { threshold: 0.91 })).added, []);
  assert.deepEqual((await scoreAdditions("t", skills, client, { threshold: 0.9 })).added.map((s) => s.name), ["s9"]);
});
test("a later round for the same task reuses scores (no call) and adds the next-best remaining skills", async () => {
  const { client, requests } = recording();
  const store = new RelevanceScoreCache();
  const options = { threshold: 0.2, maxSkills: 2 };
  const first = await scoreAdditions("same", skills, client, options, { store, key: "k" });
  assert.deepEqual(first.added.map((s) => s.name), ["s9", "s8"]);
  const remaining = skills.filter((s) => !first.added.includes(s));
  const second = await scoreAdditions("same", remaining, client, options, { store, key: "k" });
  assert.equal(requests.length, 1, "the second round made no decision call");
  assert.equal(second.cached, true); assert.deepEqual(second.batchSizes, []);
  assert.deepEqual(second.added.map((s) => s.name), ["s7", "s6"]);
  const third = await scoreAdditions("same", remaining.filter((s) => !second.added.includes(s)), client, { ...options, threshold: 1 }, { store, key: "k" });
  assert.deepEqual(third.added, []); assert.equal(requests.length, 1);
});
test("the cache is bound to its key and to each description; added skills are simply absent", async () => {
  const { client, requests } = recording();
  const store = new RelevanceScoreCache();
  await scoreAdditions("a", skills, client, {}, { store, key: "task-a" });
  await scoreAdditions("b", skills, client, {}, { store, key: "task-b" });
  assert.equal(requests.length, 2, "a different key re-scores");
  const edited = skills.map((s, i) => i === 4 ? { ...s, description: "changed" } : s);
  await scoreAdditions("b", edited, client, {}, { store, key: "task-b" });
  assert.equal(requests.length, 3, "a changed description re-scores");
  const extra = [...skills, { name: "new", description: "d" }];
  await scoreAdditions("b", extra, client, {}, { store, key: "task-b" });
  assert.equal(requests.length, 4, "a candidate that was never scored re-scores");
  store.clear();
  await scoreAdditions("b", extra, client, {}, { store, key: "task-b" });
  assert.equal(requests.length, 5);
});
test("failures are never cached; closed adds nothing, open adds every remaining candidate, config/aborted never open", async () => {
  const failing: RelevanceClient = { async decide() { throw Object.assign(new Error("PRIVATE provider body"), { code: "http" }); } };
  const store = new RelevanceScoreCache();
  const closed = await scoreAdditions("t", skills, failing, {}, { store, key: "k" });
  assert.deepEqual(closed.added, []); assert.equal(closed.errorCode, "http"); assert.equal(closed.failedOpen, undefined);
  assert.doesNotMatch(JSON.stringify(closed), /PRIVATE/);
  const open = await scoreAdditions("t", skills, failing, { failMode: "open" }, { store, key: "k" });
  assert.equal(open.failedOpen, true); assert.deepEqual(open.added, skills); assert.equal(open.errorCode, "http");
  const { client, requests } = recording();
  await scoreAdditions("t", skills, client, {}, { store, key: "k" });
  assert.equal(requests.length, 1, "the earlier failures left no cache entries");
  const abort = new AbortController(); abort.abort();
  const aborted = await scoreAdditions("t", skills, client, { failMode: "open", signal: abort.signal });
  assert.equal(aborted.errorCode, "aborted"); assert.deepEqual(aborted.added, []);
  for (const bad of [{ threshold: 1.5 }, { threshold: -1 }, { maxSkills: -1 }, { failMode: "maybe" }, { mode: "choice" }, { minLabel: "related" }] as never[]) {
    const config = await scoreAdditions("t", skills, client, { failMode: "open", ...(bad as object) });
    assert.equal(config.errorCode, "config"); assert.deepEqual(config.added, [], `${JSON.stringify(bad)} must not fail open`);
  }
});
test("malformed answers and choice answers fail closed", async () => {
  const wrong: RelevanceClient = { async decide(request) { return { answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "choice", choice: "related" }])) }; } };
  const result = await scoreAdditions("t", skills, wrong);
  assert.equal(result.errorCode, "invalid_response"); assert.deepEqual(result.added, []);
});
test("no candidates means no decision call and a clean empty result", async () => {
  const never: RelevanceClient = { async decide() { assert.fail("must not call"); } };
  const result = await scoreAdditions("t", [], never, {});
  assert.deepEqual(result, { added: [], eligible: 0, candidates: 0, cached: false, items: [], latencyMs: result.latencyMs, batchSizes: [] });
});
test("cancellation wins over cached scores, before and after the lookup", async () => {
  const { client, requests } = recording();
  const store = new RelevanceScoreCache();
  await scoreAdditions("t", skills, client, {}, { store, key: "k" });
  const abort = new AbortController(); abort.abort();
  const result = await scoreAdditions("t", skills, client, { signal: abort.signal, failMode: "open" }, { store, key: "k" });
  assert.equal(result.errorCode, "aborted"); assert.deepEqual(result.added, []); assert.equal(result.cached, false);
  assert.equal(requests.length, 1);
  const late = new AbortController();
  const lateClient: RelevanceClient = { decide: async (request) => { const answer = await client.decide(request); late.abort(); return answer; } };
  const raced = await scoreAdditions("t2", skills, lateClient, { signal: late.signal, timeoutMs: 5000 });
  assert.equal(raced.errorCode, "aborted"); assert.deepEqual(raced.added, []);
});
