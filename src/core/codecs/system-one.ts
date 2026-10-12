import type { DecisionAnswer, DecisionRequest, DecisionResponse } from "../../decision/types.ts";
import { invalid, isRecord, metadata, modelCheck, number, requestCheck, responseCheck, responseMetadata, string } from "./shared.ts";

export function encodeSystemOne(model: string, request: DecisionRequest) {
  modelCheck(model);
  requestCheck(request);
  return {model, state: request.state, questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const wire = {type: question.type === "bool" ? "noul" : question.type, instructions: question.instructions, ...(question.criteria !== undefined ? {criteria: question.criteria} : {})};
    return [id, wire];
  }))};
}
export function decodeSystemOne(request: DecisionRequest, value: unknown, options: {strictMetadata: boolean} = {strictMetadata: false}): DecisionResponse {
  if (!isRecord(value) || !isRecord(value.answers)) invalid();
  const entries: [string, DecisionAnswer][] = [];
  if (Object.keys(value.answers).length !== Object.keys(request.questions).length) invalid();
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = Object.hasOwn(value.answers, id) ? value.answers[id] : undefined;
    if (!isRecord(raw)) invalid();
    if (raw.type !== (question.type === "bool" ? "noul" : question.type)) invalid();
    if (options.strictMetadata && question.type !== "bool") {
      if (raw.probabilities === undefined || raw.confidence === undefined || (question.type === "score" && raw.legend === undefined)) invalid();
    }
    const meta = metadata(raw);
    const answer: DecisionAnswer = question.type === "bool" ? {type: "bool", probability: number(raw.noul), ...meta}
      : question.type === "choice" ? {type: "choice", choice: string(raw.choice), ...meta}
      : {type: "score", score: number(raw.score), ...meta};
    entries.push([id, answer]);
  }
  return responseCheck(request, {answers: Object.fromEntries(entries), ...responseMetadata(value)});
}
