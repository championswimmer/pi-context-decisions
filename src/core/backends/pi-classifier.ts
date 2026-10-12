import { DecisionError } from "../../decision/errors.ts";
import type { DecisionBackend, DecisionQuestion, DecisionState, DecisionUsage } from "../../decision/types.ts";
import type { AuthRegistryLike } from "../auth.ts";
import { createDeadline } from "../control.ts";
import { modelCheck, requestCheck, responseCheck } from "../codecs/shared.ts";

type PiQuestion = Exclude<DecisionQuestion, {type: "bool"}> | {type: "bool"; instructions: string; criteria: {true: string; false: string}};
export interface PiClassifierResultLike {
  provider?: string;
  model?: string;
  answers: Record<string, unknown>;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  usage?: {input?: number; output?: number; totalTokens?: number; cost?: {total?: number}};
}
export interface RegistryLike extends AuthRegistryLike {
  findOfType(type: "classifier", provider: string, id: string): unknown | undefined;
  getModelsOfType(type: "classifier" | "chat", provider?: string): readonly {provider: string; id: string; name?: string; api?: string}[];
  classify(model: unknown, context: {state: DecisionState; questions: Record<string, PiQuestion>}, options?: {signal?: AbortSignal}): Promise<PiClassifierResultLike>;
}
function nativeUsage(raw: PiClassifierResultLike["usage"]): DecisionUsage | undefined {
  if (!raw) return undefined;
  const usage: DecisionUsage = {};
  for (const [source, target] of [["input", "inputTokens"], ["output", "outputTokens"], ["totalTokens", "totalTokens"]] as const) {
    if (typeof raw[source] === "number" && Number.isSafeInteger(raw[source]) && raw[source]! >= 0) usage[target] = raw[source];
  }
  // Pi computes cost using catalog pricing, not provider-billed cost. Placeholder zeros are unknown.
  if ((usage.inputTokens !== undefined || usage.outputTokens !== undefined) && typeof raw.cost?.total === "number" && Number.isFinite(raw.cost.total) && raw.cost.total > 0) usage.cost = raw.cost.total;
  return Object.keys(usage).length ? usage : undefined;
}
export function createPiClassifierBackend(provider: string, id: string, getRegistry: () => RegistryLike): DecisionBackend {
  modelCheck(provider); modelCheck(id);
  return {
    id: "pi", model: `${provider}/${id}`,
    async decide(request, options = {}) {
      requestCheck(request);
      const deadline = createDeadline(options, "pi");
      try {
        deadline.check();
        const registry = getRegistry();
        const model = registry.findOfType("classifier", provider, id);
        if (!model) throw new DecisionError("config", "Pi classifier model is not in the registry", {backend: "pi"});
        const questions: Record<string, PiQuestion> = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, q.type === "bool" ? {...q, criteria: q.criteria ?? {true: "Yes", false: "No"}} : q]));
        const result = await deadline.run(registry.classify(model, {state: request.state, questions}, {signal: deadline.signal}));
        deadline.check();
        if (result.stopReason !== "stop") {
          if (result.stopReason === "aborted") throw new DecisionError("aborted", "Pi classifier operation aborted", {backend: "pi"});
          // Inspect for categorization only; never expose provider error text (could include secrets).
          const text = result.errorMessage ?? "";
          const code = /401|403|unauthor|api[ _-]?key|authentication/iu.test(text) ? "auth" : /429|rate[ _-]?limit/iu.test(text) ? "rate_limit" : "http";
          throw new DecisionError(code, "Pi classifier request failed", {backend: "pi", retryable: code === "rate_limit"});
        }
        const usage = nativeUsage(result.usage);
        // validateResponse refines Pi's unknown answers without assuming its parser cannot be malformed.
        const response = {answers: result.answers, backend: "pi", model: result.model ?? id, provider: result.provider ?? provider, ...(usage ? {usage} : {})};
        return responseCheck(request, response);
      } catch (error) {
        deadline.check();
        if (error instanceof DecisionError) throw error;
        throw new DecisionError("http", "Pi classifier request failed", {backend: "pi"});
      } finally { deadline.close(); }
    },
  };
}
