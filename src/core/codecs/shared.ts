import { DecisionError } from "../../decision/errors.ts";
import type { AnswerMetadata, DecisionRequest, DecisionResponse, DecisionUsage } from "../../decision/types.ts";
import { DecisionValidationError, validateRequest, validateResponse, type RequestLimits } from "../../decision/validation.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
export function invalid(): never { throw new DecisionError("invalid_response", "Decision provider returned an invalid answer schema"); }
export function requestCheck(request: DecisionRequest, limits?: RequestLimits): void {
  try { validateRequest(request, limits); }
  catch (error) { throw new DecisionError("invalid_request", error instanceof DecisionValidationError ? error.message : "Invalid decision request"); }
}
export function responseCheck(request: DecisionRequest, response: unknown): DecisionResponse {
  try { validateResponse(request, response); }
  catch (error) { throw new DecisionError("invalid_response", error instanceof DecisionValidationError ? error.message : "Invalid decision response"); }
  return response;
}
export function number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) invalid(); return value; }
export function string(value: unknown): string { if (typeof value !== "string" || !value.trim()) invalid(); return value; }
export function numberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) invalid();
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, number(entry)]));
}
export function metadata(answer: Record<string, unknown>): AnswerMetadata {
  const result: AnswerMetadata = {};
  if (answer.confidence !== undefined) result.confidence = number(answer.confidence);
  if (answer.probabilities !== undefined) result.probabilities = numberMap(answer.probabilities);
  if (answer.legend !== undefined) {
    if (!isRecord(answer.legend)) invalid();
    result.legend = Object.fromEntries(Object.entries(answer.legend).map(([key, label]) => [key, string(label)]));
  }
  return result;
}
export function responseMetadata(body: Record<string, unknown>): Omit<DecisionResponse, "answers"> {
  const result: Omit<DecisionResponse, "answers"> = {};
  if (body.id !== undefined) result.requestId = string(body.id);
  if (body.model !== undefined) result.model = string(body.model);
  if (body.provider !== undefined) result.provider = string(body.provider);
  if (body.usage !== undefined) {
    if (!isRecord(body.usage)) invalid();
    const usage: DecisionUsage = {};
    for (const [wire, internal] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["total_tokens", "totalTokens"]] as const) {
      if (body.usage[wire] !== undefined) usage[internal] = number(body.usage[wire]);
    }
    if (typeof body.usage.cost === "number" && Number.isFinite(body.usage.cost) && body.usage.cost >= 0) usage.cost = body.usage.cost;
    if (Object.keys(usage).length) result.usage = usage;
  }
  return result;
}
export function modelCheck(model: string): void {
  if (typeof model !== "string" || !model.trim() || model.length > 256 || /[\s\x00-\x1f]/u.test(model)) throw new DecisionError("config", "Invalid decision model identifier");
}
