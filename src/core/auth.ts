import { DecisionError } from "../decision/errors.ts";
import type { BackendId } from "../decision/types.ts";
import { createDeadline } from "./control.ts";

/** Narrow public registry surface; no auth-file access or provider-specific token sniffing. */
export interface ProviderAuthLike { auth: { apiKey?: string }; source?: string }
export interface AuthRegistryLike {
  /** Public request-time resolution includes auth source; prefer it over snapshot/key-only APIs. */
  getProviderAuth?(provider: string, options?: {signal?: AbortSignal}): Promise<ProviderAuthLike | undefined>;
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
  getModelsOfType?(type: "chat", provider?: string): readonly {provider: string; id: string}[];
  isUsingOAuth?(model: unknown): boolean;
}
export type CredentialSource = "pi" | "env";
export interface Credential {key: string; source: CredentialSource}
export interface AuthDeps {
  registry?: AuthRegistryLike;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
async function resolve(backend: Exclude<BackendId, "pi">, variable: string, deps: AuthDeps): Promise<Credential> {
  const provider = backend === "gemini" ? "google" : backend;
  const apiKeyOnly = backend === "openai" || backend === "gemini";
  if (deps.signal?.aborted) throw new DecisionError("aborted", "Credential lookup aborted", {backend});
  let oauth = false;
  if (apiKeyOnly && !deps.registry?.getProviderAuth && deps.registry?.isUsingOAuth) {
    try {
      // Provider auth is independent of the model catalog.
      oauth = deps.registry.isUsingOAuth({provider});
    } catch { oauth = true; } // Don't forward a key if a present OAuth detector fails.
  }
  if (deps.registry && !oauth) {
    const deadline = createDeadline({signal: deps.signal, timeoutMs: deps.timeoutMs ?? 5000}, backend);
    try {
      let key: string | undefined;
      if (deps.registry.getProviderAuth) {
        const resolved = await deadline.run(deps.registry.getProviderAuth(provider, {signal: deadline.signal}));
        // These direct routes require API keys for the exact provider, not chat OAuth.
        // The public source reflects request-time auth, unlike the cached OAuth snapshot.
        oauth = apiKeyOnly && resolved?.source === "OAuth";
        if (apiKeyOnly && resolved && resolved.source === undefined && deps.registry.isUsingOAuth) {
          try { oauth = deps.registry.isUsingOAuth({provider}); } catch { oauth = true; }
        }
        if (!oauth) key = clean(resolved?.auth.apiKey);
      } else {
        key = clean(await deadline.run(deps.registry.getApiKeyForProvider(provider)));
      }
      if (key) return {key, source: "pi"};
    } catch {
      if (deps.signal?.aborted) throw new DecisionError("aborted", "Credential lookup aborted", {backend});
      // Missing, rejected, or timed-out Pi resolution falls back to the explicit env variable.
    } finally { deadline.close(); }
  }
  const key = clean((deps.env ?? process.env)[variable]);
  if (key) return {key, source: "env"};
  throw new DecisionError("auth", oauth
    ? `${backend === "openai" ? "ChatGPT" : "Google OAuth"} login cannot call Decisions; set ${variable}`
    : `No ${provider} API key; configure /login ${provider} or ${variable}`, {backend});
}
export function resolveOpenRouterKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("openrouter", "OPENROUTER_API_KEY", deps); }
export function resolveOpenAIKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("openai", "OPENAI_API_KEY", deps); }
export function resolveGeminiKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("gemini", "GEMINI_API_KEY", deps); }
export function resolveTypeSafeKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("typesafe", "TYPESAFE_API_KEY", deps); }
