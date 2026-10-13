/** Metadata-only thirty-skill demo. Offline by default; imported modules never run the CLI. */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RelevanceClient, RelevanceItem, SkillCandidate } from "../src/apps/relevance.ts";
import { pickSkills } from "../src/apps/skill-filter.ts";
import { createDecisionClient } from "../src/decision/api.ts";
import { createBackend, type BackendSelection } from "../src/core/backends/factory.ts";
import { validateBackendSelection } from "../src/settings.ts";
import type { DecisionAnswer, DecisionRequest } from "../src/decision/types.ts";

export const DEMO_ROOT = fileURLToPath(new URL("../examples/skill-picker-demo/", import.meta.url));
export const DEFAULT_DEMO_PROMPT = "Build an accessible React signup form with validation and browser tests.";
export type DemoBackend = "mock" | "pi" | "typesafe" | "openai" | "openrouter";
export interface DemoOptions {
  backend: DemoBackend;
  prompt: string;
  batchSize: number;
  /** Normalized expectation, in [0,1]; not a probability. */
  threshold: number;
  maxSkills: number;
  concurrency: number;
  timeoutMs: number;
  live: boolean;
  model?: string;
  provider?: string;
  demoRoot?: string;
}
export interface DemoResult {
  backend: DemoBackend;
  inventoryCount: number;
  evaluatedCount: number;
  calls: number;
  batchSizes: number[];
  threshold: number;
  selectedNames: string[];
  /** Metadata-only advertisements. Full skill bodies are still loaded explicitly by Pi. */
  contextSkills: SkillCandidate[];
  rankings: RelevanceItem[];
}
export class DemoError extends Error {
  readonly code: "config" | "metadata" | "live-disabled";
  constructor(code: DemoError["code"], message: string) { super(message); this.name = "DemoError"; this.code = code; }
}
export function defaultDemoOptions(): DemoOptions {
  return { backend: "mock", prompt: DEFAULT_DEMO_PROMPT, batchSize: 10, threshold: 0.5, maxSkills: 6, concurrency: 2, timeoutMs: 15000, live: false };
}
function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { const result: unknown = JSON.parse(trimmed); if (typeof result === "string") return result; } catch { /* Safe metadata diagnostic only. */ }
    throw new DemoError("metadata", "Invalid quoted skill frontmatter");
  }
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new DemoError("metadata", "Empty skill frontmatter value");
  return trimmed;
}
/** Deliberately strict flat frontmatter subset used by this demo, not a general YAML parser. */
export function parseSkillMetadata(text: string): SkillCandidate {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0] !== "---") throw new DemoError("metadata", "Skill frontmatter must start with a delimiter");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new DemoError("metadata", "Skill frontmatter delimiter is missing");
  const values: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const match = /^(name|description):\s*(.+)$/u.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw new DemoError("metadata", "Unexpected or duplicate skill frontmatter field");
    values[match[1]] = scalar(match[2]);
  }
  if (!values.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(values.name) || values.name.length > 64
    || !values.description?.trim() || values.description.length > 400) throw new DemoError("metadata", "Invalid skill name or description");
  return { name: values.name, description: values.description };
}
async function readFrontmatter(path: string): Promise<string> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 128 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let size = 0;
  try {
    for await (const line of reader) {
      size += line.length + 1;
      if (size > 4096) throw new DemoError("metadata", "Skill frontmatter exceeds the demo limit");
      lines.push(line);
      if (lines.length > 1 && line === "---") break;
    }
    return lines.join("\n");
  } finally { reader.close(); stream.destroy(); }
}
export async function loadDemoSkills(demoRoot = DEMO_ROOT): Promise<SkillCandidate[]> {
  const root = join(demoRoot, ".agents", "skills");
  const directories = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const skills: SkillCandidate[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const metadata = parseSkillMetadata(await readFrontmatter(join(root, directory.name, "SKILL.md")));
    if (metadata.name !== directory.name || skills.some((skill) => skill.name === metadata.name)) throw new DemoError("metadata", "Skill names must uniquely match their directories");
    skills.push(metadata);
  }
  if (skills.length !== 30) throw new DemoError("metadata", "This demo requires exactly thirty skills");
  return skills;
}
const STOPWORDS = new Set("a an and are as at be build by create describe for from help how in into is it make of on or our the this to use using with write implement add update improve include should would can need new".split(" "));
function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter((token) => token.length > 2 && !STOPWORDS.has(token)).map((token) => token.replace(/(?:ing|s)$/u, "")));
}
/** A transparent lexical teaching fixture, NOT a model or a quality benchmark. */
export function createDemoMockClient(): RelevanceClient {
  return { async decide(request: DecisionRequest) {
    const query = tokens(typeof request.state.task === "string" ? request.state.task : "");
    const metadata = request.state.skills as Record<string, { name: string; description: string }>;
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type !== "score") throw new DemoError("config", "Demo mock accepts score questions only");
      const skill = metadata[id];
      const words = tokens(`${skill.name} ${skill.description}`);
      const matches = [...query].filter((token) => words.has(token)).length;
      answers[id] = { type: "score", score: matches >= 2 ? 2 : matches === 1 ? 1.2 : 0 };
    }
    return { answers, backend: "pi", provider: "offline-demo", model: "lexical-fixture" };
  } };
}
function validatedOptions(options: DemoOptions): DemoOptions {
  if (!["mock", "pi", "typesafe", "openai", "openrouter"].includes(options.backend)) throw new DemoError("config", "Unknown demo backend");
  if (typeof options.prompt !== "string" || !options.prompt.trim() || options.prompt.length > 4000) throw new DemoError("config", "A bounded nonempty demo prompt is required");
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) throw new DemoError("config", "Threshold must be a normalized score in [0,1]");
  for (const [value, min, max] of [[options.batchSize, 1, 24], [options.maxSkills, 0, 30], [options.concurrency, 1, 4], [options.timeoutMs, 1, 60000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new DemoError("config", "Invalid demo scoring limit");
  }
  return options;
}
export function parseDemoArgs(args: readonly string[]): DemoOptions {
  const options = defaultDemoOptions();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new DemoError("config", "Duplicate demo option");
    seen.add(flag);
    if (flag === "--live") { options.live = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new DemoError("config", "Missing demo option value");
    switch (flag) {
      case "--backend": options.backend = value as DemoBackend; break;
      case "--prompt": options.prompt = value; break;
      case "--batch-size": options.batchSize = Number(value); break;
      case "--threshold": options.threshold = Number(value); break;
      case "--max-skills": options.maxSkills = Number(value); break;
      case "--concurrency": options.concurrency = Number(value); break;
      case "--timeout-ms": options.timeoutMs = Number(value); break;
      case "--model": options.model = value; break;
      case "--provider": options.provider = value; break;
      case "--demo-root": options.demoRoot = resolve(value); break;
      default: throw new DemoError("config", "Unknown demo option");
    }
  }
  return validatedOptions(options);
}
function selectionFor(options: DemoOptions): BackendSelection {
  const checked = (selection: BackendSelection): BackendSelection => {
    const validated = validateBackendSelection(selection);
    if (!validated) throw new DemoError("config", "Demo requires a backend selection");
    return validated;
  };
  switch (options.backend) {
    case "typesafe": return checked({ backend: "typesafe", model: options.model ?? "jev-latest" });
    case "openai": return checked({ backend: "openai", model: options.model ?? "gpt-6-luna" });
    case "openrouter": return checked({ backend: "openrouter", model: options.model ?? "typesafe/jev-1.13" });
    case "pi": return checked({ backend: "pi", provider: options.provider ?? "typesafe", id: options.model ?? "jev-latest" });
    default: throw new DemoError("config", "Mock does not need a provider selection");
  }
}
async function liveClient(options: DemoOptions): Promise<RelevanceClient> {
  const selection = selectionFor(options);
  if (selection.backend === "pi") {
    const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    const registry = new ModelRegistry(runtime);
    return createDecisionClient(createBackend(selection, { registry, getRegistry: () => registry }));
  }
  let registry;
  try { const { createPiCredentialRegistry } = await import("../src/host/pi-credentials.ts"); registry = await createPiCredentialRegistry(); }
  catch { /* Direct backends preserve explicit env fallback if Pi initialization fails. */ }
  return createDecisionClient(createBackend(selection, { registry }));
}
export interface DemoDependencies {
  env?: Record<string, string | undefined>;
  skills?: readonly SkillCandidate[];
  /** Test/host injection. The explicit live gate still applies to non-mock backends. */
  createClient?: (options: DemoOptions) => Promise<RelevanceClient>;
}
export async function runDemo(input: Partial<DemoOptions> = {}, dependencies: DemoDependencies = {}): Promise<DemoResult> {
  const options = validatedOptions({ ...defaultDemoOptions(), ...input });
  if (options.backend !== "mock" && (!options.live || (dependencies.env ?? process.env).PI_CONTEXT_DECISIONS_LIVE !== "1")) {
    throw new DemoError("live-disabled", "Live scoring requires --live and PI_CONTEXT_DECISIONS_LIVE=1");
  }
  const skills = dependencies.skills ? dependencies.skills.map(({ name, description }) => ({ name, description })) : await loadDemoSkills(options.demoRoot);
  if (skills.length !== 30 || new Set(skills.map((skill) => skill.name)).size !== 30) throw new DemoError("metadata", "This demo requires thirty unique skills");
  const client = dependencies.createClient ? await dependencies.createClient(options)
    : options.backend === "mock" ? createDemoMockClient() : await liveClient(options);
  const batchSizes: number[] = [];
  const observed: RelevanceClient = { async decide(request, opts) { batchSizes.push(Object.keys(request.questions).length); return client.decide(request, opts); } };
  const selection = await pickSkills(options.prompt, skills, observed, {
    chunkSize: options.batchSize, maxQuestions: 24, concurrency: options.concurrency, timeoutMs: options.timeoutMs,
    threshold: options.threshold, maxSkills: options.maxSkills, failMode: "closed",
  });
  if (selection.reason !== "filtered") throw Object.assign(new Error("Demo selection failed closed"), { code: selection.errorCode ?? "config" });
  const rankings = selection.items ?? [];
  return { backend: options.backend, inventoryCount: skills.length, evaluatedCount: rankings.length,
    calls: batchSizes.length, batchSizes, threshold: options.threshold, selectedNames: selection.kept.map((skill) => skill.name), contextSkills: selection.kept, rankings };
}
export async function demoMain(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runDemo(parseDemoArgs(args));
    console.log(JSON.stringify({ backend: result.backend, inventoryCount: result.inventoryCount, evaluatedCount: result.evaluatedCount,
      calls: result.calls, batchSizes: result.batchSizes, threshold: result.threshold, selectedNames: result.selectedNames }, null, 2));
    return 0;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "demo-failed";
    console.error(JSON.stringify({ outcome: "error", code: ["config", "metadata", "live-disabled", "auth", "timeout", "aborted", "http", "network", "invalid_request", "invalid_response", "rate_limit", "refusal"].includes(code) ? code : "demo-failed" }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await demoMain();
