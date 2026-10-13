import { taskWithoutExpandedSkill } from "../apps/skill-filter.ts";

/** Newest queued steering/follow-up USER text; never assistant text, tool names, arguments or results. */
export function queuedUserTask(pending: readonly unknown[] | undefined): { id: string; text: string } | undefined {
  for (let index = (pending?.length ?? 0) - 1; index >= 0; index--) {
    const message = pending![index] as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
    if (message?.role !== "user") continue;
    const raw = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.flatMap((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
    const text = taskWithoutExpandedSkill(raw.slice(0, 100_000));
    return text.trim() ? { id: `${String(message.timestamp ?? "")}\0${text}`, text } : undefined;
  }
  return undefined;
}
