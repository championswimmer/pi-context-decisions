import { DecisionError } from "./errors.ts";
import type { BackendId, BoolAnswer, BoolQuestion, ChoiceAnswer, ChoiceQuestion, DecisionBackend, DecisionOptions, DecisionRequest, DecisionResponse, DecisionState, DecisionUsage, ScoreAnswer, ScoreQuestion } from "./types.ts";
import { DecisionValidationError, validateRequest, validateResponse, type RequestLimits } from "./validation.ts";

export interface DecisionClient {
  readonly backend: BackendId;
  readonly model: string;
  decide(request: DecisionRequest, options?: DecisionOptions): Promise<DecisionResponse>;
  bool(state: DecisionState, question: Omit<BoolQuestion, "type">, options?: DecisionOptions): Promise<{answer: BoolAnswer; response: DecisionResponse}>;
  choice(state: DecisionState, question: Omit<ChoiceQuestion, "type">, options?: DecisionOptions): Promise<{answer: ChoiceAnswer; response: DecisionResponse}>;
  score(state: DecisionState, question: Omit<ScoreQuestion, "type">, options?: DecisionOptions): Promise<{answer: ScoreAnswer; response: DecisionResponse}>;
  decideChunked(request: DecisionRequest, options: DecisionOptions & {maxQuestions: number; concurrency: number}): Promise<DecisionResponse>;
}

export function normalizeScore(answer: ScoreAnswer, levels: number): number {
  if (!Number.isSafeInteger(levels) || levels < 2 || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1) {
    throw new DecisionError("invalid_response", "Cannot normalize an invalid rubric score");
  }
  return answer.score / (levels - 1);
}

function validationError(error: unknown, code: "invalid_request" | "invalid_response", backend: BackendId): never {
  if (error instanceof DecisionValidationError) throw new DecisionError(code, error.message, {backend, cause: error});
  if (error instanceof DecisionError) throw error;
  throw new DecisionError(code, "Decision data could not be validated", {backend});
}

/** Enforces caller cancellation even when a third-party backend ignores AbortSignal. */
async function bounded<T>(options: DecisionOptions, backend: BackendId, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new DecisionError("invalid_request", "Invalid decision timeout", {backend});
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const canceled = () => new DecisionError(options.signal?.aborted ? "aborted" : "timeout", options.signal?.aborted ? "Decision operation aborted" : "Decision operation timed out", {backend});
  if (signal.aborted) throw canceled();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let abort: () => void = () => {};
  const cancel = new Promise<never>((_, reject) => {
    abort = () => reject(canceled());
    signal.addEventListener("abort", abort, {once: true});
  });
  try { return await Promise.race([operation(signal), cancel]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export function createDecisionClient(backend: DecisionBackend, limits?: RequestLimits): DecisionClient {
  async function decide(request: DecisionRequest, options: DecisionOptions = {}): Promise<DecisionResponse> {
    try { validateRequest(request, limits); } catch (error) { validationError(error, "invalid_request", backend.id); }
    return bounded(options, backend.id, async (signal) => {
      let response: DecisionResponse;
      try { response = await backend.decide(request, {...options, signal}); }
      catch (error) {
        if (error instanceof DecisionError) throw error;
        // No raw error messages/causes: custom backends may include request text or keys.
        throw new DecisionError("network", "Decision backend failed", {backend: backend.id});
      }
      try { validateResponse(request, response); } catch (error) { validationError(error, "invalid_response", backend.id); }
      return response;
    });
  }
  const client: DecisionClient = {
    backend: backend.id, model: backend.model, decide,
    async bool(state, question, options) {
      const response = await decide({state, questions: {q: {...question, type: "bool"}}}, options);
      return {answer: response.answers.q as BoolAnswer, response};
    },
    async choice(state, question, options) {
      const response = await decide({state, questions: {q: {...question, type: "choice"}}}, options);
      return {answer: response.answers.q as ChoiceAnswer, response};
    },
    async score(state, question, options) {
      const response = await decide({state, questions: {q: {...question, type: "score"}}}, options);
      return {answer: response.answers.q as ScoreAnswer, response};
    },
    async decideChunked(request, options) {
      if (!Number.isSafeInteger(options.maxQuestions) || options.maxQuestions < 1 || options.maxQuestions > 1000 || !Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
        throw new DecisionError("invalid_request", "Invalid question chunk size or concurrency", {backend: backend.id});
      }
      // Whole inventory still has local safety bounds; backend per-call cardinality applies to chunks.
      try { validateRequest(request, {...limits, maxQuestions: 1000}); } catch (error) { validationError(error, "invalid_request", backend.id); }
      return bounded(options, backend.id, async (signal) => {
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        const entries = Object.entries(request.questions);
        const chunks: DecisionRequest[] = [];
        for (let i = 0; i < entries.length; i += options.maxQuestions) chunks.push({state: request.state, questions: Object.fromEntries(entries.slice(i, i + options.maxQuestions))});
        const responses: DecisionResponse[] = new Array(chunks.length);
        let cursor = 0;
        let failure: unknown;
        async function worker() {
          while (cursor < chunks.length && !combined.aborted) {
            const i = cursor++;
            try { responses[i] = await decide(chunks[i], {...options, signal: combined}); }
            catch (error) { if (failure === undefined) failure = error; controller.abort(); return; }
          }
        }
        await Promise.all(Array.from({length: Math.min(options.concurrency, chunks.length)}, worker));
        if (failure !== undefined) throw failure;
        if (combined.aborted) throw new DecisionError("aborted", "Decision operation aborted", {backend: backend.id});
        const usage: DecisionUsage = {};
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "cost"] as const) {
          if (responses.every((r) => r.usage?.[key] !== undefined)) usage[key] = responses.reduce((sum, r) => sum + r.usage![key]!, 0);
        }
        const response: DecisionResponse = {
          answers: Object.fromEntries(responses.flatMap((r) => Object.entries(r.answers))),
          backend: backend.id,
          ...(responses.every((r) => r.model === responses[0].model) && responses[0].model ? {model: responses[0].model} : {}),
          ...(responses.every((r) => r.provider === responses[0].provider) && responses[0].provider ? {provider: responses[0].provider} : {}),
          ...(Object.keys(usage).length ? {usage} : {}),
        };
        try { validateResponse(request, response); } catch (error) { validationError(error, "invalid_response", backend.id); }
        return response;
      });
    },
  };
  return client;
}
