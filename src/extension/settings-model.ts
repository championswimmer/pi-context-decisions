// Pure data and layout helpers for /decisions views and overlays.
// No Pi or pi-tui imports: everything here is unit-testable without a terminal.
import { DecisionError } from "../decision/errors.ts";
import { ICON_STYLE_LABELS, SettingsError, type ContextDecisionsSettings } from "../settings.ts";
import { selectionLabel } from "./contracts.ts";

export { ICON_STYLE_LABELS };

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

/** Largest dialog height for 70% maxHeight overlays with one-row top/bottom margin. */
export function dialogHeightBudget(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(Math.floor(rows * 0.7), rows - 2));
}

/** Short plain-text name of the current footer icon set (no glyphs: it is reused in menus where the font is unknown). */
export function iconStyleText(settings: ContextDecisionsSettings): string {
  return ICON_STYLE_LABELS[settings.iconStyle] ?? "ASCII / Unicode";
}

export function toolsSummary(settings: ContextDecisionsSettings): string {
  return settings.tools.enabled ? `On · ${settings.tools.mode} · ${settings.tools.cadence}` : "Off";
}

export function backendLabel(selection: ContextDecisionsSettings["backend"]): string {
  if (!selection) return "not configured";
  if (selection.backend === "pi") return `Pi internal · ${sanitizeTerminalText(selection.provider, 80)}`;
  return `${selection.backend} direct`;
}

export function modelLabel(selection: ContextDecisionsSettings["backend"]): string {
  return sanitizeTerminalText(selectionLabel(selection), 160);
}

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
  const cost = (from: number, to: number) => {
    let total = 0;
    for (let i = from; i < to; i++) total += Math.max(1, heights[i]);
    return total;
  };
  let start = Math.min(Math.max(0, previousStart), pick);
  // Scroll down until the selected row fits (a row taller than the budget still counts as visible).
  while (start < pick && cost(start, pick + 1) > limit) start++;
  let end = pick + 1;
  while (end < count && cost(start, end + 1) <= limit) end++;
  // Fill leftover space above so the window uses the whole budget when scrolled past the top.
  while (start > 0 && cost(start - 1, end) <= limit) start--;
  return { start, end };
}
