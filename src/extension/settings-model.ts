import { SUBAGENT_HELP } from "./subagent-manager.ts";
// Pure data and layout helpers for the floating /decisions dialog.
// No Pi or pi-tui imports: everything here is unit-testable without a terminal.
import { DecisionError } from "../decision/errors.ts";
import { SettingsError, type ContextDecisionsSettings, type IconStyle, type RelevanceSettings, type DecisionSettings, type ToolFilterSettings } from "../settings.ts";
import { selectionLabel } from "./contracts.ts";
import { FOOTER_ICONS } from "./footer-status.ts";

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
export type ToolKey = Exclude<keyof ToolFilterSettings, "alwaysAllowedTools" | "alwaysAllowedMcpServers">;
/** Shared scoring (decision), skill policy (relevance), tool policy (tools) or the top-level shared display settings (`general`, e.g. `iconStyle`). */
export type SettingsGroup = "relevance" | "tools" | "decision" | "general";
export type GeneralKey = "iconStyle";
/** The settings key `ContextDecisionsSettings`/`updateSetting` use for a field: `relevance.x`, `tools.x`, `decision.x`, or the bare top-level key. */
export const settingKey = (group: SettingsGroup, key: string): string => group === "general" ? key : `${group}.${key}`;
export type AdvancedKind = "bool" | "options" | "int" | "decimal";
/** `label` is what the user sees (defaults to `value`, which stays the persisted token). */
export interface AdvancedOption { value: string; description: string; label?: string }
export interface AdvancedField {
  key: AdvancedKey | ToolKey | keyof DecisionSettings | GeneralKey;
  group: SettingsGroup;
  label: string;
  kind: AdvancedKind;
  hint: string;
  options?: readonly AdvancedOption[];
}
/**
 * Field metadata is shared by terminal and RPC menus. Feature policy stays separate; tuning belongs to decision.*.
 */
const RELEVANCE_FIELDS: readonly AdvancedField[] = [
  { key: "enabled", group: "relevance", label: "Skill filtering", kind: "bool", hint: "Turn skill advertisement filtering on or off, independently of tool and MCP filtering." },
  { key: "threshold", group: "decision", label: "Relevance threshold", kind: "decimal", hint: "0–1, inclusive. Skills, tools and groups qualify at or above this score. 0.375 is the default; 1 keeps only perfect scores." },
  { key: "chunkSize", group: "decision", label: "Shard size", kind: "int", hint: "1–50 candidates per decision request; every shard of the remaining candidates is evaluated." },
  { key: "maxSkills", group: "relevance", label: "Skills · Max added per round", kind: "int", hint: "0–1000 new skills added by one picking round, best first across all shards. Always-allowed and already-added skills do not count." },
  { key: "cadence", group: "relevance", label: "Run picker", kind: "options", hint: "When the picker looks for more skills to add. Skills are only ever added, never removed.", options: [
    { value: "prompt", description: "On each submitted prompt, and for queued steering/follow-up messages (default)." },
    { value: "tool-round", description: "Also after each completed tool round: adds the next-best skills for the same task. No tool names, arguments or results are sent." },
  ] },
  { key: "failMode", group: "decision", label: "On failure", kind: "options", hint: "Shared failure policy for skill and tool picking; configuration errors and aborts always fail closed.", options: [
    { value: "closed", description: "Add no new skills, tools or groups when scoring fails (default, recommended)." },
    { value: "open", description: "WARNING: every remaining skill, tool or group is added when scoring fails. Applies framework-wide." },
  ] },
  { key: "timeoutMs", group: "decision", label: "Timeout (ms)", kind: "int", hint: "1–300000 milliseconds for the whole scoring pass." },
  { key: "concurrency", group: "decision", label: "Concurrency", kind: "int", hint: "0–32. 0 sends every shard in parallel; 1–32 limits simultaneous shards." },
  { key: "minCandidates", group: "relevance", label: "Skills · Minimum inventory", kind: "int", hint: "0–1000. Below this many skills, nothing is scored and every skill stays advertised." },
  { key: "maxPromptChars", group: "decision", label: "Prompt size (chars)", kind: "int", hint: "1–4000 characters of the task sent to the decision model." },
  { key: "maxDescriptionChars", group: "decision", label: "Description size (chars)", kind: "int", hint: "1–400 characters of each candidate description sent." },
];
export function advancedField(key: string): AdvancedField | undefined { return RELEVANCE_FIELDS.find((field) => field.key === key); }
/**
 * Opt-in tool and MCP filtering (default off), independent of skills; all scoring tuning is shared.
 */
