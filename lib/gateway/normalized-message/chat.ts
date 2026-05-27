import { normalizeContentParts } from "@/lib/gateway/normalized-message/content";
import type { NormalizedMessage } from "@/lib/gateway/normalized-message/types";
import { asArray, asRecord } from "@/lib/gateway/normalized-message/utils";

export function normalizeChatMessages(messages: unknown): NormalizedMessage[] {
  const normalized: NormalizedMessage[] = [];
  for (const item of asArray(messages)) {
    const record = asRecord(item);
    if (!record) continue;

    const role = typeof record.role === "string" ? record.role : "user";
    const toolCalls = asArray(record.tool_calls).reduce<Array<{ id?: string; name?: string; arguments: string }>>((acc, toolCall) => {
        const call = asRecord(toolCall);
        const fn = asRecord(call?.function);
        if (!call || !fn) return acc;
        acc.push({
          id: typeof call.id === "string" ? call.id : undefined,
          name: typeof fn.name === "string" ? fn.name : undefined,
          arguments: typeof fn.arguments === "string" ? fn.arguments : "",
        });
        return acc;
      }, []);

    const content = normalizeContentParts(record.content);
    const reasoning = typeof record.reasoning === "string"
      ? record.reasoning
      : typeof record.reasoning_content === "string"
        ? record.reasoning_content
        : "";
    if (reasoning) {
      content.unshift({ type: "thinking", thinking: reasoning });
    }

    normalized.push({
      role,
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      tool_call_id: typeof record.tool_call_id === "string" ? record.tool_call_id : undefined,
    });
  }
  return normalized;
}
