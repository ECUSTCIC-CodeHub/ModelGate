import { normalizeContentParts } from "@/lib/gateway/normalized-message/content";
import type { NormalizedMessage } from "@/lib/gateway/normalized-message/types";
import { asRecord } from "@/lib/gateway/normalized-message/utils";

export function normalizeResponsesInput(input: unknown, instructions?: string): NormalizedMessage[] {
  const normalized: NormalizedMessage[] = [];

  if (instructions && instructions.trim()) {
    normalized.push({
      role: "system",
      content: [{ type: "text", text: instructions }],
    });
  }

  const inputArray = Array.isArray(input) ? input : [input];
  for (const item of inputArray) {
    if (typeof item === "string") {
      normalized.push({
        role: "user",
        content: [{ type: "text", text: item }],
      });
      continue;
    }

    const record = asRecord(item);
    if (!record) continue;
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "message" || (!type && typeof record.role === "string")) {
      normalized.push({
        role: typeof record.role === "string" ? record.role : "user",
        content: normalizeContentParts(record.content),
      });
      continue;
    }

    if (type === "function_call") {
      normalized.push({
        role: "assistant",
        content: [],
        tool_calls: [{
          id: typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : undefined,
          name: typeof record.name === "string" ? record.name : undefined,
          arguments: typeof record.arguments === "string" ? record.arguments : "",
        }],
      });
      continue;
    }

    if (type === "function_call_output") {
      normalized.push({
        role: "tool",
        tool_call_id: typeof record.call_id === "string" ? record.call_id : undefined,
        content: normalizeContentParts(
          typeof record.output === "string"
            ? record.output
            : Array.isArray(record.output)
              ? record.output
              : JSON.stringify(record.output ?? ""),
        ),
      });
      continue;
    }

    if (type === "reasoning") {
      normalized.push({
        role: "assistant",
        content: normalizeContentParts(record.content),
      });
      continue;
    }

    if (typeof record.role === "string" || Array.isArray(record.content)) {
      normalized.push({
        role: typeof record.role === "string" ? record.role : "user",
        content: normalizeContentParts(record.content),
      });
    }
  }

  return normalized;
}
