import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionRequest, DecisionResponse } from "../src/decision/types.ts";
import { DecisionValidationError, validateAnswer, validateQuestion, validateRequest, validateResponse } from "../src/decision/validation.ts";

const request: DecisionRequest = {
  state: { prompt: "Validate API requests", skill: { name: "typescript", description: "Validation patterns" } },
  questions: {
    useful: { type: "bool", instructions: "Is this useful?" },
    category: { type: "choice", instructions: "Choose relevance", criteria: { direct: "Task help", unrelated: "No help" } },
    relevance: { type: "score", instructions: "Score relevance", criteria: ["Irrelevant", "Related", "Directly relevant"] },
  },
};

function response(): DecisionResponse {
  return {
    answers: {
      useful: { type: "bool", probability: 0.8 },
      category: { type: "choice", choice: "direct" },
      relevance: { type: "score", score: 1.75 },
    },
  };
}

test("canonical mixed question request and scalar-only response are valid", () => {
  validateRequest(request);
  validateResponse(request, response());
});

test("all optional metadata is preserved without defaults or mutation", () => {
  const value = response();
  Object.assign(value.answers.category, { confidence: 0.6, probabilities: { direct: 0.8, unrelated: 0.2 } });
  Object.assign(value.answers.relevance, {
    confidence: 0.6,
    probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 },
    legend: { "0": "Irrelevant", "1": "Related", "2": "Directly relevant" },
  });
  value.provider = "openrouter";
  value.model = "typesafe/jev-1.13";
  value.usage = { inputTokens: 500, outputTokens: 70, totalTokens: 570, cost: 0.00002 };
  const before = structuredClone(value);
  validateResponse(request, value);
  assert.deepEqual(value, before);
  assert.equal(value.answers.relevance.type === "score" && value.answers.relevance.score, 1.75);
});

test("bool criteria are optional or explicit true/false descriptions", () => {
  validateQuestion({ type: "bool", instructions: "Approve?" });
  validateQuestion({ type: "bool", instructions: "Approve?", criteria: { true: "Approved", false: "Not approved" } });
  for (const criteria of [{ true: "Approved" }, { true: "Approved", false: "No", maybe: "Maybe" }, { true: "", false: "No" }, null]) {
    assert.throws(() => validateQuestion({ type: "bool", instructions: "Approve?", criteria }), DecisionValidationError);
  }
});

test("wire aliases cannot enter the application contract", () => {
  for (const type of ["noul", "predicate", "boolean"]) {
    assert.throws(() => validateQuestion({ type, instructions: "Approve?" }), DecisionValidationError);
    const value = response();
    (value.answers as Record<string, unknown>).useful = { type, noul: 0.8, probability: 0.8 };
    assert.throws(() => validateResponse(request, value), DecisionValidationError);
  }
});

test("bool values are finite probabilities, including zero and one", () => {
  for (const probability of [0, 0.3, 1]) validateAnswer(request.questions.useful, { type: "bool", probability });
  for (const probability of [-0.1, 1.1, NaN, Infinity, -Infinity, true, "0.8", null, undefined]) {
    assert.throws(() => validateAnswer(request.questions.useful, { type: "bool", probability }), DecisionValidationError);
  }
});

test("choice answers must belong to supplied own options", () => {
  for (const choice of ["missing", "toString", "__proto__", "", null]) {
    assert.throws(() => validateAnswer(request.questions.category, { type: "choice", choice }), DecisionValidationError);
  }
  const criteria = JSON.parse('{"__proto__":"valid label","constructor":"another valid label"}');
  validateAnswer({ type: "choice", instructions: "Choose", criteria }, { type: "choice", choice: "__proto__" });
});

test("score is the fractional expected rubric index, not a 0..1 probability", () => {
  for (const score of [0, 1, 1.75, 2]) validateAnswer(request.questions.relevance, { type: "score", score });
  for (const score of [-0.1, 2.1, NaN, Infinity, "1.75", undefined]) {
    assert.throws(() => validateAnswer(request.questions.relevance, { type: "score", score }), DecisionValidationError);
  }
});

test("invalid confidence is rejected rather than clamped", () => {
  for (const confidence of [-0.1, 1.1, Infinity, NaN, "0.6", null]) {
    assert.throws(() => validateAnswer(request.questions.category, { type: "choice", choice: "direct", confidence }), DecisionValidationError);
  }
});

