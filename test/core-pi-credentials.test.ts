import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
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
