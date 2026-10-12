import { DecisionError } from "../../decision/errors.ts";
import type { DecisionBackend } from "../../decision/types.ts";
import type { DirectBackendDeps } from "./direct.ts";
import { createOpenAIBackend } from "./openai.ts";
import { createOpenRouterBackend } from "./openrouter.ts";
import { createPiClassifierBackend, type RegistryLike } from "./pi-classifier.ts";
import { createTypeSafeBackend } from "./typesafe.ts";

export type BackendSelection = {backend: "pi"; provider: string; id: string}
  | {backend: "typesafe"; model?: string}
  | {backend: "openai"; model?: string}
  | {backend: "openrouter"; model: string};
export interface BackendDeps extends DirectBackendDeps {
  getRegistry?: () => RegistryLike;
}
export function createBackend(selection: BackendSelection, deps: BackendDeps = {}): DecisionBackend {
  switch (selection.backend) {
    case "typesafe": return createTypeSafeBackend(selection.model, deps);
    case "openai": return createOpenAIBackend(selection.model, deps);
    case "openrouter": return createOpenRouterBackend(selection.model, deps);
    case "pi": {
      if (!deps.getRegistry) throw new DecisionError("config", "Pi backend requires a registry getter", {backend: "pi"});
      return createPiClassifierBackend(selection.provider, selection.id, deps.getRegistry);
    }
    default: throw new DecisionError("config", "Unknown decision backend");
  }
}
export type { DirectBackendDeps } from "./direct.ts";
export type { RegistryLike } from "./pi-classifier.ts";