const ALL_TOOL_FIELDS: readonly AdvancedField[] = [
  { key: "allowSubagentInheritedTools", group: "tools", label: "Subagents · Allow inherited tools", kind: "bool", hint: SUBAGENT_HELP },
  { key: "enabled", group: "tools", label: "Tool filtering", kind: "bool", hint: "Off by default and independent of skill filtering. When on, external tools, MCP servers or extensions are made available per prompt by the decision model; Pi's built-in tools are never filtered. Calls to unavailable tools are blocked. This is not a sandbox." },
  { key: "mode", group: "tools", label: "Mode", kind: "options", hint: "What is decided.", options: [
    { value: "tools", description: "Every external tool is decided on its own, whichever MCP server or extension it comes from (default)." },
    { value: "mcp", description: "Groups are decided as a whole: every MCP server and every extension (all its tools together) is on or off. Extension tools without public provenance are never filtered." },
  ] },
  { key: "cadence", group: "tools", label: "Run picker", kind: "options", hint: "When more tools, servers or extensions are added. They are only ever added, never removed.", options: [
    { value: "initial", description: "Pick once from your first prompt; later tools are scored against that first prompt only." },
    { value: "prompt", description: "On each new user prompt, including queued steering/follow-up messages (default)." },
    { value: "tool-round", description: "Also after each completed tool round: adds the next-best candidates for the same task from cached scores. The decision model only ever receives your bounded user text plus tool/server names and descriptions; never arguments, results or assistant text." },
  ] },
  { key: "maxAdded", group: "tools", label: "Tools · Max added per round", kind: "int", hint: "0–1000 new tools (or whole servers/extensions in group mode) per round, best first. Separate from skill advertisements; allowlisted and already-available ones do not count." },
  { key: "minCandidates", group: "tools", label: "Tools · Minimum candidates", kind: "int", hint: "0–1000. Tool gating starts at zero by default. Below this inventory size, no scoring and every tool stays available." },
];
export const SKILL_FIELDS = RELEVANCE_FIELDS.filter((field) => field.key === "enabled" || field.key === "cadence");
export const TOOL_FIELDS = ALL_TOOL_FIELDS.filter((field) => ["enabled", "mode", "cadence"].includes(field.key));
export const ADVANCED_FIELDS = [
  ...RELEVANCE_FIELDS.filter((field) => !SKILL_FIELDS.includes(field)),
  ...ALL_TOOL_FIELDS.filter((field) => !TOOL_FIELDS.includes(field)),
];
/** Resolve display metadata from the current snapshot, never mutating field definitions or policy. */
export function fieldForSettings(field: AdvancedField, settings: ContextDecisionsSettings): AdvancedField {
  if (field.group !== "tools" || settings.tools.mode !== "mcp") return field;
  if (field.key === "maxAdded") return { ...field, label: "MCP/exts · Max added per round", hint: "0–1000 new MCP servers or extensions per round, best first. Each whole group counts once; allowlisted and already-available groups do not count." };
  if (field.key === "minCandidates") return { ...field, label: "MCP/exts · Minimum candidates", hint: "0–1000 MCP servers or extensions. Gating starts at zero by default. Below this many groups, no scoring and every tool stays available." };
  return field;
}
export function fieldFor(group: SettingsGroup, key: string, settings: ContextDecisionsSettings): AdvancedField | undefined {
  const field = [...SKILL_FIELDS, ...TOOL_FIELDS, ...ADVANCED_FIELDS, ...GENERAL_FIELDS].find((field) => field.group === group && field.key === key);
  return field && fieldForSettings(field, settings);
}
export function fieldValue(settings: ContextDecisionsSettings, group: SettingsGroup, key: string): unknown {
  return ((group === "general" ? settings : settings[group]) as unknown as Record<string, unknown>)[key];
}
/** Illustrative preview taken from the footer's own glyph table, so the picker can never drift from what is printed. */
const iconPreview = (style: IconStyle): string => { const icons = FOOTER_ICONS[style]; return `${icons.decisions} ${icons.skills} ${icons.tools}`; };
/**
 * Shared, non-filtering display settings (top-level `iconStyle`). Offered on the Advanced tab (and the RPC Advanced menu), next to the
 * other settings shared by both pipelines; deliberately not part of `ADVANCED_FIELDS`, which stays the decision/policy tuning list.
 */
export const GENERAL_FIELDS: readonly AdvancedField[] = [
  { key: "iconStyle", group: "general", label: "Footer icons", kind: "options", hint: "Icon set in the compact status footer (extension, skills, tools). Unicode works in regular terminal fonts, Emoji needs colour emoji support, Nerd Font needs a Nerd Font as the terminal font.", options: [
    { value: "unicode", label: `ASCII / Unicode  ${iconPreview("unicode")}`, description: "Plain Unicode symbols; no patched font needed (default). A few fonts may lack some glyphs." },
    { value: "emoji", label: `Emoji  ${iconPreview("emoji")}`, description: "Colour emoji. Needs a terminal and font with emoji support; glyph width can vary between terminals." },
    { value: "nerd", label: `Nerd Font  ${iconPreview("nerd")}`, description: "Requires a Nerd Font (nerdfonts.com) as the terminal font; without one these glyphs show as empty boxes. Pick another set if so." },
  ] },
];
export const ICON_STYLE_LABELS: Readonly<Record<IconStyle, string>> = { unicode: "ASCII / Unicode", emoji: "Emoji", nerd: "Nerd Font" };
/** Short plain-text name of the current footer icon set (no glyphs: it is reused in menus where the font is unknown). */
export function iconStyleText(settings: ContextDecisionsSettings): string { return ICON_STYLE_LABELS[settings.iconStyle] ?? "ASCII / Unicode"; }
export function toolsSummary(settings: ContextDecisionsSettings): string { return settings.tools.enabled ? `On · ${settings.tools.mode} · ${settings.tools.cadence}` : "Off"; }

export function advancedValueText(field: AdvancedField, settings: ContextDecisionsSettings): string {
  const value = fieldValue(settings, field.group, field.key);
  if (field.kind === "bool") return value ? "On" : "Off";
  if (field.key === "concurrency") return value === 0 ? "0 (all shards parallel)" : String(value);
  return String(value);
}

export interface RowDescription { id: string; label: string; value: string; description: string }
export function advancedRows(settings: ContextDecisionsSettings): RowDescription[] {
  return ADVANCED_FIELDS.map((field) => fieldForSettings(field, settings)).map((field) => ({
    id: `${field.group}.${field.key}`, label: field.label, value: advancedValueText(field, settings), description: field.hint,
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
