import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SKILLS_BASE_ENTRY, SKILLS_MESSAGE_TYPE } from "./skill-ledger.ts";
import { TOOLS_LEDGER_ENTRY, TOOLS_NOTICE_TYPE } from "./tool-ledger.ts";
import { sanitizeTerminalText } from "./settings-model.ts";

export const HISTORY_KINDS = ["skills", "redelivered", "base", "tools", "groups", "noticeTools", "noticeGroups"] as const;
export type HistoryKind = typeof HISTORY_KINDS[number];
export interface HistoryBatch {
  /** One-based assistant response on this branch; boundary additions belong to the NEXT response. */
  turn: number;
  answered: boolean;
  timestamp?: string;
  items: Record<HistoryKind, string[]>;
}
export interface DecisionsHistory { batches: HistoryBatch[] }
export const HISTORY_NOTE = "Committed active-branch history, grouped before each assistant response; empty turns omitted. Historical additions, not current visibility or proof of a provider request.";
const LABELS: Record<HistoryKind, string> = {
  skills: "Skills advertised (user-role context; metadata, not bodies)",
  redelivered: "Skills re-delivered (not newly picked)",
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
const emptyItems = (): Record<HistoryKind, string[]> => ({ skills: [], redelivered: [], base: [], tools: [], groups: [], noticeTools: [], noticeGroups: [] });
const hasItems = (batch: HistoryBatch) => HISTORY_KINDS.some((kind) => batch.items[kind].length > 0);
const decodeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);

/**
 * Read-only, branch-derived snapshot: never consults live scores, inventory, pending drafts or settings.
 * getBranch deliberately preserves compacted/edited history. A committed delta was added to context at
 * that point, even if it was later summarized away. Base custom entries alone are NOT delivery proof:
 * show those names only when a subsequent committed system skills section actually advertises them.
 * The ledgers do not retain scores/reasons, so neither scored picks nor allowlist/fail-open/base grants
 * can be inferred for tool availability. Notices are a distinct context event, never a declaration.
 */
export function readDecisionsHistory(session: Pick<ExtensionContext["sessionManager"], "getBranch">): DecisionsHistory {
  const batches: HistoryBatch[] = [];
  const seen = Object.fromEntries(HISTORY_KINDS.map((kind) => [kind, new Set<string>()])) as Record<HistoryKind, Set<string>>;
  const recordedBase = new Set<string>();
  let batch: HistoryBatch = { turn: 1, answered: false, items: emptyItems() };
  let inBatch = new Map<HistoryKind, Set<string>>();
  const add = (kind: HistoryKind, values: readonly string[], timestamp: string) => {
    for (const name of values) {
      // Re-delivery is meaningful on each boundary, unlike a new addition. Deduplicate inside a batch.
      const local = inBatch.get(kind) ?? new Set<string>();
      if (local.has(name) || (kind !== "redelivered" && seen[kind].has(name))) continue;
      local.add(name); inBatch.set(kind, local);
      seen[kind].add(name); batch.items[kind].push(name);
      if (!batch.timestamp && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(timestamp)) batch.timestamp = timestamp;
    }
  };
  for (const entry of session.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      batch.answered = true;
      if (hasItems(batch)) batches.push(batch);
      batch = { turn: batch.turn + 1, answered: false, items: emptyItems() };
      inBatch = new Map();
      continue;
    }
    if (entry.type === "custom" && entry.customType === SKILLS_BASE_ENTRY) {
      const data = object(entry.data);
      if (data?.v === 1) for (const name of names(data.names)) recordedBase.add(name);
    } else if (entry.type === "message" && entry.message.role === "system") {
      const skills = entry.message.sections?.skills;
      if (typeof skills !== "string") continue;
      // Pi's public formatSkillsForPrompt uses these XML-escaped tags. Do not display paths/descriptions.
      for (const match of skills.matchAll(/<name>([^<]{1,1536})<\/name>/g)) {
        const name = decodeXml(match[1]);
        if (recordedBase.has(name) && !seen.skills.has(name)) add("base", [name], entry.timestamp);
      }
    } else if (entry.type === "custom_message" && entry.customType === SKILLS_MESSAGE_TYPE) {
      const details = object(entry.details);
      if (details?.v !== 1 || typeof entry.content !== "string" || !entry.content.trim()) continue;
      add("skills", names(details.added).filter((name) => !seen.base.has(name)), entry.timestamp);
      add("redelivered", names(details.redelivered), entry.timestamp);
    } else if (entry.type === "custom" && entry.customType === TOOLS_LEDGER_ENTRY) {
      const data = object(entry.data);
      if (data?.v !== 1) continue;
      add("tools", names(data.tools, 1000), entry.timestamp);
      add("groups", names(data.groups, 1000), entry.timestamp);
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
    i.tools.length && `${i.tools.length} tools available`, i.groups.length && `${i.groups.length} groups available`,
    (i.noticeTools.length + i.noticeGroups.length) && `${i.noticeTools.length + i.noticeGroups.length} in notices`].filter(Boolean).join(" · ");
}
/** One bounded, sanitized name per line; the terminal viewer scrolls through ALL names. */
export function historyBatchLines(batch: HistoryBatch): string[] {
  const lines = [historyBatchTitle(batch), ...(batch.timestamp ? [batch.timestamp] : [])];
  for (const kind of HISTORY_KINDS) {
    if (!batch.items[kind].length) continue;
    lines.push("", `${LABELS[kind]} (${batch.items[kind].length}):`, ...batch.items[kind].map((name) => `  ${sanitizeTerminalText(name, 256)}`));
  }
  return lines;
}
/** Bounded report for RPC notifications / stderr (never writes to the JSON protocol stream). */
export function historyReportLines(history: DecisionsHistory): string[] {
  const lines = [`Decisions history · ${history.batches.length} non-empty batches`, HISTORY_NOTE,
    "Skill advertisements are metadata, not loaded bodies. Tool availability includes unscored grants; notices are not tool declarations. No stored scores or pick reasons."];
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
