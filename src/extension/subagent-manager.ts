import { MANAGER_DIAGNOSTICS_HELP } from "./manager-diagnostics.ts";
import type { ToolInfoLike } from "../apps/tool-inventory.ts";

export const INHERITED_TOOLS_GROUP = "ext__subagent_inherited_tools";
export const SUBAGENT_HELP = MANAGER_DIAGNOSTICS_HELP + " Requires enabled pi-subagent-manager with subagentExtensions: true ([lab] Enable subagent extensions), and pi-context-decisions installed as a configured package (not only -e). Allows already-bridged parent tools; does not create bridges or bypass the manager's policy.";
/** Public command/tool provenance only. Names alone are not evidence of the manager. */
export function subagentManagerPresent(tools: readonly ToolInfoLike[]): boolean {
  return tools.some(({ sourceInfo: info }) => {
    if (!info) return false;
    const rawSource = String(info.source ?? "");
    if (rawSource.startsWith("npm:")) return rawSource.slice(4).replace(/@[^/@]+$/u, "") === "pi-subagent-manager";
    if (info.path === "<subagent-inherited-tools>") return true; // manager's child bridge
    if (info.origin === "package") {
      const source = String(info.source ?? "").replace(/^npm:/u, "").replace(/@[^/@]+$/u, "");
      if (source === "pi-subagent-manager") return true;
      if (/^(?:file:|[\\/]|[A-Za-z]:[\\/]|\.{1,2}(?:[\\/]|$)|local$)/u.test(String(info.source ?? "")) && String(info.baseDir ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() === "pi-subagent-manager") return true;
    }
    // Local checkout loaded with -e; Pi supplies the resolved public source path.
    return /(?:^|[\\/])pi-subagent-manager[\\/]src[\\/]index\.[cm]?[jt]s$/u.test(String(info.path ?? ""));
  });
}
