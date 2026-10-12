import type { DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResponse } from "./types.ts";

/** Intentionally excludes state, instructions, keys, and provider bodies from diagnostics. */
export class DecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionValidationError";
  }
}

function fail(message: string): never {
  throw new DecisionValidationError(message);
}

function record(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) fail(message);
}

function text(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(message);
}

function bounded(value: unknown, minimum: number, maximum: number, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(message);
}

function sameKeys(value: Record<string, unknown>, expected: string[], message: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) fail(message);
}

function json(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") fail("State must contain only finite JSON values");
  if (ancestors.has(value)) fail("State must not contain cycles");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail("State must not contain sparse arrays");
      json(value[i], ancestors);
    }
  } else {
    record(value, "State must contain only plain JSON objects");
    for (const entry of Object.values(value)) json(entry, ancestors);
  }
  ancestors.delete(value);
}

export function validateQuestion(question: unknown): asserts question is DecisionQuestion {
  record(question, "Question must be an object");
  text(question.instructions, "Question instructions must be nonempty text");
  switch (question.type) {
    case "bool":
      if (question.criteria !== undefined) {
        record(question.criteria, "Bool criteria must be an object");
        sameKeys(question.criteria, ["true", "false"], "Bool criteria must describe true and false");
        for (const description of Object.values(question.criteria)) text(description, "Bool criteria must be nonempty text");
      }
      break;
    case "choice":
      record(question.criteria, "Choice criteria must be an object");
      if (Object.keys(question.criteria).length < 2) fail("Choice must have at least two options");
      for (const [label, description] of Object.entries(question.criteria)) {
        text(label, "Choice labels must be nonempty");
        text(description, "Choice descriptions must be nonempty text");
      }
      break;
    case "score":
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) fail("Score must have at least two ordered rubric levels");
      for (const level of question.criteria) text(level, "Score levels must be nonempty text");
      break;
    default:
      fail("Question type must be bool, choice, or score");
  }
}

/** Cardinality and byte/token limits specific to a vendor belong in its adapter. */
export function validateRequest(request: unknown): asserts request is DecisionRequest {
  record(request, "Decision request must be an object");
  record(request.state, "Decision state must be a JSON object");
  json(request.state);
  record(request.questions, "Decision questions must be a named map");
  if (Object.keys(request.questions).length === 0) fail("Decision request must have at least one question");
  for (const [name, question] of Object.entries(request.questions)) {
    text(name, "Question names must be nonempty");
    validateQuestion(question);
  }
}

const ROUNDING_TOLERANCE = 0.001;

export function validateAnswer(question: DecisionQuestion, answer: unknown): asserts answer is DecisionAnswer {
  validateQuestion(question);
  record(answer, "Decision answer must be an object");
  if (answer.type !== question.type) fail("Answer type must match its question");
  let keys: string[];
  switch (question.type) {
    case "bool":
      bounded(answer.probability, 0, 1, "Bool probability must be finite and in [0, 1]");
      keys = ["true", "false"];
      break;
    case "choice":
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) fail("Choice answer must be a supplied option");
      keys = Object.keys(question.criteria);
      break;
    case "score":
      bounded(answer.score, 0, question.criteria.length - 1, "Score must be a finite expected rubric index");
      keys = question.criteria.map((_, index) => String(index));
      break;
  }
  if (answer.confidence !== undefined) bounded(answer.confidence, 0, 1, "Confidence must be finite and in [0, 1]");
  if (answer.probabilities !== undefined) {
    record(answer.probabilities, "Probabilities must be a map");
    sameKeys(answer.probabilities, keys, "Distribution must cover exactly the supplied outcomes");
    let sum = 0;
    for (const probability of Object.values(answer.probabilities)) {
      bounded(probability, 0, 1, "Outcome probability must be finite and in [0, 1]");
      sum += probability;
    }
    if (Math.abs(sum - 1) > ROUNDING_TOLERANCE) fail("Outcome probabilities must sum to one within rounding tolerance");
    if (question.type === "score") {
      const expected = keys.reduce((total, key, index) => total + index * (answer.probabilities as Record<string, number>)[key], 0);
      if (Math.abs(expected - (answer.score as number)) > ROUNDING_TOLERANCE * keys.length) fail("Score must agree with its probability distribution");
    }
    if (question.type === "bool" && Math.abs((answer.probabilities.true as number) - (answer.probability as number)) > ROUNDING_TOLERANCE) {
      fail("Bool probability must agree with its distribution");
    }
  }
  if (answer.legend !== undefined) {
    record(answer.legend, "Legend must be a map");
    for (const [key, label] of Object.entries(answer.legend)) {
      if (!keys.includes(key)) fail("Legend must describe only supplied outcomes");
      text(label, "Legend descriptions must be nonempty text");
    }
  }
}

/** Validates a normalized response; wire decoding occurs exclusively in core adapters. */
export function validateResponse(request: DecisionRequest, response: unknown): asserts response is DecisionResponse {
  validateRequest(request);
  record(response, "Decision response must be an object");
  record(response.answers, "Decision answers must be a named map");
  sameKeys(response.answers, Object.keys(request.questions), "Response must answer exactly the requested names");
  for (const [name, question] of Object.entries(request.questions)) validateAnswer(question, response.answers[name]);
  if (response.provider !== undefined) text(response.provider, "Response provider must be nonempty text");
  if (response.model !== undefined) text(response.model, "Response model must be nonempty text");
  if (response.usage !== undefined) {
    record(response.usage, "Usage must be an object");
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cost"]) {
      const value = response.usage[key];
      if (value === undefined) continue;
      bounded(value, 0, Number.MAX_SAFE_INTEGER, "Usage measurements must be finite and nonnegative");
      if (key !== "cost" && !Number.isSafeInteger(value)) fail("Usage token counts must be safe integers");
    }
  }
}
