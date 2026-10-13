import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  armOrder, benchmarkMain, BenchmarkError, buildShortlistRequest, jaccard, loadCases, NONE_OPTION, parseArgs, planRuns, quality, renderDisagreementMarkdown, renderListingsMarkdown, renderSelectionsMarkdown, renderSummaryMarkdown, choiceArgmaxVsThreshold, accounting, inventoryHash, eligibleNames, POLICY, HISTORICAL_POLICY, HISTORICAL_CRITERIA, buildHistoricalChoiceRequests, interpretHistoricalChoice, selectHistoricalChoice,
  RequestMonitor, requiredAtR, runBenchmark, selectFromItems, shortlistStats, summarize, thresholdSweep, validateCases, DEFAULT_MODELS, type BenchmarkCase, type BenchmarkConfig, type BenchmarkReport,
} from "../scripts/benchmark-relevance-methods.ts";
import { loadDemoSkills } from "../scripts/demo-skill-picker.ts";
import { OPENROUTER_DECISION_MODELS } from "../src/catalog/openrouter-models.ts";
import { validateRequest } from "../src/decision/validation.ts";
import { buildRelevanceRequests, RELEVANCE_CRITERIA, type RelevanceClient } from "../src/apps/relevance.ts";
import { selectRelevant } from "../src/apps/skill-filter.ts";
import type { DecisionRequest, DecisionResponse } from "../src/decision/types.ts";

const SCRIPT_URL = new URL("../scripts/benchmark-relevance-methods.ts", import.meta.url).href;
const LIVE = { PI_CONTEXT_DECISIONS_LIVE: "1" };
const skills = await loadDemoSkills();
const cases = await loadCases(skills);

