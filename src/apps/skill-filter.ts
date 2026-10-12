import { rankSkills, type RelevanceClient, type RelevanceItem, type RelevanceLabel, type RelevanceOptions } from "./relevance.ts";

export interface AdvertisedSkill { name: string; description: string; disableModelInvocation?: boolean }
export interface SkillFilterOptions {
  minLabel?: "related" | "directly_relevant";
  maxSkills?: number;
  pinned?: readonly string[];
  /** Open explicitly retains unverified advertisements. Closed is the safe default. */
  failMode?: "open" | "closed";
}
export type FilterReason = "filtered" | "fail-open" | "fail-closed" | "skipped";
export interface SkillFilterResult<T> { kept: T[]; dropped: string[]; reason: FilterReason }
const LABEL_RANK: Record<RelevanceLabel, number> = { irrelevant: 0, related: 1, directly_relevant: 2 };
function uniqueSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  const names = new Set<string>();
  return skills.filter((skill) => {
    if (names.has(skill.name)) return false;
    names.add(skill.name);
    return true;
  });
}
function validItems(items: readonly RelevanceItem[], expected: Set<string>): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || !expected.has(item.name) || seen.has(item.name)
      || !Object.hasOwn(LABEL_RANK, item.label) || !Number.isFinite(item.score) || item.score < 0 || item.score > 2
      || !Number.isFinite(item.normalized) || Math.abs(item.normalized - item.score / 2) > 1e-9
      || (item.confidence !== undefined && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1))) return false;
    seen.add(item.name);
  }
  return seen.size === expected.size;
}
/** Advertisement policy only: original references/order survive; explicit skill access is not changed. */
export function filterSkills<T extends { name: string; disableModelInvocation?: boolean }>(
  skills: readonly T[], items: readonly RelevanceItem[] | null, options: SkillFilterOptions = {},
): SkillFilterResult<T> {
  const inventory = uniqueSkills(skills);
  const pinned = new Set(options.pinned ?? []);
  const maxSkills = options.maxSkills ?? 12;
  const minLabel = options.minLabel ?? "related";
  const validPolicy = Number.isSafeInteger(maxSkills) && maxSkills >= 0
    && (minLabel === "related" || minLabel === "directly_relevant")
    && (options.failMode === undefined || options.failMode === "closed" || options.failMode === "open");
  const candidates = inventory.filter((skill) => !skill.disableModelInvocation);
  const failed = !validPolicy || items === null || !validItems(items, new Set(candidates.map((skill) => skill.name)));
  let kept: T[];
  let reason: FilterReason;
  if (failed) {
    // Invalid policies never accidentally opt in to fail-open.
    if (validPolicy && options.failMode === "open") {
      kept = [...skills]; reason = "fail-open";
    } else {
      kept = inventory.filter((skill) => skill.disableModelInvocation || pinned.has(skill.name)); reason = "fail-closed";
    }
  } else {
    const eligible = (items as readonly RelevanceItem[])
      .filter((item) => !pinned.has(item.name) && LABEL_RANK[item.label] >= LABEL_RANK[minLabel])
      .map((item, index) => ({ item, index }))
      .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
      .slice(0, maxSkills);
    const names = new Set([...pinned, ...eligible.map(({ item }) => item.name)]);
    kept = inventory.filter((skill) => skill.disableModelInvocation || names.has(skill.name)); reason = "filtered";
  }
  const keptNames = new Set(kept.map((skill) => skill.name));
  return { kept, dropped: inventory.filter((skill) => !keptNames.has(skill.name)).map((skill) => skill.name), reason };
}
export interface SkillAdvertisementOptions extends RelevanceOptions, SkillFilterOptions {
  enabled?: boolean;
  relevanceEnabled?: boolean;
  minCandidates?: number;
}
export interface SkillAdvertisementEvent<T> {
  prompt: string;
  systemPromptOptions: { skills: T[] };
}
export interface SkillAdvertisementResult<T> extends SkillFilterResult<T> {
  candidates: number;
  items?: RelevanceItem[];
  skipReason?: "disabled" | "unconfigured" | "empty-prompt" | "below-minimum";
  /** Safe code only: raw provider errors/prompt/skill text are never returned in diagnostics. */
  errorCode?: string;
  latencyMs: number;
}
function safeCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && ["config", "auth", "invalid_request", "invalid_response", "refusal", "rate_limit", "http", "timeout", "aborted", "network"].includes(error.code)) return error.code;
  return "decision-failed";
}
/**
 * Pi 1.1.0 expands /skill:name before this hook as <skill name="..." location="...">
 * followed by body, </skill>, then optional task arguments. Keep only those arguments.
 * Use the LAST closing tag: a skill body may itself contain a closing-tag example.
 * Malformed skill envelopes are not task text and must never be sent to a provider.
 */
function taskWithoutExpandedSkill(prompt: string): string {
  if (!/^\s*<skill\b/u.test(prompt)) return prompt;
  const match = prompt.match(/^\s*<skill\b[^>]*>\r?\n[\s\S]*\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]*))?$/u);
  return match?.[1]?.trim() ?? "";
}
/** Call from the early before_agent_start hook. ONLY assigns systemPromptOptions.skills. */
export async function applySkillAdvertisementFilter<T extends AdvertisedSkill>(
  event: SkillAdvertisementEvent<T>, client: RelevanceClient | null, options: SkillAdvertisementOptions = {},
): Promise<SkillAdvertisementResult<T>> {
  const started = Date.now();
  const skills = event.systemPromptOptions.skills;
  const candidates = uniqueSkills(skills).filter((skill) => !skill.disableModelInvocation);
  const skip = (skipReason: SkillAdvertisementResult<T>["skipReason"]): SkillAdvertisementResult<T> => ({
    kept: skills, dropped: [], reason: "skipped", skipReason, candidates: candidates.length, latencyMs: Date.now() - started,
  });
  if (options.enabled === false || options.relevanceEnabled === false) return skip("disabled");
  if (!client) return skip("unconfigured");
  const task = taskWithoutExpandedSkill(event.prompt);
  if (!task.trim()) return skip("empty-prompt");
  const minCandidates = options.minCandidates ?? 8;
  let items: RelevanceItem[] | null = null;
  let errorCode: string | undefined;
  if (!Number.isSafeInteger(minCandidates) || minCandidates < 0) errorCode = "config";
  else if (candidates.length < minCandidates) return skip("below-minimum");
  else {
    try { items = await rankSkills(task, candidates, client, options); }
    catch (error) { errorCode = safeCode(error); }
  }
  const result = filterSkills(skills, items, options);
  event.systemPromptOptions.skills = result.kept;
  return {
    ...result, candidates: candidates.length, ...(items === null ? {} : { items }),
    ...(errorCode === undefined ? {} : { errorCode }), latencyMs: Date.now() - started,
  };
}
