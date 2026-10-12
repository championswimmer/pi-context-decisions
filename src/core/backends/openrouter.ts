import { resolveOpenRouterKey } from "../auth.ts";
import { encodeSystemOne, decodeSystemOne } from "../codecs/system-one.ts";
import { createDirectBackend, type DirectBackendDeps } from "./direct.ts";
export function createOpenRouterBackend(model: string, deps: DirectBackendDeps = {}) {
  return createDirectBackend({id: "openrouter", model, url: "https://openrouter.ai/api/alpha/decisions", resolveKey: resolveOpenRouterKey, encode: encodeSystemOne, decode: (request, json) => decodeSystemOne(request, json, {strictMetadata: false})}, deps);
}
