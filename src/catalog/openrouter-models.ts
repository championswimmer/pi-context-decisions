/**
 * Checked-in weekly-token snapshot, retrieved 2026-11-24 UTC.
 * Evidence: .agents/research/openrouter-top20-accuracy-2026-11-24.md (and the earlier
 * openrouter-weekly-popularity-2026-11-21.md).
 * These are popularity figures for public OpenRouter traffic, not model quality.
 * The list is the union of the 2026-11-24 popularity top ten (minus models whose
 * request shape this extension cannot send) and the top five by benchmark accuracy,
 * and nothing else; models outside both sets were removed on purpose. No automatic backfill or runtime discovery.
 * Update this source file deliberately when adopting a newer verified snapshot.
 */
export interface OpenRouterDecisionModel {
  readonly id: string;
  readonly name: string;
  readonly canonicalSlug: string;
  /** Position among concrete decision models in the original weekly leaderboard. */
  readonly popularityRank: number;
  /** Exact seven-day prompt + completion tokens. Decimal strings avoid precision loss. */
  readonly weeklyTokens: string;
}

export const OPENROUTER_DECISION_SNAPSHOT = Object.freeze({
  snapshotDate: "2026-11-24",
  windowStart: "2026-11-17",
  usageThrough: "2026-11-23",
  metric: "prompt + completion tokens",
  originalCount: 10,
  // Live check 2026-11-24: every listed model scored requests; excluded ids are not sendable (Respan needs a message-array `state`, HTTP 400).
  routingCheckedDate: "2026-11-24",
  excludedIds: Object.freeze(["respan/span-01-lite"]),
  source: "openrouter-frontend-rankings-week",
  unofficial: true,
  catalogUrl: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  rankingsUrl: "https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens",
  license: "CC BY 4.0",
  attribution: "Source: OpenRouter rankings (unofficial endpoint), usage through 2026-11-23, retrieved 2026-11-24 UTC. CC BY 4.0. Static checked-in snapshot; updates require a code change.",
} as const);

export const OPENROUTER_DECISION_MODELS: readonly OpenRouterDecisionModel[] = Object.freeze([
  { id: "typesafe/jev-1.13", popularityRank: 1, name: "TypeSafe: Jev 1.13", canonicalSlug: "typesafe/jev-1.13-20260917", weeklyTokens: "2867645738506" },
  { id: "typesafe/jev-1.14", popularityRank: 2, name: "TypeSafe: Jev 1.14", canonicalSlug: "typesafe/jev-1.14-20261014", weeklyTokens: "2410606533178" },
  { id: "perplexity/pplx-decider-v1.2", popularityRank: 3, name: "Perplexity: Decider V1.2", canonicalSlug: "perplexity/pplx-decider-v1.2-20261016", weeklyTokens: "460501929334" },
  { id: "liquid/d1-ultra", popularityRank: 4, name: "LiquidAI: d1-ultra", canonicalSlug: "liquid/d1-ultra-20261015", weeklyTokens: "329343210047" },
  { id: "perplexity/pplx-decider-v1.3:free", popularityRank: 5, name: "Perplexity: Decider V1.3 (free)", canonicalSlug: "perplexity/pplx-decider-v1.3-20261112", weeklyTokens: "220127827639" },
  { id: "perplexity/pplx-decider-flash-v1.3:free", popularityRank: 6, name: "Perplexity: Decider Flash V1.3 (free)", canonicalSlug: "perplexity/pplx-decider-flash-v1.3-20261112", weeklyTokens: "88151909161" },
  { id: "openai/gpt-6-luna-decisions", popularityRank: 7, name: "OpenAI: GPT-6 Luna Decisions", canonicalSlug: "openai/gpt-6-luna-decisions-20261006", weeklyTokens: "72752139186" },
  { id: "liquid/d1.2-ultra", popularityRank: 9, name: "LiquidAI: d1.2-ultra", canonicalSlug: "liquid/d1.2-ultra-20261116", weeklyTokens: "41294570971" },
  { id: "nace-ai/drex-max", popularityRank: 10, name: "Nace.AI: Drex Max", canonicalSlug: "nace-ai/drex-max-20261016", weeklyTokens: "39605478346" },
  { id: "liquid/d1.1", popularityRank: 12, name: "LiquidAI: d1.1", canonicalSlug: "liquid/d1.1-20261027", weeklyTokens: "36271783829" },
  { id: "nace-ai/drex-v1.5", popularityRank: 13, name: "Nace.AI: Drex v1.5", canonicalSlug: "nace-ai/drex-v1.5-20261009", weeklyTokens: "23416168331" },
  { id: "perplexity/pplx-decider-flash-v1.2", popularityRank: 18, name: "Perplexity: Decider Flash V1.2", canonicalSlug: "perplexity/pplx-decider-flash-v1.2-20261016", weeklyTokens: "14903669615" },
].map((model) => Object.freeze(model)));

export function getOpenRouterDecisionModel(id: string): OpenRouterDecisionModel | undefined {
  return OPENROUTER_DECISION_MODELS.find((model) => model.id === id);
}

/** Exact IDs only: redirect aliases and alternate paid/free variants are not this snapshot. */
export function isAllowedOpenRouterModel(id: string): boolean {
  return getOpenRouterDecisionModel(id) !== undefined;
}
