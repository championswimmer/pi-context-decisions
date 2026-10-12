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
async function resolve(provider: "typesafe" | "openai" | "openrouter", variable: string, deps: AuthDeps): Promise<Credential> {
  if (deps.signal?.aborted) throw new DecisionError("aborted", "Credential lookup aborted", {backend: provider});
  let oauth = false;
  if (provider === "openai" && !deps.registry?.getProviderAuth && deps.registry?.isUsingOAuth) {
    try {
      // Pi 1.1.0 ModelRegistry.isUsingOAuth reads ONLY model.provider. Provider
      // auth is independent of catalog contents, which extensions may replace.
      oauth = deps.registry.isUsingOAuth({provider: "openai"});
    } catch { oauth = true; } // Don't forward a key if a present OAuth detector fails.
  }
  if (deps.registry && !oauth) {
    const deadline = createDeadline({signal: deps.signal, timeoutMs: deps.timeoutMs ?? 5000}, provider);
    try {
      let key: string | undefined;
      if (deps.registry.getProviderAuth) {
        const resolved = await deadline.run(deps.registry.getProviderAuth(provider, {signal: deadline.signal}));
        // Decisions needs the exact openai API key, never openai-codex or ChatGPT auth.
        // The public source reflects request-time auth, unlike the cached OAuth snapshot.
        oauth = provider === "openai" && resolved?.source === "OAuth";
        if (provider === "openai" && resolved && resolved.source === undefined && deps.registry.isUsingOAuth) {
          try { oauth = deps.registry.isUsingOAuth({provider: "openai"}); } catch { oauth = true; }
        }
        if (!oauth) key = clean(resolved?.auth.apiKey);
      } else {
        key = clean(await deadline.run(deps.registry.getApiKeyForProvider(provider)));
      }
      if (key) return {key, source: "pi"};
    } catch {
      if (deps.signal?.aborted) throw new DecisionError("aborted", "Credential lookup aborted", {backend: provider});
      // Missing, rejected, or timed-out Pi resolution falls back to the explicit env variable.
    } finally { deadline.close(); }
  }
  const key = clean((deps.env ?? process.env)[variable]);
  if (key) return {key, source: "env"};
  throw new DecisionError("auth", oauth
    ? `ChatGPT login cannot call Decisions; set ${variable}`
    : `No ${provider} API key; configure /login ${provider} or ${variable}`, {backend: provider as BackendId});
}
export function resolveOpenRouterKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("openrouter", "OPENROUTER_API_KEY", deps); }
export function resolveOpenAIKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("openai", "OPENAI_API_KEY", deps); }
export function resolveTypeSafeKey(deps: AuthDeps = {}): Promise<Credential> { return resolve("typesafe", "TYPESAFE_API_KEY", deps); }
