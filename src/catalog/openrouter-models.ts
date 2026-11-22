/**
 * Checked-in weekly-token snapshot, retrieved 2026-11-21 UTC.
 * Evidence: .agents/research/openrouter-weekly-popularity-2026-11-21.md.
 * These are popularity figures for public OpenRouter traffic, not model quality.
 * The retained top ten is supplemented by explicitly requested variants from
 * the same leaderboard. No automatic backfill or runtime discovery.
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
  snapshotDate: "2026-11-21",
  windowStart: "2026-11-14",
  usageThrough: "2026-11-20",
  metric: "prompt + completion tokens",
  originalCount: 10,
  // Historical routing check, not a guarantee or an eligibility filter.
  routingCheckedDate: "2026-10-12",
  excludedIds: Object.freeze(["typesafe/jev-1.13", "perplexity/pplx-decider-v1.2"]),
  source: "openrouter-frontend-rankings-week",
  unofficial: true,
  catalogUrl: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  rankingsUrl: "https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens",
  license: "CC BY 4.0",
  attribution: "Source: OpenRouter rankings (unofficial endpoint), usage through 2026-11-20, retrieved 2026-11-21 UTC. CC BY 4.0. Static checked-in snapshot; updates require a code change.",
} as const);

export const OPENROUTER_DECISION_MODELS: readonly OpenRouterDecisionModel[] = Object.freeze([
  { id: "typesafe/jev-1.14", popularityRank: 2, name: "TypeSafe: Jev 1.14", canonicalSlug: "typesafe/jev-1.14-20261014", weeklyTokens: "2228772203880" },
  { id: "liquid/d1-ultra", popularityRank: 4, name: "LiquidAI: d1-ultra", canonicalSlug: "liquid/d1-ultra-20261015", weeklyTokens: "275356685190" },
  { id: "perplexity/pplx-decider-v1.3:free", popularityRank: 5, name: "Perplexity: Decider V1.3 (free)", canonicalSlug: "perplexity/pplx-decider-v1.3-20261112", weeklyTokens: "232109682778" },
  { id: "liquid/d1.1", popularityRank: 6, name: "LiquidAI: d1.1", canonicalSlug: "liquid/d1.1-20261027", weeklyTokens: "93715760755" },
  { id: "openai/gpt-6-luna-decisions", popularityRank: 7, name: "OpenAI: GPT-6 Luna Decisions", canonicalSlug: "openai/gpt-6-luna-decisions-20261006", weeklyTokens: "87507974349" },
  { id: "perplexity/pplx-decider-flash-v1.3:free", popularityRank: 8, name: "Perplexity: Decider Flash V1.3 (free)", canonicalSlug: "perplexity/pplx-decider-flash-v1.3-20261112", weeklyTokens: "60108700793" },
  { id: "nace-ai/drex-max", popularityRank: 9, name: "Nace.AI: Drex Max", canonicalSlug: "nace-ai/drex-max-20261016", weeklyTokens: "41326695423" },
  { id: "google/gemini-decision-1", popularityRank: 10, name: "Google: Gemini Decision 1", canonicalSlug: "google/gemini-decision-1-20261111", weeklyTokens: "39751518937" },
  { id: "cloudflare/clef-flash", popularityRank: 12, name: "Cloudflare: Clef Flash", canonicalSlug: "cloudflare/clef-flash", weeklyTokens: "26557452284" },
  { id: "liquid/d1.2-ultra", popularityRank: 14, name: "LiquidAI: d1.2-ultra", canonicalSlug: "liquid/d1.2-ultra-20261116", weeklyTokens: "19599199230" },
  { id: "microsoft/microsoft-decision-1.1", popularityRank: 16, name: "Microsoft: Microsoft-Decision-1.1", canonicalSlug: "microsoft/microsoft-decision-1.1-20261117", weeklyTokens: "12876482257" },
  { id: "cloudflare/clef", popularityRank: 17, name: "Cloudflare: Clef", canonicalSlug: "cloudflare/clef", weeklyTokens: "12243330513" },
  { id: "liquid/d1.2", popularityRank: 20, name: "LiquidAI: d1.2", canonicalSlug: "liquid/d1.2-20261116", weeklyTokens: "9525052959" },
  { id: "cloudflare/clef-omni", popularityRank: 26, name: "Cloudflare: Clef Omni", canonicalSlug: "cloudflare/clef-omni-20261009", weeklyTokens: "2391884447" },
].map((model) => Object.freeze(model)));

export function getOpenRouterDecisionModel(id: string): OpenRouterDecisionModel | undefined {
  return OPENROUTER_DECISION_MODELS.find((model) => model.id === id);
}

/** Exact IDs only: redirect aliases and alternate paid/free variants are not this snapshot. */
export function isAllowedOpenRouterModel(id: string): boolean {
  return getOpenRouterDecisionModel(id) !== undefined;
}
