import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SKILLS_BASE_ENTRY, SKILLS_MESSAGE_TYPE } from "./skill-ledger.ts";
import { TOOLS_LEDGER_ENTRY, TOOLS_NOTICE_TYPE } from "./tool-ledger.ts";
import { sanitizeTerminalText } from "./settings-model.ts";

export const HISTORY_KINDS = ["skills", "redelivered", "pinned", "base", "tools", "groups", "noticeTools", "noticeGroups"] as const;
export type HistoryKind = typeof HISTORY_KINDS[number];
export interface HistoryBatch {
  /** One-based assistant response on this branch; boundary additions belong to the NEXT response. */
  turn: number;
  answered: boolean;
  timestamp?: string;
  items: Record<HistoryKind, string[]>;
  /** Display text after a name, for kinds that carry one (added items, pinned/allowlisted skills). Other kinds show the bare name. */
  marks?: Partial<Record<HistoryKind, Map<string, string>>>;
}
export interface DecisionsHistory { batches: HistoryBatch[] }
export const HISTORY_NOTE = "Committed active-branch history, grouped before each assistant response; empty turns omitted. Historical additions, not current visibility or proof of a provider request. Added items read `value >= threshold`: the relevance value (raw 0–2 score ÷ 2) and the threshold it had to reach.";
const LABELS: Record<HistoryKind, string> = {
  skills: "Skills advertised (user-role context; metadata, not bodies)",
  redelivered: "Skills re-delivered (not newly picked)",
  pinned: "Pinned/allowlisted skills (always advertised; bypass scoring; confirmed by Pi's recorded skills section)",
  base: "Skills in system base (not scored; confirmed by Pi's recorded skills section)",
  tools: "Tools made available (ledger; not a context declaration)",
  groups: "MCP servers / extensions made available (canonical group keys; ledger)",
  noticeTools: "Tool notice membership (names-only context notice; long lists summarized)",
  noticeGroups: "Group notice membership (names-only context notice; long lists summarized)",
};
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Skill records can contain the full inventory (>1000); only tool records have a 1000-name storage bound.
 * Keep presentation/report limits separate from the complete validated skill history. */
function names(value: unknown, recordLimit = Infinity): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 256).slice(0, recordLimit) : [];
}
const emptyItems = (): Record<HistoryKind, string[]> => ({ skills: [], redelivered: [], pinned: [], base: [], tools: [], groups: [], noticeTools: [], noticeGroups: [] });
const emptyMarks = (): Record<HistoryKind, Map<string, string>> => ({ skills: new Map(), redelivered: new Map(), pinned: new Map(), base: new Map(), tools: new Map(), groups: new Map(), noticeTools: new Map(), noticeGroups: new Map() });
const newBatch = (turn: number): HistoryBatch => ({ turn, answered: false, items: emptyItems(), marks: emptyMarks() });
/** Marks replace the number for items that bypass scoring. */
const PINNED_MARK = "pinned/allowlisted";
const ALLOWLISTED_MARK = "allowlisted";
const UNSCORED_MARK = "not scored";
interface RecordedPick { score: number; threshold: number }
const inRange = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
/** Numbers only: a malformed pick is not a recorded score, so its item shows as unscored. */
function picksOf(value: unknown): Map<string, RecordedPick> {
  const result = new Map<string, RecordedPick>();
  const record = object(value);
  if (!record) return result;
  for (const [name, entry] of Object.entries(record)) {
    const pick = object(entry);
    const score = pick?.score, threshold = pick?.threshold;
    if (name.length > 0 && name.length <= 256 && inRange(score, 2) && inRange(threshold, 1)) result.set(name, { score, threshold });
  }
  return result;
}
/**
 * `value >= threshold`: the raw 0–2 score halved, then the stored threshold. The value uses its shortest EXACT decimal (two places minimum);
 * if that needs more than ten places, the first rounding that keeps the shown comparison honest is used.
 */
