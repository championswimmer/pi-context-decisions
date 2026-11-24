/**
 * Opt-in, billable benchmark: the three frozen runs in docs/benchmarks/decision-benchmark.json against the frozen
 * top-20 roster in docs/benchmarks/decision-models-top20.json. Uses the production decision stack (OpenRouter backend,
 * decision client, score-only `pickSkills` via `runOnce`). Only the prompt and skill names/descriptions are sent.
 * Usage: PI_CONTEXT_DECISIONS_LIVE=1 node --experimental-strip-types scripts/benchmark-decision-models.ts --live --output <new-json>
 */
import { readFile, writeFile } from "node:fs/promises";
import { createOpenRouterBackend } from "../src/core/backends/openrouter.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import { loadDemoSkills } from "./demo-skill-picker.ts";
import { inventoryHash, POLICY, RequestMonitor, runOnce, validateCases } from "./benchmark-relevance-methods.ts";

export const SPEC = new URL("../docs/benchmarks/decision-benchmark.json", import.meta.url);
export const ROSTER = new URL("../docs/benchmarks/decision-models-top20.json", import.meta.url);
const SHARD = 16;
const TIMEOUT_MS = 15_000;
const MODEL_CONCURRENCY = 2;
const TRIALS = 3;
const STOP_RETRY = async () => { throw new Error("benchmark retries disabled"); };

export interface Spec { version: 2; inventory: { count: number; sha256: string }; runs: { id: string; domain: string; prompt: string; shouldPick: string[]; acceptable: string[] }[] }
export interface Trial {
  model: string; runId: string; trial: number; outcome: "ok" | "error"; errorCode?: string; ms: number; posts: number; status: number[];
  selected: string[]; scores?: Record<string, number>; usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
}

async function main() {
  const [live, outputFlag, output, ...rest] = process.argv.slice(2);
  if (live !== "--live" || outputFlag !== "--output" || !output || rest.length || process.env.PI_CONTEXT_DECISIONS_LIVE !== "1") {
    console.error("Live benchmark disabled. Set PI_CONTEXT_DECISIONS_LIVE=1 and pass --live --output <new-json-path>.");
    process.exitCode = 2; return;
  }
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY is required");
  const spec = JSON.parse(await readFile(SPEC, "utf8")) as Spec;
  const roster = JSON.parse(await readFile(ROSTER, "utf8")) as { models: { rank: number; id: string }[] };
  const skills = (await loadDemoSkills()).map(({ name, description }) => ({ name, description }));
  if (spec.version !== 2 || spec.runs.length < 3 || skills.length !== spec.inventory.count || inventoryHash(skills) !== spec.inventory.sha256) throw new Error("benchmark spec does not match the skill inventory");
  const cases = validateCases({ cases: spec.runs.map(({ id, prompt, shouldPick, acceptable }) => ({ id, task: prompt, required: shouldPick, acceptable })) }, skills);
  const models = roster.models.map(({ id }) => id);
  if (models.length !== 20 || new Set(models).size !== 20) throw new Error("roster must be exactly 20 unique models");
  await writeFile(output, "", { flag: "wx", mode: 0o600 }); // reserve the path before any billable request

  const perRun = Math.ceil(skills.length / SHARD);
  const maxPosts = models.length * cases.length * perRun * TRIALS;
  let posts = 0; let reportedCost = 0;
  const baseFetch: typeof fetch = (input, init) => { if (posts >= maxPosts) throw new Error("benchmark request cap"); posts++; return fetch(input, init); };
  const startedAt = new Date().toISOString();
  const trials: Trial[] = [];
  for (let trial = 1; trial <= TRIALS; trial++) for (const [caseIndex, testCase] of cases.entries()) {
    const k = (caseIndex + trial * 7) % models.length;
    const rotated = [...models.slice(k), ...models.slice(0, k)];
    for (let i = 0; i < rotated.length; i += MODEL_CONCURRENCY) {
      const group = await Promise.all(rotated.slice(i, i + MODEL_CONCURRENCY).map(async (model): Promise<Trial> => {
        const monitor = new RequestMonitor(baseFetch, perRun);
        const client = createDecisionClient(createOpenRouterBackend(model, { http: { fetch: monitor.fetch, sleep: STOP_RETRY } }));
        const row = await runOnce({ model, testCase, trial, arm: "score", position: 0, skills, monitor, timeoutMs: TIMEOUT_MS, client: { maxQuestions: SHARD, decide: (r, o) => client.decide(r, o) } });
        const complete = row.outcome === "ok" && row.items?.length === skills.length;
        reportedCost += row.usage?.cost ?? 0;
        return {
          model, runId: testCase.id, trial, outcome: complete ? "ok" : "error", errorCode: complete ? undefined : row.errorCode ?? "incomplete",
          ms: Math.round(row.e2eMs * 10) / 10, posts: row.physicalRequests, status: row.httpStatuses,
          selected: complete ? row.selected : [], scores: complete ? Object.fromEntries(row.items!.map(({ name, score }) => [name, score])) : undefined, usage: row.usage,
        };
      }));
      for (const t of group) { trials.push(t); console.error(`t${t.trial} ${t.runId} ${t.model}: ${t.outcome} ${t.ms}ms ${t.errorCode ?? ""}`); }
    }
  }
  await writeFile(output, `${JSON.stringify({
    version: 3, startedAt, finishedAt: new Date().toISOString(), credentials: "OPENROUTER_API_KEY only",
    inventory: { sha256: spec.inventory.sha256 },
    settings: { trials: TRIALS, questionsPerShard: SHARD, parallelShards: true, timeoutMs: TIMEOUT_MS, modelConcurrency: MODEL_CONCURRENCY, cap: POLICY.maxSkills, threshold: POLICY.threshold, maxPosts },
    posts, reportedCost, trials,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("Decision benchmark could not finish; check inputs, credentials, network, and the new output path.", (e as Error)?.message); process.exitCode = 1; });
