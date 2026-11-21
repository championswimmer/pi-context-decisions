// Drives the REAL settings paths through the RPC select/input fallback and TUI overlay of `/decisions`.
// `/decisions` has no setter subcommands (the dialog owns every setting), so tests that need a
// settings change use this instead of typing a command. It goes through the real `openSettingsDialog`
// flow (`pi-extension-settings-tui`), including validation, persistence, cancellation and generation bumps.
import { getKeybindings } from "@earendil-works/pi-tui";
import type { CommandContext } from "../../src/extension/contracts.ts";

type Run = (args: string, ctx: CommandContext) => Promise<void>;

/**
 * A context that behaves like an RPC client: reads fall through to `ctx`, but select/input are scripted. `cwd` is dropped so the
 * menu does not read the project allowlist (a gated test read would otherwise deadlock the settings change under test).
 */
export function rpcContext(ctx: CommandContext, ui: Record<string, unknown>): CommandContext {
  return Object.create(ctx, {
    hasUI: { value: true },
    mode: { value: "rpc" },
    cwd: { value: undefined },
    ui: { value: { ...ctx.ui, custom: undefined, setStatus() {}, ...ui } },
  }) as CommandContext;
}

type FieldKind = "boolean" | "enum" | "number";
interface FieldTarget {
  labels: readonly string[];
  kind: FieldKind;
  enumMap?: Readonly<Record<string, string>>;
}

const LEGACY_FIELD_MAP: Readonly<Record<string, FieldTarget>> = {
  enabled: { labels: ["Skill filtering"], kind: "boolean" },
  "relevance.enabled": { labels: ["Skill filtering"], kind: "boolean" },
  "relevance.maxSkills": { labels: ["Skills · Max added per round"], kind: "number" },
  "relevance.minCandidates": { labels: ["Skills · Minimum inventory"], kind: "number" },
  "relevance.constantMatrix": { labels: ["Skills · Constant scoring matrix"], kind: "boolean" },
  "tools.enabled": { labels: ["Tool filtering"], kind: "boolean" },
  "tools.mode": { labels: ["Mode"], kind: "enum" },
  "tools.cadence": { labels: ["Run picker"], kind: "enum" },
  "tools.maxAdded": { labels: ["Tools · Max added per round", "MCP/exts · Max added per round"], kind: "number" },
  "tools.minCandidates": { labels: ["Tools · Minimum candidates", "MCP/exts · Minimum candidates"], kind: "number" },
  "tools.allowSubagentInheritedTools": { labels: ["Subagents · Allow inherited tools"], kind: "boolean" },
  "decision.threshold": { labels: ["Relevance threshold"], kind: "number" },
  "decision.failMode": { labels: ["On failure"], kind: "enum" },
  "decision.chunkSize": { labels: ["Shard size"], kind: "number" },
  "decision.concurrency": { labels: ["Concurrency"], kind: "number" },
  "decision.timeoutMs": { labels: ["Timeout"], kind: "number" },
  "decision.maxPromptChars": { labels: ["Prompt size"], kind: "number" },
  "decision.maxDescriptionChars": { labels: ["Description size"], kind: "number" },
  iconStyle: {
    labels: ["Footer icons"],
    kind: "enum",
    enumMap: { unicode: "ASCII / Unicode", emoji: "Emoji", nerd: "Nerd Font" },
  },
  "history.enabled": { labels: ["Past turn summaries · Enabled"], kind: "boolean" },
};

/**
 * Change one setting (`enabled`, `relevance.<key>`, `tools.<key>`, `decision.<key>`, `iconStyle`, `history.enabled`)
 * through the real `openSettingsDialog` RPC menu. Boolean rows without an explicit `"true"`/`"false"` value toggle.
 * Invalid values are reported by the RPC menu and left unsaved, matching user interaction.
 */
export async function setSetting(run: Run, ctx: CommandContext, key: string, value = ""): Promise<void> {
  const target = LEGACY_FIELD_MAP[key];
  if (!target) throw new Error(`Unknown setting key in test helper: ${key}`);
  let pickedRow = false;
  let currentBool: boolean | undefined;
  let inputSent = false;

  await run("", rpcContext(ctx, {
    async select(title: string, options: string[]) {
      if (title === "Context Decisions Settings") {
        if (pickedRow) return "Done";
        pickedRow = true;
        const match = options.find((option) =>
          target.labels.some((label) => {
            const idx = option.indexOf(`] ${label}:`);
            return idx >= 0 || option.startsWith(`${label}:`);
          }),
        );
        if (!match) return "Done";
        if (target.kind === "boolean") {
          const afterColon = match.slice(match.indexOf(":") + 1).trim();
          currentBool = afterColon.startsWith("On") || afterColon.startsWith("Enabled") || afterColon.startsWith("true");
        }
        return match;
      }
      if (target.kind === "boolean") {
        if (value === "true" || value === "On" || value === "Enabled") return options[0];
        if (value === "false" || value === "Off" || value === "Disabled") return options[1];
        return currentBool ? options[1] : options[0];
      }
      if (target.kind === "enum") {
        const mapped = target.enumMap?.[value] ?? value;
        return options.find(
          (option) =>
            option === mapped ||
            option.startsWith(`${mapped} —`) ||
            option.startsWith(`${mapped}  `),
        );
      }
      return undefined;
    },
    async input() {
      if (inputSent) return undefined;
      inputSent = true;
      return value;
    },
  }));
}

