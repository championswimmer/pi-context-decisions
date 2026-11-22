/** Offline, dependency-free charts for the published decision benchmark. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { selectFromItems } from "./benchmark-relevance-methods.ts";

const docs = new URL("../docs/benchmarks/", import.meta.url);
const thresholds = [0.30, 0.40, 0.50] as const;
interface Case { id: string; required: string[]; optional: string[] }
interface Trial { model: string; caseId: string; outcome: string; ms: number; usage?: { cost?: number }; scores?: number[] }
interface Counts { missed: number; offTopic: number; controls: number; optional: number }
interface Row { model: string; counts: Counts[]; medianMs: number; cost?: number }
const modelColor = (index: number) => `hsl(${Math.round((index * 137.508 + 206) % 360)}, ${index % 2 ? 64 : 76}%, ${index % 2 ? 36 : 43}%)`;
const quality = (c: Counts, required: number) => 100 * (required - c.missed - 0.25 * (c.offTopic + c.controls)) / required;
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function chart(rows: Row[], key: "offTopic" | "missed", title: string, subtitle: string, maximum: number, tick: number): string {
  const width = 1010, height = 620, left = 70, right = 617, top = 104, bottom = 502;
  const lanes = key === "missed";
  const x = (index: number) => left + 22 + index * (right - left - 44) / (thresholds.length - 1);
  const y = (value: number) => bottom - (lanes ? 85 : 4) - (bottom - top - (lanes ? 170 : 12)) * value / maximum;
  const text = (x: number, y: number, value: string, cls = "", extra = "") =>
    `<text x="${x}" y="${y}" class="${cls}" ${extra}>${xml(value)}</text>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${xml(title)}</title>`,
    `<desc id="desc">${xml(subtitle)} Each model has a colored line and three measured points at thresholds 0.30, 0.40, and 0.50. ${lanes ? "Vertical offsets spread tied lines within their integer count bands." : "Lines may overlap where models tie."} Exact values are in the companion table.</desc>`,
    `<style>text{font:14px system-ui,sans-serif;fill:#1e293b}.title{font-size:25px;font-weight:700}.head{font-size:16px;font-weight:700}.muted{font-size:13px;fill:#475569}.label{font:12px ui-monospace,Menlo,monospace}</style>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    text(24, 36, title, "title"), text(24, 61, subtitle, "muted"),
    text(left, 90, lanes ? "Required picks missed (of 22)" : "Off-topic picks", "head"), text(652, 90, "Model", "head"),
    `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="5" fill="#f5f8fc" stroke="#d5dce5"/>`,
  ];
  for (let value = 0; value <= maximum; value += tick) {
    if (lanes) parts.push(`<rect x="${left + 1}" y="${y(value) - 48}" width="${right - left - 2}" height="96" fill="#e8eef7"/>`);
    parts.push(`<path d="M ${left} ${y(value)} H ${right}" stroke="#c9d3e1" stroke-dasharray="${lanes ? "4 4" : "none"}"/>`, text(left - 12, y(value) + 5, String(value), "muted", 'text-anchor="end"'));
  }
  for (const [i, threshold] of thresholds.entries()) {
    parts.push(`<path d="M ${x(i)} ${top} V ${bottom}" stroke="#d5dce5"/>`, text(x(i), bottom + 27, threshold.toFixed(2), "head", 'text-anchor="middle"'));
  }
  parts.push(text((left + right) / 2, bottom + 52, "Normalized threshold", "muted", 'text-anchor="middle"'));

  for (const [r, row] of rows.entries()) {
    const color = modelColor(r);
    // A fixed offset per model keeps flat series flat and shows coincident paths within each integer band.
    const offset = lanes ? 4 * (r - (rows.length - 1) / 2) : 0;
    const values = row.counts.map((counts) => counts[key]);
    const points = values.map((value, i) => [x(i), y(value) + offset]);
    const legendY = 114 + r * 19;
    parts.push(
      `<g data-model="${xml(row.model)}" stroke="${color}" fill="${color}"><title>${xml(row.model)}: ${values.join(" → ")}</title>`,
      `<polyline points="${points.map((point) => point.join(",")).join(" ")}" fill="none" stroke-width="${lanes ? 2 : 2.3}" stroke-opacity="0.83" stroke-linejoin="round"/>`,
      ...points.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${lanes ? 2.1 : 3}" stroke="none"/>`),
      `<path d="M 652 ${legendY} h 20" stroke-width="3"/><circle cx="662" cy="${legendY}" r="2.8" stroke="none"/>`,
      "</g>", text(680, legendY + 4, row.model, "label"),
    );
  }
  parts.push(
    text(24, 583, lanes ? "Lines are spaced within each count band so tied models remain visible; only the band indicates the count." : "Overlapping paths indicate ties; the companion table gives exact counts.", "muted"),
    text(24, 604, "23 complete models · 10 public demo tasks · same saved scores at each threshold", "muted"),
    "</svg>",
  );
  return `${parts.join("\n")}\n`;
}

function qualityChart(rows: Row[], axis: "latency" | "cost", required: number): string {
  const width = 1010, height = 652, left = 82, right = 617, top = 124, bottom = 522;
  const costAxis = axis === "cost";
  const title = `Picking quality vs. ${costAxis ? "reported cost" : "latency"}`;
  const subtitle = "Higher is better. Each model has three threshold settings at the same measured latency or cost.";
  const minScore = Math.floor(Math.min(...rows.flatMap((row) => row.counts.map((c) => quality(c, required)))) / 10) * 10;
  const y = (score: number) => bottom - 10 - (bottom - top - 24) * (score - minScore) / Math.max(10, 100 - minScore);
  const costLeft = left + 112;
  const minCost = 0.0003, maxCost = 0.01;
  const xMax = Math.max(800, Math.ceil(Math.max(...rows.map((row) => row.medianMs)) / 100) * 100);
  const timeX = (ms: number) => left + (right - left - 10) * (ms - 100) / (xMax - 100);
  const paidX = (cost: number) => costLeft + (right - costLeft - 10) * Math.log(cost / minCost) / Math.log(maxCost / minCost);
  const centered = 'text-anchor="middle"';
  const text = (x: number, y: number, value: string, cls = "", extra = "") =>
    `<text x="${x}" y="${y}" class="${cls}" ${extra}>${xml(value)}</text>`;
  const marker = (x: number, y: number, index: number) => index === 0
    ? `<circle cx="${x}" cy="${y}" r="6.4" fill="none" stroke-width="1.7"/>`
    : index === 1
      ? `<path d="M ${x} ${y - 5.2} L ${x + 5.2} ${y} L ${x} ${y + 5.2} L ${x - 5.2} ${y} Z" fill="none" stroke-width="1.6"/>`
      : `<rect x="${x - 2.6}" y="${y - 2.6}" width="5.2" height="5.2" stroke="none"/>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${title}</title>`,
    `<desc id="desc">${subtitle} Circle is 0.30, diamond is 0.40, and filled square is 0.50. ${costAxis ? "Positive costs use a log scale; reported zeros have a separate lane." : "Latency is median elapsed time per task."} The benchmark page contains the exact values.</desc>`,
    `<style>text{font:14px system-ui,sans-serif;fill:#1e293b}.title{font-size:25px;font-weight:700}.head{font-size:16px;font-weight:700}.muted{font-size:13px;fill:#475569}.label{font:12px ui-monospace,Menlo,monospace}</style>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    text(24, 36, title, "title"), text(24, 61, subtitle, "muted"), text(left, 107, "Picking quality (100 = ideal)", "head"), text(652, 107, "Model", "head"),
    `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="5" fill="#f5f8fc" stroke="#d5dce5"/>`,
  ];
  if (costAxis) parts.push(`<rect x="${left + 1}" y="${top + 1}" width="85" height="${bottom - top - 2}" fill="#e8eef7"/>`);
  for (let score = minScore; score <= 100; score += 10) {
    parts.push(`<path d="M ${left} ${y(score)} H ${right}" stroke="#c9d3e1"/>`, text(left - 12, y(score) + 5, String(score), "muted", 'text-anchor="end"'));
  }
  const ticks = costAxis
    ? [[minCost, "$0.0003"], [0.001, "$0.001"], [0.003, "$0.003"], [maxCost, "$0.01"]] as const
    : Array.from({ length: 1 + (xMax - 100) / 100 }, (_, i) => [(i + 1) * 100, String((i + 1) * 100)] as const);
  for (const [value, label] of ticks) {
    const x = costAxis ? paidX(value) : timeX(value);
    parts.push(`<path d="M ${x} ${top} V ${bottom}" stroke="#d5dce5"/>`, text(x, bottom + 23, label, "muted", centered));
  }
  if (costAxis) parts.push(text(left + 43, bottom + 23, "$0 reported", "muted", centered));
  parts.push(text((left + right) / 2, bottom + 46, costAxis ? "Reported USD per 10 tasks (log scale for positive costs)" : "Median end-to-end milliseconds per task", "muted", centered));

  const zeros = rows.filter((row) => row.cost === 0);
  for (const [r, row] of rows.entries()) {
    const color = modelColor(r), legendY = 131 + r * 19;
    const scores = row.counts.map((count) => quality(count, required));
    if (!costAxis || row.cost !== undefined) {
      // Spread reported-zero models within a dedicated lane, not on the numeric cost scale.
      const x = !costAxis ? timeX(row.medianMs) : row.cost === 0
        ? left + 10 + 66 * Math.max(0, zeros.indexOf(row)) / Math.max(1, zeros.length - 1)
        : paidX(row.cost!);
      parts.push(
        `<g data-model="${xml(row.model)}" fill="${color}" stroke="${color}"><title>${xml(row.model)} · ${costAxis ? `$${row.cost!.toFixed(6)}` : `${row.medianMs.toFixed(1)} ms`} · quality ${scores.map((s) => s.toFixed(1)).join(" / ")}</title>`,
        `<path d="M ${x} ${y(Math.min(...scores))} V ${y(Math.max(...scores))}" fill="none" stroke-width="2" stroke-opacity="0.6"/>`,
        ...scores.map((score, i) => marker(x, y(score), i)), "</g>",
      );
    }
    parts.push(`<rect x="652" y="${legendY - 5}" width="18" height="10" rx="2" fill="${color}"/>`, text(680, legendY + 4, row.model, "label"));
  }
  for (const [i, threshold] of thresholds.entries()) {
    const x = left + i * 112;
    parts.push(`<g fill="#334155" stroke="#334155">${marker(x + 7, 598, i)}</g>`, text(x + 20, 603, threshold.toFixed(2), "muted"));
  }
  parts.push(text(24, 631, costAxis ? "Zero-cost markers are spaced within their own lane; spacing does not imply a cost difference." : "Overlapping markers can share a score or latency; see the exact-value table.", "muted"), "</svg>");
  return `${parts.join("\n")}\n`;
}

async function main() {
  const baselineText = await readFile(new URL("decision-model-baseline.json", docs), "utf8");
  const { cases } = JSON.parse(baselineText) as { cases: Case[] };
  const report = JSON.parse(await readFile(new URL("decision-model-results-2026-11-22.json", docs), "utf8")) as {
    baselineSha256: string; inventory: { names: string[] }; settings: { cap: number }; trials: Trial[];
  };
  if (createHash("sha256").update(baselineText).digest("hex") !== report.baselineSha256) throw Error("Baseline mismatch");
  const rows: Row[] = [];
  const names = report.inventory.names;
  for (const model of [...new Set(report.trials.map((trial) => trial.model))].sort()) {
    const trials = report.trials.filter((trial) => trial.model === model && trial.outcome === "ok");
    const byCase = new Map(trials.map((trial) => [trial.caseId, trial]));
    if (trials.length !== cases.length || !cases.every(({ id }) => byCase.has(id))) continue;
    const counts = thresholds.map((threshold) => {
      const count: Counts = { missed: 0, offTopic: 0, controls: 0, optional: 0 };
      for (const c of cases) {
        const scores = byCase.get(c.id)!.scores;
        if (scores?.length !== names.length || scores.some((score) => !Number.isFinite(score) || score < 0 || score > 2)) throw Error("Invalid saved scores");
        const selected = new Set(selectFromItems(names.map((name, i) => ({ name, score: scores[i]! })), { minScore: threshold * 2 }, report.settings.cap));
        count.missed += c.required.filter((name) => !selected.has(name)).length;
        for (const name of selected) {
          if (c.required.includes(name)) continue;
          if (c.optional.includes(name)) count.optional++;
          else if (c.required.length) count.offTopic++;
          else count.controls++;
        }
      }
      return count;
    });
    const times = trials.map((trial) => trial.ms).sort((a, b) => a - b);
    const medianMs = (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2;
    const cost = trials.every((trial) => trial.usage?.cost !== undefined)
      ? trials.reduce((sum, trial) => sum + trial.usage!.cost!, 0) : undefined;
    rows.push({ model, counts, medianMs, cost });
  }
  if (rows.length !== 23) throw Error("Expected 23 complete models in the published run");
  for (const [key, file, title, subtitle, tick] of [
    ["offTopic", "decision-threshold-off-topic.svg", "Off-topic picks by model", "Unwanted advertisements on the eight related tasks. Lower is better; optional picks are not counted.", 5],
    ["missed", "decision-threshold-missed.svg", "Required picks missed by model", "Missed picks out of 22 required per model. Zero means the model kept every required skill.", 1],
  ] as const) {
    const max = Math.max(...rows.flatMap((row) => row.counts.map((count) => count[key])));
    await writeFile(new URL(file, docs), chart(rows, key, title, subtitle, Math.max(tick, Math.ceil(max / tick) * tick), tick));
  }
  console.log("| Model | Off-topic @ 0.30 | @ 0.40 | @ 0.50 | Required missed @ 0.30 | @ 0.40 | @ 0.50 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) console.log(`| \`${row.model}\` | ${[...row.counts.map((c) => c.offTopic), ...row.counts.map((c) => c.missed)].join(" | ")} |`);
  const required = cases.reduce((sum, c) => sum + c.required.length, 0);
  for (const axis of ["latency", "cost"] as const) {
    await writeFile(new URL(`decision-quality-${axis}.svg`, docs), qualityChart(rows, axis, required));
  }
  console.log("\n| Model | Median ms / task | Reported cost / 10 tasks | Quality @ 0.30 | @ 0.40 | @ 0.50 |\n| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) console.log(`| \`${row.model}\` | ${Math.round(row.medianMs)} | ${row.cost === undefined ? "—" : `$${row.cost.toFixed(6)}`} | ${row.counts.map((c) => quality(c, required).toFixed(1)).join(" | ")} |`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Could not render benchmark plots."); process.exitCode = 1; });
