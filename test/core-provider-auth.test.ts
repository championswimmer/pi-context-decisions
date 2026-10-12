import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey } from "../src/core/auth.ts";

const providers = [["openai", "OPENAI_API_KEY", resolveOpenAIKey], ["openrouter", "OPENROUTER_API_KEY", resolveOpenRouterKey], ["typesafe", "TYPESAFE_API_KEY", resolveTypeSafeKey]] as const;
for (const [provider, variable, resolve] of providers) {
  test(`${provider}: public request-time auth precedes legacy lookup and env`, async () => {
    let calls = 0;
    const registry = {
      async getProviderAuth(id: string) { assert.equal(id, provider); calls++; return { auth: { apiKey: " pi-fixture " }, source: "stored credential" }; },
      async getApiKeyForProvider() { throw new Error("legacy lookup must not run"); },
      isUsingOAuth() { return false; },
    };
    assert.deepEqual(await resolve({ registry, env: {} }), { key: "pi-fixture", source: "pi" });
    assert.deepEqual(await resolve({ registry, env: { [variable]: "env-fixture" } }), { key: "pi-fixture", source: "pi" });
    assert.equal(calls, 2);
  });
  test(`${provider}: missing, failed, timed-out public auth falls back safely`, async () => {
    for (const operation of [async () => undefined, async () => ({auth: {apiKey: " "}}), async () => { throw new Error("PRIVATE-RESOLVER-ERROR"); }, () => new Promise<never>(() => {})]) {
      const registry = { getProviderAuth: operation, async getApiKeyForProvider() { throw new Error("unsafe legacy fallback"); } };
      assert.deepEqual(await resolve({registry, env: {[variable]: "env-fixture"}, timeoutMs: 5}), {key: "env-fixture", source: "env"});
      await assert.rejects(resolve({registry, env: {}, timeoutMs: 5}), (e: unknown) => {
        assert.equal((e as {code: string}).code, "auth"); assert.doesNotMatch(String(e), /PRIVATE|unsafe/); return true;
      });
    }
  });
  test(`${provider}: aborted public auth does not select env`, async () => {
    const abort = new AbortController();
    const pending = resolve({registry: {getProviderAuth: () => new Promise(() => {}), async getApiKeyForProvider() { return "fixture"; }}, env: {[variable]: "env-fixture"}, signal: abort.signal});
    abort.abort(); await assert.rejects(pending, {code: "aborted"});
  });
}
test("OpenAI request-time OAuth is rejected despite an empty/stale snapshot", async () => {
  const queried: string[] = [];
  const registry = {
    async getProviderAuth(provider: string) { queried.push(provider); return {auth: {apiKey: "oauth-fixture"}, source: "OAuth"}; },
    async getApiKeyForProvider() { throw new Error("must not use key-only lookup"); },
    isUsingOAuth() { return false; }, getModelsOfType() { return []; },
  };
  assert.deepEqual(await resolveOpenAIKey({registry, env: {OPENAI_API_KEY: "env-fixture"}}), {key: "env-fixture", source: "env"});
  await assert.rejects(resolveOpenAIKey({registry, env: {}}), {code: "auth", message: /ChatGPT login/});
  assert.deepEqual(queried, ["openai", "openai"]);
});
test("request-time API key overrides stale OAuth snapshot; resolver owns config references", async () => {
  const registry = {
    async getProviderAuth(provider: string) { assert.equal(provider, "openai"); return {auth: {apiKey: "already-resolved-reference"}, source: "stored credential"}; },
    async getApiKeyForProvider() { throw new Error("must not use key-only lookup"); },
    isUsingOAuth() { return true; },
  };
  assert.deepEqual(await resolveOpenAIKey({registry, env: {}}), {key: "already-resolved-reference", source: "pi"});
});
test("OpenRouter OAuth is an API-compatible provider credential, not ChatGPT", async () => {
  const registry = {async getProviderAuth(provider: string) { assert.equal(provider, "openrouter"); return {auth: {apiKey: "router-key-fixture"}, source: "OAuth"}; }, async getApiKeyForProvider() { return undefined; }};
  assert.deepEqual(await resolveOpenRouterKey({registry, env: {OPENROUTER_API_KEY: "env-fixture"}}), {key: "router-key-fixture", source: "pi"});
});
