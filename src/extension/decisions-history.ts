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
  /** Recorded score/threshold or an explicit non-scored label. Never inferred from current settings. */
  marks?: Partial<Record<HistoryKind, Map<string, string>>>;
}
export interface HistoryTurn {
  /** Index of the next assistant response when the native user prompt was committed (one-based, branch-wide). */
  turn: number;
  batches: HistoryBatch[];
}
export interface DecisionsHistory { turns: HistoryTurn[] }
export const HISTORY_NOTE = "Committed active-branch history by user prompt; empty prompts omitted. Turn = one-based assistant response index, including tool rounds. Queued user prompts start a row too; messages before the same response share a row. Counts include confirmed base skills, not re-deliveries or notices. Historical additions, not current visibility or proof of a provider request. Picks show score (raw 0–2) / ≥ minimum (2 × stored threshold). Missing picks are unknown: fail-open/base reasons were not stored.";
const LABELS: Record<HistoryKind, string> = {
  skills: "Skills advertised",
  redelivered: "Skills re-delivered (not new)",
  pinned: "Pinned/allowlisted skills",
  base: "System base skills (not scored)",
  tools: "Tools available",
  groups: "MCPs/extensions available",
  noticeTools: "Tool notice only (not a declaration)",
  noticeGroups: "MCP/extension notice only (not a declaration)",
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
const PINNED_MARK = "pinned (allowlist)";
const BASE_MARK = "base (unfiltered)";
const REDELIVERED_MARK = "re-delivered";
const UNKNOWN_MARK = "unknown (no recorded pick)";
const defaultMark = (kind: HistoryKind): string => kind === "pinned" ? PINNED_MARK : kind === "base" ? BASE_MARK : kind === "redelivered" ? REDELIVERED_MARK : UNKNOWN_MARK;
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
/** Raw score and minimum on the SAME 0–2 scale. Shortest exact numbers avoid rounding a failing score into a tie. */
export function qualifyingMark(score: number, threshold: number): string {
  return `score ${score} / ≥${2 * threshold}`;
}
/** An allowlist grant bypasses scoring, even if an inconsistent/older record also supplies a pick. */
const markFor = (picks: Map<string, RecordedPick>, allowlisted: ReadonlySet<string>) => (name: string): string => {
  if (allowlisted.has(name)) return PINNED_MARK;
  const pick = picks.get(name);
  return pick ? qualifyingMark(pick.score, pick.threshold) : UNKNOWN_MARK;
};
const hasItems = (batch: HistoryBatch) => HISTORY_KINDS.some((kind) => batch.items[kind].length > 0);
const decodeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);

/**
 * Read-only, branch-derived snapshot: never consults live scores, pending drafts or settings. Optional names-only
 * membership comes from the filter's existing registry snapshot, never a fresh lookup or a parsed tool-name prefix.
 * It only collapses tools covered by a group at the SAME response boundary; earlier tools-mode grants stay historical.
 * Old records store no membership, so unloaded/unknown members remain individual rather than guessed.
 * getBranch deliberately preserves compacted/edited history. A committed delta was added to context at
 * that point, even if it was later summarized away. Base custom entries alone are NOT delivery proof:
 * show those names only when a subsequent committed system skills section actually advertises them.
 * Added skills/tools carry their raw score and threshold when recorded (`picks`); allowlist grants are marked
 * pinned and never scored. Pick reasons and fail-open flags are not stored, so missing picks show as unknown.
 * A later notice can reuse the original committed grant's mark, not a live decision or today's threshold.
 * Notices are a distinct context event, never a declaration.
 */
