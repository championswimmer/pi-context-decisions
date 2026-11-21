// Standalone read-only `/decisions history` overlay: one overlay with a two-level
// internal route stack (`history` turn list -> `history-batch` scrollable turn details).
// Close only through `done`, exactly once.
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type OverlayHandle,
  type OverlayOptions,
} from "@earendil-works/pi-tui";
import type { CommandContext } from "./contracts.ts";
import {
  HISTORY_NOTE,
  historyTurnLines,
  historyTurnSummary,
  historyTurnTitle,
  type DecisionsHistory,
  type HistoryTurn,
} from "./decisions-history.ts";
import { describeError, dialogHeightBudget, layoutMenu, sanitizeTerminalText } from "./settings-model.ts";

/** Percent sizes are resolved by Pi on every render; the options object itself is read once. */
export const HISTORY_OVERLAY_OPTIONS = {
  anchor: "top-center",
  width: "70%",
  minWidth: 46,
  maxHeight: "70%",
  margin: { top: 1, right: 1, bottom: 1, left: 1 },
} as const satisfies OverlayOptions;

export type HistoryDialogResult = "closed" | "shutdown";

export interface HistoryDialogTui {
  requestRender(): void;
  terminal?: { readonly rows: number };
}

export type HistoryDialogTheme = Pick<Theme, "fg" | "bg">;

export type HistoryDialogComponent = Component & Focusable & {
  dispose(): void;
  close(result: HistoryDialogResult): void;
  refresh(): void;
  isClosed(): boolean;
};

export interface HistoryDialogOptions {
  onClose?: () => void;
}

type HistoryRoute = { kind: "history" } | { kind: "history-batch"; turn: HistoryTurn };

interface Banner {
  text: string;
  tone: "info" | "error";
}

interface Item {
  label: string;
  description?: string;
  disabled?: string;
  run(): void;
}

interface Frame {
  route: HistoryRoute;
  selected: number;
  offset: number;
  scroll: number;
  loading: boolean;
  op?: AbortController;
  banner?: Banner;
  history?: DecisionsHistory;
  lines?: string[];
}

