import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The message Pi's own working row shows (braille spinner included) while a decision round is in flight. */
export const DECIDING_CONTEXT_LABEL = "Deciding Context";

/**
 * The two public Pi UI methods the working row needs. Both are TUI-only (documented no-ops in RPC) and
 * optional here so an older host or a minimal offline fake cannot break a decision round.
 */
export interface DecisionLoaderUi {
  setWorkingMessage?(message?: string): void;
  setWorkingVisible?(visible: boolean): void;
}
export interface DecisionLoaderContext {
  mode: ExtensionContext["mode"];
  ui: DecisionLoaderUi;
  /** `!isIdle()` means the agent run is streaming and the working row can actually be drawn. */
  isIdle?(): boolean;
}
function usable(ctx: DecisionLoaderContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui.setWorkingMessage === "function";
}
/**
 * Decision rounds overlap: the skill pass and the tool pass are both in flight during the same
 * `before_agent_start` window, and a lazy tool gate can run while a turn boundary scores. The loader is
 * therefore reference-counted: the first round to start sets the text, the last one to finish restores
 * Pi's default "Working" message. `finally` at every call site keeps the count balanced on error/abort.
 */
let active = 0;
let row: DecisionLoaderUi | undefined;

/** Show Pi's braille working spinner with `DECIDING_CONTEXT_LABEL`; no-op outside the TUI. */
export function beginDecisionLoader(ctx: DecisionLoaderContext): void {
  if (!usable(ctx)) return;
  active += 1;
  if (active > 1) return;
  row = ctx.ui;
  try {
    row.setWorkingMessage?.(DECIDING_CONTEXT_LABEL);
    // The working row is only drawn while the run streams; during `before_agent_start` the run is already
    // active but Pi shows the row at `turn_start`, so the prompt-time pass needs this to appear early.
    // Never turned off again: Pi exposes no getter for the previous value, and hiding the row would stick.
    if (ctx.isIdle?.() === false) row.setWorkingVisible?.(true);
  } catch { /* purely cosmetic: a UI failure must never break a decision round */ }
}

/** Release one earlier `beginDecisionLoader`; the last release restores Pi's default working message. */
export function endDecisionLoader(): void {
  if (active === 0) return; // an unmatched release is ignored, never a negative count
  active -= 1;
  if (active > 0) return;
  const ui = row;
  row = undefined;
  try { ui?.setWorkingMessage?.(undefined); } // no argument restores the default; keeps no reference to a dead session
  catch { /* the session may already be gone; the working message must never break a run */ }
}

/** Drops retained state: called on session lifecycle changes and between offline test cases. */
export function resetDecisionLoader(): void {
  active = 0;
  row = undefined;
}
