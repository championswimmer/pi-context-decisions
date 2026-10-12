import { resolveOpenAIKey } from "../auth.ts";
import { encodeOpenAI, decodeOpenAI } from "../codecs/openai-decisions.ts";
import { createDirectBackend, type DirectBackendDeps } from "./direct.ts";
export function createOpenAIBackend(model = "gpt-6-luna", deps: DirectBackendDeps = {}) {
  return createDirectBackend({id: "openai", model, url: "https://api.openai.com/v1/decisions", resolveKey: resolveOpenAIKey, encode: encodeOpenAI, decode: decodeOpenAI}, deps);
}
