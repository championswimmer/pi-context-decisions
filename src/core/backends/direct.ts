import { DecisionError } from "../../decision/errors.ts";
import type { BackendId, DecisionBackend, DecisionOptions, DecisionRequest, DecisionResponse } from "../../decision/types.ts";
import type { RequestLimits } from "../../decision/validation.ts";
import type { AuthDeps, AuthRegistryLike, Credential } from "../auth.ts";
import { createDeadline } from "../control.ts";
import { postJson, type HttpDeps } from "../http.ts";
import { modelCheck, requestCheck } from "../codecs/shared.ts";

export interface DirectBackendDeps {
  registry?: AuthRegistryLike;
  env?: Record<string, string | undefined>;
  http?: HttpDeps;
}
export function createDirectBackend(config: {
  id: Exclude<BackendId, "pi">;
  model: string;
  url: string;
  resolveKey: (deps: AuthDeps) => Promise<Credential>;
  encode: (model: string, request: DecisionRequest) => unknown;
  decode: (request: DecisionRequest, json: unknown) => DecisionResponse;
  limits?: RequestLimits;
}, deps: DirectBackendDeps): DecisionBackend {
  modelCheck(config.model);
  return {
    id: config.id, model: config.model,
    async decide(request: DecisionRequest, options: DecisionOptions = {}): Promise<DecisionResponse> {
      requestCheck(request, config.limits);
      // Encode and validate before requesting auth or touching the network.
      const body = config.encode(config.model, request);
      const deadline = createDeadline(options, config.id);
      try {
        deadline.check();
        const {key} = await deadline.run(config.resolveKey({...deps, signal: deadline.signal}));
        const result = await postJson(config.url, key, body, {backend: config.id, signal: deadline.signal, timeoutMs: options.timeoutMs ?? 8000}, deps.http);
        deadline.check();
        const response = config.decode(request, result.json);
        return {...response, backend: config.id, model: response.model ?? config.model, provider: response.provider ?? config.id};
      } catch (error) {
        deadline.check();
        if (error instanceof DecisionError) {
          if (error.backend !== undefined) throw error;
          throw new DecisionError(error.code, error.message, {backend: config.id, status: error.status, retryable: error.retryable, questionId: error.questionId});
        }
        throw new DecisionError("network", "Decision backend request failed", {backend: config.id});
      } finally { deadline.close(); }
    },
  };
}
