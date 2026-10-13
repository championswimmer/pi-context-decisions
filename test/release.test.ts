import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const workflow = read(".github/workflows/release.yml");
const workflowCode = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

test("package metadata is publish-ready and public", () => {
  assert.equal(pkg.name, "pi-context-decisions");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.repository.url, "git+https://github.com/championswimmer/pi-context-decisions.git");
  assert.ok(pkg.homepage && pkg.bugs.url && pkg.author && pkg.description);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.equal(pkg.engines.node, ">=22.18.0");
  assert.equal(pkg.private, undefined);
  assert.ok(existsSync(new URL("../LICENSE", import.meta.url)));
});

test("Pi host packages are peers with * ranges, never runtime dependencies", () => {
  assert.equal(pkg.dependencies, undefined);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
    assert.equal(pkg.peerDependencies[name], "*");
  }
});

test("published file list ships sources and excludes tests, demos and scripts", () => {
  assert.deepEqual(pkg.files, ["src/", "README.md", "CHANGELOG.md", "LICENSE", ".agents/plans/mcp-visibility.md"]);
  const out = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", cwd: new URL("..", import.meta.url) }));
  const paths: string[] = out[0].files.map((file: { path: string }) => file.path);
  for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "src/extension.ts", "src/index.ts", "src/host/pi-credentials.ts"]) assert.ok(paths.includes(required), required);
  for (const path of paths) assert.ok(!/^(test|scripts|examples|node_modules|\.github)\//.test(path) && !/\.(env|tgz)/.test(path) && path !== "AGENTS.md", path);
  for (const target of [pkg.pi.extensions[0], ...Object.values(pkg.exports) as string[]]) assert.ok(paths.includes(target.replace(/^\.\//, "")), target);
});

test("release workflow is tag-triggered OIDC trusted publishing without long-lived tokens", () => {
  assert.match(workflow, /tags:\s*\n\s*- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflowCode, /pull_request|branches:|NPM_TOKEN|NODE_AUTH_TOKEN|--provenance|contents: write/);
  assert.match(workflowCode, /package-manager-cache: false/);
  assert.doesNotMatch(workflowCode, /cache: npm/);
  assert.match(workflow, /npm@\^11\.5\.1/);
  assert.match(workflow, /GITHUB_REF_NAME#v/);
  assert.match(workflow, /npm ci --ignore-scripts/);
});

test("release skill exists and requires explicit authorization", () => {
  const skill = read(".agents/skills/release/SKILL.md");
  assert.match(skill, /^---\nname: release\n/);
  assert.match(skill, /explicit user authorization/);
  assert.doesNotMatch(skill, /npm publish --provenance/);
});

function stepScript(name: string): string {
  const lines = workflowCode.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `missing step ${name}`);
  const run = lines.findIndex((line, i) => i > start && line.trim() === "run: |");
  assert.ok(run > start);
  const indent = lines[run + 1].match(/^ */)![0].length;
  const body: string[] = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === "" || lines[i].match(/^ */)![0].length >= indent); i++) body.push(lines[i].slice(indent));
  return body.join("\n");
}

function runStep(name: string, version: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-step-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }));
    writeFileSync(join(dir, "npm"), '#!/bin/sh\necho "npm $@" >> "$NPM_LOG"\n');
    chmodSync(join(dir, "npm"), 0o755);
    const log = join(dir, "npm.log");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", stepScript(name)], {
      cwd: dir, encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, NPM_LOG: log, ...env },
    });
    return { status: result.status, output: result.stdout + result.stderr, npmCalls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("stable versions publish to latest and prereleases to next, for any version", () => {
  for (const [version, tag] of [["0.1.1", "latest"], ["2.14.9", "latest"], ["1.0.0-rc.1", "next"], ["0.2.0-beta.0", "next"], ["3.0.0-alpha", "next"]]) {
    const result = runStep("Publish to npm with trusted publishing", version);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.npmCalls, [`npm publish --access public --tag ${tag}`], version);
  }
});

test("tag verification follows package.json and rejects mismatches; no version is hard-coded", () => {
  for (const version of ["0.1.0", "0.1.1", "9.9.9", "1.0.0-rc.1"]) {
    assert.equal(runStep("Verify tag matches package.json version", version, { GITHUB_REF_NAME: `v${version}` }).status, 0, version);
    assert.notEqual(runStep("Verify tag matches package.json version", version, { GITHUB_REF_NAME: "v8.8.8" }).status, 0, version);
  }
  assert.doesNotMatch(workflowCode, /\b0\.1\.0\b/);
});

test("tag filters route only semver release tags", () => {
  const patterns = [...workflowCode.matchAll(/^\s+- "(v[^"]+)"$/gm)].map((m) => m[1]);
  assert.equal(patterns.length, 2);
  const matches = (tag: string) => patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*").replace(/\+/g, "+")}$`).test(tag));
  for (const tag of ["v0.1.1", "v10.20.30", "v1.0.0-rc.1", "v2.0.0-beta.2"]) assert.ok(matches(tag), tag);
  for (const tag of ["0.1.1", "v1.0", "v1.0.0.1", "vNext", "release/v1.0.0", "v1.0.0+build"]) assert.ok(!matches(tag), tag);
});

test("README and release skill document dist-tags, Allow npm publish and the two-day deadline", () => {
  for (const doc of [read("README.md"), read(".agents/skills/release/SKILL.md")]) {
    assert.match(doc, /Allow npm publish|"npm publish"/);
    assert.match(doc, /2 days|two days/i);
    assert.match(doc, /\bnext\b/);
    assert.match(doc, /2026-09-03|Sep(tember)? 3, 2026/);
  }
});
