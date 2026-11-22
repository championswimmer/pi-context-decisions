import { resolveGeminiKey } from "../auth.ts";
import { decodeGemini, encodeGemini, GEMINI_DECISION_MODEL } from "../codecs/gemini.ts";
import { GEMINI_DECISIONS } from "../http.ts";
import { createDirectBackend, type DirectBackendDeps } from "./direct.ts";

export function createGeminiBackend(model = GEMINI_DECISION_MODEL, deps: DirectBackendDeps = {}) {
  return createDirectBackend({id: "gemini", model, url: GEMINI_DECISIONS, resolveKey: resolveGeminiKey, encode: encodeGemini, decode: decodeGemini}, deps);
}
