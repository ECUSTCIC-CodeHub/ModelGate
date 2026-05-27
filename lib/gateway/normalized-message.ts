export type JsonRecord = Record<string, unknown>;

export type NormalizedContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string | null; redacted?: boolean }
  | { type: "image"; image_url: string; detail?: string | null }
  | { type: "file"; value: JsonRecord }
  | { type: "unknown"; value: unknown };

export type NormalizedMessage = {
  role: string;
  content: NormalizedContentPart[];
  tool_calls?: Array<{
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  tool_call_id?: string;
};

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function normalizeContentParts(value: unknown): NormalizedContentPart[] {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "text", text: value }] : [];
  }

  if (!Array.isArray(value)) return [];

  const parts: NormalizedContentPart[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;

    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text) parts.push({ type: "text", text });
      continue;
    }

    if (type === "thinking") {
      const thinking = typeof record.thinking === "string" ? record.thinking : typeof record.text === "string" ? record.text : "";
      if (thinking) {
        parts.push({
          type: "thinking",
          thinking,
          signature: typeof record.signature === "string" ? record.signature : null,
        });
      }
      continue;
    }

    if (type === "redacted_thinking") {
      parts.push({
        type: "thinking",
        thinking: typeof record.data === "string" ? record.data : "[redacted thinking]",
        signature: typeof record.signature === "string" ? record.signature : null,
        redacted: true,
      });
      continue;
    }

    if (type === "reasoning_text") {
      const thinking = typeof record.text === "string" ? record.text : "";
      if (thinking) parts.push({ type: "thinking", thinking });
      continue;
    }

    if (type === "image_url" || type === "input_image") {
      const imageUrl = typeof record.image_url === "string"
        ? record.image_url
        : asRecord(record.image_url)?.url;
      if (typeof imageUrl === "string" && imageUrl.length > 0) {
        const detail = typeof record.detail === "string" ? record.detail : null;
        parts.push({ type: "image", image_url: imageUrl, detail });
      }
      continue;
    }

    if (type === "file" || type === "input_file") {
      parts.push({ type: "file", value: record });
      continue;
    }

    if (typeof record.text === "string" && record.text.length > 0) {
      parts.push({ type: "text", text: record.text });
      continue;
    }

    parts.push({ type: "unknown", value: item });
  }

  return parts;
}

export function normalizedPartsToChatContent(parts: NormalizedContentPart[], options?: { preserveThinking?: boolean }) {
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "thinking") {
      if (options?.preserveThinking) {
        return part.redacted
          ? [{ type: "redacted_thinking", data: part.thinking, signature: part.signature ?? undefined }]
          : [{ type: "thinking", thinking: part.thinking, signature: part.signature ?? undefined }];
      }
      return [];
    }
    if (part.type === "image") {
      return [{ type: "image_url", image_url: { url: part.image_url, detail: part.detail ?? undefined } }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });

  if (normalized.length === 0) return "";
  if (normalized.length === 1 && normalized[0]?.type === "text") {
    return normalized[0].text;
  }
  return normalized;
}

export function normalizedPartsToResponseContent(parts: NormalizedContentPart[], role = "user") {
  const textType = role === "assistant" ? "output_text" : "input_text";
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: textType, text: part.text }];
    }
    if (part.type === "thinking") {
      return [];
    }
    if (part.type === "image") {
      return [{ type: "input_image", image_url: part.image_url, detail: part.detail ?? undefined }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });

  return normalized.length > 0 ? normalized : [{ type: textType, text: "" }];
}

export function normalizedPartsToAnthropicContent(parts: NormalizedContentPart[]) {
  return parts.flatMap((part) => {
    if (part.type === "text") {
      return part.text ? [{ type: "text", text: part.text }] : [];
    }
    if (part.type === "thinking") {
      return part.redacted
        ? [{ type: "redacted_thinking", data: part.thinking, signature: part.signature ?? undefined }]
        : [{ type: "thinking", thinking: part.thinking, signature: part.signature ?? undefined }];
    }
    if (part.type === "image") {
      return [{
        type: "image",
        source: {
          type: "url",
          url: part.image_url,
        },
      }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });
}

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
        if (typeof source?.data === "string") {
          textParts.push({ type: "unknown", value: content });
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

export function extractThinkingText(parts: NormalizedContentPart[]) {
  return parts
    .filter((part): part is Extract<NormalizedContentPart, { type: "thinking" }> => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}
