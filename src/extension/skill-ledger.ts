import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

/**
 * Per-branch skill advertisement ledger. Everything here is DERIVED from the active session branch;
 * there is no hidden in-memory truth, so reload, resume, fork, tree navigation, compaction and
 * context edits are all reflected exactly as Pi committed them.
 *
 * - `SKILLS_BASE_ENTRY` (`custom`, never sent to the model) records names that belong to the stable
 *   `systemPromptOptions.skills` base: always-allowed skills and full-inventory advertisement.
 * - `SKILLS_MESSAGE_TYPE` (`custom_message`, sent to the model as user-role context) carries newly
 *   added skill descriptions, built with Pi's PUBLIC `formatSkillsForPrompt`.
 */
export const SKILLS_BASE_ENTRY = "context-decisions-base";
export const SKILLS_MESSAGE_TYPE = "context-decisions-skills";
const MAX_NAMES = 1000;
const MAX_NAME_CHARS = 256;

export interface BranchEntryLike { type: string; id?: string; customType?: string; data?: unknown; details?: unknown; content?: unknown }
/** The subset of Pi's `ReadonlySessionManager` the ledger needs. */
export interface LedgerSession {
  getBranch(): readonly BranchEntryLike[];
  buildSessionProjection(): { entries: readonly { sourceEntry: BranchEntryLike; messages: readonly unknown[] }[] };
}
export interface LedgerState {
  /** Names in the stable system-prompt base on this branch. */
  base: Set<string>;
  /** Names advertised through deltas on this branch. Never re-scored, never removed. */
  added: Set<string>;
  /** Added names whose delta text is still in model-visible context. */
  visible: Set<string>;
  /** Added names no longer visible (summarized away by compaction or edited out); re-delivered, never re-scored. */
  lost: string[];
}
export interface SkillsDeltaDetails { v: 1; added: string[]; redelivered: string[] }

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= MAX_NAME_CHARS).slice(0, MAX_NAMES);
}
function deltaNames(entry: BranchEntryLike): { added: string[]; redelivered: string[] } | undefined {
  if (entry.type !== "custom_message" || entry.customType !== SKILLS_MESSAGE_TYPE) return undefined;
  const details = entry.details;
  if (!details || typeof details !== "object" || (details as { v?: unknown }).v !== 1) return undefined;
  return { added: names((details as { added?: unknown }).added), redelivered: names((details as { redelivered?: unknown }).redelivered) };
}
/** Read the ledger from the ACTIVE branch. A projection failure is treated as "everything is still visible". */
export function readLedger(session: LedgerSession): LedgerState {
  const base = new Set<string>();
  const added = new Set<string>();
  const entries = session.getBranch();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === SKILLS_BASE_ENTRY) {
      const data = entry.data;
      if (data && typeof data === "object" && (data as { v?: unknown }).v === 1) for (const name of names((data as { names?: unknown }).names)) base.add(name);
      continue;
    }
    const delta = deltaNames(entry);
    if (delta) for (const name of [...delta.added, ...delta.redelivered]) added.add(name);
  }
  const visible = new Set<string>();
  try {
    for (const projected of session.buildSessionProjection().entries) {
      const delta = deltaNames(projected.sourceEntry);
      if (!delta || projected.messages.length === 0) continue;
      // A context edit that replaced the text no longer carries our descriptions.
      const message = projected.messages[0] as { content?: unknown };
      if (JSON.stringify(message?.content) !== JSON.stringify(projected.sourceEntry.content)) continue;
      for (const name of [...delta.added, ...delta.redelivered]) visible.add(name);
    }
  } catch { for (const name of added) visible.add(name); }
  return { base, added, visible, lost: [...added].filter((name) => !visible.has(name) && !base.has(name)) };
}
/**
 * Pi's own rule is: `read` if declared, else `bash`, else an indirect reader. Only the active set is
 * visible to an extension, so no reader here means no delivery (and nothing is recorded as added).
 */
export function skillReader(activeTools: readonly string[]): "read" | "bash" | undefined {
  return activeTools.includes("read") ? "read" : activeTools.includes("bash") ? "bash" : undefined;
}
export interface SkillsDelta {
  customType: typeof SKILLS_MESSAGE_TYPE;
  content: string;
  /** Hidden: the descriptions reach the model but do not spam the transcript. */
  display: false;
  details: SkillsDeltaDetails;
}
/**
 * Append-only delta for newly added (and re-delivered) skills. Only skill names, descriptions and
 * locations in Pi's canonical format are included; skill bodies, transcripts and tool output never are.
 * Returns undefined when nothing visible to the model would be advertised.
 */
export function buildSkillsDelta(added: readonly Skill[], redelivered: readonly Skill[], reader: "read" | "bash"): SkillsDelta | undefined {
  const skills = [...added, ...redelivered].filter((skill) => !skill.disableModelInvocation);
  if (skills.length === 0) return undefined;
  const block = formatSkillsForPrompt(skills, reader).trim();
  if (!block) return undefined;
  return {
    customType: SKILLS_MESSAGE_TYPE,
    content: `Additional skills are now available; previously listed skills remain available.\n\n${block}`,
    display: false,
    details: { v: 1, added: added.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.name), redelivered: redelivered.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.name) },
  };
}
