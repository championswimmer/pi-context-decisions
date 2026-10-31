import type { ContextDecisionsSettings, IconStyle, ToolFilterMode } from "../settings.ts";
import type { LastDecision, LastToolDecision } from "./contracts.ts";

/** Fixed glyphs only: no provider/model names, task text or paths reach the footer. */
export const FOOTER_ICONS: Readonly<Record<IconStyle, { decisions: string; skills: string; tools: string }>> = {
  unicode: { decisions: "◇", skills: "≡", tools: "⚙" },
  emoji: { decisions: "🎯", skills: "📚", tools: "🔧" },
  // Classic Font Awesome filter/book/wrench: avoid newer glyphs missing from older patched fonts.
  // Nerd Font remains opt-in; spaces before counts keep icon overhang away from digits.
  nerd: { decisions: "\uf0b0", skills: "\uf02d", tools: "\uf0ad" },
};
function flag(last?: { reason: string; errorCode?: string }): string {
  if (last?.reason === "fail-open") return " !open";
  if (last?.errorCode || last?.reason === "fail-closed") {
    // Safe codes, not arbitrary diagnostic strings; keep the footer bounded even for unknown codes.
    const code = last.errorCode && /^[a-z][a-z0-9-]{0,23}$/u.test(last.errorCode) ? last.errorCode : "error";
    return ` !${code}`;
  }
  return "";
}
/** Counts are the whole invocable inventory, never this round's remaining/scored candidates. */
export function skillFooter(settings: ContextDecisionsSettings, settingsError: string | undefined, last: LastDecision | undefined, total: number): string {
  const icons = FOOTER_ICONS[settings.iconStyle];
  const prefix = `${icons.decisions} ${icons.skills} `;
  if (settingsError) return `${icons.decisions} !config`;
  if (!settings.relevance.enabled) return `${prefix}off`;
  if (!settings.backend) return `${icons.decisions} setup`;
  if (!last) return `${prefix}ready`;
  return `${prefix}${last.advertised ?? "?"}/${total}${flag(last)}`;
}
export interface ToolFooterCounts { mode: ToolFilterMode; available: number; external: number }
/** Undefined means no status write at all while the opt-in feature is off. */
export function toolFooter(settings: ContextDecisionsSettings, options: {
  supported: boolean; settingsError?: string; counts?: ToolFooterCounts; last?: LastToolDecision;
}): string | undefined {
  if (!settings.tools.enabled) return undefined;
  const icon = FOOTER_ICONS[settings.iconStyle].tools;
  if (!options.supported) return `${icon} !host`;
  if (options.settingsError) return `${icon} !config`;
  if (!settings.backend) return `${icon} setup`;
  const unit = settings.tools.mode === "mcp" ? "g" : "";
  if (!options.counts || options.counts.mode !== settings.tools.mode) return `${icon} ready${unit ? " (g)" : ""}${flag(options.last)}`;
  return `${icon} ${options.counts.available}/${options.counts.external}${unit}${flag(options.last)}`;
}
