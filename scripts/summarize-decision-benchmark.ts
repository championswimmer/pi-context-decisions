/** Offline rendering of the frozen manual baseline and saved OpenRouter scores. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { selectFromItems } from "./benchmark-relevance-methods.ts";

interface Case { id: string; split: string; required: string[]; optional: string[] }
interface Trial {
  model: string; caseId: string; outcome: string; ms: number; status: number[];
  errorCode?: string; posts: number; usage?: { cost?: number }; scores?: number[];
}
interface Report {
  baselineSha256: string; startedAt: string; finishedAt: string; posts: number; reportedCost: number;
  inventory: { names: string[] }; settings: { threshold: number; cap: number };
  probes: { model: string; ok: boolean; status?: number; code?: string; policy?: string }[];
  trials: Trial[];
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const fmt = (n: number, digits = 3) => n.toFixed(digits);
const pct = (n: number) => `${fmt(n * 100, 1)}%`;
const dcg = (scores: number[], cap: number) => scores.slice(0, cap).reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
function summarize(rows: readonly Trial[], cases: ReadonlyMap<string, Case>, names: readonly string[], threshold: number, cap: number) {
  let hit = 0, needed = 0, optional = 0, off = 0, unrelated = 0;
  const ndcg: number[] = [];
  const scores = { required: [] as number[], optional: [] as number[], rejected: [] as number[] };
  for (const row of rows) {
    const testCase = cases.get(row.caseId)!;
    const required = new Set(testCase.required), allowed = new Set(testCase.optional);
    const items = names.map((name, i) => ({ name, score: row.scores![i] }));
    needed += required.size;
    const picked = selectFromItems(items, { minScore: threshold * 2 }, cap);
    for (const name of picked) {
      if (required.has(name)) hit++;
      else if (allowed.has(name)) optional++;
      else if (required.size) off++;
      else unrelated++;
    }
    for (const { name, score } of items) scores[required.has(name) ? "required" : allowed.has(name) ? "optional" : "rejected"].push(score);
    if (required.size) {
      const ranks = selectFromItems(items, {}, cap).map((name) => required.has(name) ? 3 : allowed.has(name) ? 1 : 0);
      const ideal = [...testCase.required.map(() => 3), ...testCase.optional.map(() => 1)];
      ndcg.push(dcg(ranks, cap) / dcg(ideal, cap));
    }
  }
  const selected = hit + optional + off + unrelated;
  return { hit, needed, optional, off, unrelated, strictPrecision: selected ? hit / selected : 0, strictF1: selected + needed ? 2 * hit / (selected + needed) : 0,
    ndcg: mean(ndcg), scores: [mean(scores.required), mean(scores.optional), mean(scores.rejected)] };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw Error("Usage: summarize-decision-benchmark.ts <raw-json-path>");
  const baselineText = await readFile(new URL("../docs/benchmarks/decision-model-baseline.json", import.meta.url), "utf8");
  const report = JSON.parse(await readFile(path, "utf8")) as Report;
  if (createHash("sha256").update(baselineText).digest("hex") !== report.baselineSha256) throw Error("Report baseline does not match the frozen labels");
  const inputs = (JSON.parse(baselineText) as { cases: Case[] }).cases;
  const cases = new Map(inputs.map((c) => [c.id, c]));
  const { names } = report.inventory;
  const { threshold, cap } = report.settings;
  const trials = report.trials.filter((r) => r.outcome === "ok");
  if (trials.some((r) => !cases.has(r.caseId) || r.scores?.length !== names.length || r.scores.some((s) => !Number.isFinite(s) || s < 0 || s > 2))) throw Error("Invalid saved scores");
  const measured = report.probes.filter((r) => r.ok).map(({ model }) => ({ model, rows: trials.filter((r) => r.model === model) }));
  const complete = measured.filter(({ rows }) => rows.length === inputs.length && new Set(rows.map(({ caseId }) => caseId)).size === inputs.length);
  const qualityRows = complete.map(({ model, rows }) => ({ model, rows, m: summarize(rows, cases, names, threshold, cap) }));
  console.log(JSON.stringify({ probes: report.probes.length, probePasses: measured.length, complete: complete.length, casesPassed: trials.length, casesAttempted: report.trials.length,
    posts: report.posts, reportedCost: report.reportedCost, elapsedSeconds: (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000 }));
  console.log("\n| Model | Median ms | P95 ms | Required found | Strict precision | Strict F1 | Optional | Off-topic | Control picks | nDCG@12 | Reported trial cost |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { model, rows, m } of qualityRows.sort((a, b) => b.m.strictF1 - a.m.strictF1 || b.m.ndcg - a.m.ndcg || a.model.localeCompare(b.model))) {
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    const median = mean([ms[Math.floor((ms.length - 1) / 2)], ms[Math.floor(ms.length / 2)]]);
    const values = rows.flatMap((r) => r.usage?.cost === undefined ? [] : [r.usage.cost]);
    const cost = values.length ? `$${fmt(values.reduce((a, b) => a + b, 0), 6)}${values.length < rows.length ? "*" : ""}` : "—";
    console.log(`| \`${model}\` | ${Math.round(median)} | ${Math.round(ms[Math.ceil(ms.length * 0.95) - 1])} | ${m.hit}/${m.needed} | ${pct(m.strictPrecision)} | ${fmt(m.strictF1)} | ${m.optional} | ${m.off} | ${m.unrelated} | ${fmt(m.ndcg)} | ${cost} |`);
  }
  console.log("\n| Model | Mean required score | Mean optional score | Mean rejected score |\n| --- | ---: | ---: | ---: |");
  for (const { model, m } of qualityRows) console.log(`| \`${model}\` | ${m.scores.map((s) => fmt(s, 2)).join(" | ")} |`);
  console.log("\nProbe failures:");
  for (const r of report.probes.filter((p) => !p.ok)) console.log(r.model, r.status ?? "no HTTP status", r.policy ?? r.code);
  console.log("\nIncomplete workload results:");
  for (const { model, rows } of measured.filter((entry) => !complete.includes(entry))) {
    const failures = report.trials.filter((r) => r.model === model && r.outcome !== "ok").map((r) => `${r.caseId}=${r.status.join("/") || r.errorCode}`);
    console.log(model, `${rows.length}/${inputs.length}`, failures.join(", "));
  }

  const grid = [0.25, threshold, 0.425, 0.5, 0.55, 0.625, 0.7, 0.75];
  const all = complete.flatMap(({ rows }) => rows);
  const forSplit = (rows: readonly Trial[], split: string) => rows.filter((r) => cases.get(r.caseId)?.split === split);
  const dev = forSplit(all, "development");
  const eligible = grid.filter((t) => t >= threshold && complete.every(({ rows }) => {
    const perModel = forSplit(rows, "development");
    return summarize(perModel, cases, names, t, cap).hit >= summarize(perModel, cases, names, threshold, cap).hit;
  }));
  const compare = (a: number, b: number) => {
    const x = summarize(dev, cases, names, a, cap), y = summarize(dev, cases, names, b, cap);
    return x.off + x.unrelated - y.off - y.unrelated || b - a;
  };
  const candidate = eligible.sort(compare)[0] ?? threshold;
  console.log(`\nDevelopment candidate: ${candidate}`);
  console.log("\n| Threshold | Dev required | Dev off-topic + controls | Holdout required | Holdout off-topic + controls | Holdout optional |\n| ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const t of grid) {
    const d = summarize(dev, cases, names, t, cap), h = summarize(forSplit(all, "holdout"), cases, names, t, cap);
    console.log(`| ${t} | ${d.hit}/${d.needed} | ${d.off + d.unrelated} | ${h.hit}/${h.needed} | ${h.off + h.unrelated} | ${h.optional} |`);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Could not summarize benchmark."); process.exitCode = 1; });
