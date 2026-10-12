/**
 * Checked-in weekly-token snapshot, verified 2026-10-12 UTC.
 * Evidence: .agents/plans/openrouter-weekly-popularity.md (live OpenRouter catalog
 * joined to the full weekly frontend leaderboard). No runtime discovery or refresh.
 * These are popularity figures for public OpenRouter traffic, not model quality.
 * Two original top-ten entries were removed after confirmed routing guardrails;
 * see .agents/plans/live-provider-validation-2026-10-12.md. No replenishment.
 * Update this source file deliberately when adopting a newer verified snapshot.
 */
export interface OpenRouterDecisionModel {
  readonly id: string;
  readonly name: string;
  readonly canonicalSlug: string;
  /** Position in the original top-ten snapshot, before routing exclusions. */
  readonly popularityRank: number;
  /** Exact seven-day prompt + completion tokens. Decimal strings avoid precision loss. */
  readonly weeklyTokens: string;
}

export const OPENROUTER_DECISION_SNAPSHOT = Object.freeze({
  snapshotDate: "2026-10-12",
  windowStart: "2026-10-05",
  usageThrough: "2026-10-11",
  metric: "prompt + completion tokens",
  originalCount: 10,
  routingCheckedDate: "2026-10-12",
  excludedIds: Object.freeze(["openai/gpt-6-luna-decisions", "inception/mercury-decide:free"]),
  source: "openrouter-frontend-rankings-week",
  unofficial: true,
  catalogUrl: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  rankingsUrl: "https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens",
  license: "CC BY 4.0",
  attribution: "Source: OpenRouter rankings (unofficial endpoint), usage through 2026-10-11, verified 2026-10-12 UTC. CC BY 4.0. Static checked-in snapshot; updates require a code change.",
} as const);

export const OPENROUTER_DECISION_MODELS: readonly OpenRouterDecisionModel[] = Object.freeze([
  { id: "typesafe/jev-1.13", popularityRank: 1, name: "TypeSafe: Jev 1.13", canonicalSlug: "typesafe/jev-1.13-20260917", weeklyTokens: "3359670383787" },
  { id: "perplexity/pplx-decider-v1.1-27b", popularityRank: 2, name: "Perplexity: Decider V1.1 27B", canonicalSlug: "perplexity/pplx-decider-v1.1-27b-20261006", weeklyTokens: "71465391606" },
  { id: "cloudflare/clef-flash", popularityRank: 4, name: "Cloudflare: Clef Flash", canonicalSlug: "cloudflare/clef-flash", weeklyTokens: "37269378167" },
  { id: "liquid/d1", popularityRank: 6, name: "Liquid: D1", canonicalSlug: "liquid/d1-20260930", weeklyTokens: "12526551021" },
  { id: "cloudflare/clef", popularityRank: 7, name: "Cloudflare: Clef", canonicalSlug: "cloudflare/clef", weeklyTokens: "11067471867" },
  { id: "nace-ai/drex-v1.5", popularityRank: 8, name: "Nace: Drex V1.5", canonicalSlug: "nace-ai/drex-v1.5-20261009", weeklyTokens: "10456871306" },
  { id: "microsoft/microsoft-decision-1", popularityRank: 9, name: "Microsoft: Decision-1", canonicalSlug: "microsoft/microsoft-decision-1-20261009", weeklyTokens: "8926732791" },
  { id: "upstage/solar-decide", popularityRank: 10, name: "Upstage: Solar Decide", canonicalSlug: "upstage/solar-decide-20260928", weeklyTokens: "4181138097" },
].map((model) => Object.freeze(model)));

export function getOpenRouterDecisionModel(id: string): OpenRouterDecisionModel | undefined {
  return OPENROUTER_DECISION_MODELS.find((model) => model.id === id);
}

/** Exact IDs only: redirect aliases and alternate paid/free variants are not this snapshot. */
export function isAllowedOpenRouterModel(id: string): boolean {
  return getOpenRouterDecisionModel(id) !== undefined;
}
