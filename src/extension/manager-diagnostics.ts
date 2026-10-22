import type { ExtensionHost } from "./contracts.ts";

export const MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION = "1.1.0";
const CHANNEL = "pi-subagent-manager:diagnostic";
const PROBE = `${CHANNEL}:probe`;
const PARENT_PROBE = "pi-subagent-manager:capabilities:probe";
export const MANAGER_DIAGNOSTICS_HELP = `pi-subagent-manager integration (diagnostics routed to the parent) requires pi-subagent-manager >= ${MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION} with diagnostics protocol 1. Without this capability, subagent diagnostics fall back to stderr.`;

/** Only explicit stable semver releases with protocol 1 qualify. Never infer a version
 * from reply arity, transcript ownership, installed files or tool names. Discovery
 * among same-session trusted extensions is not authentication or a delivery ack.
 */
export function compatibleManagerCapability(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const { version, protocol } = value as Record<string, unknown>;
  if (protocol !== 1 || typeof version !== "string" || version.length > 128) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
  if (!match) return false; // Prereleases are intentionally not supported releases.
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const minimum = MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== minimum[i]!) return parts[i]! > minimum[i]!;
  }
  return true;
}

export function createManagerDiagnostics(pi: ExtensionHost) {
  let hosted: boolean | undefined;
  const probe = (channel: string): boolean => {
    let open = true, replies = 0, compatible = false;
    try {
      pi.events?.emit(channel, { respond: (...args: unknown[]) => {
        if (!open) return;
        replies++;
        compatible = replies === 1 && args.length === 1 && compatibleManagerCapability(args[0]);
      } });
      return compatible;
    } catch { return false; }
    finally { open = false; }
  };
  return {
    reset() { hosted = undefined; },
    // Parent discovery is cheap and deliberately refreshed: extension initialization
    // order must not permanently cache a miss before the manager registers its listener.
    parentAvailable() { return probe(PARENT_PROBE); },
    send(level: "info" | "warning" | "error", message: string): boolean {
      try {
        hosted ??= probe(PROBE);
        if (!hosted || !pi.events) return false;
        pi.events.emit(CHANNEL, { level, message: message.slice(0, 1000), source: "pi-context-decisions" });
        return true;
      } catch {
        hosted = false;
        return false;
      }
    },
  };
}
