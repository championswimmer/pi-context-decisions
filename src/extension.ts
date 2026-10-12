import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "./extension/runtime.ts";

export default function contextDecisions(pi: ExtensionAPI): void {
  registerContextDecisions(pi, {
    settingsPath: join(getAgentDir(), "pi-context-decisions", "settings.json"),
  });
}
