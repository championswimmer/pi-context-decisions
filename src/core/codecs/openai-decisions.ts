import { DecisionError } from "../../decision/errors.ts";
import type { AnswerMetadata, DecisionAnswer, DecisionRequest, DecisionResponse } from "../../decision/types.ts";
import { invalid, isRecord, modelCheck, number, requestCheck, responseCheck, responseMetadata, string } from "./shared.ts";

export function encodeOpenAI(model: string, request: DecisionRequest) {
  modelCheck(model);
  requestCheck(request);
  return {model, input: JSON.stringify(request.state), questions: Object.entries(request.questions).map(([name, q]) => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name)) throw new DecisionError("invalid_request", "OpenAI question names require 1–64 safe identifier characters");
    if (q.type === "choice") return {name, type: "choice", instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({value, description}))};
    if (q.type === "score") return {name, type: "score", instructions: q.instructions, levels: q.criteria.map((label) => ({label}))};
    return {name, type: "predicate", instructions: q.criteria ? `${q.instructions}\n\nTrue means: ${q.criteria.true}\nFalse means: ${q.criteria.false}` : q.instructions};
  })};
}

export function decodeOpenAI(request: DecisionRequest, value: unknown): DecisionResponse {
  if (!isRecord(value) || !Array.isArray(value.answers)) invalid();
  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of value.answers) {
    if (!isRecord(raw) || typeof raw.name !== "string" || byName.has(raw.name) || !Object.hasOwn(request.questions, raw.name)) invalid();
    byName.set(raw.name, raw);
  }
  if (byName.size !== Object.keys(request.questions).length) invalid();
  const entries: [string, DecisionAnswer][] = [];
  for (const [id, q] of Object.entries(request.questions)) {
    const raw = byName.get(id)!;
    if (raw.type === "refusal") throw new DecisionError("refusal", "Decision provider refused a question", {questionId: /^[A-Za-z0-9_.-]{1,64}$/u.test(id) ? id : undefined});
    if (raw.type !== (q.type === "bool" ? "predicate" : q.type)) invalid();
    const meta: AnswerMetadata = {};
    if (raw.confidence !== undefined) meta.confidence = number(raw.confidence);
    if (raw.probabilities !== undefined) {
      if (!Array.isArray(raw.probabilities)) invalid();
      const probs = new Map<string, number>();
      const labels = new Map<string, string>();
      for (const entry of raw.probabilities) {
        if (!isRecord(entry)) invalid();
        let key: string;
        if (q.type === "score") {
          if (typeof entry.value !== "number" || !Number.isSafeInteger(entry.value)) invalid();
          key = String(entry.value);
          if (entry.label !== undefined) labels.set(key, string(entry.label));
        } else {
          key = string(entry.value);
        }
        if (probs.has(key)) invalid();
        probs.set(key, number(entry.probability));
      }
      meta.probabilities = Object.fromEntries(probs);
      if (labels.size) meta.legend = Object.fromEntries(labels);
    }
    const answer: DecisionAnswer = q.type === "bool" ? {type: "bool", probability: number(raw.probability), ...meta}
      : q.type === "choice" ? {type: "choice", choice: string(raw.choice), ...meta}
      : {type: "score", score: number(raw.score), ...meta};
    entries.push([id, answer]);
  }
  return responseCheck(request, {answers: Object.fromEntries(entries), ...responseMetadata(value)});
}
