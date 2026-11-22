/** Opt-in live comparison against the frozen manual skill baseline. No effect on the extension's catalog. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createOpenRouterBackend } from "../src/core/backends/openrouter.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import { loadDemoSkills } from "./demo-skill-picker.ts";
import { inventoryHash, POLICY, RequestMonitor, runOnce, validateCases } from "./benchmark-relevance-methods.ts";
import type { DecisionClient } from "../src/decision/api.ts";
import type { DecisionRequest, DecisionUsage } from "../src/decision/types.ts";

const BASELINE = new URL("../docs/benchmarks/decision-model-baseline.json", import.meta.url);
const CATALOG = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
const MAX_MODELS = 50;
const SHARD = 16;
const TIMEOUT_MS = 15_000;
const SOFT_USD = 0.30;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::[a-z0-9_-]+)?$/;
const STOP_RETRY = async () => { throw new Error("benchmark retries disabled"); };

type Probe = { model: string; ok: boolean; status?: number; code?: string; policy?: string; usage?: DecisionUsage };

async function main() {
  const [live, outputFlag, output, ...rest] = process.argv.slice(2);
  if (live !== "--live" || outputFlag !== "--output" || !output || rest.length || process.env.PI_CONTEXT_DECISIONS_LIVE !== "1") {
    console.error("Live benchmark disabled. Set PI_CONTEXT_DECISIONS_LIVE=1 and pass --live --output <new-json-path>.");
    process.exitCode = 2;
    return;
  }
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY is required");
  const baselineText = await readFile(BASELINE, "utf8");
  const baseline = JSON.parse(baselineText) as { version: number; cases: { id: string; task: string; split: string; required: string[]; optional: string[] }[] };
  const skills = (await loadDemoSkills()).map(({ name, description }) => ({ name, description }));
  if (baseline.version !== 1 || baseline.cases.length !== 10 || skills.length !== 30) throw new Error("unexpected benchmark fixture");
  const cases = validateCases({ cases: baseline.cases.map(({ optional, ...c }) => ({ ...c, acceptable: optional })) }, skills);
  const response = await fetch(CATALOG, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new Error("could not load OpenRouter catalog");
  const catalog = await response.json() as { data: { id: string; alias_target?: unknown; architecture?: { output_modalities?: string[] } }[] };
  const models = catalog.data.filter((model) => !model.alias_target).map((model) => {
    if (!MODEL_ID.test(model.id) || !model.architecture?.output_modalities?.includes("decisions")) throw new Error("invalid decision catalog entry");
    return model.id;
  }).sort();
  if (!models.length || models.length > MAX_MODELS || new Set(models).size !== models.length) throw new Error("unexpected decision inventory size");
  // Reserve a new file before any billable POST, so a typo cannot overwrite an existing report.
  await writeFile(output, "", { flag: "wx", mode: 0o600 });

  const startedAt = new Date().toISOString();
  const maxPosts = models.length * (1 + cases.length * Math.ceil(skills.length / SHARD));
  let posts = 0;
  let reportedCost = 0;
  const baseFetch: typeof fetch = (input, init) => {
    if (posts >= maxPosts) throw new Error("benchmark request cap");
    posts++;
    return fetch(input, init);
  };
  const makeClient = (model: string, fetch: typeof globalThis.fetch): DecisionClient =>
    createDecisionClient(createOpenRouterBackend(model, { http: { fetch, sleep: STOP_RETRY } }));
  const smoke: DecisionRequest = {
    state: { text: "The sky is blue on a clear day." },
    questions: { weather: { type: "score", instructions: "How relevant is the text to weather?", criteria: ["Unrelated", "Related", "Directly relevant"] } },
  };
  const probes: Probe[] = [];
  for (let i = 0; i < models.length && reportedCost < SOFT_USD; i += 3) {
    const group = await Promise.all(models.slice(i, i + 3).map(async (model): Promise<Probe> => {
      let status: number | undefined;
      let policy: string | undefined;
      const monitored: typeof fetch = async (input, init) => {
        const res = await baseFetch(input, init);
        status = res.status;
        if (!res.ok) {
          const msg = (await res.clone().json().catch(() => null))?.error?.message;
          if (typeof msg === "string") policy = /guard.?rail/i.test(msg) ? "guardrail" : /privacy/i.test(msg) ? "privacy-settings" : undefined;
        }
        return res;
      };
      try {
        const result = await makeClient(model, monitored).decide(smoke, { timeoutMs: TIMEOUT_MS });
        reportedCost += result.usage?.cost ?? 0;
        return { model, status, ok: true, usage: result.usage };
      } catch (error) {
        return { model, status, ok: false, code: (error as { code?: string }).code ?? "unexpected", policy };
      }
    }));
    for (const row of group) { probes.push(row); console.error(`probe ${row.model}: ${row.status ?? row.code} ${row.ok ? "ok" : row.policy ?? "failed"}`); }
  }

  const viable = probes.filter(({ ok }) => ok).map(({ model }) => model);
  const trials: {
    model: string; caseId: string; outcome: string; ms: number; status: number[];
    errorCode?: string; posts: number; batchSizes: number[]; resolvedModel?: string; usage?: DecisionUsage;
    scores?: number[];
  }[] = [];
  // Sequence tasks. Rotate the model order per task; at most two runs (four parallel shards) in flight.
  for (const [caseIndex, testCase] of cases.entries()) {
    const index = caseIndex % viable.length;
    const rotated = [...viable.slice(index), ...viable.slice(0, index)];
    for (let i = 0; i < rotated.length && reportedCost < SOFT_USD; i += 2) {
      const group = await Promise.all(rotated.slice(i, i + 2).map(async (model) => {
        const monitor = new RequestMonitor(baseFetch, Math.ceil(skills.length / SHARD));
        const client = makeClient(model, monitor.fetch);
        const row = await runOnce({
          model, testCase, trial: 1, arm: "score", position: 0, skills, monitor, timeoutMs: TIMEOUT_MS,
          client: { maxQuestions: SHARD, async decide(request, options) {
            const result = await client.decide(request, options);
            reportedCost += result.usage?.cost ?? 0;
            return result;
          } },
        });
        const scoreByName = new Map(row.items?.map(({ name, score }) => [name, score]));
        const complete = row.outcome === "ok" && skills.every(({ name }) => scoreByName.has(name));
        return {
          model, caseId: testCase.id, outcome: complete ? "ok" : "error", ms: Math.round(row.e2eMs * 10) / 10,
          status: row.httpStatuses, errorCode: complete ? undefined : row.errorCode ?? "incomplete",
          posts: row.physicalRequests, batchSizes: row.batchSizes, resolvedModel: row.responseModel, usage: row.usage,
          scores: complete ? skills.map(({ name }) => scoreByName.get(name)!) : undefined,
        };
      }));
      for (const row of group) { trials.push(row); console.error(`${row.caseId} ${row.model}: ${row.outcome} ${row.ms}ms ${row.status.join("/")}`); }
    }
  }
  await writeFile(output, `${JSON.stringify({
    version: 1, startedAt, finishedAt: new Date().toISOString(), catalog: CATALOG, credentials: "OPENROUTER_API_KEY only",
    baselineSha256: createHash("sha256").update(baselineText).digest("hex"),
    inventory: { names: skills.map(({ name }) => name), sha256: inventoryHash(skills) },
    settings: { modelConcurrency: 2, questionsPerShard: SHARD, parallelShards: true, timeoutMs: TIMEOUT_MS, cap: POLICY.maxSkills, threshold: POLICY.threshold, maxPosts, softUsd: SOFT_USD },
    posts, reportedCost, probes, trials,
  })}\n`);
}

main().catch(() => { console.error("Decision benchmark could not finish; check inputs, credentials, network, and the new output path."); process.exitCode = 1; });
