import { OPENROUTER_DECISION_MODELS, OPENROUTER_DECISION_SNAPSHOT } from "./openrouter-models.ts";

// Structural mirror of the backend factory selection, with no runtime/Pi dependency.
export type PickerSelection =
  | { backend: "pi"; provider: string; id: string }
  | { backend: "typesafe"; model?: string }
  | { backend: "openai"; model?: string }
  | { backend: "openrouter"; model: string };
export type AuthStatus = "ok" | "missing" | "unknown";
export interface PickerEntry {
  label: string;
  selection: PickerSelection;
  group: "pi-native" | "openrouter-top10" | "direct";
  authStatus: AuthStatus;
  note?: string;
}
export interface PickerInputs {
  piClassifiers: readonly { provider: string; id: string; name?: string }[];
  auth: Readonly<Record<string, AuthStatus>>;
}

/** Pure merge of registry metadata and the checked-in ten; never discovers models or keys. */
export function buildPickerEntries(input: PickerInputs): PickerEntry[] {
  const entries: PickerEntry[] = [];
  const registryIds = new Set<string>();
  const piRouterIds = new Set<string>();
  for (const model of input.piClassifiers) {
    const key = JSON.stringify([model.provider, model.id]);
    if (registryIds.has(key)) continue;
    registryIds.add(key);
    if (model.provider === "openrouter") { piRouterIds.add(model.id); continue; }
    entries.push({ label: `${model.name || model.id} · ${model.provider} via Pi`, selection: { backend: "pi", provider: model.provider, id: model.id }, group: "pi-native", authStatus: input.auth[model.provider] ?? "unknown" });
  }
  OPENROUTER_DECISION_MODELS.forEach((model, index) => {
    const note = `#${index + 1} · ${model.weeklyTokens} tokens · week ${OPENROUTER_DECISION_SNAPSHOT.windowStart}–${OPENROUTER_DECISION_SNAPSHOT.usageThrough} · static snapshot ${OPENROUTER_DECISION_SNAPSHOT.snapshotDate} · unofficial OpenRouter rankings · CC BY 4.0`;
    const status = input.auth.openrouter ?? "unknown";
    if (piRouterIds.has(model.id)) entries.push({ label: `${model.name} · OpenRouter via Pi`, selection: { backend: "pi", provider: "openrouter", id: model.id }, group: "openrouter-top10", authStatus: status, note: `${note}; Pi parser compatibility varies — use direct if needed` });
    entries.push({ label: `${model.name} · OpenRouter direct`, selection: { backend: "openrouter", model: model.id }, group: "openrouter-top10", authStatus: status, note });
  });
  for (const model of ["jev-latest", "jev-1.13.0"]) entries.push({ label: `${model} · TypeSafe direct`, selection: { backend: "typesafe", model }, group: "direct", authStatus: input.auth.typesafe ?? "unknown" });
  entries.push({ label: "gpt-6-luna · OpenAI direct", selection: { backend: "openai", model: "gpt-6-luna" }, group: "direct", authStatus: input.auth.openai ?? "unknown" });
  return entries;
}
