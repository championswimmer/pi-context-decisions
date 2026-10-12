/** Explicitly opt-in, billable public-fact smoke test; excluded from offline npm test. */
import { createDecisionClient } from "../src/decision/api.ts";
import { DecisionError } from "../src/decision/errors.ts";
import type { DecisionRequest } from "../src/decision/types.ts";
import { createTypeSafeBackend } from "../src/core/backends/typesafe.ts";
import { createOpenRouterBackend } from "../src/core/backends/openrouter.ts";
import { OPENROUTER_DECISION_MODELS } from "../src/catalog/openrouter-models.ts";

if (process.env.PI_CONTEXT_DECISIONS_LIVE !== "1") {
  console.error("Live inference disabled. Set PI_CONTEXT_DECISIONS_LIVE=1 to authorize billable smoke calls.");
  process.exit(2);
}
const request: DecisionRequest = {
  state: { text: "The sky is blue on a clear day.", topic: "weather" },
  questions: {
    sky: { type: "bool", instructions: "Does the text say the sky is blue?", criteria: { true: "It says the sky is blue.", false: "It does not say the sky is blue." } },
    topic: { type: "choice", instructions: "Which topic best describes the text?", criteria: { weather: "Sky or weather", cooking: "Food preparation" } },
    relevance: { type: "score", instructions: "How relevant is the text to weather?", criteria: ["Irrelevant", "Related", "Directly relevant"] },
  },
};
const selected = process.argv.slice(2);
const targets = [
  { backend: "typesafe", model: "jev-latest", key: "TYPESAFE_API_KEY" },
  ...OPENROUTER_DECISION_MODELS.map(({ id }) => ({ backend: "openrouter", model: id, key: "OPENROUTER_API_KEY" })),
].filter(({ model }) => selected.length === 0 || selected.includes(model));
if (!targets.length || selected.some((id) => !targets.some(({ model }) => model === id))) {
  console.error("Unknown smoke-test model. Only the checked-in catalog and jev-latest are allowed.");
  process.exit(2);
}
console.log(JSON.stringify({ kind: "live-smoke", request: "public-weather-fact", primitiveCount: 3, targets: targets.length }));
for (const target of targets) {
  if (!process.env[target.key]) {
    console.log(JSON.stringify({ backend: target.backend, model: target.model, outcome: "missing_key", calls: 0 }));
    continue;
  }
  let calls = 0;
  const http: { status: number; guardrail: boolean; unavailable: boolean; schema?: Record<string, string[]> }[] = [];
  const monitoredFetch: typeof fetch = async (input, init) => {
    // No headers, credentials, raw errors, or provider bodies are printed or retained.
    calls++;
    const response = await fetch(input, init);
    const entry: (typeof http)[number] = { status: response.status, guardrail: false, unavailable: false };
    if (response.ok) {
      try {
        const data = await response.clone().json() as { answers?: Record<string, unknown> };
        if (data.answers && typeof data.answers === "object") {
          entry.schema = Object.fromEntries(Object.entries(data.answers).map(([id, answer]) => [id, answer && typeof answer === "object" ? Object.keys(answer).filter((key) => /^(type|noul|predicate|probability|choice|score|probabilities|confidence|legend)$/u.test(key)).sort() : []]));
        }
      } catch { /* Backend performs authoritative parsing. */ }
    } else {
      try {
        const body = await response.clone().text();
        entry.guardrail = /guardrail|guard.?rail|policy.*(?:block|restrict)|(?:block|restrict).*policy/iu.test(body);
        entry.unavailable = /no endpoints|unavailable|not available|no providers|not supported|model.*not found|unknown model|not enabled/iu.test(body);
      } catch { /* Transport outcome remains observable. */ }
    }
    http.push(entry);
    return response;
  };
  const deps = { http: { fetch: monitoredFetch }, env: process.env };
  const backend = target.backend === "typesafe" ? createTypeSafeBackend(target.model, deps) : createOpenRouterBackend(target.model, deps);
  const start = Date.now();
  try {
    const result = await createDecisionClient(backend).decide(request, { timeoutMs: 15000 });
    const scalars = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, answer.type === "bool" ? answer.probability : answer.type === "choice" ? answer.choice : answer.score]));
    console.log(JSON.stringify({ backend: target.backend, model: target.model, outcome: "ok", calls, latencyMs: Date.now() - start, answers: scalars, usage: result.usage ?? null, http }));
  } catch (error) {
    console.log(JSON.stringify({ backend: target.backend, model: target.model, outcome: "error", code: error instanceof DecisionError ? error.code : "unexpected", status: error instanceof DecisionError ? error.status : undefined, calls, latencyMs: Date.now() - start, http }));
  }
}
