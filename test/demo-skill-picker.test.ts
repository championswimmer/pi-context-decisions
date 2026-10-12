import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createDemoMockClient, defaultDemoOptions, DEMO_ROOT, DemoError, loadDemoSkills, parseDemoArgs, parseSkillMetadata, runDemo } from "../scripts/demo-skill-picker.ts";
import type { DecisionRequest } from "../src/decision/types.ts";

const CANDIDATES = Array.from({ length: 30 }, (_, index) => ({ name: `skill-${index}`, description: `Illustrative metadata ${index}` }));
const DEMO_SCRIPT_URL = new URL("../scripts/demo-skill-picker.ts", import.meta.url).href;

test("demo contains exactly thirty unique portable skill directories and metadata fields", async () => {
  const skills = await loadDemoSkills();
  assert.equal(skills.length, 30); assert.equal(new Set(skills.map((skill) => skill.name)).size, 30);
  assert.ok(skills.some((skill) => skill.name === "react-components"));
  assert.ok(skills.some((skill) => skill.name === "postgres-queries"));
  for (const skill of skills) {
    assert.deepEqual(Object.keys(skill).sort(), ["description", "name"]);
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(skill.name.length <= 64 && skill.description.length <= 400);
    const document = await readFile(join(DEMO_ROOT, ".agents/skills", skill.name, "SKILL.md"), "utf8");
    assert.deepEqual(parseSkillMetadata(document), skill); assert.match(document, /illustrative demo guidance/u);
  }
  const files = await readdir(join(DEMO_ROOT, ".agents/skills")); assert.equal(files.length, 30);
});
test("Pi's actual skill loader discovers thirty skills without frontmatter diagnostics", async () => {
  const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
  const loaded = loadSkillsFromDir({ dir: join(DEMO_ROOT, ".agents/skills"), source: "demo" });
  assert.equal(loaded.skills.length, 30); assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name)), await loadDemoSkills());
});
test("frontmatter parser returns only name and description, never body or location", () => {
  const header = '---\nname: demo-skill\ndescription: "Metadata for testing a skill."\n---\n';
  assert.deepEqual(parseSkillMetadata(`${header}PRIVATE_BODY /private/SKILL.md`), { name: "demo-skill", description: "Metadata for testing a skill." });
  assert.deepEqual(parseSkillMetadata(`${header}${"x".repeat(10000)}`), parseSkillMetadata(header));
  for (const input of ["no frontmatter", "---\nname: one", "---\nname: Bad_Name\ndescription: yes\n---", "---\nname: one\nname: two\ndescription: yes\n---", "---\nname: one\ndescription: yes\nlocation: /private\n---", "---\nname: one\ndescription: \"broken\n---"]) assert.throws(() => parseSkillMetadata(input), DemoError);
});
test("default offline demo evaluates every candidate and picks useful web skills with zero fetch calls", async () => {
  const source = `globalThis.fetch = async () => { throw new Error('NETWORK_MUST_NOT_RUN'); }; const {runDemo} = await import(${JSON.stringify(DEMO_SCRIPT_URL)}); const result=await runDemo(); console.log(JSON.stringify({count:result.evaluatedCount,batches:result.batchSizes,names:result.selectedNames}));`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.count, 30); assert.deepEqual(result.batches, [10, 10, 10]);
  for (const name of ["react-components", "web-accessibility", "form-validation", "browser-testing"]) assert.ok(result.names.includes(name));
  assert.ok(!result.names.includes("terraform-infra"));
});
test("batch size and threshold/max-selected are configurable without losing any of thirty evaluations", async () => {
  for (const size of [1, 7, 10, 24]) {
    const result = await runDemo({ batchSize: size });
    assert.equal(result.evaluatedCount, 30);
    assert.equal(result.batchSizes.reduce((sum, count) => sum + count, 0), 30);
    assert.equal(result.calls, Math.ceil(30 / size));
    assert.ok(result.batchSizes.every((count) => count <= size));
  }
  const all = await runDemo({ threshold: 0, maxSkills: 30 }); assert.equal(all.selectedNames.length, 30);
  const strict = await runDemo({ threshold: 1, maxSkills: 30 });
  assert.ok(strict.selectedNames.length < all.selectedNames.length);
  const capped = await runDemo({ threshold: 0, maxSkills: 2 }); assert.equal(capped.selectedNames.length, 2);
  const none = await runDemo({ maxSkills: 0 }); assert.equal(none.selectedNames.length, 0);
});
test("all request payloads contain only bounded task and name/description metadata, including final batch", async () => {
  const requests: DecisionRequest[] = [];
  const base = createDemoMockClient();
  const decorated = CANDIDATES.map((skill) => ({ ...skill, body: "PRIVATE_SKILL_BODY", filePath: "/private/SKILL.md", location: "/private/directory" }));
  const result = await runDemo({ prompt: "Illustrative metadata", batchSize: 7 }, {
    skills: decorated, createClient: async () => ({ async decide(request, options) { requests.push(request); return base.decide(request, options); } }),
  });
  assert.equal(result.evaluatedCount, 30); assert.deepEqual(result.batchSizes, [7, 7, 7, 7, 2]);
  const scoredNames: string[] = [];
  for (const request of requests) {
    assert.deepEqual(Object.keys(request.state).sort(), ["skills", "task"]);
    const metadata = request.state.skills as Record<string, { name: string; description: string }>;
    for (const skill of Object.values(metadata)) { assert.deepEqual(Object.keys(skill).sort(), ["description", "name"]); scoredNames.push(skill.name); }
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_SKILL_BODY|\/private|filePath|location/u);
  }
  assert.deepEqual(scoredNames.sort(), CANDIDATES.map((skill) => skill.name).sort());
  assert.ok(result.contextSkills.every((skill) => Object.keys(skill).length === 2));
});
test("live target requires both explicit flag and environment opt-in before credential or client access", async () => {
  for (const backend of ["pi", "typesafe", "openai", "openrouter"] as const) {
    let created = 0;
    const dependencies = { env: {}, createClient: async () => { created++; return createDemoMockClient(); } };
    await assert.rejects(runDemo({ backend }, dependencies), { code: "live-disabled" });
    await assert.rejects(runDemo({ backend, live: true }, dependencies), { code: "live-disabled" });
    await assert.rejects(runDemo({ backend }, { ...dependencies, env: { PI_CONTEXT_DECISIONS_LIVE: "1" } }), { code: "live-disabled" });
    assert.equal(created, 0);
    const successful = await runDemo({ backend, live: true }, { ...dependencies, env: { PI_CONTEXT_DECISIONS_LIVE: "1" } });
    assert.equal(successful.evaluatedCount, 30); assert.equal(created, 1);
  }
});
test("importing demo CLI has no output, credential lookup, or network side effect", () => {
  const source = `globalThis.fetch=async()=>{throw Error('NETWORK')}; await import(${JSON.stringify(DEMO_SCRIPT_URL)});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
});
test("CLI options are bounded, normalized and strict; malformed configuration never starts a client", async () => {
  assert.deepEqual(parseDemoArgs([]), defaultDemoOptions());
  const options = parseDemoArgs(["--backend", "pi", "--provider", "typesafe", "--model", "jev-latest", "--batch-size", "7", "--threshold", "0.75", "--max-skills", "4", "--prompt", "PostgreSQL queries", "--live"]);
  assert.equal(options.batchSize, 7); assert.equal(options.threshold, 0.75); assert.equal(options.maxSkills, 4); assert.equal(options.live, true);
  for (const args of [["--threshold", "1.1"], ["--threshold", "NaN"], ["--batch-size", "25"], ["--batch-size", "0"], ["--max-skills", "31"], ["--concurrency", "5"], ["--timeout-ms", "60001"], ["--backend", "unknown"], ["--prompt", ""], ["--batch-size"], ["--unknown", "foo"], ["--live", "--live"], ["--batch-size", "3", "--batch-size", "4"]]) assert.throws(() => parseDemoArgs(args), DemoError);
  await assert.rejects(runDemo({ threshold: -1 }), { code: "config" });
});
test("demo prompt fixtures refer only to actual demo skills and distinguish example/model expectations", async () => {
  const fixtures = JSON.parse(await readFile(join(DEMO_ROOT, "prompts.json"), "utf8")) as { note: string; examples: { prompt: string; illustrativeRelevantSkills: string[] }[] };
  assert.match(fixtures.note, /not guaranteed/iu);
  const known = new Set((await loadDemoSkills()).map((skill) => skill.name));
  assert.ok(fixtures.examples.length >= 5);
  for (const fixture of fixtures.examples) { assert.ok(fixture.prompt.trim()); assert.ok(fixture.illustrativeRelevantSkills.length >= 2); assert.ok(fixture.illustrativeRelevantSkills.every((name) => known.has(name))); }
});
