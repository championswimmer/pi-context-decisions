import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiCredentialRegistry } from "../src/host/pi-credentials.ts";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey } from "../src/core/auth.ts";

for (const [provider, resolve] of [["openai", resolveOpenAIKey], ["openrouter", resolveOpenRouterKey], ["typesafe", resolveTypeSafeKey]] as const) {
  test(`${provider}: standalone SDK adapter delegates resolved keys for exact provider`, async () => {
    const queries: string[] = [];
    const registry = await createPiCredentialRegistry({runtime: {
      async listCredentials() { return [{providerId: "openai-codex", type: "oauth"}, {providerId: "openai", type: "api_key"}]; },
      async getAuth(id) { queries.push(id); return {auth: {apiKey: "resolved-config-reference-fixture"}, source: "stored credential"}; },
    }});
    assert.deepEqual(await resolve({registry, env: {}}), {key: "resolved-config-reference-fixture", source: "pi"});
    assert.deepEqual(queries, [provider]);
  });
}
test("Luna routes read distinct stored keys through Pi's public SDK before env fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-luna-auth-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  const options = {authPath: join(root, "auth.json"), modelsPath: null};
  const runtime = await ModelRuntime.create({...options, refreshOnCreate: false, allowModelNetwork: false});
  await runtime.login("openai", "api_key", {async prompt() { return "stored-openai-fixture"; }, notify() {}});
  await runtime.login("openrouter", "api_key", {async prompt() { return "stored-router-fixture"; }, notify() {}});
  const native = new ModelRegistry(await ModelRuntime.create({...options, refreshOnCreate: false, allowModelNetwork: false}));
  const standalone = await createPiCredentialRegistry(options);
  for (const registry of [native, standalone]) {
    const env = {OPENAI_API_KEY: "env-openai-fixture", OPENROUTER_API_KEY: "env-router-fixture"};
    assert.deepEqual(await resolveOpenAIKey({registry, env}), {key: "stored-openai-fixture", source: "pi"});
    assert.deepEqual(await resolveOpenRouterKey({registry, env}), {key: "stored-router-fixture", source: "pi"});
  }
  assert.equal(fetch.mock.callCount(), 0);
});
test("standalone adapter never refreshes stored OpenAI OAuth; router OAuth still resolves", async () => {
  const queries: string[] = [];
  const registry = await createPiCredentialRegistry({runtime: {
    async listCredentials() { return [{providerId: "openai", type: "oauth"}, {providerId: "openrouter", type: "oauth"}]; },
    async getAuth(id) { queries.push(id); return {auth: {apiKey: "router-fixture"}, source: "OAuth"}; },
  }});
  assert.deepEqual(await resolveOpenAIKey({registry, env: {OPENAI_API_KEY: "env-fixture"}}), {key: "env-fixture", source: "env"});
  await assert.rejects(resolveOpenAIKey({registry, env: {}}), {code: "auth"});
  assert.deepEqual(await resolveOpenRouterKey({registry, env: {}}), {key: "router-fixture", source: "pi"});
  assert.deepEqual(queries, ["openrouter"]);
});
test("credential metadata failure is redacted and selects env; cancellation remains aborted", async () => {
  const registry = await createPiCredentialRegistry({runtime: {
    async listCredentials() { throw new Error("PRIVATE-METADATA-ERROR"); },
    async getAuth() { throw new Error("must not run"); },
  }});
  assert.deepEqual(await resolveOpenAIKey({registry, env: {OPENAI_API_KEY: "env-fixture"}}), {key: "env-fixture", source: "env"});
  await assert.rejects(resolveOpenAIKey({registry, env: {}}), (error: unknown) => { assert.doesNotMatch(String(error), /PRIVATE|must not/); return true; });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(resolveOpenAIKey({registry, env: {OPENAI_API_KEY: "env-fixture"}, signal: abort.signal}), {code: "aborted"});
});
test("live smoke requires opt-in before initializing Pi or requesting credentials", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/live-smoke.ts", "gpt-6-luna"], {
    cwd: process.cwd(), env: {...process.env, PI_CONTEXT_DECISIONS_LIVE: "0", PI_CODING_AGENT_DIR: "/invalid/never-access-fixture"}, encoding: "utf8",
  });
  assert.equal(result.status, 2); assert.match(result.stderr, /Live inference disabled/); assert.equal(result.stdout, "");
});
test("invalid live target is rejected before Pi initialization/network calls", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/live-smoke.ts", "openai-codex"], {
    cwd: process.cwd(), env: {...process.env, PI_CONTEXT_DECISIONS_LIVE: "1", PI_CODING_AGENT_DIR: "/invalid/never-access-fixture"}, encoding: "utf8",
  });
  assert.equal(result.status, 2); assert.match(result.stderr, /Unknown smoke-test/); assert.equal(result.stdout, "");
});
