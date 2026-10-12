import { DecisionError } from "../decision/errors.ts";
import type { BackendId } from "../decision/types.ts";
import { createDeadline } from "./control.ts";

export interface HttpDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
export interface PostOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxAttempts?: number;
  backend: BackendId;
  maxResponseBytes?: number;
}
export interface GetOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
}
const ENDPOINTS = new Set([
  "https://api.typesafe.ai/v1/systemone",
  "https://api.openai.com/v1/decisions",
  "https://openrouter.ai/api/alpha/decisions",
]);

function httpError(status: number, backend?: BackendId): DecisionError {
  const code = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : [400,404,413,422].includes(status) ? "invalid_request" : "http";
  const retryable = status === 429 || ([500,502,503,504,524,529].includes(status) && !(backend === "openai" && status === 504));
  // Provider bodies may echo private state or keys: deliberately do not include them or raw causes.
  return new DecisionError(code, status === 402 ? "Decision provider has insufficient credits (HTTP 402)" : `Decision provider returned HTTP ${status}`, {backend, status, retryable});
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DecisionError("aborted", "Retry canceled")); return; }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DecisionError("aborted", "Retry canceled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, {once: true});
  });
}
function retryDelay(headers: Headers, attempt: number, now: () => number): number {
  const value = headers.get("retry-after");
  if (value !== null) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now();
    if (Number.isFinite(milliseconds)) return Math.min(10000, Math.max(0, milliseconds));
  }
  return Math.min(10000, 500 * 2 ** attempt * (0.8 + 0.4 * Math.random()));
}
async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new DecisionError("config", "Invalid response byte limit");
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) { void response.body?.cancel().catch(() => {}); throw new DecisionError("invalid_response", "Decision response exceeds the byte safety limit"); }
  const reader = response.body?.getReader();
  if (!reader) throw new DecisionError("invalid_response", "Decision provider returned an empty response");
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, {once: true});
  if (signal.aborted) abort();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => {}); throw new DecisionError("invalid_response", "Decision response exceeds the byte safety limit"); }
      text += decoder.decode(part.value, {stream: true});
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    throw new DecisionError("invalid_response", "Decision response stream failed");
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  try { return JSON.parse(text); }
  catch { throw new DecisionError("invalid_response", "Decision provider returned invalid JSON"); }
}

export async function postJson(url: string, key: string, body: unknown, options: PostOptions, deps: HttpDeps = {}): Promise<{json: unknown; status: number; headers: Headers}> {
  if (!ENDPOINTS.has(url)) throw new DecisionError("config", "Decision endpoint is not an approved HTTPS destination", {backend: options.backend});
  const attempts = options.maxAttempts ?? 2;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 4) throw new DecisionError("config", "Invalid HTTP attempt limit", {backend: options.backend});
  if (!key.trim() || /[\r\n]/u.test(key)) throw new DecisionError("auth", "Invalid API key configuration", {backend: options.backend});
  let serialized: string;
  try { serialized = JSON.stringify(body); }
  catch { throw new DecisionError("invalid_request", "Decision payload must be JSON", {backend: options.backend}); }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 1024 * 1024) throw new DecisionError("invalid_request", "Decision payload exceeds the byte safety limit", {backend: options.backend});
  const deadline = createDeadline(options, options.backend);
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      deadline.check();
      let response: Response;
      try {
        response = await deadline.run((deps.fetch ?? fetch)(url, {method: "POST", redirect: "error", headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"}, body: serialized, signal: deadline.signal}));
      } catch (error) {
        deadline.check();
        if (error instanceof DecisionError) throw error;
        if (attempt + 1 === attempts) throw new DecisionError("network", "Decision network request failed", {backend: options.backend, retryable: true});
        await deadline.run((deps.sleep ?? sleep)(retryDelay(new Headers(), attempt, deps.now ?? Date.now), deadline.signal));
        continue;
      }
      if (response.ok) {
        const json = await deadline.run(readJson(response, options.maxResponseBytes ?? 4 * 1024 * 1024, deadline.signal));
        return {json, status: response.status, headers: response.headers};
      }
      void response.body?.cancel().catch(() => {});
      const error = httpError(response.status, options.backend);
      if (!error.retryable || attempt + 1 === attempts) throw error;
      await deadline.run((deps.sleep ?? sleep)(retryDelay(response.headers, attempt, deps.now ?? Date.now), deadline.signal));
    }
    throw new DecisionError("network", "Decision network request failed", {backend: options.backend});
  } catch (error) {
    deadline.check();
    if (error instanceof DecisionError) throw error;
    throw new DecisionError("network", "Decision network operation failed", {backend: options.backend, retryable: true});
  } finally { deadline.close(); }
}

/** Public catalog/ranking GETs are separate from the credential-bearing allowlisted POST path. */
export async function getJson(url: string, options: GetOptions, deps: HttpDeps = {}): Promise<unknown> {
  let destination: URL;
  try { destination = new URL(url); } catch { throw new DecisionError("config", "Invalid catalog URL"); }
  if (destination.protocol !== "https:" || destination.username || destination.password) throw new DecisionError("config", "Catalog URL must use HTTPS without URL credentials");
  const deadline = createDeadline(options);
  try {
    let response: Response;
    try { response = await deadline.run((deps.fetch ?? fetch)(url, {method: "GET", redirect: "error", headers: options.headers, signal: deadline.signal})); }
    catch (error) { deadline.check(); if (error instanceof DecisionError) throw error; throw new DecisionError("network", "Catalog network request failed", {retryable: true}); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status); }
    return await deadline.run(readJson(response, options.maxResponseBytes ?? 2 * 1024 * 1024, deadline.signal));
  } finally { deadline.close(); }
}
