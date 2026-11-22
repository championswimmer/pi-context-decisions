import { DecisionError } from "../../decision/errors.ts";
import type { DecisionRequest, DecisionResponse } from "../../decision/types.ts";
import { isRecord, invalid, number, requestCheck } from "./shared.ts";
import { decodeSystemOne } from "./system-one.ts";

export const GEMINI_DECISION_MODEL = "gemini-decision-1";

export function encodeGemini(model: string, request: DecisionRequest) {
  if (model !== GEMINI_DECISION_MODEL) throw new DecisionError("config", "Select a supported Gemini decision model");
  requestCheck(request, {maxChoices: 255, maxLevels: 255});
  const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new DecisionError("invalid_request", "Invalid Gemini question identifier");
    if (question.type !== "bool") return [id, {type: question.type, instructions: question.instructions, criteria: question.criteria}];
    const criteria = question.criteria;
    return [id, {type: "noul", instructions: question.instructions, ...(criteria ? {criteria: {true_description: criteria.true, false_description: criteria.false}} : {})}];
  }));
  // Use text input, not a structured media part inferred from caller data.
  return {model, input: JSON.stringify(request.state), questions};
}

export function decodeGemini(request: DecisionRequest, value: unknown): DecisionResponse {
  if (!isRecord(value)) invalid();
  const {usage, ...rest} = value;
  if (usage === undefined) return decodeSystemOne(request, rest);
  if (!isRecord(usage)) invalid();
  const tokens = Object.fromEntries([["total_input_tokens", "input_tokens"], ["total_output_tokens", "output_tokens"], ["total_tokens", "total_tokens"]]
    .filter(([field]) => usage[field] !== undefined)
    .map(([field, normalized]) => [normalized, number(usage[field])]));
  return decodeSystemOne(request, {...rest, usage: tokens});
}
