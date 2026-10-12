import assert from "node:assert/strict";
import test from "node:test";
import { DecisionError } from "../src/decision/errors.ts";
import { resolveOpenAIKey, resolveOpenRouterKey, resolveTypeSafeKey, type AuthDeps } from "../src/core/auth.ts";

const resolvers = [
  [resolveOpenRouterKey, "openrouter", "OPENROUTER_API_KEY"],
  [resolveOpenAIKey, "openai", "OPENAI_API_KEY"],
  [resolveTypeSafeKey, "typesafe", "TYPESAFE_API_KEY"],
] as const;
for (const [resolve, provider, variable] of resolvers) {
  test(`${provider}: Pi resolution wins over env and is trimmed, not cached`, async () => {
    let calls = 0;
    const deps: AuthDeps = {registry: {async getApiKeyForProvider(id) { assert.equal(id, provider); return ` pi-fixture-${++calls} `; }}, env: {[variable]: "env-fixture"}};
    assert.deepEqual(await resolve(deps), {key: "pi-fixture-1", source: "pi"});
    assert.deepEqual(await resolve(deps), {key: "pi-fixture-2", source: "pi"});
  });
  test(`${provider}: missing, whitespace, rejection, and auth timeout fall back to env`, async () => {
    for (const operation of [async () => undefined, async () => "   ", async () => {throw new Error("private-auth-fixture");}, () => new Promise<string>(() => {})]) {
      const result = await resolve({registry: {getApiKeyForProvider: operation}, env: {[variable]: " env-fixture "}, timeoutMs: 5});
      assert.deepEqual(result, {key: "env-fixture", source: "env"});
    }
    await assert.rejects(resolve({env: {[variable]: "  "}}), (error: unknown) => {
      assert.ok(error instanceof DecisionError); assert.equal(error.code, "auth"); assert.ok(error.message.includes(variable)); return true;
    });
  });
  test(`${provider}: cancellation never falls through to env`, async () => {
    const controller = new AbortController();
    const result = resolve({registry: {getApiKeyForProvider: () => new Promise(() => {})}, env: {[variable]: "env-fixture"}, signal: controller.signal});
    controller.abort("private-abort-fixture");
    await assert.rejects(result, (error: unknown) => {assert.ok(error instanceof DecisionError); assert.equal(error.code, "aborted"); assert.ok(!String(error).includes("private")); return true;});
    await assert.rejects(resolve({signal: controller.signal, env: {[variable]: "env-fixture"}}), {code: "aborted"});
  });
}
test("OpenAI ChatGPT OAuth key is never resolved or sent; explicit API env fallback works", async () => {
  let lookups = 0;
  const registry = {async getApiKeyForProvider() {lookups++; return "oauth-fixture";}, getModelsOfType(type: "chat", provider?: string) {assert.equal(type, "chat"); assert.equal(provider, "openai"); return [{provider: "openai", id: "chat-model"}];}, isUsingOAuth() {return true;}};
  assert.deepEqual(await resolveOpenAIKey({registry, env: {OPENAI_API_KEY: "env-fixture"}}), {key: "env-fixture", source: "env"});
  await assert.rejects(resolveOpenAIKey({registry, env: {}}), {code: "auth", message: /ChatGPT login/});
  assert.equal(lookups, 0);
});
test("OpenAI uses API-key Pi auth; unknown detection does not sniff tokens or use openai-codex", async () => {
  for (const registry of [
    {async getApiKeyForProvider(provider: string) {assert.equal(provider, "openai"); return "fixture";}},
    {async getApiKeyForProvider(provider: string) {assert.equal(provider, "openai"); return "fixture";}, getModelsOfType() {return [{provider: "openai", id: "chat"}];}, isUsingOAuth() {return false;}},
  ]) assert.deepEqual(await resolveOpenAIKey({registry, env: {}}), {key: "fixture", source: "pi"});
});
test("OpenAI OAuth exclusion does not depend on a populated chat catalog", async () => {
  for (const catalog of [[], [{ provider: "openai", id: "chat" }]]) {
    let oauthChecks = 0;
    let keyLookups = 0;
    const registry = {
      async getApiKeyForProvider() { keyLookups++; return "fixture-oauth-token"; },
      getModelsOfType() { return catalog; },
      isUsingOAuth(model: unknown) {
        assert.equal((model as { provider: string }).provider, "openai");
        oauthChecks++;
        return true;
      },
    };
    assert.deepEqual(await resolveOpenAIKey({ registry, env: { OPENAI_API_KEY: "env-fixture" } }), { key: "env-fixture", source: "env" });
    assert.equal(oauthChecks, 1);
    assert.equal(keyLookups, 0);
    await assert.rejects(resolveOpenAIKey({ registry, env: {} }), { code: "auth" });
  }
});
test("OpenAI provider-level API key auth with an empty catalog still uses Pi first", async () => {
  const registry = {
    async getApiKeyForProvider() { return "pi-fixture"; },
    getModelsOfType() { return []; },
    isUsingOAuth(model: unknown) { assert.equal((model as { provider: string }).provider, "openai"); return false; },
  };
  assert.deepEqual(await resolveOpenAIKey({ registry, env: { OPENAI_API_KEY: "env-fixture" } }), { key: "pi-fixture", source: "pi" });
});
test("OAuth detector failure takes safe env path without leaking detector errors", async () => {
  const registry = {async getApiKeyForProvider() {throw new Error("must not look up token");}, getModelsOfType() {return [{provider: "openai", id: "chat"}];}, isUsingOAuth() {throw new Error("private-detector-fixture");}};
  assert.equal((await resolveOpenAIKey({registry, env: {OPENAI_API_KEY: "env-fixture"}})).source, "env");
});
