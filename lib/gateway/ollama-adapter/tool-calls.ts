import type { ToolCallState } from "@/lib/gateway/ollama-adapter/types";
import { asArray, asRecord } from "@/lib/gateway/ollama-adapter/utils";

export function parseToolArguments(value: unknown) {
  if (asRecord(value)) return value;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return { raw: value };
  }
}

export function normalizeToolCalls(value: unknown) {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record || !fn || typeof fn.name !== "string") return null;
      return {
        function: {
          name: fn.name,
          arguments: parseToolArguments(fn.arguments),
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export function updateToolCallState(states: Map<number, ToolCallState>, rawToolCalls: unknown[]) {
  rawToolCalls.forEach((item, fallbackIndex) => {
    const record = asRecord(item);
    if (!record) return;

    const index = Number(record.index ?? fallbackIndex);
    const key = Number.isFinite(index) ? index : fallbackIndex;
    const fn = asRecord(record.function);
    const current = states.get(key) ?? { name: "", arguments: "" };

    if (typeof record.id === "string" && record.id) current.id = record.id;
    if (typeof fn?.name === "string") current.name += fn.name;
    if (typeof fn?.arguments === "string") current.arguments += fn.arguments;

    states.set(key, current);
  });
}

export function statesToToolCalls(states: Map<number, ToolCallState>) {
  return [...states.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, state]) => ({
      function: {
        name: state.name,
        arguments: parseToolArguments(state.arguments),
      },
    }))
    .filter((item) => item.function.name.length > 0);
}