test("distributions require exact outcomes, bounded probabilities and a near-unit sum", () => {
  for (const probabilities of [
    { direct: 0.8 },
    { direct: 0.8, unrelated: 0.2, extra: 0 },
    { direct: 0.8, unrelated: 0.8 },
    { direct: NaN, unrelated: 0.2 },
    { direct: 1.1, unrelated: -0.1 },
    { direct: "0.8", unrelated: 0.2 },
    [],
    null,
  ]) {
    assert.throws(() => validateAnswer(request.questions.category, { type: "choice", choice: "direct", probabilities }), DecisionValidationError);
  }
  validateAnswer({ type: "choice", instructions: "Choose", criteria: { a: "A", b: "B", c: "C" } }, {
    type: "choice", choice: "a", probabilities: { a: 0.3333, b: 0.3333, c: 0.3333 },
  });
});

test("score distributions and bool distributions agree with scalar answers", () => {
  validateAnswer(request.questions.useful, { type: "bool", probability: 0.8, probabilities: { true: 0.8, false: 0.2 } });
  assert.throws(() => validateAnswer(request.questions.useful, { type: "bool", probability: 0.1, probabilities: { true: 0.8, false: 0.2 } }), DecisionValidationError);
  assert.throws(() => validateAnswer(request.questions.relevance, { type: "score", score: 0.1, probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 } }), DecisionValidationError);
  assert.throws(() => validateAnswer(request.questions.relevance, { type: "score", score: 1.75, probabilities: { "1": 0.05, "2": 0.15, "3": 0.8 } }), DecisionValidationError);
});

test("legends may be partial but cannot introduce unknown outcomes or non-text labels", () => {
  validateAnswer(request.questions.relevance, { type: "score", score: 1.75, legend: { "2": "Direct" } });
  for (const legend of [{ "3": "Unknown" }, { "0": "" }, { "0": 0 }, null]) {
    assert.throws(() => validateAnswer(request.questions.relevance, { type: "score", score: 1.75, legend }), DecisionValidationError);
  }
});

test("named responses cannot omit, invent, or inherit an answer", () => {
  const missing = response();
  delete missing.answers.useful;
  assert.throws(() => validateResponse(request, missing), DecisionValidationError);
  const extra = response();
  extra.answers.extra = { type: "bool", probability: 0.8 };
  assert.throws(() => validateResponse(request, extra), DecisionValidationError);
  const inherited = Object.create(response().answers);
  assert.throws(() => validateResponse(request, { answers: inherited }), DecisionValidationError);
});

test("mismatched or refused answers fail, never becoming zero relevance", () => {
  for (const answer of [{ type: "bool", probability: 0.8 }, { type: "refusal" }, {}, null]) {
    assert.throws(() => validateAnswer(request.questions.relevance, answer), DecisionValidationError);
  }
});

test("request rejects empty maps, malformed labels and missing question semantics", () => {
  for (const value of [
    { ...request, questions: {} },
    { ...request, state: [] },
    { ...request, questions: [] },
    { ...request, questions: { "": request.questions.useful } },
    { ...request, questions: { one: { type: "bool", instructions: "" } } },
    { ...request, questions: { one: { type: "choice", instructions: "Choose", criteria: {} } } },
    { ...request, questions: { one: { type: "choice", instructions: "Choose", criteria: { only: "One" } } } },
    { ...request, questions: { one: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "" } } } },
    { ...request, questions: { one: { type: "score", instructions: "Score", criteria: ["One"] } } },
    { ...request, questions: { one: { type: "score", instructions: "Score", criteria: ["One", 2] } } },
  ]) assert.throws(() => validateRequest(value), DecisionValidationError);
});

test("vendor cardinality caps do not masquerade as universal request limits", () => {
  validateQuestion({ type: "score", instructions: "Score", criteria: Array.from({ length: 11 }, (_, i) => String(i)) });
  validateQuestion({ type: "choice", instructions: "Choose", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), String(i)])) });
});

test("state must be finite JSON without cycles, custom objects or sparse arrays", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const invalid of [undefined, () => 1, 1n, Infinity, NaN, new Date(), cycle, new Array(2)]) {
    assert.throws(() => validateRequest({ ...request, state: { nested: invalid } }), DecisionValidationError);
  }
  const shared = { ok: true };
  validateRequest({ ...request, state: { left: shared, right: shared, values: [null, false, 0, ""] } });
});

test("usage is optional with no invented costs; provided measurements are valid", () => {
  validateResponse(request, { ...response(), usage: {} });
  for (const usage of [{ inputTokens: -1 }, { inputTokens: 1.5 }, { outputTokens: Infinity }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 }, { cost: NaN }, { cost: -1 }]) {
    assert.throws(() => validateResponse(request, { ...response(), usage }), DecisionValidationError);
  }
});

test("diagnostics do not contain prompt, question text, names or answer contents", () => {
  const secret = "fixture-only-not-a-real-key";
  assert.throws(() => validateRequest({ state: { prompt: secret }, questions: { [secret]: { type: "predicate", instructions: secret } } }), (error: unknown) => {
    assert.ok(error instanceof DecisionValidationError);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});
