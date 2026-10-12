import { resolveTypeSafeKey } from "../auth.ts";
import { encodeSystemOne, decodeSystemOne } from "../codecs/system-one.ts";
import { createDirectBackend, type DirectBackendDeps } from "./direct.ts";
export type { DirectBackendDeps } from "./direct.ts";
export function createTypeSafeBackend(model = "jev-latest", deps: DirectBackendDeps = {}) {
  return createDirectBackend({id: "typesafe", model, url: "https://api.typesafe.ai/v1/systemone", resolveKey: resolveTypeSafeKey, encode: encodeSystemOne, decode: (request, json) => decodeSystemOne(request, json, {strictMetadata: true}), limits: {maxChoices: 255, maxLevels: 10}}, deps);
}
