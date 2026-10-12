import assert from "node:assert/strict";
import test from "node:test";
import { DecisionError } from "../src/decision/errors.ts";
import { getJson, postJson } from "../src/core/http.ts";
const url = "https://api.typesafe.ai/v1/systemone";
const key = "fixture-key-not-real";
const options = {backend: "typesafe" as const, timeoutMs: 1000};
const ok = () => Response.json({answers: {q: {type: "noul", noul: 0.8}}});

test("POST uses approved destination, JSON headers/body, caller signal, redirects disabled", async () => {
  const result = await postJson(url, key, {private: "fixture"}, options, {fetch: async (destination, init) => {
    assert.equal(destination, url); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, {Authorization: `Bearer ${key}`, "Content-Type": "application/json"});
    assert.equal(init?.body, '{"private":"fixture"}'); assert.ok(init?.signal instanceof AbortSignal); return ok();
  }});
  assert.equal(result.status, 200); assert.ok(result.headers instanceof Headers);
});
test("POST rejects unapproved URLs, malformed keys, limits, non-JSON/oversized requests before fetch", async () => {
  let calls = 0;
  const deps = {fetch: async () => {calls++; return ok();}};
  for (const destination of ["http://api.typesafe.ai/v1/systemone", "https://evil.example/decisions", `${url}?x=1`]) await assert.rejects(postJson(destination, key, {}, options, deps), {code: "config"});
  for (const bad of ["", "   ", "fixture\r\nInjected: header"]) await assert.rejects(postJson(url, bad, {}, options, deps), {code: "auth"});
  await assert.rejects(postJson(url, key, {large: "x".repeat(1024 * 1024)}, options, deps), {code: "invalid_request"});
  await assert.rejects(postJson(url, key, 1n, options, deps), {code: "invalid_request"});
  await assert.rejects(postJson(url, key, {}, {...options, maxAttempts: 0}, deps), {code: "config"});
  await assert.rejects(postJson(url, key, {}, {...options, timeoutMs: NaN}, deps), {code: "invalid_request"});
  assert.equal(calls, 0);
});
for (const [status, code, retryable] of [
  [400,"invalid_request",false], [401,"auth",false], [402,"http",false], [403,"auth",false], [404,"invalid_request",false], [413,"invalid_request",false], [422,"invalid_request",false], [429,"rate_limit",true], [500,"http",true], [502,"http",true], [503,"http",true], [524,"http",true], [529,"http",true],
] as const) test(`HTTP ${status} maps ${code}, retry policy ${retryable}`, async () => {
  let calls = 0;
  await assert.rejects(postJson(url, key, {secret: "private-state-fixture"}, options, {fetch: async () => {calls++; return new Response(`${key} Bearer ${key} private-state-fixture`, {status});}, sleep: async () => {}}), (error: unknown) => {
    assert.ok(error instanceof DecisionError); assert.equal(error.code, code); assert.equal(error.retryable, retryable); assert.equal(error.status, status);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(key), false);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("private-state-fixture"), false);
    return true;
  });
  assert.equal(calls, retryable ? 2 : 1);
});
test("OpenAI 504 is non-retryable, other backends can retry gateway failures", async () => {
  let calls = 0;
  await assert.rejects(postJson("https://api.openai.com/v1/decisions", key, {}, {...options, backend: "openai"}, {fetch: async () => {calls++; return new Response("gateway", {status: 504});}}), {code: "http", retryable: false});
  assert.equal(calls, 1);
  calls = 0;
  await postJson(url, key, {}, options, {fetch: async () => ++calls === 1 ? new Response("gateway", {status: 504}) : ok(), sleep: async () => {}});
  assert.equal(calls, 2);
});
test("Retry-After seconds/date are honored and capped; success ends retries", async () => {
  for (const [retryAfter, expected] of [["2",2000], ["1000",10000], ["Mon, 12 Oct 2026 00:00:03 GMT",3000]] as const) {
    let calls = 0; const delays: number[] = [];
    await postJson(url, key, {}, options, {fetch: async () => ++calls === 1 ? new Response("busy", {status: 429, headers: {"Retry-After": retryAfter}}) : ok(), sleep: async (ms) => {delays.push(ms);}, now: () => Date.parse("2026-10-12T00:00:00Z")});
    assert.deepEqual(delays, [expected]); assert.equal(calls, 2);
  }
});
test("network errors are bounded/retried and never expose raw messages or causes", async () => {
  let calls = 0;
  await assert.rejects(postJson(url, key, {}, options, {fetch: async () => {calls++; throw new Error(`Bearer ${key}`);}, sleep: async () => {}}), (error: unknown) => {assert.ok(error instanceof DecisionError); assert.equal(error.code, "network"); assert.ok(!String(error.stack).includes(key)); assert.equal(error.cause, undefined); return true;});
  assert.equal(calls, 2);
});
test("invalid 2xx JSON, empty streams, declared and actual byte overflows fail safely", async () => {
  for (const response of [new Response("<html>not-json</html>"), new Response(null), new Response("{}", {headers: {"Content-Length": "1000"}}), new Response('{"a":"too much data"}')]) {
    await assert.rejects(postJson(url, key, {}, {...options, maxResponseBytes: 10}, {fetch: async () => response}), {code: "invalid_response"});
  }
});
test("timeout bounds noncooperative fetch, caller abort is distinct including pre-abort", async () => {
  await assert.rejects(postJson(url, key, {}, {...options, timeoutMs: 5}, {fetch: () => new Promise(() => {})}), {code: "timeout"});
  const controller = new AbortController();
  const promise = postJson(url, key, {}, {...options, signal: controller.signal}, {fetch: () => new Promise(() => {})});
  controller.abort("private-abort"); await assert.rejects(promise, {code: "aborted"});
  await assert.rejects(postJson(url, key, {}, {...options, signal: controller.signal}), {code: "aborted"});
});
test("abort cancels retry delay and closes stalled response readers", async () => {
  const controller = new AbortController(); let calls = 0;
  const result = postJson(url, key, {}, {...options, signal: controller.signal}, {fetch: async () => {calls++; return new Response("busy", {status: 429});}, sleep: () => {controller.abort(); return new Promise(() => {});}});
  await assert.rejects(result, {code: "aborted"}); assert.equal(calls, 1);
  let canceled = false;
  const stream = new ReadableStream({cancel() {canceled = true;}});
  await assert.rejects(postJson(url, key, {}, {...options, timeoutMs: 5}, {fetch: async () => new Response(stream)}), {code: "timeout"});
  assert.equal(canceled, true);
});
test("GET public data has no implicit Authorization and uses byte cap/HTTPS/no redirects", async () => {
  const json = await getJson("https://openrouter.ai/api/v1/models?output_modalities=decisions", {timeoutMs: 1000}, {fetch: async (_, init) => {assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.headers, undefined); return Response.json({data: []});}});
  assert.deepEqual(json, {data: []});
  for (const destination of ["http://openrouter.ai", "https://user:secret@openrouter.ai", "invalid"]) await assert.rejects(getJson(destination, {timeoutMs: 10}), {code: "config"});
  await assert.rejects(getJson("https://openrouter.ai", {timeoutMs: 5}, {fetch: () => new Promise(() => {})}), {code: "timeout"});
  await assert.rejects(getJson("https://openrouter.ai", {timeoutMs: 10}, {fetch: async () => new Response("no", {status: 401})}), {code: "auth"});
});