/** Deterministic stand-in: required skills are relevant; first acceptable-looking neighbours are "related". No network. */
function fakeFactory(options: { fail?: (model: string) => boolean } = {}) {
  const calls: { model: string; request: DecisionRequest }[] = [];
  const baseFetch: typeof fetch = async () => new Response("{}", { status: 200 });
  const createClient = async (model: string, monitor: RequestMonitor): Promise<RelevanceClient> => ({
    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      calls.push({ model, request });
      await monitor.fetch("https://example.invalid/", { method: "POST", body: JSON.stringify(request) });
      if (options.fail?.(model)) throw Object.assign(new Error("boom"), { code: "http", status: 500 });
      const task = String(request.state.task);
      const testCase = cases.find((c) => c.task === task)!;
      const answers: DecisionResponse["answers"] = {};
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === "choice" && id === "pick") {
          const choice = testCase.required[0] ?? NONE_OPTION;
          const keys = Object.keys(question.criteria);
          const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 0.7 : 0.3 / (keys.length - 1)]));
          answers[id] = { type: "choice", choice, probabilities };
          continue;
        }
        const name = (request.state.skills as Record<string, { name: string }>)[id].name;
        const level = testCase.required.includes(name) ? 2 : testCase.acceptable.includes(name) ? 1 : 0;
        answers[id] = question.type === "score" ? { type: "score", score: level === 1 ? 1.2 : level } : { type: "choice", choice: ["irrelevant", "related", "directly_relevant"][level] };
      }
      return { answers, usage: { inputTokens: 100, outputTokens: 10, cost: 0.00001 }, model };
    },
  });
  return { calls, baseFetch, createClient };
}
async function withTemp<T>(run: (output: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bench-"));
  try { return await run(join(dir, "report.json")); } finally { await rm(dir, { recursive: true, force: true }); }
}
const config = (output: string, extra: Partial<BenchmarkConfig> = {}): BenchmarkConfig => ({
  models: ["typesafe/jev-1.13", "liquid/d1"], trials: 2, shortlistTrials: 1, maxRequests: 100, maxCostUsd: 5, timeoutMs: 5000, retryFailed: false, output, ...extra,
});

test("benchmark fixture: at least three cases incl. multi-skill and unrelated, all names real demo skills", () => {
  assert.ok(cases.length >= 3);
  assert.ok(cases.some((c) => c.required.length >= 3));
  assert.ok(cases.some((c) => c.required.length === 0));
  const bad = { cases: [{ id: "x", task: "t", required: ["nope"], acceptable: [] }, ...cases.slice(0, 2).map((c) => ({ ...c, id: `${c.id}-copy` }))] };
  assert.throws(() => validateCases(bad, skills), BenchmarkError);
  assert.throws(() => validateCases({ cases: cases.slice(0, 2) }, skills), BenchmarkError);
});
test("default models are five distinct entries of the static retained catalog", () => {
  const catalog = new Set(OPENROUTER_DECISION_MODELS.map((m) => m.id));
  assert.equal(DEFAULT_MODELS.length, 5); assert.equal(new Set(DEFAULT_MODELS).size, 5);
  assert.ok(DEFAULT_MODELS.every((id) => catalog.has(id)));
  assert.throws(() => parseArgs(["--models", "openai/gpt-6-luna-decisions"]), BenchmarkError);
  assert.throws(() => parseArgs(["--models", "typesafe/jev-1.13,typesafe/jev-1.13"]), BenchmarkError);
});
test("default plan fits the 100-request budget: 5 models x 4 cases x (2 trials x 2 arms + 1 shortlist)", () => {
  const { config: defaults } = parseArgs([]);
  assert.equal(planRuns(defaults, cases).length, 5 * cases.length * 5);
  assert.ok(planRuns(defaults, cases).length <= defaults.maxRequests);
  assert.deepEqual(armOrder(1), ["score", "choice-label"]); assert.deepEqual(armOrder(2), ["choice-label", "score"]);
});
test("shortlist request is one valid single-winner choice over all 30 skills plus none, metadata only", () => {
  const request = buildShortlistRequest("Task text", skills);
  validateRequest(request);
  assert.deepEqual(Object.keys(request.state), ["task"]);
  const question = request.questions.pick;
  assert.equal(question.type, "choice");
  assert.equal(Object.keys(question.criteria as object).length, 31);
  assert.deepEqual(Object.keys(question.criteria as object).slice(0, 30), skills.map((s) => s.name));
});
test("quality metrics: precision/recall/f1, off-topic excludes acceptable, empty required has no recall", () => {
  const c = { required: ["a", "b"], acceptable: ["c"] };
  assert.deepEqual(quality(["a", "c", "z"], c), { selected: 3, truePositives: 1, offTopic: 1, precision: 1 / 3, recall: 0.5, f1: 0.4 });
  assert.equal(quality([], c).precision, null); assert.equal(quality([], c).f1, 0);
  assert.deepEqual(quality(["z"], { required: [], acceptable: [] }), { selected: 1, truePositives: 0, offTopic: 1, precision: 0, recall: null, f1: null });
  assert.equal(jaccard([], []), 1); assert.equal(jaccard(["a"], ["b"]), 0);
});
test("required@R resolves ties pessimistically against the arm", () => {
  const items = [{ name: "x", score: 1 }, { name: "a", score: 1 }, { name: "y", score: 1 }];
  assert.equal(requiredAtR(items, ["a"]), 0); // all tie, a ranks last
  assert.equal(requiredAtR([{ name: "a", score: 2 }, { name: "x", score: 1 }], ["a"]), 1);
  assert.equal(requiredAtR(items, []), null);
});
test("selectFromItems mirrors production policy: label floor, score order, stable ties, cap", () => {
  const items = [{ name: "a", score: 1, label: "related" }, { name: "b", score: 2, label: "directly_relevant" }, { name: "c", score: 1, label: "related" }, { name: "d", score: 0.4, label: "irrelevant" }];
  assert.deepEqual(selectFromItems(items, { minLabel: "related" }), ["b", "a", "c"]);
  assert.deepEqual(selectFromItems(items, { minLabel: "directly_relevant" }), ["b"]);
  assert.deepEqual(selectFromItems(items, { minScore: 0.75 }, 2), ["b", "a"]);
});
test("monitor enforces a hard physical request cap and records sizes without keys", async () => {
  const seen: unknown[] = [];
  const monitor = new RequestMonitor(async (_input, init) => { seen.push(init); return new Response("{}"); }, 2, 1);
  await monitor.fetch("https://example.invalid/", { method: "POST", body: "abcd" });
  await assert.rejects(monitor.fetch("https://example.invalid/", { method: "POST", body: "x" }), /budget/);
  assert.equal(seen.length, 1); assert.equal(monitor.log[0].bytes, 4); assert.equal(monitor.used, 2);
});
test("live gate: no client or file work without PI_CONTEXT_DECISIONS_LIVE=1", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    await assert.rejects(runBenchmark(config(output), { env: {}, createClient: fake.createClient, baseFetch: fake.baseFetch }), { code: "live-disabled" });
    assert.equal(fake.calls.length, 0);
    assert.equal(await benchmarkMain([], {}), 2);
    assert.equal(await benchmarkMain(["--live"], {}), 2);
  });
});
test("every score and choice run evaluates all thirty candidates in identical bounded payloads; production selection is reproduced", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    const report = await runBenchmark(config(output), { env: { ...LIVE, OPENROUTER_API_KEY: "sk-test-SECRET" }, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    assert.equal(report.records.length, 2 * cases.length * 5);
    for (const record of report.records) {
      assert.equal(record.outcome, "ok"); assert.equal(record.evaluatedCount, 30);
      assert.equal(record.physicalRequests, 1); assert.equal(record.retries, 0);
      if (record.arm !== "choice-shortlist") {
        assert.deepEqual(record.batchSizes, [30]); assert.equal(record.items!.length, 30);
        assert.deepEqual([...record.selected].sort(), eligibleNames(record, 12).sort());
      }
    }
    // Same prompt/metadata for both per-skill arms; only the answer format differs.
    const perSkill = fake.calls.filter((c) => !("pick" in c.request.questions));
    const score = perSkill.find((c) => Object.values(c.request.questions)[0].type === "score")!;
    const choice = perSkill.find((c) => Object.values(c.request.questions)[0].type === "choice" && c.request.state.task === score.request.state.task)!;
    assert.deepEqual(score.request.state, choice.request.state);
    assert.equal(Object.values(score.request.questions)[0].instructions, Object.values(choice.request.questions)[0].instructions);
    const serialized = JSON.stringify(fake.calls.map((c) => c.request));
    assert.doesNotMatch(serialized, /SKILL\.md|\/Users\/|sk-test/u);
    const written = await readFile(output, "utf8");
    assert.doesNotMatch(written, /sk-test-SECRET|Bearer/u);
    assert.equal(JSON.parse(written).credentials.envKeyPresent, true);
  });
});
test("results are resumable and idempotent; failures are recorded not retried unless asked", async () => {
  await withTemp(async (output) => {
    const failing = fakeFactory({ fail: (model) => model === "liquid/d1" });
    const first = await runBenchmark(config(output), { env: LIVE, createClient: failing.createClient, baseFetch: failing.baseFetch, skills });
    assert.equal(first.records.filter((r) => r.outcome === "error").length, cases.length * 5);
    assert.ok(first.records.filter((r) => r.outcome === "error").every((r) => r.errorCode === "http" && r.selected.length === 0));
    const before = failing.calls.length;
    await runBenchmark(config(output), { env: LIVE, createClient: failing.createClient, baseFetch: failing.baseFetch, skills });
    assert.equal(failing.calls.length, before);
    const healthy = fakeFactory();
    const retried = await runBenchmark(config(output, { retryFailed: true }), { env: LIVE, createClient: healthy.createClient, baseFetch: healthy.baseFetch, skills });
    assert.equal(healthy.calls.length, cases.length * 5);
    assert.ok(retried.records.every((r) => r.outcome === "ok")); assert.equal(retried.records.length, 2 * cases.length * 5);
  });
});
test("request cap stops the benchmark and later invocations count earlier requests", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    const report = await runBenchmark(config(output, { maxRequests: 7 }), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    assert.equal(report.records.length, 7); assert.equal(fake.calls.length, 7);
    await runBenchmark(config(output, { maxRequests: 7 }), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    assert.equal(fake.calls.length, 7);
  });
});
test("summary: per-arm quality, shortlist hit@1, sweep and render are consistent", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    let clock = 0;
    const report = await runBenchmark(config(output, { models: ["typesafe/jev-1.13"] }), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills, now: () => (clock += 10) });
    const stats = summarize(report);
    assert.deepEqual(stats.map((s) => s.arm), ["choice-label", "choice-shortlist", "score"]);
    const score = stats.find((s) => s.arm === "score")!;
    assert.equal(score.runs, cases.length * 2); assert.equal(score.recall, 1); assert.equal(score.unrelatedSelectedMean, 0); assert.equal(score.stability, 1);
    assert.equal(score.allThirtyEvaluated, true); assert.ok(score.e2eMeanMs! > 0);
    // Uncapped re-selection keeps the same label floor; fake data selects required + acceptable-level skills only.
    const uncapped = summarize(report, { cap: "none" }).find((s) => s.arm === "score")!;
    assert.ok(uncapped.selectedMean! >= score.selectedMean!);
    assert.equal(shortlistStats(report)[0].hitAt1, 1);
    assert.ok(shortlistStats(report)[0].maxPossibleRecall! < 0.5);
    const sweep = thresholdSweep(report, "score");
    assert.equal(sweep.length, 5); assert.ok(sweep.every((row) => row.recall === 1));
    assert.match(renderSummaryMarkdown(report), /choice-shortlist/u);
    const parsed: BenchmarkReport = JSON.parse(await readFile(output, "utf8"));
    assert.equal(parsed.kind, "relevance-methods-benchmark");
  });
});
test("CLI options are strict and importing the script has no side effects", () => {
  for (const args of [["--trials", "0"], ["--trials", "1", "--trials", "2"], ["--max-requests", "-1"], ["--bogus", "1"], ["--timeout-ms"], ["--max-cost-usd", "NaN"]]) assert.throws(() => parseArgs(args), BenchmarkError);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `globalThis.fetch=async()=>{throw Error('NETWORK')}; await import(${JSON.stringify(SCRIPT_URL)});`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
});
test("selection rendering bounds long off-topic lists", () => {
  const names = skills.map((s) => s.name);
  const testCase: BenchmarkCase = { id: "c", task: "t", required: [names[0]], acceptable: [] };
  const report = { version: 1, kind: "relevance-methods-benchmark", createdAt: "", node: "", inventory: { count: 30, names }, policy: {}, config: {}, credentials: {}, cases: [testCase],
    records: [{ key: "k", model: "m", caseId: "c", trial: 1, arm: "score", outcome: "ok", selected: names, items: names.map((name) => ({ name, score: 2, label: "directly_relevant" })) }] } as unknown as BenchmarkReport;
  const text = renderSelectionsMarkdown(report, 3);
  assert.match(text, /\(\+26 more\)/u); assert.ok(text.split("\n").every((line) => line.length < 400));
});
test("argmax-versus-threshold diagnostic compares ALL items; an integer derived score is not evidence of a missing distribution", () => {
  const names = skills.map((s) => s.name);
  const testCase: BenchmarkCase = { id: "c", task: "t", required: [names[0]], acceptable: [] };
  const rec = (trial: number, items: { name: string; score: number; label: string }[], selected: string[]) => ({ key: `k${trial}`, model: "m", caseId: "c", trial, arm: "choice-label", outcome: "ok", selected, items });
  // e: integer expectation 1 from a distribution such as [.4,.2,.4]-like mass with an argmax of irrelevant; must still count.
  const report = { version: 1, kind: "relevance-methods-benchmark", inventory: { count: 30, names }, cases: [testCase],
    records: [rec(1, [{ name: "a", score: 0.85, label: "irrelevant" }, { name: "b", score: 1.1, label: "directly_relevant" }, { name: "c", score: 1, label: "related" }, { name: "d", score: 0.6, label: "related" }, { name: "e", score: 1, label: "irrelevant" }], ["b", "c"]),
      rec(2, [], ["c"])] } as unknown as BenchmarkReport;
  const [row] = choiceArgmaxVsThreshold(report);
  assert.deepEqual({ items: row.items, fractionalScore: row.fractionalScore, labelDiffers: row.labelDiffers, eligibilityDiffers: row.eligibilityDiffers, argmaxOnly: row.argmaxOnly, thresholdOnly: row.thresholdOnly },
    { items: 5, fractionalScore: 3, labelDiffers: 4, eligibilityDiffers: 3, argmaxOnly: 1, thresholdOnly: 2 });
  assert.match(renderDisagreementMarkdown(report), /\| m \| 5 \| 3 \| 4 \| 3 \| 1 \| 2 \|/u);
  assert.match(renderListingsMarkdown(report), /\| m \| choice-label \| 3\/0 \| 2\/1 \| b, c \| -b \|/u);
});

