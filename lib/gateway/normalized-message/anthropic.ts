import { normalizeContentParts } from "@/lib/gateway/normalized-message/content";
import type { NormalizedContentPart, NormalizedMessage } from "@/lib/gateway/normalized-message/types";
import { asArray, asRecord } from "@/lib/gateway/normalized-message/utils";

export function normalizeAnthropicMessages(messages: unknown, system?: unknown): NormalizedMessage[] {
  const normalized: NormalizedMessage[] = [];

  const systemParts = normalizeContentParts(system);
  if (systemParts.length > 0) {
    normalized.push({
      role: "system",
      content: systemParts,
    });
  }

  for (const item of asArray(messages)) {
    const record = asRecord(item);
    if (!record) continue;
    const role = typeof record.role === "string" ? record.role : "user";

    if (typeof record.content === "string") {
      normalized.push({
        role,
        content: normalizeContentParts(record.content),
      });
      continue;
    }

    const contentBlocks = asArray(record.content);
    const textParts: NormalizedContentPart[] = [];
    const toolCalls: Array<{ id?: string; name?: string; arguments?: string }> = [];
    const toolResults: Array<{ tool_call_id?: string; output: string }> = [];

    for (const block of contentBlocks) {
      const content = asRecord(block);
      if (!content) continue;
      const type = typeof content.type === "string" ? content.type : "";

      if (type === "tool_use") {
        toolCalls.push({
          id: typeof content.id === "string" ? content.id : undefined,
          name: typeof content.name === "string" ? content.name : undefined,
          arguments: JSON.stringify(asRecord(content.input) ?? content.input ?? {}),
        });
        continue;
      }

      if (type === "tool_result") {
        const output = typeof content.content === "string"
          ? content.content
          : normalizeContentParts(content.content)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
        toolResults.push({
          tool_call_id: typeof content.tool_use_id === "string" ? content.tool_use_id : undefined,
          output,
        });
        continue;
      }

      if (type === "image") {
        const source = asRecord(content.source);
        if (typeof source?.data === "string" && source.data.length > 0) {
          textParts.push({ type: "image", image_url: source.data, detail: null });
        } else if (typeof source?.url === "string" && source.url.length > 0) {
          textParts.push({ type: "image", image_url: source.url, detail: null });
        }
      }

      textParts.push(...normalizeContentParts([content]));
    }

    if (toolResults.length > 0) {
      for (const result of toolResults) {
        normalized.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          content: result.output ? [{ type: "text", text: result.output }] : [],
        });
      }
      continue;
    }

    normalized.push({
      role,
      content: textParts,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }

  return normalized;
}