export function qualifyingMark(score: number, threshold: number): string {
  const value = score / 2;
  const qualifies = value >= threshold;
  let fallback: string | undefined;
  for (let digits = 2; digits <= 10; digits++) {
    const text = value.toFixed(digits);
    if (Number(text) === value) return `${text} >= ${threshold}`;
    if (fallback === undefined && (Number(text) >= threshold) === qualifies) fallback = text;
  }
  return `${fallback ?? String(value)} >= ${threshold}`;
}
/** A recorded pick shows its value; an allowlist grant shows that; anything else has no recorded score. */
const markFor = (picks: Map<string, RecordedPick>, allowlisted: ReadonlySet<string>) => (name: string): string => {
  const pick = picks.get(name);
  return pick ? qualifyingMark(pick.score, pick.threshold) : allowlisted.has(name) ? ALLOWLISTED_MARK : UNSCORED_MARK;
};
const hasItems = (batch: HistoryBatch) => HISTORY_KINDS.some((kind) => batch.items[kind].length > 0);
const decodeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);

/**
 * Read-only, branch-derived snapshot: never consults live scores, inventory, pending drafts or settings.
 * getBranch deliberately preserves compacted/edited history. A committed delta was added to context at
 * that point, even if it was later summarized away. Base custom entries alone are NOT delivery proof:
 * show those names only when a subsequent committed system skills section actually advertises them.
 * Added skills/tools carry their raw score and threshold when recorded (`picks`); allowlist grants are marked
 * `allowlisted` or pinned and never scored. Pick reasons and fail-open flags are not stored, so those adds show as unscored.
 * Notices are a distinct context event, never a declaration.
 */