// ---------- resume safety ----------
const SMALL = { models: ["liquid/d1"], trials: 1, shortlistTrials: 0 };
const failingEveryTime = () => fakeFactory({ fail: () => true });
test("--retry-failed preserves attempt history: cumulative requests/failures survive repeated failure and resume, and the request cap keeps binding", async () => {
  await withTemp(async (output) => {
    const run = async (extra: Partial<BenchmarkConfig>, fake = failingEveryTime()) =>
      ({ fake, report: await runBenchmark(config(output, { ...SMALL, ...extra }), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills }) });
    const planned = cases.length * 2; // two per-skill arms
    const first = await run({});
    assert.equal(first.report.records.length, planned); assert.equal(accounting(first.report).physicalRequests, planned);
    assert.equal(first.report.attempts, undefined);
    const second = await run({ retryFailed: true });
    assert.equal(second.fake.calls.length, planned);
    assert.equal(second.report.attempts!.length, planned); assert.equal(second.report.records.length, planned);
    assert.ok(second.report.attempts!.every((r) => r.outcome === "error" && r.errorCode === "http" && r.physicalRequests === 1 && r.selected.length === 0));
    const afterRetry = accounting(second.report);
    assert.equal(afterRetry.physicalRequests, planned * 2); assert.equal(afterRetry.failedAttempts, planned * 2); assert.equal(afterRetry.finalFailures, planned);
    // The cap counts superseded attempts: a cap of 20 total leaves room for only 4 more requests after 16.
    const capped = await run({ retryFailed: true, maxRequests: planned * 2 + 4 });
    assert.equal(capped.fake.calls.length, 4);
    assert.equal(accounting(capped.report).physicalRequests, planned * 2 + 4);
    const blocked = await run({ retryFailed: true, maxRequests: planned * 2 + 4 });
    assert.equal(blocked.fake.calls.length, 0);
    // A fresh process that merely resumes without --retry-failed makes no calls and rewrites nothing.
    const before = await readFile(output, "utf8");
    const idle = await run({ maxRequests: 1000 });
    assert.equal(idle.fake.calls.length, 0); assert.equal(await readFile(output, "utf8"), before);
    // Recovery: attempts and failure evidence remain after success.
    const healthy = await run({ retryFailed: true, maxRequests: 1000 }, fakeFactory());
    const totals = accounting(healthy.report);
    assert.equal(totals.finalFailures, 0); assert.deepEqual(totals.failureCodes, ["http"]);
    assert.equal(totals.physicalRequests, planned * 2 + 4 + planned); assert.equal(totals.failedAttempts, planned * 2 + 4);
    assert.ok(healthy.report.records.every((r) => r.outcome === "ok"));
    assert.equal(healthy.report.attempts!.length, totals.failedAttempts);
  });
});
test("resume rejects changed task or labels for an existing case; file and request count stay untouched", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    const base = { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills };
    await runBenchmark(config(output, SMALL), { ...base, cases });
    const snapshot = await readFile(output, "utf8"); const callsBefore = fake.calls.length;
    const edit = (change: Partial<BenchmarkCase>) => cases.map((c) => c.id === "react-signup" ? { ...c, ...change } : c);
    for (const changed of [edit({ task: `${cases[0].task} Also add dark mode.` }), edit({ required: cases[0].required.slice(1) }), edit({ acceptable: [...cases[0].acceptable, "docker-containers"] })]) {
      await assert.rejects(runBenchmark(config(output, SMALL), { ...base, cases: changed }), (error: unknown) => error instanceof BenchmarkError && error.code === "incompatible" && /fresh --output/u.test(error.message));
    }
    assert.equal(await readFile(output, "utf8"), snapshot); assert.equal(fake.calls.length, callsBefore);
    // Reordering labels is not a change.
    await runBenchmark(config(output, SMALL), { ...base, cases: edit({ required: [...cases[0].required].reverse() }) });
    assert.equal(fake.calls.length, callsBefore);
  });
});
test("resume rejects changed protocol inputs: policy, timeout, inventory names and descriptions", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    const base = { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch };
    await runBenchmark(config(output, SMALL), { ...base, skills });
    const snapshot = await readFile(output, "utf8"); const report = JSON.parse(snapshot) as BenchmarkReport;
    assert.equal(report.inventory.sha256, inventoryHash(skills));
    const attempt = (extra: Partial<BenchmarkConfig>, withSkills = skills) => runBenchmark(config(output, { ...SMALL, ...extra }), { ...base, skills: withSkills, cases });
    const incompatible = (error: unknown) => error instanceof BenchmarkError && error.code === "incompatible";
    await assert.rejects(attempt({ timeoutMs: 8000 }), incompatible);
    await assert.rejects(attempt({}, skills.map((s, i) => i === 3 ? { ...s, description: `${s.description} (edited)` } : s)), incompatible);
    await assert.rejects(attempt({}, skills.map((s, i) => i === 3 ? { ...s, name: "renamed-skill" } : s)), incompatible);
    await writeFile(output, JSON.stringify({ ...report, policy: { ...report.policy, threshold: 0.5 } }));
    const tampered = await readFile(output, "utf8");
    await assert.rejects(attempt({}), incompatible);
    assert.equal(await readFile(output, "utf8"), tampered); assert.equal(fake.calls.length, cases.length * 2);
    // A corrupt output is never silently replaced.
    await writeFile(output, "{");
    await assert.rejects(attempt({}), (error: unknown) => error instanceof BenchmarkError && error.code === "config");
    assert.equal(await readFile(output, "utf8"), "{");
  });
});
test("resume may extend the file with new models, trials or cases without touching earlier cases", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    const base = { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills };
    await runBenchmark(config(output, SMALL), { ...base, cases });
    const extra: BenchmarkCase = { ...cases[0], id: "react-signup-variant", task: cases[0].task.replace("Build", "Create") };
    const extended = await runBenchmark(config(output, { ...SMALL, models: ["liquid/d1", "typesafe/jev-1.13"] }), { ...base, cases: [...cases, extra] });
    assert.deepEqual(extended.cases.map((c) => c.id), [...cases.map((c) => c.id), "react-signup-variant"]);
    assert.deepEqual(extended.cases.slice(0, cases.length), cases);
    assert.equal(extended.records.length, (cases.length + 1) * 2 * 2);
  });
});
test("the committed successful snapshot resumes as complete: no calls, no rewrite, legacy format accepted", async () => {
  const committed = new URL("../docs/benchmarks/relevance-methods-raw.json", import.meta.url).pathname;
  const original = await readFile(committed, "utf8");
  const legacy = JSON.parse(original) as BenchmarkReport;
  assert.equal(legacy.attempts, undefined); assert.equal(legacy.inventory.sha256, undefined);
  const totals = accounting(legacy);
  assert.deepEqual({ r: totals.records, p: totals.physicalRequests, f: totals.failedAttempts, s: totals.supersededAttempts }, { r: 100, p: 100, f: 0, s: 0 });
  await withTemp(async (output) => {
    await copyFile(committed, output);
    const fake = fakeFactory();
    const { config: defaults } = parseArgs([]);
    const result = await runBenchmark({ ...defaults, output }, { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    assert.equal(fake.calls.length, 0); assert.equal(result.records.length, 100);
    assert.equal(await readFile(output, "utf8"), original);
  });
  assert.equal(await readFile(committed, "utf8"), original);
  assert.equal((await stat(committed)).isFile(), true);
});
test("cost threshold is soft and checked between runs: an in-flight run can overshoot; the request cap stays hard", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory(); // 0.00001 reported per call
    const report = await runBenchmark(config(output, { ...SMALL, maxCostUsd: 0.000015 }), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    // after call 1: 0.00001 <= 0.000015 continue; after call 2: 0.00002 > threshold stop. Spend ended above the threshold.
    assert.equal(report.records.length, 2); assert.ok(accounting(report).reportedCostUsd > 0.000015);
    const again = await runBenchmark(config(output, { ...SMALL, maxCostUsd: 0.000015, maxRequests: 1 }), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    assert.equal(again.records.length, 2); assert.equal(fake.calls.length, 2);
  });
});

// ---------- score-only production compatibility; historical comparator ----------
test("current policy selects identically to the recorded historical policy: normalized 0.375 is raw 0.75", () => {
  assert.equal(2 * POLICY.threshold, HISTORICAL_POLICY.relatedThreshold);
  assert.equal(POLICY.maxSkills, HISTORICAL_POLICY.maxSkills); assert.equal(POLICY.chunkSize, HISTORICAL_POLICY.chunkSize);
  const items = [0, 0.74, 0.75, 0.76, 1, 1.49, 1.5, 2].map((score, i) => ({ name: `s${i}`, score, normalized: score / 2 }));
  const production = selectRelevant(items, POLICY.threshold, 12).chosen.map((item) => item.name).sort();
  assert.deepEqual(selectFromItems(items, { minScore: 2 * POLICY.threshold }, 12).sort(), production);
  assert.deepEqual(selectFromItems(items.map((i) => ({ ...i, label: i.score >= 1.5 ? "directly_relevant" : i.score >= 0.75 ? "related" : "irrelevant" })), { minLabel: "related" }, 12).sort(), production);
});
test("historical choice comparator sends the production score request's state and instruction text, differing only in answer format", () => {
  assert.deepEqual([...HISTORICAL_CRITERIA], [...RELEVANCE_CRITERIA]);
  const historical = buildHistoricalChoiceRequests(cases[0].task, skills);
  const production = buildRelevanceRequests(cases[0].task, skills, { chunkSize: 50, maxQuestions: 50 });
  assert.equal(historical.length, 1); assert.equal(production.length, 1);
  assert.deepEqual(historical[0].request.state, production[0].request.state); assert.deepEqual(historical[0].idToName, production[0].idToName);
  assert.deepEqual(Object.keys(historical[0].request.questions), Object.keys(production[0].request.questions));
  for (const id of Object.keys(production[0].request.questions)) {
    const choice = historical[0].request.questions[id]; const score = production[0].request.questions[id];
    assert.equal(choice.type, "choice"); assert.equal(score.type, "score"); assert.equal(choice.instructions, score.instructions);
    assert.deepEqual(Object.values(choice.criteria), score.criteria);
    assert.deepEqual(Object.keys(choice.criteria), ["irrelevant", "related", "directly_relevant"]);
  }
  validateRequest(historical[0].request);
  assert.deepEqual(buildHistoricalChoiceRequests("t", skills, 12).map((b) => Object.keys(b.request.questions).length), [12, 12, 6]);
});
test("historical choice interpretation: argmax label, derived expectation from a distribution else hard label, label floor, cap, inventory order", () => {
  const [batch] = buildHistoricalChoiceRequests("t", skills.slice(0, 5));
  const answer = (choice: string, probabilities?: Record<string, number>) => ({ type: "choice" as const, choice, ...(probabilities ? { probabilities } : {}) });
  const response: DecisionResponse = { answers: {
    s0: answer("irrelevant", { irrelevant: 0.4, related: 0.2, directly_relevant: 0.4 }), // expectation 1.0, but argmax label irrelevant
    s1: answer("directly_relevant"), s2: answer("related"), s3: answer("related", { irrelevant: 0.2, related: 0.5, directly_relevant: 0.3 }), s4: answer("irrelevant") } };
  const items = interpretHistoricalChoice([response], [batch]);
  assert.deepEqual(items.map((i) => [i.label, Number(i.score.toFixed(2))]), [["irrelevant", 1], ["directly_relevant", 2], ["related", 1], ["related", 1.1], ["irrelevant", 0]]);
  assert.deepEqual(selectHistoricalChoice(items, 12), [skills[1].name, skills[2].name, skills[3].name]);
  assert.deepEqual(selectHistoricalChoice(items, 2), [skills[1].name, skills[3].name]);
  assert.throws(() => interpretHistoricalChoice([{ answers: { ...response.answers, s4: { type: "score", score: 1 } } } as unknown as DecisionResponse], [batch]), { code: "invalid_response" });
});
test("historical analysis is unchanged by the score-only change: legacy records re-select identically under the current rule", async () => {
  const legacy = JSON.parse(await readFile(new URL("../docs/benchmarks/relevance-methods-raw.json", import.meta.url), "utf8")) as BenchmarkReport;
  let scored = 0;
  for (const record of legacy.records.filter((r) => r.arm === "score")) {
    assert.deepEqual(eligibleNames(record), selectFromItems(record.items!, { minLabel: "related" })); scored++;
  }
  assert.equal(scored, 40);
  assert.deepEqual(legacy.policy, HISTORICAL_POLICY);
});
test("new score-arm records carry no labels; reports record the current policy and the comparator marker", async () => {
  await withTemp(async (output) => {
    const fake = fakeFactory();
    const report = await runBenchmark(config(output, SMALL), { env: LIVE, createClient: fake.createClient, baseFetch: fake.baseFetch, skills });
    assert.equal((report.policy as typeof POLICY).policyVersion, 2); assert.match((report.policy as typeof POLICY).choiceArm, /historical per-skill choice comparator/u);
    for (const record of report.records.filter((r) => r.arm === "score")) assert.ok(record.items!.every((item) => item.label === undefined));
    for (const record of report.records.filter((r) => r.arm === "choice-label")) assert.ok(record.items!.every((item) => typeof item.label === "string"));
  });
});
