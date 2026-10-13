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
export type { RelevanceItem, RelevanceOptions, RelevanceRubric, SkillCandidate, RelevanceClient } from "./apps/relevance.ts";
export { pickSkills, filterSkills, applySkillAdvertisementFilter, DEFAULT_RELEVANCE_THRESHOLD } from "./apps/skill-filter.ts";
export { scoreAdditions, RelevanceScoreCache } from "./apps/skill-additions.ts";
export type { SkillAdditionOptions, SkillAdditionResult } from "./apps/skill-additions.ts";
export type { AdvertisedSkill, SkillFilterOptions, SkillAdvertisementOptions, SkillAdvertisementResult } from "./apps/skill-filter.ts";
export { AllowlistError, scopeOf, isAllowlistName, normalizeAllowlist, allowlistedNames, toScopedSkills } from "./apps/allowlist.ts";
export type { AllowlistScope, Allowlists, ScopedSkill } from "./apps/allowlist.ts";