export function readDecisionsHistory(session: Pick<ExtensionContext["sessionManager"], "getBranch">): DecisionsHistory {
  const batches: HistoryBatch[] = [];
  const seen = Object.fromEntries(HISTORY_KINDS.map((kind) => [kind, new Set<string>()])) as Record<HistoryKind, Set<string>>;
  const recordedBase = new Set<string>();
  const recordedPinned = new Set<string>();
  let batch = newBatch(1);
  let inBatch = new Map<HistoryKind, Set<string>>();
  const add = (kind: HistoryKind, values: readonly string[], timestamp: string, mark?: (name: string) => string) => {
    for (const name of values) {
      // Re-delivery is meaningful on each boundary, unlike a new addition. Deduplicate inside a batch.
      const local = inBatch.get(kind) ?? new Set<string>();
      if (local.has(name) || (kind !== "redelivered" && seen[kind].has(name))) continue;
      local.add(name); inBatch.set(kind, local);
      seen[kind].add(name); batch.items[kind].push(name);
      if (mark) batch.marks![kind]!.set(name, mark(name));
      if (!batch.timestamp && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(timestamp)) batch.timestamp = timestamp;
    }
  };
  for (const entry of session.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      batch.answered = true;
      if (hasItems(batch)) batches.push(batch);
      batch = newBatch(batch.turn + 1);
      inBatch = new Map();
      continue;
    }
    if (entry.type === "custom" && entry.customType === SKILLS_BASE_ENTRY) {
      const data = object(entry.data);
      if (data?.v === 1) for (const name of names(data.names)) { recordedBase.add(name); if (data.pinned === true) recordedPinned.add(name); }
    } else if (entry.type === "message" && entry.message.role === "system") {
      const skills = entry.message.sections?.skills;
      if (typeof skills !== "string") continue;
      // Pi's public formatSkillsForPrompt uses these XML-escaped tags. Do not display paths/descriptions.
      for (const match of skills.matchAll(/<name>([^<]{1,1536})<\/name>/g)) {
        const name = decodeXml(match[1]);
        if (!recordedBase.has(name) || seen.skills.has(name)) continue;
        if (recordedPinned.has(name)) add("pinned", [name], entry.timestamp, () => PINNED_MARK);
        else add("base", [name], entry.timestamp);
      }
    } else if (entry.type === "custom_message" && entry.customType === SKILLS_MESSAGE_TYPE) {
      const details = object(entry.details);
      if (details?.v !== 1 || typeof entry.content !== "string" || !entry.content.trim()) continue;
      add("skills", names(details.added).filter((name) => !seen.base.has(name) && !seen.pinned.has(name)), entry.timestamp, markFor(picksOf(details.picks), new Set()));
      add("redelivered", names(details.redelivered), entry.timestamp);
    } else if (entry.type === "custom" && entry.customType === TOOLS_LEDGER_ENTRY) {
      const data = object(entry.data);
      if (data?.v !== 1) continue;
      const mark = markFor(picksOf(data.picks), new Set(names(data.allowlisted, 1000)));
      add("tools", names(data.tools, 1000), entry.timestamp, mark);
      add("groups", names(data.groups, 1000), entry.timestamp, mark);
      // withheld/released/considered/initialTask are not additions to context or new availability.
    } else if (entry.type === "custom_message" && entry.customType === TOOLS_NOTICE_TYPE) {
      const details = object(entry.details);
      if (details?.v !== 1 || typeof entry.content !== "string" || !entry.content.trim()) continue;
      add("noticeTools", names(details.tools, 1000), entry.timestamp);
      add("noticeGroups", names(details.groups, 1000), entry.timestamp);
    }
  }
  if (hasItems(batch)) batches.push(batch);
  return { batches };
}
export function historyBatchTitle(batch: HistoryBatch): string { return `Before turn ${batch.turn}${batch.answered ? "" : " (no response yet)"}`; }
export function historyBatchSummary(batch: HistoryBatch): string {
  const i = batch.items;
  return [i.skills.length && `${i.skills.length} skills`, i.redelivered.length && `${i.redelivered.length} re-delivered`, i.base.length && `${i.base.length} base skills`,
    i.pinned.length && `${i.pinned.length} pinned skills`, i.tools.length && `${i.tools.length} tools available`, i.groups.length && `${i.groups.length} groups available`,
    (i.noticeTools.length + i.noticeGroups.length) && `${i.noticeTools.length + i.noticeGroups.length} in notices`].filter(Boolean).join(" · ");
}
/** One bounded, sanitized name per line; the terminal viewer scrolls through ALL names. */
export function historyBatchLines(batch: HistoryBatch): string[] {
  const lines = [historyBatchTitle(batch), ...(batch.timestamp ? [batch.timestamp] : [])];
  for (const kind of HISTORY_KINDS) {
    if (!batch.items[kind].length) continue;
    lines.push("", `${LABELS[kind]} (${batch.items[kind].length}):`, ...batch.items[kind].map((name) => {
      const mark = batch.marks?.[kind]?.get(name);
      return `  ${sanitizeTerminalText(name, 256)}${mark ? `  ${mark}` : ""}`;
    }));
  }
  return lines;
}
/** Bounded report for RPC notifications / stderr (never writes to the JSON protocol stream). */
export function historyReportLines(history: DecisionsHistory): string[] {
  const lines = [`Decisions history · ${history.batches.length} non-empty batches`, HISTORY_NOTE,
    "Skill advertisements are metadata, not loaded bodies. Tool availability includes unscored grants; notices are not tool declarations. Stored values are only each pick's raw score and threshold; no pick reasons."];
  if (!history.batches.length) return [...lines, "No committed additions on this branch."];
  let chars = lines.join("\n").length;
  for (const batch of [...history.batches].reverse()) {
    for (const line of ["", ...historyBatchLines(batch)]) {
      if (lines.length >= 240 || chars + line.length + 1 > 24_000) return [...lines, "… report truncated; use /decisions history in the terminal to browse every batch and name."];
      lines.push(line); chars += line.length + 1;
    }
  }
  return lines;
}
