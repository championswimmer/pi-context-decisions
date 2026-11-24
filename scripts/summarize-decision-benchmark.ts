/** Offline: grades saved benchmark results against docs/benchmarks/decision-benchmark.json and prints Markdown. */
import { readFile } from "node:fs/promises";
import { SPEC, ROSTER, type Spec, type Trial } from "./benchmark-decision-models.ts";

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: summarize-decision-benchmark.ts <results-json>");
  const spec = JSON.parse(await readFile(SPEC, "utf8")) as Spec;
  const roster = (JSON.parse(await readFile(ROSTER, "utf8")) as { models: { rank: number; id: string; weeklyTokens: number }[] }).models;
  const report = JSON.parse(await readFile(path, "utf8")) as { trials: Trial[]; posts: number; reportedCost: number; startedAt: string; finishedAt: string };
  const out: string[] = [];
  out.push("| Rank | Model | Exact sets | Recall | Precision | Off-topic | Failed | Median ms | Cost | a / b / c |", "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  const rows = roster.map(({ rank, id }) => {
    const mine = report.trials.filter((t) => t.model === id);
    let exact = 0, hit = 0, need = 0, picked = 0, off = 0, failed = 0, cost = 0; const ms: number[] = []; const cells: string[] = [];
    for (const run of spec.runs) {
      const t = mine.find((x) => x.runId === run.id);
      if (!t || t.outcome !== "ok") { failed++; cells.push("ERR"); continue; }
      const want = new Set(run.shouldPick), ok = new Set([...run.shouldPick, ...run.acceptable]), got = [...new Set(t.selected)];
      const tp = got.filter((n) => want.has(n)).length, o = got.filter((n) => !ok.has(n)).length;
      hit += tp; need += want.size; picked += got.length; off += o; ms.push(t.ms); cost += t.usage?.cost ?? 0;
      const same = tp === want.size && got.length === want.size; if (same) exact++;
      cells.push(`${tp}/${want.size}${o ? `+${o}off` : ""}${same ? " ✓" : ""}`);
    }
    return { rank, id, exact, hit, need, picked, off, failed, ms, cost, cells };
  });
  rows.sort((a, b) => b.exact - a.exact || a.off - b.off || b.hit - a.hit || a.rank - b.rank);
  for (const r of rows) out.push(`| ${r.rank} | \`${r.id}\` | ${r.exact}/${spec.runs.length} | ${pct(r.hit, r.need)} | ${pct(r.hit, r.picked)} | ${r.off} | ${r.failed} | ${r.ms.length ? Math.round(median(r.ms)) : "–"} | $${r.cost.toFixed(6)} | ${r.cells.join(" / ")} |`);
  out.push("", `Cells: required found / required, \`+Noff\` = picks outside shouldPick+acceptable, ✓ = exact match. POSTs ${report.posts}, reported cost $${report.reportedCost.toFixed(6)}, ${report.startedAt} → ${report.finishedAt}.`);
  console.log(out.join("\n"));
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
