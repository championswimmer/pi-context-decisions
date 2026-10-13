import { rankSkills, type RelevanceClient, type RelevanceItem, type RelevanceOptions } from "./relevance.ts";
import { DEFAULT_RELEVANCE_THRESHOLD, safeCode, selectRelevant, validItems, validThreshold, type AdvertisedSkill } from "./skill-filter.ts";

/**
 * Additive skill picking: skills that are already advertised are never scored here, and nothing in
 * this module ever removes an advertisement. Pure (no Pi imports): the extension owns the ledger.
 */
export interface SkillAdditionOptions extends RelevanceOptions {
  /** Normalized 0–1, inclusive. */
  threshold?: number;
  /** Most NEW skills added by one round, ranked across all scoring batches. */
  maxSkills?: number;
  /** Open adds every remaining candidate when scoring fails; closed (default) adds none. */
  failMode?: "open" | "closed";
}
export interface SkillAdditionResult<T> {
  /** Newly added skills, best score first (inventory order breaks ties). */
  added: T[];
  /** Candidates that met the threshold before the per-round cap. */
  eligible: number;
  /** Candidates considered this round (never already-advertised skills). */
  candidates: number;
  /** Scores were reused for an identical task; the decision backend was not called. */
  cached: boolean;
  items?: RelevanceItem[];
  /** The round failed open: every remaining candidate was added without scoring. */
  failedOpen?: boolean;
  /** Safe code only. */
  errorCode?: string;
  latencyMs: number;
  /** Actual dispatched question counts per decision call. Empty when cached. */
  batchSizes: number[];
}
/**
 * Scores keyed by task/backend/limits so a later round for the SAME task can add the next-best
 * remaining skills without another decision call. Rejected skills may be re-scored when the key
 * or their description changes; skills that were already added are simply absent from candidates.
 */
export class RelevanceScoreCache {
  #key: string | undefined;
  #entries = new Map<string, { description: string; item: RelevanceItem }>();
  lookup(key: string, candidates: readonly { name: string; description: string }[]): RelevanceItem[] | undefined {
    if (this.#key !== key) return undefined;
    const items: RelevanceItem[] = [];
    for (const candidate of candidates) {
      const entry = this.#entries.get(candidate.name);
      if (!entry || entry.description !== candidate.description) return undefined;
      items.push(entry.item);
    }
    return items;
  }
  store(key: string, candidates: readonly { name: string; description: string }[], items: readonly RelevanceItem[]): void {
    this.#key = key;
    this.#entries = new Map();
    const byName = new Map(items.map((item) => [item.name, item]));
    for (const candidate of candidates) {
      const item = byName.get(candidate.name);
      if (item) this.#entries.set(candidate.name, { description: candidate.description, item });
    }
  }
  clear(): void { this.#key = undefined; this.#entries = new Map(); }
}
/** Score only `candidates`, then choose up to `maxSkills` new skills at or above the threshold. */
export async function scoreAdditions<T extends AdvertisedSkill>(
  task: string, candidates: readonly T[], client: RelevanceClient, options: SkillAdditionOptions = {},
  cache?: { store: RelevanceScoreCache; key: string },
): Promise<SkillAdditionResult<T>> {
  const started = Date.now();
  const batchSizes: number[] = [];
  const done = (fields: Omit<SkillAdditionResult<T>, "candidates" | "latencyMs" | "batchSizes">): SkillAdditionResult<T> =>
    ({ candidates: candidates.length, latencyMs: Date.now() - started, batchSizes, ...fields });
  const threshold = options.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const maxSkills = options.maxSkills ?? 12;
  if (!validThreshold(threshold) || !Number.isSafeInteger(maxSkills) || maxSkills < 0
    || (options.failMode !== undefined && options.failMode !== "closed" && options.failMode !== "open")) {
    // An invalid policy never opts in to fail-open.
    return done({ added: [], eligible: 0, cached: false, errorCode: "config" });
  }
  const cancelled = () => done({ added: [], eligible: 0, cached: false, errorCode: "aborted" });
  // Cancellation wins even when scores are cached: a superseded round must never produce additions.
  if (options.signal?.aborted) return cancelled();
  if (candidates.length === 0) return done({ added: [], eligible: 0, cached: false, items: [] });
  let items: RelevanceItem[] | undefined;
  let cached = false;
  let errorCode: string | undefined;
  try {
    items = cache?.store.lookup(cache.key, candidates);
    cached = items !== undefined;
    if (!items) {
      items = await rankSkills(task, candidates, {
        ...(client.maxQuestions === undefined ? {} : { maxQuestions: client.maxQuestions }),
        decide(request, decisionOptions) {
          batchSizes.push(Object.keys(request.questions).length);
          return client.decide(request, decisionOptions);
        },
      }, options);
      if (!validItems(items, new Set(candidates.map((skill) => skill.name)), new Set())) {
        items = undefined;
        errorCode = "invalid_response";
      } else cache?.store.store(cache.key, candidates, items);
    }
  } catch (error) { errorCode = safeCode(error); items = undefined; }
  if (!items) {
    if (options.failMode === "open" && errorCode !== "aborted" && errorCode !== "config") return done({ added: [...candidates], eligible: candidates.length, cached: false, failedOpen: true, errorCode });
    return done({ added: [], eligible: 0, cached: false, ...(errorCode ? { errorCode } : {}) });
  }
  if (options.signal?.aborted) return cancelled();
  const { chosen, eligible } = selectRelevant(items, threshold, maxSkills);
  const byName = new Map(candidates.map((skill) => [skill.name, skill]));
  return done({ added: chosen.map((item) => byName.get(item.name)!), eligible, cached, items });
}
