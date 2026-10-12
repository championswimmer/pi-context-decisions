/** Portable application/core API. Import ./extension only when registering with Pi. */
export { createDecisionClient, normalizeScore } from "./decision/api.ts";
export type { DecisionClient } from "./decision/api.ts";
export { DecisionError, isDecisionError } from "./decision/errors.ts";
export type { DecisionErrorCode } from "./decision/errors.ts";
export type * from "./decision/types.ts";
export { createBackend } from "./core/backends/factory.ts";
export type { BackendSelection, BackendDeps, RegistryLike } from "./core/backends/factory.ts";
export { OPENROUTER_DECISION_MODELS, OPENROUTER_DECISION_SNAPSHOT } from "./catalog/openrouter-models.ts";
export { rankSkills, buildRelevanceRequests, interpretRelevance } from "./apps/relevance.ts";
export type { RelevanceItem, RelevanceOptions, RelevanceLabel, SkillCandidate } from "./apps/relevance.ts";
