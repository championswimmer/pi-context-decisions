import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Read skill names from Pi's canonical skills section without exposing descriptions or paths. */
export function skillNamesFromSection(section: string): string[] {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return Array.from(section.matchAll(/<name>([^<]{1,1536})<\/name>/g), (match) =>
    match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]));
}

/** Reconstruct advertisements from committed native system sections on the active branch. */
export function advertisedSkillNames(session: Pick<ExtensionContext["sessionManager"], "getBranch">): Set<string> {
  const names = new Set<string>();
  for (const entry of session.getBranch()) {
    if (entry.type === "message" && entry.message.role === "system") {
      const section = entry.message.sections?.skills;
      if (typeof section === "string") for (const name of skillNamesFromSection(section)) names.add(name);
    }
    // Sessions written by earlier versions advertised skills in custom messages.
    if (entry.type === "custom_message" && entry.customType === "context-decisions-skills") {
      const details = entry.details as { v?: unknown; added?: unknown; redelivered?: unknown } | undefined;
      if (details?.v === 1) for (const list of [details.added, details.redelivered]) {
        if (Array.isArray(list)) for (const name of list) if (typeof name === "string") names.add(name);
      }
    }
  }
  return names;
}
