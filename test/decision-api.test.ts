import assert from "node:assert/strict";
import test from "node:test";
import { createDecisionClient, normalizeScore } from "../src/decision/api.ts";
import { DecisionError } from "../src/decision/errors.ts";
import type { DecisionBackend, DecisionRequest, DecisionResponse } from "../src/decision/types.ts";
import { validateRequest, validateAnswer } from "../src/decision/validation.ts";

function answer(request: DecisionRequest): DecisionResponse {
  return {answers: Object.fromEntries(Object.entries(request.questions).map(([name,q]) => [name, q.type === "bool" ? {type: "bool",probability: 0.8} : q.type === "score" ? {type: "score",score: 1} : {type: "choice",choice: Object.keys(q.criteria)[0]}])), model: "fixture-model",provider: "fixture-provider",usage: {inputTokens: 10,outputTokens: 2,cost: 0.001}};
}
const request: DecisionRequest = {state: {task: "Fixture"},questions: {a: {type: "bool",instructions: "Useful?"},b: {type: "bool",instructions: "Useful?"},c: {type: "bool",instructions: "Useful?"}}};
const base: DecisionBackend = {id: "typesafe",model: "fixture-model",async decide(request) {return answer(request);}};

test("single unified helper API uses q, preserves response, and normalizes score", async () => {
  const seen: DecisionRequest[] = [];
  const client = createDecisionClient({...base,async decide(request) {seen.push(request); return answer(request);}});
  assert.equal(client.backend, "typesafe"); assert.equal(client.model, "fixture-model");
  assert.deepEqual((await client.bool({}, {instructions: "Useful?"})).answer, {type: "bool",probability: 0.8});
  assert.deepEqual((await client.choice({}, {instructions: "Choose",criteria: {a: "First",b: "Second"}})).answer, {type: "choice",choice: "a"});
  const {answer: score,response} = await client.score({}, {instructions: "Rate",criteria: ["Low","Medium","High"]});
  assert.equal(score.score, 1); assert.equal(response.model, "fixture-model"); assert.equal(normalizeScore(score,3), 0.5);
  assert.deepEqual(seen.map((r) => Object.keys(r.questions)), [["q"],["q"],["q"]]);
  assert.throws(() => normalizeScore({type: "score",score: 3},3), {code: "invalid_response"});
});
test("client validates before network and after backend, wraps safe typed failures", async () => {
  let calls = 0;
  const client = createDecisionClient({...base,async decide(request) {calls++;return answer(request);}});
  await assert.rejects(client.decide({...request,questions: {}}), {code: "invalid_request"}); assert.equal(calls,0);
  await assert.rejects(createDecisionClient({...base,async decide() {return {answers: {}};}}).decide(request), {code: "invalid_response"});
  await assert.rejects(createDecisionClient({...base,async decide() {throw new Error("private-fixture-key");}}).decide(request), (error: unknown) => {assert.ok(error instanceof DecisionError); assert.equal(error.code,"network");assert.ok(!String(error.stack).includes("private"));assert.equal(error.cause,undefined);return true;});
  const typed = new DecisionError("auth", "Key missing");
  await assert.rejects(createDecisionClient({...base,async decide() {throw typed;}}).decide(request), (error) => error === typed);
});
test("chunked decisions bound concurrency, merge exact IDs and sum only common usage fields", async () => {
  let active = 0;let peak = 0;
  const client = createDecisionClient({...base,async decide(chunk) {
    assert.equal(Object.keys(chunk.questions).length,1); assert.equal(chunk.state,request.state);
    peak = Math.max(peak,++active); await new Promise((resolve) => setTimeout(resolve,5)); active--;
    const result = answer(chunk); if (Object.hasOwn(chunk.questions,"b")) delete result.usage?.cost;
    return result;
  }});
  const result = await client.decideChunked(request,{maxQuestions:1,concurrency:2});
  assert.equal(peak,2); assert.deepEqual(Object.keys(result.answers),["a","b","c"]);
  assert.deepEqual(result.usage,{inputTokens:30,outputTokens:6}); assert.equal(result.requestId,undefined);
  assert.equal(result.model,"fixture-model");
});
test("chunk failure aborts siblings, prevents starting further calls, and returns original failure", async () => {
  let calls = 0; const signals: AbortSignal[] = [];
  const failure = new DecisionError("refusal", "Fixture refusal");
  const client = createDecisionClient({...base,async decide(req,options) {
    calls++;signals.push(options!.signal!);
    if (Object.hasOwn(req.questions,"a")) throw failure;
    return new Promise(() => {});
  }});
  await assert.rejects(client.decideChunked(request,{maxQuestions:1,concurrency:2}), (error) => error === failure);
  assert.equal(calls,2); assert.ok(signals.every((signal) => signal.aborted));
});
test("caller cancellation and timeout bound noncooperative backends, including chunks", async () => {
  const client = createDecisionClient({...base,decide: () => new Promise(() => {})});
  await assert.rejects(client.decide(request,{timeoutMs:5}), {code:"timeout"});
  await assert.rejects(client.decideChunked(request,{maxQuestions:1,concurrency:2,timeoutMs:5}), {code:"timeout"});
  const controller = new AbortController();const result = client.decide(request,{signal:controller.signal});controller.abort("private-abort");
  await assert.rejects(result,{code:"aborted"});await assert.rejects(client.decide(request,{signal:controller.signal}),{code:"aborted"});
});
test("invalid chunk configuration/timeout/backend limits and bounded JSON fail before backend", async () => {
  for (const [maxQuestions,concurrency] of [[0,2],[1,0],[1,1.5],[1001,1],[1,33]]) await assert.rejects(createDecisionClient(base).decideChunked(request,{maxQuestions,concurrency}),{code:"invalid_request"});
  await assert.rejects(createDecisionClient(base).decide(request,{timeoutMs:0}),{code:"invalid_request"});
  assert.throws(() => validateRequest(request,{maxQuestions:2}));
  assert.throws(() => validateRequest({state:{},questions:{q:{type:"score",instructions:"Rate",criteria:Array(11).fill("Level")}}},{maxLevels:10}));
  assert.throws(() => validateRequest({...request,state:{large:"x".repeat(512*1024)}}));
  let nested: unknown = {};
  for(let i=0;i<66;i++) nested = {nested};
  assert.throws(() => validateRequest({...request,state:{nested}}));
  assert.throws(() => validateRequest({...request,images:[]}));
});
test("rounded probability maps accepted without pretending partial distributions are complete", () => {
  const q = {type:"score" as const,instructions:"Rate",criteria:["Low","Mid","High"]};
  validateAnswer(q,{type:"score",score:1,probabilities:{"0":0.33,"1":0.33,"2":0.33}});
  validateAnswer({type:"choice",instructions:"Choose",criteria:{a:"A",b:"B",c:"C"}},{type:"choice",choice:"a",probabilities:{a:0.33,b:0.33,c:0.33}});
  assert.throws(() => validateAnswer(q,{type:"score",score:1,probabilities:{"1":1}}));
});
