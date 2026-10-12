import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionRequest } from "../src/decision/types.ts";
import { encodeSystemOne, decodeSystemOne } from "../src/core/codecs/system-one.ts";
import { encodeOpenAI, decodeOpenAI } from "../src/core/codecs/openai-decisions.ts";
const request: DecisionRequest = {state: {task: "Fixture task"}, questions: {
  binary: {type: "bool", instructions: "Useful?", criteria: {true: "Useful", false: "Not useful"}},
  category: {type: "choice", instructions: "Choose", criteria: {direct: "Task help", related: "Background", irrelevant: "No help"}},
  relevance: {type: "score", instructions: "Rate", criteria: ["Irrelevant", "Related", "Direct"]},
}};
function systemFixture() {return {
  id: "fixture-response", model: "fixture-model", provider: "fixture-provider",
  answers: {
    binary: {type: "noul", noul: 0.96},
    category: {type: "choice", choice: "direct", probabilities: {direct: 0.8, related: 0.15, irrelevant: 0.05}, confidence: 0.6},
    relevance: {type: "score", score: 1.75, probabilities: {"0": 0.05, "1": 0.15, "2": 0.8}, confidence: 0.6, legend: {"0": "Irrelevant", "1": "Related", "2": "Direct"}},
  }, usage: {input_tokens: 500, output_tokens: 70, total_tokens: 570, cost: 0.00002},
};}
function openaiFixture() {return {id: "fixture-openai", model: "gpt-6-luna", answers: [
  {type: "score", name: "relevance", score: 1.75, probabilities: [{value: 0,label: "Irrelevant",probability: 0.05},{value: 1,label: "Related",probability: 0.15},{value: 2,label: "Direct",probability: 0.8}], confidence: 0.6},
  {type: "predicate", name: "binary", probability: 0.96},
  {type: "choice", name: "category", choice: "direct", probabilities: [{value: "direct",probability: 0.8},{value: "related",probability: 0.15},{value: "irrelevant",probability: 0.05}],confidence: 0.6},
], usage: {input_tokens: 500,output_tokens: 70}};}