/** Choose a shared backend via the real `openSettingsDialog` RPC `field.picker` menu. */
export async function setModel(run: Run, ctx: CommandContext, label: string): Promise<void> {
  let openedPicker = false;
  let pickerAsked = false;

  await run("", rpcContext(ctx, {
    async select(title: string, options: string[]) {
      if (title === "Context Decisions Settings") {
        if (openedPicker) return "Done";
        openedPicker = true;
        return options.find((option) => option.includes("] Decision model:") || option.startsWith("Decision model:")) ?? "Done";
      }
      if (title === "Decision model") {
        if (pickerAsked) return undefined;
        pickerAsked = true;
        if (label === "none") {
          return options.find((option) => option.startsWith("Not configured —"));
        }
        // Match exact `selectionLabel` embedded in the option description (e.g. `Pi custom/nested/model`, `openrouter direct typesafe/jev-1.13`).
        const exact = new RegExp(`— ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$| —| \\(| \\[)`);
        return options.find((option) => exact.test(option));
      }
      return undefined;
    },
    async input() {
      return undefined;
    },
  }));
}

const ROW_LABEL_ALIASES: Readonly<Record<string, string>> = {
  "Always allowed · Global": "Global always-allowed skills",
  "Always allowed · Project": "Project always-allowed skills",
  "Always allowed tools · Global": "Global always-allowed tools",
  "Always allowed tools · Project": "Project always-allowed tools",
  "Always allowed MCP servers & extensions · Global": "Global always-allowed MCP / extensions",
  "Always allowed MCP servers & extensions · Project": "Project always-allowed MCP / extensions",
};

const KEY = { down: "\x1b[B", enter: "\r", esc: "\x1b", save: "\x13", tab: "\t", space: " " };
const theme = {
  fg: (_token: unknown, value: string) => value,
  bg: (_token: unknown, value: string) => value,
  bold: (value: string) => value,
};
interface DialogComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
}
const until = async (component: DialogComponent, pattern: RegExp, width = 120): Promise<string> => {
  const deadline = Date.now() + 2000;
  for (;;) {
    const text = component.render(width).join("\n");
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}; last render:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/**
 * Edit one allowlist inside the REAL terminal dialog (`openSettingsDialog` -> `field.external` subroute)
 * and save it with Ctrl+S, the dialog's only save path for allowlists.
 * `tab` is the root tab the row lives on; `row` is its label (accepts both v5 and legacy v4 labels);
 * `toggle` names one entry to flip (found with the editor's local search), or is omitted to save unchanged.
 */
export async function saveAllowlist(
  run: Run,
  ctx: CommandContext,
  options: { tab: "skills" | "tools"; row: string; toggle?: string },
): Promise<void> {
  const rowLabel = ROW_LABEL_ALIASES[options.row] ?? options.row;
  const escapedRow = rowLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tui = Object.create(ctx, {
    hasUI: { value: true },
    mode: { value: "tui" },
    ui: {
      value: {
        ...ctx.ui,
        setStatus() {},
        async custom(factory: (...args: unknown[]) => unknown) {
          let settle!: (value: unknown) => void;
          const result = new Promise((resolve) => { settle = resolve; });
          const component = (await factory(
            { requestRender() {}, terminal: { rows: 40 } },
            theme,
            getKeybindings(),
            (value: unknown) => settle(value),
          )) as DialogComponent;
          try {
            if (options.tab === "tools") {
              component.handleInput!(KEY.tab);
              await until(component, /Global always-allowed tools/);
            }
            for (let i = 0; i < 40 && !new RegExp(`❯ ${escapedRow}`).test(component.render(120).join("\n")); i++) {
              component.handleInput!(KEY.down);
            }
            component.handleInput!(KEY.enter);
            await until(component, /Search:/);
            if (options.toggle) {
              for (const char of options.toggle) component.handleInput!(char);
              component.handleInput!(KEY.down);
              component.handleInput!(KEY.space);
            }
            component.handleInput!(KEY.save);
            await until(component, /Always-allowed .+ saved/);
            component.handleInput!(KEY.esc);
          } finally {
            component.dispose?.();
            settle({ saved: true, values: {}, scope: "global", dirty: false, closedBy: "escape" });
          }
          return result;
        },
      },
    },
  }) as CommandContext;
  await run("", tui);
}