export function readDecisionsHistory(session: Pick<ExtensionContext["sessionManager"], "getBranch">, toolGroups: ReadonlyMap<string, string> = new Map()): DecisionsHistory {
  const turns: HistoryTurn[] = [];
  let prompt: HistoryTurn | undefined;
  let hasUser = false;
  const seen = Object.fromEntries(HISTORY_KINDS.map((kind) => [kind, new Set<string>()])) as Record<HistoryKind, Set<string>>;
  const recordedBase = new Set<string>();
  const recordedPinned = new Set<string>();
  const grantMarks = { tools: new Map<string, string>(), groups: new Map<string, string>() };
  let batch = newBatch(1);
  let inBatch = new Map<HistoryKind, Set<string>>();
  let batchGroups = new Set<string>();
  // Buffer until the assistant: before_agent_start records precede the user, and turn_end deltas
  // precede queued steering. Both belong to a user in this same response boundary, not the prior prompt.
  const finishBatch = () => {
    // Older writers could record an individual pin AND its promoted group (possibly in separate chunks).
    // Collapse only known members covered at this boundary, never unrelated tools or earlier per-tool grants.
    batch.items.tools = batch.items.tools.filter((name) => !batchGroups.has(toolGroups.get(name) ?? ""));
    const noticedGroups = new Set([...batchGroups, ...batch.items.noticeGroups]);
    batch.items.noticeTools = batch.items.noticeTools.filter((name) => !noticedGroups.has(toolGroups.get(name) ?? ""));
    for (const [notice, grant] of [["noticeTools", "tools"], ["noticeGroups", "groups"]] as const) {
      for (const name of batch.items[notice]) batch.marks![notice]!.set(name, grantMarks[grant].get(name) ?? UNKNOWN_MARK);
    }
    if (hasUser || !prompt) {
      prompt = { turn: batch.turn, batches: [] };
      turns.push(prompt);
    }
    if (hasItems(batch)) prompt.batches.push(batch);
  };
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
      finishBatch();
      batch = newBatch(batch.turn + 1);
      hasUser = false;
      inBatch = new Map();
      batchGroups = new Set();
      continue;
    }
    if (entry.type === "message" && entry.message.role === "user") {
      hasUser = true;
    } else if (entry.type === "custom" && entry.customType === SKILLS_BASE_ENTRY) {
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
        else add("base", [name], entry.timestamp, () => BASE_MARK);
      }
    } else if (entry.type === "custom_message" && entry.customType === SKILLS_MESSAGE_TYPE) {
      const details = object(entry.details);
      if (details?.v !== 1 || typeof entry.content !== "string" || !entry.content.trim()) continue;
      add("skills", names(details.added).filter((name) => !seen.base.has(name) && !seen.pinned.has(name)), entry.timestamp, markFor(picksOf(details.picks), new Set()));
      add("redelivered", names(details.redelivered), entry.timestamp, () => REDELIVERED_MARK);
    } else if (entry.type === "custom" && entry.customType === TOOLS_LEDGER_ENTRY) {
      const data = object(entry.data);
      if (data?.v !== 1) continue;
      const mark = markFor(picksOf(data.picks), new Set(names(data.allowlisted, 1000)));
      const tools = names(data.tools, 1000), groups = names(data.groups, 1000);
      for (const [kind, values] of [["tools", tools], ["groups", groups]] as const) {
        for (const name of values) if (!grantMarks[kind].has(name)) grantMarks[kind].set(name, mark(name));
      }
      add("tools", tools, entry.timestamp, mark);
      for (const group of groups) batchGroups.add(group);
      add("groups", groups, entry.timestamp, mark);
      // withheld/released/considered/initialTask are not additions to context or new availability.
    } else if (entry.type === "custom_message" && entry.customType === TOOLS_NOTICE_TYPE) {
      const details = object(entry.details);
      if (details?.v !== 1 || typeof entry.content !== "string" || !entry.content.trim()) continue;
      add("noticeTools", names(details.tools, 1000), entry.timestamp);
      add("noticeGroups", names(details.groups, 1000), entry.timestamp);
    }
  }
  finishBatch();
  return { turns: turns.filter((turn) => turn.batches.length > 0) };
}
export function historyTurnTitle(turn: HistoryTurn): string { return `Turn ${turn.turn}`; }
export function historyTurnSummary(turn: HistoryTurn): string {
  let skills = 0, tools = 0;
  for (const { items: i } of turn.batches) {
    skills += i.skills.length + i.base.length + i.pinned.length;
    tools += i.tools.length + i.groups.length;
  }
  return `${skills} skills, ${tools} tools/MCPs added`;
}
/** One bounded, sanitized name per line; the terminal viewer scrolls through ALL names. */
export function historyBatchLines(batch: HistoryBatch): string[] {
  const lines = [`Internal turn ${batch.turn}${batch.answered ? "" : " (no response yet)"}`];
  for (const kind of HISTORY_KINDS) {
    // Availability and context notice membership remain distinct, but do not repeat the same name
    // twice at one boundary. Later notice-only deliveries still get their own internal-turn section.
    const availableKind = kind === "noticeTools" ? "tools" : kind === "noticeGroups" ? "groups" : undefined;
    const available = new Set(availableKind ? batch.items[availableKind] : []);
    const shown = batch.items[kind].filter((name) => !available.has(name));
    if (!shown.length) continue;
    const noticed = new Set(kind === "tools" ? batch.items.noticeTools : kind === "groups" ? batch.items.noticeGroups : []);
    lines.push(`${LABELS[kind]} (${shown.length}):`, ...shown.map((name) => {
      const mark = batch.marks?.[kind]?.get(name) ?? defaultMark(kind);
      return `  + ${sanitizeTerminalText(name, 256)}  ${sanitizeTerminalText(mark, 160)}${noticed.has(name) ? " · notice" : ""}`;
    }));
  }
  return lines;
}
export function historyTurnLines(turn: HistoryTurn): string[] {
  return [`${historyTurnTitle(turn)}: (${historyTurnSummary(turn)})`, ...turn.batches.flatMap((batch) => ["", ...historyBatchLines(batch)])];
}
/** Bounded report for RPC notifications / stderr (never writes to the JSON protocol stream). */
export function historyReportLines(history: DecisionsHistory): string[] {
  const lines = [`Decisions history · ${history.turns.length} non-empty user turns`, HISTORY_NOTE,
    "Skills are advertisements of metadata, not loaded bodies. Tools/MCPs count ledger availability, with each MCP server or extension group counted once (never expanded into member tools). Notices are membership only; no declarations or pick reasons."];
  if (!history.turns.length) return [...lines, "No committed additions on this branch."];
  let chars = lines.join("\n").length;
  for (const turn of [...history.turns].reverse()) {
    for (const line of ["", ...historyTurnLines(turn)]) {
      if (lines.length >= 240 || chars + line.length + 1 > 24_000) return [...lines, "… report truncated; use /decisions history in the terminal to browse every turn and name."];
      lines.push(line); chars += line.length + 1;
    }
  }
  return lines;
}
