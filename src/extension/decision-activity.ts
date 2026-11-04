import type { JsonValue } from "../decision/types.ts";

/** A missing or unreadable branch supplies no prior reply. */
export function readPreviousFinalReply(session: { getBranch(): readonly unknown[] }, queued = false): { text: string } | undefined {
  try { return previousFinalReply(session.getBranch(), queued); } catch { return undefined; }
}

/** Visible text from the immediately preceding run's final assistant message, if one exists. */
export function previousFinalReply(entries: readonly unknown[], queued = false): { text: string } | undefined {
  // At before_agent_start the new user is not yet in the branch. At a queued boundary the
  // current run's user IS in the branch, so skip that entire run before finding the prior one.
  let end = entries.length;
  if (queued) {
    while (end > 0) {
      const e = entries[--end] as { type?: unknown; message?: { role?: unknown } };
      if (e?.type === "message" && e.message?.role === "user") break;
    }
    if (end === 0) return undefined;
  }
  let assistant: { role?: unknown; stopReason?: unknown; content?: unknown } | undefined;
  let foundUser = false;
  for (let i = end - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; content?: unknown } };
    if (e?.type !== "message") continue;
    if (e.message?.role === "user") { foundUser = true; break; }
    if (!assistant && e.message?.role === "assistant") assistant = e.message;
  }
  if (!foundUser || assistant?.stopReason !== "stop" || !Array.isArray(assistant.content)) return undefined;
  let text = "";
  for (const block of assistant.content as { type?: unknown; text?: unknown }[]) {
    if (block?.type === "toolCall") return undefined;
    if (block?.type === "text" && typeof block.text === "string" && text.length < 2000) {
      text += (text ? "\n" : "") + block.text.slice(0, 2000 - text.length);
      text = text.slice(0, 2000);
    }
  }
  while (JSON.stringify({ text }).length > 3000) text = text.slice(0, -1);
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  return text ? { text } : undefined;
}
/** At most 3,000 JSON characters of recent assistant text and direct tool calls, after the last user. */
export function decisionActivity(entries: readonly unknown[]): JsonValue[] {
  const blocks: JsonValue[] = [];
  // Only own data properties are inspected; cap traversal before serialization, including hostile/cyclic values.
  const copy = (value: unknown, depth: number, budget: { left: number }, seen: Set<object>): JsonValue => {
    if (budget.left-- <= 0 || depth > 4) return "[truncated]";
    if (typeof value === "string") return value.slice(0, 256);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "object" || seen.has(value)) return "[omitted]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let i = 0; i < Math.min(value.length, 16); i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        result.push(descriptor && "value" in descriptor ? copy(descriptor.value, depth + 1, budget, seen) : "[omitted]");
      }
      return result;
    }
    const result: Record<string, JsonValue> = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count++ === 16) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ("value" in descriptor) result[key.slice(0, 80)] = copy(descriptor.value, depth + 1, budget, seen);
    }
    return result;
  };

  let foundUser = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry?.type !== "message") continue;
    if (entry.message?.role === "user") { foundUser = true; break; }
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (let j = entry.message.content.length - 1; j >= 0; j--) {
      const block = entry.message.content[j] as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      let item: JsonValue | undefined;
      if (block?.type === "text" && typeof block.text === "string") item = { type: "text", text: block.text.slice(0, 600) };
      else if (block?.type === "toolCall" && typeof block.name === "string") {
        let args = copy(block.arguments, 0, { left: 32 }, new Set());
        if (JSON.stringify(args).length > 1000) args = "[truncated]";
        item = { type: "toolCall", name: block.name.slice(0, 128), arguments: args };
      }
      if (item && JSON.stringify(item).length <= 1500 && JSON.stringify([item, ...blocks]).length <= 3000) blocks.unshift(item);
    }
  }
  return foundUser ? blocks : [];
}
