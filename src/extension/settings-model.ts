// Pure data and layout helpers for the floating /decisions dialog.
// No Pi or pi-tui imports: everything here is unit-testable without a terminal.
import { DecisionError } from "../decision/errors.ts";
import { SettingsError, type ContextDecisionsSettings, type RelevanceSettings } from "../settings.ts";
import { selectionLabel } from "./contracts.ts";

/** Strip control and format characters (ANSI introducers, bidi overrides) and bound the length. */
export function sanitizeTerminalText(value: unknown, limit = 400): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, Math.max(0, limit));
}

/** Safe, bounded description of a failure: never provider bodies, paths or secrets. */
export function describeError(error: unknown): string {
  if (error instanceof SettingsError) return error.message;
  if (error instanceof DecisionError) return `Decision operation failed (${error.code}${error.status ? `, HTTP ${error.status}` : ""})`;
  return "Context-decisions operation failed";
}

/** Largest dialog height for `SETTINGS_OVERLAY_OPTIONS` (70% maxHeight, one-row top/bottom margin). */
export function dialogHeightBudget(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(Math.floor(rows * 0.7), rows - 2));
}

export type AdvancedKey = Exclude<keyof RelevanceSettings, "pinned">;
export type AdvancedKind = "bool" | "options" | "int" | "decimal";
export interface AdvancedOption { value: string; description: string }
export interface AdvancedField {
  key: AdvancedKey;
  label: string;
  kind: AdvancedKind;
  hint: string;
  options?: readonly AdvancedOption[];
}
/**
 * Every relevance knob except `pinned`, which stays on the headless pin/unpin commands. The four picking
 * controls come first (threshold, shard size, max added per round, cadence); safety limits follow.
 */
export const ADVANCED_FIELDS: readonly AdvancedField[] = [
  { key: "enabled", label: "Skill filtering", kind: "bool", hint: "Turn relevance scoring of skill advertisements on or off. The master switch on the main screen also applies." },
  { key: "threshold", label: "Relevance threshold", kind: "decimal", hint: "0–1, inclusive. A skill is added when its relevance score is at least this. 0.375 is the default; 1 keeps only perfect scores." },
  { key: "chunkSize", label: "Shard size", kind: "int", hint: "1–50 skills per decision request; every shard of the remaining candidates is evaluated." },
  { key: "maxSkills", label: "Max added per round", kind: "int", hint: "0–1000 new skills added by one picking round, best first across all shards. Always-allowed and already-added skills do not count." },
  { key: "cadence", label: "Run picker", kind: "options", hint: "When the picker looks for more skills to add. Skills are only ever added, never removed.", options: [
    { value: "prompt", description: "On each submitted prompt, and for queued steering/follow-up messages (default)." },
    { value: "tool-round", description: "Also after each completed tool round: adds the next-best skills for the same task. No tool names, arguments or results are sent." },
  ] },
  { key: "failMode", label: "On failure", kind: "options", hint: "What happens when scoring fails.", options: [
    { value: "closed", description: "Add no new skills when scoring fails (default, recommended)." },
    { value: "open", description: "WARNING: every remaining skill is added when scoring fails." },
  ] },
  { key: "timeoutMs", label: "Timeout (ms)", kind: "int", hint: "1–300000 milliseconds for the whole scoring pass." },
  { key: "concurrency", label: "Concurrency", kind: "int", hint: "0–32. 0 sends every shard in parallel; 1–32 limits simultaneous shards." },
  { key: "minCandidates", label: "Minimum inventory", kind: "int", hint: "0–1000. Below this many skills, nothing is scored and every skill stays advertised." },
  { key: "maxPromptChars", label: "Prompt size (chars)", kind: "int", hint: "1–4000 characters of the task sent to the decision model." },
  { key: "maxDescriptionChars", label: "Description size (chars)", kind: "int", hint: "1–400 characters of each skill description sent." },
];
export function advancedField(key: string): AdvancedField | undefined { return ADVANCED_FIELDS.find((field) => field.key === key); }

export function advancedValueText(field: AdvancedField, settings: ContextDecisionsSettings): string {
  const value = settings.relevance[field.key];
  if (field.kind === "bool") return value ? "On" : "Off";
  if (field.key === "concurrency") return value === 0 ? "0 (all shards parallel)" : String(value);
  return String(value);
}

export interface RowDescription { id: string; label: string; value: string; description: string }
export function advancedRows(settings: ContextDecisionsSettings): RowDescription[] {
  return ADVANCED_FIELDS.map((field) => ({
    id: field.key, label: field.label, value: advancedValueText(field, settings), description: field.hint,
  }));
}

export function backendLabel(selection: ContextDecisionsSettings["backend"]): string {
  if (!selection) return "not configured";
  if (selection.backend === "pi") return `Pi internal · ${sanitizeTerminalText(selection.provider, 80)}`;
  return `${selection.backend} direct`;
}
export function modelLabel(selection: ContextDecisionsSettings["backend"]): string { return sanitizeTerminalText(selectionLabel(selection), 160); }

export interface MenuLayout { start: number; end: number }
/**
 * Pick the visible window [start, end) over rows of the given line heights so that the selected
 * row is always inside it. `previousStart` keeps scrolling stable between renders.
 */
export function layoutMenu(heights: readonly number[], selected: number, budget: number, previousStart = 0): MenuLayout {
  const count = heights.length;
  if (count === 0) return { start: 0, end: 0 };
  const pick = Math.min(Math.max(0, Math.floor(selected)), count - 1);
  const limit = Math.max(1, Math.floor(budget));
  const cost = (from: number, to: number) => { let total = 0; for (let i = from; i < to; i++) total += Math.max(1, heights[i]); return total; };
  let start = Math.min(Math.max(0, previousStart), pick);
  // Scroll down until the selected row fits (a row taller than the budget still counts as visible).
  while (start < pick && cost(start, pick + 1) > limit) start++;
  let end = pick + 1;
  while (end < count && cost(start, end + 1) <= limit) end++;
  // Fill leftover space above so the window uses the whole budget when scrolled past the top.
  while (start > 0 && cost(start - 1, end) <= limit) start--;
  return { start, end };
}
