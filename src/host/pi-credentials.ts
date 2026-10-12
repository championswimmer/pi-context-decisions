import type { AuthRegistryLike, ProviderAuthLike } from "../core/auth.ts";
import { DecisionError } from "../decision/errors.ts";

/** Nonsecret public SDK surface, injectable without loading Pi for offline tests. */
export interface PiCredentialRuntime {
  listCredentials(options?: {signal?: AbortSignal}): Promise<readonly {providerId: string; type: "api_key" | "oauth"}[]>;
  getAuth(provider: string, options?: {signal?: AbortSignal}): Promise<ProviderAuthLike | undefined>;
}
export interface PiCredentialRegistryOptions {
  runtime?: PiCredentialRuntime;
  authPath?: string;
  modelsPath?: string | null;
}
/**
 * Standalone hosts only. Active extensions must use ctx.modelRegistry to preserve
 * in-process overrides/extensions. Default SDK paths honor PI_CODING_AGENT_DIR.
 * No raw credential file access, session creation, or model catalog network refresh.
 */
export async function createPiCredentialRegistry(options: PiCredentialRegistryOptions = {}): Promise<AuthRegistryLike> {
  let runtime: PiCredentialRuntime;
  let providerAuth: (provider: string, options?: {signal?: AbortSignal}) => Promise<ProviderAuthLike | undefined>;
  try {
    if (options.runtime) {
      runtime = options.runtime;
      providerAuth = (provider, opts) => runtime.getAuth(provider, opts);
    } else {
      const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
      const sdk = await ModelRuntime.create({
        refreshOnCreate: false, allowModelNetwork: false,
        ...(options.authPath === undefined ? {} : {authPath: options.authPath}),
        ...(options.modelsPath === undefined ? {} : {modelsPath: options.modelsPath}),
      });
      runtime = sdk;
      const registry = new ModelRegistry(sdk);
      providerAuth = (provider) => registry.getProviderAuth(provider);
    }
  } catch {
    throw new DecisionError("auth", "Pi credential runtime could not be initialized");
  }
  const getProviderAuth: NonNullable<AuthRegistryLike["getProviderAuth"]> = async (provider, opts) => {
    // Avoid refreshing a known incompatible OpenAI OAuth credential even when
    // refreshOnCreate:false leaves the registry's snapshot unpopulated.
    if (provider === "openai") {
      const credential = (await runtime.listCredentials(opts)).find((item) => item.providerId === "openai");
      if (credential?.type === "oauth") return {auth: {}, source: "OAuth"};
    }
    return providerAuth(provider, opts);
  };
  return {
    getProviderAuth,
    async getApiKeyForProvider(provider) { return (await getProviderAuth(provider))?.auth.apiKey; },
  };
}