test("System One encodes bool only at provider boundary with full model/state and named questions", () => {
  const wire = encodeSystemOne("~typesafe/jev-latest", request);
  assert.equal(wire.model, "~typesafe/jev-latest"); assert.equal(wire.state, request.state);
  assert.deepEqual(wire.questions.binary, {type: "noul", instructions: "Useful?", criteria: {true: "Useful",false: "Not useful"}});
  assert.deepEqual(wire.questions.category, request.questions.category);
  const noCriteria = encodeSystemOne("jev-latest", {state: {}, questions: {q: {type: "bool",instructions: "Useful?"}}});
  assert.deepEqual(noCriteria.questions.q, {type: "noul",instructions: "Useful?"});
});
test("System One normalizes all primitives, metadata, model/id/provider and measured usage", () => {
  const response = decodeSystemOne(request, systemFixture(), {strictMetadata: true});
  assert.deepEqual(response.answers.binary, {type: "bool",probability: 0.96});
  assert.deepEqual(response.answers.relevance, {type: "score",score: 1.75,probabilities: {"0": 0.05,"1": 0.15,"2": 0.8},confidence: 0.6,legend: {"0": "Irrelevant","1": "Related","2": "Direct"}});
  assert.deepEqual(response.usage, {inputTokens: 500,outputTokens: 70,totalTokens: 570,cost: 0.00002});
  assert.equal(response.requestId, "fixture-response");
});
test("OpenRouter scalar-only responses valid; TypeSafe requires documented metadata", () => {
  const scalar = {answers: {binary: {type: "noul",noul: 0.96}, category: {type: "choice",choice: "direct"}, relevance: {type: "score",score: 1.75}}};
  const response = decodeSystemOne(request, scalar, {strictMetadata: false});
  assert.equal(response.usage, undefined); assert.equal(response.answers.relevance.confidence, undefined);
  assert.throws(() => decodeSystemOne(request, scalar, {strictMetadata: true}), {code: "invalid_response"});
  const value = systemFixture(); delete (value.answers.relevance as {legend?: unknown}).legend;
  assert.throws(() => decodeSystemOne(request, value, {strictMetadata: true}), {code: "invalid_response"});
});
test("System One rejects missing/extra/nonscalar/wrong typed/malformed metadata answers", () => {
  for (const change of [
    (v: Record<string, unknown>) => {delete v.binary;},
    (v: Record<string, unknown>) => {v.extra = {type: "noul",noul: 0.8};},
    (v: Record<string, unknown>) => {v.binary = {type: "bool",probability: 0.8};},
    (v: Record<string, unknown>) => {v.binary = {type: "noul",noul: NaN};},
    (v: Record<string, unknown>) => {v.category = {type: "choice",choice: "unknown"};},
    (v: Record<string, unknown>) => {v.relevance = {type: "score",score: 3};},
    (v: Record<string, unknown>) => {v.relevance = {type: "score",score: 1.5,probabilities: []};},
  ]) {const value = systemFixture(); change(value.answers); assert.throws(() => decodeSystemOne(request, value), {code: "invalid_response"});}
});
test("unknown answer fields are dropped; unknown usage cost isn't fabricated", () => {
  const value = systemFixture(); Object.assign(value.answers.binary, {privateUnexpected: "fixture"});
  assert.equal(Object.hasOwn(decodeSystemOne(request, value).answers.binary, "privateUnexpected"), false);
  const response = decodeSystemOne(request, {...value, usage: {input_tokens: 500,cost: "0.01"}});
  assert.deepEqual(response.usage, {inputTokens: 500});
  assert.throws(() => decodeSystemOne(request, {...value, usage: {input_tokens: -1}}), {code: "invalid_response"});
});
test("OpenAI request uses serialized input, named question array, predicate meanings and levels", () => {
  const wire = encodeOpenAI("gpt-6-luna", request);
  assert.equal(wire.input, '{"task":"Fixture task"}');
  assert.deepEqual(wire.questions[0], {name: "binary",type: "predicate",instructions: "Useful?\n\nTrue means: Useful\nFalse means: Not useful"});
  assert.deepEqual(wire.questions[1], {name: "category",type: "choice",instructions: "Choose",choices: [{value: "direct",description: "Task help"},{value: "related",description: "Background"},{value: "irrelevant",description: "No help"}]});
  assert.deepEqual(wire.questions[2], {name: "relevance",type: "score",instructions: "Rate",levels: [{label: "Irrelevant"},{label: "Related"},{label: "Direct"}]});
  const defaultBool = encodeOpenAI("gpt-6-luna", {state: {},questions: {q: {type: "bool",instructions: "Useful?"}}});
  assert.deepEqual(defaultBool.questions[0], {name: "q",type: "predicate",instructions: "Useful?"});
  for (const name of ["space name", "x".repeat(65), ""]) assert.throws(() => encodeOpenAI("gpt-6-luna", {state: {},questions: {[name]: request.questions.binary}}), {code: "invalid_request"});
});
test("OpenAI answers map by name not position, and distributions/labels normalize", () => {
  const response = decodeOpenAI(request, openaiFixture());
  assert.deepEqual(response.answers.binary, {type: "bool",probability: 0.96});
  assert.deepEqual(response.answers.category.probabilities, {direct: 0.8,related: 0.15,irrelevant: 0.05});
  assert.deepEqual(response.answers.relevance.legend, {"0": "Irrelevant","1": "Related","2": "Direct"});
  assert.deepEqual(response.usage, {inputTokens: 500,outputTokens: 70});
});
test("OpenAI rejects duplicate/missing/unknown answer names and refusals", () => {
  const value = openaiFixture();
  for (const answers of [value.answers.slice(1), [...value.answers, value.answers[0]], [...value.answers, {name: "unknown",type: "predicate",probability: 0.5}], [{...value.answers[0],name: "binary"}, ...value.answers.slice(1)]]) {
    assert.throws(() => decodeOpenAI(request, {...value,answers}), {code: "invalid_response"});
  }
  assert.throws(() => decodeOpenAI(request, {...value,answers: value.answers.map((a) => a.name === "binary" ? {type: "refusal",name: "binary"} : a)}), {code: "refusal",questionId: "binary"});
});
test("OpenAI rejects duplicate distribution options and invalid score level indices", () => {
  const value = openaiFixture(); const score = value.answers[0];
  for (const probabilities of [[{value: 0,probability: 0.5},{value: 0,probability: 0.5}], [{value: 0.5,probability: 1}], [{value: "0",probability: 1}]]) {
    assert.throws(() => decodeOpenAI(request, {...value,answers: [{...score,probabilities}, ...value.answers.slice(1)]}), {code: "invalid_response"});
  }
});
