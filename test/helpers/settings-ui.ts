// Drives the REAL settings paths through the RPC select/input fallback of `/decisions`.
// `/decisions` has no setter subcommands (the dialog owns every setting), so tests that need a
// settings change use this instead of typing a command. It goes through the same `controller.update`
// as the terminal dialog, including in-flight cancellation and generation bumps.
import type { CommandContext } from "../../src/extension/contracts.ts";

type Run = (args: string, ctx: CommandContext) => Promise<void>;
/**
 * A context that behaves like an RPC client: reads fall through to `ctx`, but select/input are scripted. `cwd` is dropped so the
 * menu does not read the project allowlist (a gated test read would otherwise deadlock the settings change under test).
 */
export function rpcContext(ctx: CommandContext, ui: Record<string, unknown>): CommandContext {
  return Object.create(ctx, {
    hasUI: { value: true }, mode: { value: "rpc" }, cwd: { value: undefined },
    ui: { value: { ...ctx.ui, custom: undefined, setStatus() {}, ...ui } },
  }) as CommandContext;
}
/**
 * Change one setting (`enabled`, `relevance.<key>`, `tools.<key>`) through the RPC menus. Boolean rows and `enabled`
 * toggle, so pass the opposite of the current value. Invalid values are reported by the command, exactly as for a user.
 */
export async function setSetting(run: Run, ctx: CommandContext, key: string, value = ""): Promise<void> {
  let stage: "main" | "fields" | "edited" = "main";
  const ui = {
    async select(title: string, options: string[]) {
      if (/\(currently /.test(title)) return options.find((option) => option.startsWith(`${value} ·`)) ?? "Back";
      if (title === "Decisions · settings") {
        if (stage !== "main") return "Done";
        stage = "fields";
        if (key === "enabled") { stage = "edited"; return options.find((option) => option.startsWith("Context decisions:")); }
        return options.find((option) => key.startsWith("relevance.") ? option === "Advanced…" : option.startsWith("Tools & MCP…"));
      }
      if (stage === "fields") { stage = "edited"; return options.find((option) => option.startsWith(`${key}:`)); }
      return "Back";
    },
    async input() { return value; },
  };
  await run("", rpcContext(ctx, ui));
}
/**
 * Choose a decision model through the RPC menus: settings → Provider / execution → provider → model (settings → Model for
 * `"none"`, which the current-provider picker always offers). `label` is the option's trailing selection label, e.g.
 * `Pi custom/nested/model` or `openrouter direct typesafe/jev-1.13`. Missing credentials or an unregistered classifier are
 * rejected and reported exactly as for a user.
 */
export async function setModel(run: Run, ctx: CommandContext, label: string): Promise<void> {
  const pi = /^Pi ([^/]+)\//.exec(label)?.[1];
  const providerPrefix = pi ? `${pi} · Pi internal classifier pipeline` : `${label.split(" ")[0]} · direct API`;
  let stage = 0;
  const ui = {
    async select(title: string, options: string[]) {
      if (title === "Decisions · settings") return stage++ === 0 ? options.find((option) => option.startsWith(label === "none" ? "Model:" : "Provider / execution:")) : "Done";
      if (/provider and execution path/.test(title)) return options.find((option) => option.startsWith(providerPrefix));
      if (/select model/.test(title)) return label === "none" ? "None (no decision calls)" : options.find((option) => option.endsWith(` · ${label}`));
      return undefined;
    },
    async input() { return undefined; },
  };
  await run("", rpcContext(ctx, ui));
}

const KEY = { down: "\x1b[B", enter: "\r", esc: "\x1b", save: "\x13", tab: "\t", space: " " };
const theme = { fg: (_token: unknown, value: string) => value, bg: (_token: unknown, value: string) => value };
interface DialogComponent { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }
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
 * Edit one allowlist inside the REAL terminal dialog and save it with Ctrl+S, the dialog's only save path for allowlists.
 * `tab` is the root tab the row lives on; `row` is its label (e.g. "Always allowed · Project"); `toggle` names one entry to
 * flip (found with the editor's local search), or is omitted to save the list unchanged.
 */
export async function saveAllowlist(run: Run, ctx: CommandContext, options: { tab: "skills" | "tools"; row: string; toggle?: string }): Promise<void> {
  const tui = Object.create(ctx, {
    hasUI: { value: true }, mode: { value: "tui" },
    ui: { value: { ...ctx.ui, setStatus() {}, async custom(factory: (...args: unknown[]) => unknown) {
      let settle!: (value: unknown) => void;
      const result = new Promise((resolve) => { settle = resolve; });
      const component = await factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, (value: unknown) => settle(value)) as DialogComponent;
      try {
        if (options.tab === "tools") { component.handleInput!(KEY.tab); await until(component, /Always allowed tools · Global/); }
        for (let i = 0; i < 40 && !new RegExp(`❯ ${options.row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(component.render(120).join("\n")); i++) component.handleInput!(KEY.down);
        component.handleInput!(KEY.enter);
        await until(component, /Search:/);
        if (options.toggle) { for (const char of options.toggle) component.handleInput!(char); component.handleInput!(KEY.down); component.handleInput!(KEY.space); }
        component.handleInput!(KEY.save);
        await until(component, /Always-allowed .+ saved/);
      } finally { component.dispose?.(); settle("closed"); }
      return result;
    } } },
  }) as CommandContext;
  await run("", tui);
}
