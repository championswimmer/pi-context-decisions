// Additive, incremental scoring for tool/MCP candidates. Pure (no Pi imports); the extension owns the ledger.
import { rankSkills, type RelevanceClient, type RelevanceItem, type RelevanceOptions, type RelevanceSubject } from "./relevance.ts";
import { DEFAULT_RELEVANCE_THRESHOLD, safeCode, selectRelevant, validItems, validThreshold } from "./skill-filter.ts";
import type { ToolCandidate } from "./tool-inventory.ts";

export interface ToolAdditionOptions extends RelevanceOptions {
  /** Normalized 0–1, inclusive. */
  threshold?: number;
  /** Most NEW candidates added by one round, ranked across all scoring batches. */
  maxAdded?: number;
  /** Open adds every remaining candidate when scoring fails; closed (default) adds none. Never for config errors or aborts. */
  failMode?: "open" | "closed";
  subject: Exclude<RelevanceSubject, "skill">;
}
export interface ToolAdditionResult {
  /** Newly added identifiers, best score first (candidate order breaks ties). */
  added: string[];
  /** Candidates that met the threshold before the per-round cap. */
  eligible: number;
  candidates: number;
  /** Candidates that needed a decision call this round (cache misses). */
  scored: number;
  /** Candidates whose scores were reused. When `scored` is 0 no decision call was made. */
  reused: number;
  failedOpen?: boolean;
  /** Safe code only. */
  errorCode?: string;
  latencyMs: number;
  batchSizes: number[];
  /** Identifiers that were actually evaluated (scored now or reused) in a successful round. */
  considered: string[];
}
/**
 * Scores keyed by task/backend/limits/subject. A later round for the SAME key only scores candidates it has not
 * scored yet (or whose description changed), then selects across cached and new scores: that is how a
 * tool-round round adds the next-best remaining candidates with no extra decision call.
 */
export class IncrementalScoreCache {
  #key: string | undefined;
  #entries = new Map<string, { description: string; item: RelevanceItem }>();
  lookup(key: string, candidate: ToolCandidate): RelevanceItem | undefined {
    if (this.#key !== key) return undefined;
    const entry = this.#entries.get(candidate.name);
    return entry && entry.description === candidate.description ? entry.item : undefined;
  }
  store(key: string, candidates: readonly ToolCandidate[], items: readonly RelevanceItem[]): void {
    if (this.#key !== key) { this.#key = key; this.#entries = new Map(); }
    const byName = new Map(items.map((item) => [item.name, item]));
    for (const candidate of candidates) {
      const item = byName.get(candidate.name);
      if (item) this.#entries.set(candidate.name, { description: candidate.description, item });
    }
  }
  /** True when a decision call would be needed for this candidate under `key`. */
  needsScoring(key: string, candidate: ToolCandidate): boolean { return this.lookup(key, candidate) === undefined; }
  clear(): void { this.#key = undefined; this.#entries = new Map(); }
}
export async function scoreToolAdditions(
  task: string, candidates: readonly ToolCandidate[], client: RelevanceClient, options: ToolAdditionOptions,
  cache?: { store: IncrementalScoreCache; key: string },
): Promise<ToolAdditionResult> {
  const started = Date.now();
  const batchSizes: number[] = [];
  const done = (fields: Partial<ToolAdditionResult>): ToolAdditionResult =>
    ({ added: [], eligible: 0, candidates: candidates.length, scored: 0, reused: 0, latencyMs: Date.now() - started, batchSizes, considered: [], ...fields });
  const threshold = options.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const maxAdded = options.maxAdded ?? 8;
  if ((options.subject as string) !== "tool" && (options.subject as string) !== "mcp_server") return done({ errorCode: "config" });
  if (!validThreshold(threshold) || !Number.isSafeInteger(maxAdded) || maxAdded < 0
    || (options.failMode !== undefined && options.failMode !== "closed" && options.failMode !== "open")) return done({ errorCode: "config" });
  // Cancellation wins even with cached scores: a superseded round must never produce additions.
  if (options.signal?.aborted) return done({ errorCode: "aborted" });
  if (candidates.length === 0) return done({});
  const unique = [...new Map(candidates.map((candidate) => [candidate.name, candidate])).values()];
  const cachedItems = new Map<string, RelevanceItem>();
  const misses: ToolCandidate[] = [];
  for (const candidate of unique) {
    const hit = cache?.store.lookup(cache.key, candidate);
    if (hit) cachedItems.set(candidate.name, hit); else misses.push(candidate);
  }
  let fresh: RelevanceItem[] = [];
  let errorCode: string | undefined;
  if (misses.length) {
    try {
      fresh = await rankSkills(task, misses, {
        ...(client.maxQuestions === undefined ? {} : { maxQuestions: client.maxQuestions }),
        decide(request, decisionOptions) {
          batchSizes.push(Object.keys(request.questions).length);
          return client.decide(request, decisionOptions);
        },
      }, { ...options, maxCandidates: Math.min(20_000, Math.max(options.maxCandidates ?? 1000, misses.length)) });
      if (!validItems(fresh, new Set(misses.map((candidate) => candidate.name)), new Set())) { fresh = []; errorCode = "invalid_response"; }
    } catch (error) { errorCode = safeCode(error); }
  }
  if (errorCode) {
    if (options.failMode === "open" && errorCode !== "aborted" && errorCode !== "config") {
      return done({ added: unique.map((candidate) => candidate.name), eligible: unique.length, failedOpen: true, errorCode, scored: misses.length });
    }
    return done({ errorCode, scored: misses.length });
  }
  if (options.signal?.aborted) return done({ errorCode: "aborted", scored: misses.length });
  cache?.store.store(cache.key, misses, fresh);
  const items = [...cachedItems.values(), ...fresh];
  const order = new Map(unique.map((candidate, index) => [candidate.name, index]));
  items.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  const { chosen, eligible } = selectRelevant(items, threshold, maxAdded);
  return done({ added: chosen.map((item) => item.name), eligible, scored: misses.length, reused: cachedItems.size, considered: unique.map((candidate) => candidate.name) });
}