export function createHistoryDialogComponent(
  tui: HistoryDialogTui,
  theme: HistoryDialogTheme,
  done: (result: HistoryDialogResult) => void,
  loadHistory: (signal: AbortSignal) => Promise<DecisionsHistory>,
  options: HistoryDialogOptions = {},
): HistoryDialogComponent {
  const lifetime = new AbortController();
  const stack: Frame[] = [];
  let closed = false;
  let focused = false;
  const kb = () => getKeybindings();
  const redraw = () => { if (!closed) tui.requestRender(); };
  const top = (): Frame | undefined => stack[stack.length - 1];

  const newFrame = (route: HistoryRoute): Frame => ({
    route,
    selected: 0,
    offset: 0,
    scroll: 0,
    loading: false,
  });

  const leave = (frame: Frame) => {
    frame.op?.abort();
    frame.op = undefined;
    frame.loading = false;
  };

  const markClosed = () => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    lifetime.abort();
    while (stack.length) leave(stack.pop()!);
  };

  const close = (result: HistoryDialogResult) => {
    if (closed) return;
    markClosed();
    done(result);
  };

  const load = (frame: Frame) => {
    frame.op?.abort();
    const controller = new AbortController();
    frame.op = controller;
    frame.loading = true;
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const settle = (change: () => void) => {
      if (closed || frame.op !== controller || signal.aborted) return;
      frame.op = undefined;
      frame.loading = false;
      change();
      redraw();
    };
    (async () => loadHistory(signal))().then(
      (history) => settle(() => {
        frame.history = history;
        frame.selected = 0;
        frame.offset = 0;
      }),
      (error) => settle(() => {
        frame.banner = { text: describeError(error), tone: "error" };
      }),
    );
  };

  const enter = (frame: Frame) => {
    if (frame.route.kind === "history") {
      load(frame);
    } else {
      frame.lines = historyTurnLines(frame.route.turn);
      frame.scroll = 0;
    }
  };

  const push = (route: HistoryRoute) => {
    if (closed) return;
    const frame = newFrame(route);
    stack.push(frame);
    enter(frame);
    redraw();
  };

  const pop = () => {
    const frame = stack.pop();
    if (frame) leave(frame);
    if (!stack.length) {
      close("closed");
      return;
    }
    redraw();
  };

  const refresh = () => {
    if (closed) return;
    while (stack.length > 1) leave(stack.pop()!);
    if (!stack.length) {
      push({ kind: "history" });
      return;
    }
    const root = stack[0];
    root.banner = undefined;
    enter(root);
    redraw();
  };

  const itemsFor = (frame: Frame): Item[] => {
    if (frame.route.kind !== "history") return [];
    if (!frame.history) {
      return [{
        label: frame.loading ? "Reading committed branch…" : "History unavailable",
        disabled: "Ctrl+R retries reading the active branch. No decision calls are made.",
        run: () => {},
      }];
    }
    if (!frame.history.turns.length) {
      return [{
        label: "No committed additions on this branch",
        disabled: "Empty turns are omitted. Ctrl+R refreshes the committed branch snapshot.",
        run: () => {},
      }];
    }
    return [...frame.history.turns].reverse().map((turn) => ({
      label: `${historyTurnTitle(turn)}: (${historyTurnSummary(turn)})`,
      description: HISTORY_NOTE,
      run: () => push({ kind: "history-batch", turn }),
    }));
  };

  const crumb = (frame: Frame): string =>
    frame.route.kind === "history"
      ? "Decisions › History"
      : `Decisions › History › ${historyTurnTitle(frame.route.turn)}`;

  const hint = (frame: Frame): string =>
    frame.route.kind === "history"
      ? "↑↓ turn · Enter expand · Ctrl+R refresh · Esc close"
      : "↑↓ / PgUp/PgDn scroll · Home/End · Esc back";

  const wrap = (text: string, width: number, limit: number): string[] =>
    wrapTextWithAnsi(sanitizeTerminalText(text, 1200), Math.max(1, width)).slice(0, Math.max(0, limit));

  const bannerLines = (frame: Frame, width: number): string[] => {
    if (!frame.banner) return [];
    const color = frame.banner.tone === "error" ? "error" : "warning";
    return wrap(frame.banner.text, width, 4).map((line) => theme.fg(color, line));
  };

  const borderLine = (left: string, right: string, label: string, tag: string, width: number): string => {
    const inner = width - 2;
    let tagText = tag ? ` ${tag} ` : "";
    if (visibleWidth(tagText) > inner - 6) tagText = "";
    const labelText = truncateToWidth(` ${label} `, Math.max(0, inner - 1 - visibleWidth(tagText)), "…");
    const fill = Math.max(0, inner - 1 - visibleWidth(labelText) - visibleWidth(tagText));
    return theme.fg("border", `${left}─`) + theme.fg("accent", labelText) + theme.fg("border", "─".repeat(fill)) + theme.fg("warning", tagText) + theme.fg("border", right);
  };

  const bottomLine = (label: string, width: number): string => {
    const inner = width - 2;
    const text = truncateToWidth(` ${label} `, Math.max(0, inner - 1), "…");
    return theme.fg("border", "╰─") + theme.fg("dim", text) + theme.fg("border", "─".repeat(Math.max(0, inner - 1 - visibleWidth(text))) + "╯");
  };

  const bodyLine = (text: string, inner: number): string =>
    theme.fg("border", "│") + " " + truncateToWidth(text, inner, "…", true) + " " + theme.fg("border", "│");

  const fit = (budget: number, sections: { lines: string[]; min: number }[]): string[] => {
    const taken = sections.map(() => 0);
    let remaining = Math.max(0, budget);
    for (let i = 0; i < sections.length; i++) {
      const take = Math.min(sections[i].min, sections[i].lines.length, remaining);
      taken[i] = take;
      remaining -= take;
    }
    for (let i = 0; i < sections.length; i++) {
      const take = Math.min(sections[i].lines.length - taken[i], remaining);
      taken[i] += take;
      remaining -= take;
    }
    return sections.flatMap((section, i) => section.lines.slice(0, taken[i]));
  };

  const listBody = (frame: Frame, inner: number, bodyBudget: number): string[] => {
    const items = itemsFor(frame);
    frame.selected = Math.min(Math.max(0, frame.selected), Math.max(0, items.length - 1));
    const selected = items[frame.selected];
    const rowLabelCol = Math.max(1, inner - 2);
    const row = (item: Item, index: number): string => {
      const mark = index === frame.selected ? "❯" : " ";
      const line = truncateToWidth(`${mark} ${truncateToWidth(sanitizeTerminalText(item.label, 120), rowLabelCol, "…", true)}`, inner, "…");
      return index === frame.selected ? theme.fg("accent", line) : item.disabled ? theme.fg("dim", line) : line;
    };
    const banner = bannerLines(frame, inner);
    const bannerCount = banner.length ? Math.min(banner.length, Math.max(1, Math.min(4, bodyBudget - 1))) : 0;
    const descSource = selected?.disabled ?? selected?.description ?? "";
    const spare = bodyBudget - bannerCount - items.length;
    const wantDesc = bodyBudget >= 8 && descSource && spare >= 1 ? Math.min(2, spare) : 0;
    const descLines = wantDesc === 0
      ? []
      : wantDesc === 1
        ? [theme.fg("muted", truncateToWidth(sanitizeTerminalText(descSource, 1200), inner, "…"))]
        : wrap(descSource, inner, 2).map((line) => theme.fg("muted", line));
    const descCount = Math.min(descLines.length, Math.max(0, bodyBudget - 1 - bannerCount));
    const listBudget = Math.max(1, bodyBudget - bannerCount - descCount);
    const layout = layoutMenu(items.map(() => 1), frame.selected, listBudget, frame.offset);
    frame.offset = layout.start;
    const rows = items.slice(layout.start, layout.end).map((item, i) => row(item, layout.start + i));
    if (!items.length) rows.push(theme.fg("muted", "Nothing to show"));
    return [...rows, ...descLines.slice(0, descCount), ...banner.slice(0, bannerCount)];
  };

  const component: HistoryDialogComponent = {
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; },
    isClosed: () => closed,
    close,
    refresh,
    dispose() { markClosed(); },
    invalidate() {},
    render(width: number): string[] {
      const w = Math.max(1, Math.floor(width));
      const frame = top();
      if (closed || !frame) return [];
      const budget = dialogHeightBudget(tui.terminal?.rows);
      const tag = frame.loading ? "loading…" : "";
      if (w < 8 || budget < 3) {
        const items = itemsFor(frame);
        const line = items[Math.min(frame.selected, items.length - 1)]?.label ?? crumb(frame);
        return [truncateToWidth(`${tag ? `${tag} ` : ""}${sanitizeTerminalText(line, 200)}`, w, "…", true)];
      }
      const inner = w - 4;
      const bodyBudget = budget - 2;
      let body: string[];
      if (frame.route.kind === "history-batch") {
        const banner = bannerLines(frame, inner);
        const lines = frame.lines ? frame.lines.flatMap((line) => wrapTextWithAnsi(line, inner)) : [theme.fg("muted", "Nothing to show")];
        const room = Math.max(1, bodyBudget - Math.min(banner.length, Math.max(0, bodyBudget - 1)));
        frame.scroll = Math.min(Math.max(0, frame.scroll), Math.max(0, lines.length - room));
        body = fit(bodyBudget, [{ lines: lines.slice(frame.scroll, frame.scroll + room), min: 1 }, { lines: banner, min: 1 }]);
      } else {
        body = listBody(frame, inner, bodyBudget);
      }
      body = body.slice(0, bodyBudget);
      return [borderLine("╭", "╮", crumb(frame), tag, w), ...body.map((line) => bodyLine(line, inner)), bottomLine(hint(frame), w)];
    },
    handleInput(data: string) {
      if (closed) return;
      const frame = top();
      if (!frame) return;
      const keys = kb();
      if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
        if (stack.length > 1) pop();
        else close("closed");
        return;
      }
      if (frame.route.kind === "history" && matchesKey(data, "ctrl+r")) {
        frame.banner = undefined;
        enter(frame);
        redraw();
        return;
      }
      if (frame.route.kind === "history-batch") {
        if (keys.matches(data, "tui.select.up")) frame.scroll = Math.max(0, frame.scroll - 1);
        else if (keys.matches(data, "tui.select.down")) frame.scroll += 1;
        else if (keys.matches(data, "tui.select.pageUp")) frame.scroll = Math.max(0, frame.scroll - 5);
        else if (keys.matches(data, "tui.select.pageDown")) frame.scroll += 5;
        else if (matchesKey(data, "home")) frame.scroll = 0;
        else if (matchesKey(data, "end")) frame.scroll = Number.MAX_SAFE_INTEGER;
        else return;
        redraw();
        return;
      }
      const items = itemsFor(frame);
      if (!items.length) return;
      if (keys.matches(data, "tui.select.up")) frame.selected = Math.max(0, frame.selected - 1);
      else if (keys.matches(data, "tui.select.down")) frame.selected = Math.min(items.length - 1, frame.selected + 1);
      else if (keys.matches(data, "tui.select.pageUp")) frame.selected = Math.max(0, frame.selected - 5);
      else if (keys.matches(data, "tui.select.pageDown")) frame.selected = Math.min(items.length - 1, frame.selected + 5);
      else if (keys.matches(data, "tui.select.confirm") || matchesKey(data, "return")) {
        const item = items[Math.min(frame.selected, items.length - 1)];
        if (item.disabled) frame.banner = { text: item.disabled, tone: "info" };
        else {
          frame.banner = undefined;
          item.run();
        }
      } else return;
      redraw();
    },
  };

  push({ kind: "history" });
  return component;
}

