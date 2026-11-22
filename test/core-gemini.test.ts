import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackend, createDecisionClient, type DecisionRequest } from "../src/index.ts";

const request: DecisionRequest = {
  state: {task: "Check the weather", nested: {text: "Clear skies"}},
  questions: {
    binary: {type: "bool", instructions: "Is the sky clear?", criteria: {true: "Clear skies", false: "Cloudy"}},
    category: {type: "choice", instructions: "Which topic?", criteria: {weather: "Weather", other: "Other"}},
    relevance: {type: "score", instructions: "How relevant?", criteria: ["None", "Some", "Direct"]},
  },
};
const wire = {
  answers: {
    binary: {type: "noul", noul: 0.94, confidence: 0.94},
    category: {type: "choice", choice: "weather", probabilities: {weather: 0.9, other: 0.1}},
    relevance: {type: "score", score: 1.9, probabilities: {"0": 0, "1": 0.1, "2": 0.9}},
  },
  usage: {total_input_tokens: 324, total_output_tokens: 0, total_tokens: 324},
};

test("Gemini direct uses the Developer Decisions endpoint and Google API-key header, normalizing all primitives", async () => {
  const providers: string[] = [];
  const backend = createBackend({backend: "gemini"}, {
    registry: {async getApiKeyForProvider() { throw Error("use request-time auth"); }, async getProviderAuth(provider) {
      providers.push(provider);
      return {auth: {apiKey: "fixture-google"}, source: "api_key"};
    }},
    env: {GEMINI_API_KEY: "env-fallback"},
    http: {async fetch(url, init) {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/decisions");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-goog-api-key"), "fixture-google");
      assert.equal(headers.has("authorization"), false);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "gemini-decision-1", input: JSON.stringify(request.state),
        questions: {...request.questions, binary: {type: "noul", instructions: "Is the sky clear?", criteria: {true_description: "Clear skies", false_description: "Cloudy"}}},
      });
      return Response.json(wire);
    }},
  });
  const result = await createDecisionClient(backend).decide(request);
  assert.deepEqual(providers, ["google"]);
  assert.equal(result.backend, "gemini");
  assert.equal(result.model, "gemini-decision-1");
  assert.deepEqual(result.answers, {
    binary: {type: "bool", probability: 0.94, confidence: 0.94},
    category: wire.answers.category,
    relevance: wire.answers.relevance,
  });
  assert.deepEqual(result.usage, {inputTokens: 324, outputTokens: 0, totalTokens: 324});
});

test("Gemini rejects Google OAuth, falls back only to GEMINI_API_KEY, and validates before I/O", async () => {
  let calls = 0;
  const deps = {
    registry: {async getApiKeyForProvider() { return undefined; }, async getProviderAuth() {
      return {auth: {apiKey: "not-an-api-key"}, source: "OAuth"};
    }},
    http: {async fetch(_url: string | URL | Request, init?: RequestInit) {
      calls++;
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "fixture-gemini");
      return Response.json({answers: {...wire.answers, relevance: {type: "score", score: 3}}});
    }},
  };
  await assert.rejects(createBackend({backend: "gemini"}, {...deps, env: {OPENAI_API_KEY: "wrong", OPENROUTER_API_KEY: "wrong"}}).decide(request), {code: "auth"});
  const backend = createBackend({backend: "gemini"}, {...deps, env: {GEMINI_API_KEY: "fixture-gemini"}});
  await assert.rejects(backend.decide({...request, questions: {"bad key": request.questions.binary}}), {code: "invalid_request"});
  assert.equal(calls, 0);
  await assert.rejects(backend.decide(request), {code: "invalid_response"});
  assert.equal(calls, 1);
});