export interface HistoryDialogLife {
  isOpen(): boolean;
}

export interface HistoryDialogManager {
  open(
    ctx: Pick<CommandContext, "ui">,
    makeLoader: (life: HistoryDialogLife) => (signal: AbortSignal) => Promise<DecisionsHistory>,
  ): Promise<HistoryDialogResult | "focused-existing">;
  /** Idempotent and synchronous: resolves any pending `open` with "shutdown" and aborts in-flight loads. */
  closeAll(): void;
  isOpen(): boolean;
}

export function createHistoryDialogManager(): HistoryDialogManager {
  let active: { component: HistoryDialogComponent; handle?: OverlayHandle } | undefined;
  let opening = false;
  let closeRequested = false;

  return {
    async open(ctx, makeLoader) {
      if (active || opening) {
        active?.component.refresh();
        try { active?.handle?.focus(); } catch { /* handle may belong to a disposed overlay */ }
        return "focused-existing";
      }
      const custom = ctx.ui.custom;
      if (!custom) throw new Error("Terminal custom UI is unavailable");
      opening = true;
      closeRequested = false;
      const life = { closed: false };
      try {
        const loader = makeLoader({ isOpen: () => !life.closed });
        return await custom.call(
          ctx.ui,
          (tui, theme, _keys, done) => {
            const component = createHistoryDialogComponent(tui, theme, done, loader, {
              onClose: () => { life.closed = true; },
            });
            active = { component };
            opening = false;
            if (closeRequested) queueMicrotask(() => component.close("shutdown"));
            return component;
          },
          {
            overlay: true,
            overlayOptions: HISTORY_OVERLAY_OPTIONS,
            onHandle: (handle) => { if (active) active.handle = handle; },
          },
        ) as HistoryDialogResult;
      } finally {
        active = undefined;
        opening = false;
        life.closed = true;
      }
    },
    closeAll() {
      if (active) active.component.close("shutdown");
      else if (opening) closeRequested = true;
    },
    isOpen: () => !!active || opening,
  };
}
