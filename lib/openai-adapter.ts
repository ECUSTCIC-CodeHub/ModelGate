import { countTextTokens } from "@/lib/tokenizer";
import type { GatewayProtocol } from "@/lib/protocols";

type JsonRecord = Record<string, unknown>;

type NormalizedContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string | null; redacted?: boolean }
  | { type: "image"; image_url: string; detail?: string | null }
  | { type: "file"; value: JsonRecord }
  | { type: "unknown"; value: unknown };

type NormalizedMessage = {
  role: string;
  content: NormalizedContentPart[];
  tool_calls?: Array<{
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  tool_call_id?: string;
};

type ToolCallState = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function normalizeContentParts(value: unknown): NormalizedContentPart[] {
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

function normalizedPartsToChatContent(parts: NormalizedContentPart[]) {
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "thinking") {
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

function normalizedPartsToResponseContent(parts: NormalizedContentPart[]) {
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "input_text", text: part.text }];
    }
    if (part.type === "thinking") {
      return [{
        type: "reasoning",
        id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
        summary: [],
        content: [{ type: "reasoning_text", text: part.thinking }],
      }];
    }
    if (part.type === "image") {
      return [{ type: "input_image", image_url: part.image_url, detail: part.detail ?? undefined }];
    }
    if (part.type === "file") {
      return [part.value];
    }
    return [];
  });

  return normalized.length > 0 ? normalized : [{ type: "input_text", text: "" }];
}

function normalizedPartsToAnthropicContent(parts: NormalizedContentPart[]) {
  const normalized = parts.flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
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

  return normalized.length > 0 ? normalized : [{ type: "text", text: "" }];
}

function normalizeChatMessages(messages: unknown): NormalizedMessage[] {
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

function normalizeResponsesInput(input: unknown, instructions?: string): NormalizedMessage[] {
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

function normalizeAnthropicMessages(messages: unknown, system?: unknown): NormalizedMessage[] {
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

function extractThinkingText(parts: NormalizedContentPart[]) {
  return parts
    .filter((part): part is Extract<NormalizedContentPart, { type: "thinking" }> => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

function chatToolsToResponsesTools(tools: unknown) {
  return asArray(tools).map((tool) => {
    const record = asRecord(tool);
    if (!record) return tool;
    if (record.type !== "function") return tool;

    const fn = asRecord(record.function) ?? {};
    return {
      type: "function",
      name: typeof fn.name === "string" ? fn.name : "",
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: asRecord(fn.parameters) ?? fn.parameters,
      strict: typeof fn.strict === "boolean" ? fn.strict : undefined,
    };
  });
}

function responsesToolsToChatTools(tools: unknown) {
  const converted = asArray(tools).map((tool) => {
    const record = asRecord(tool);
    if (!record) return null;

    if (record.type !== "function") {
      throw new Error(`当前暂不支持将 ${String(record.type)} 工具转换为 /chat/completions`);
    }

    return {
      type: "function",
      function: {
        name: typeof record.name === "string" ? record.name : "",
        description: typeof record.description === "string" ? record.description : undefined,
        parameters: asRecord(record.parameters) ?? record.parameters,
        strict: typeof record.strict === "boolean" ? record.strict : undefined,
      },
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));

  return converted.length > 0 ? converted : undefined;
}

function toolsToAnthropicTools(tools: unknown) {
  return asArray(tools)
    .map((tool) => {
      const record = asRecord(tool);
      if (!record) return null;

      if (record.type === "function") {
        const fn = asRecord(record.function) ?? record;
        return {
          name: typeof fn.name === "string" ? fn.name : "",
          description: typeof fn.description === "string" ? fn.description : undefined,
          input_schema: asRecord(fn.parameters) ?? fn.parameters ?? { type: "object", properties: {} },
        };
      }

      if (record.type === "custom") {
        throw new Error("当前暂不支持将 custom tools 转换为 Claude Messages");
      }

      if (typeof record.name === "string") {
        return {
          name: record.name,
          description: typeof record.description === "string" ? record.description : undefined,
          input_schema: asRecord(record.parameters) ?? record.parameters ?? { type: "object", properties: {} },
        };
      }

      return null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function anthropicToolsToChatTools(tools: unknown) {
  const converted = asArray(tools)
    .map((tool) => {
      const record = asRecord(tool);
      if (!record || typeof record.name !== "string") return null;
      return {
        type: "function",
        function: {
          name: record.name,
          description: typeof record.description === "string" ? record.description : undefined,
          parameters: asRecord(record.input_schema) ?? record.input_schema ?? { type: "object", properties: {} },
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return converted.length > 0 ? converted : undefined;
}

function anthropicToolChoiceToChat(toolChoice: unknown) {
  const record = asRecord(toolChoice);
  if (!record || typeof record.type !== "string") return undefined;
  if (record.type === "auto") return "auto";
  if (record.type === "any") return "required";
  if (record.type === "tool" && typeof record.name === "string") {
    return {
      type: "function",
      function: {
        name: record.name,
      },
    };
  }
  return undefined;
}

function toolChoiceToAnthropic(toolChoice: unknown) {
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return undefined;

  const record = asRecord(toolChoice);
  const fn = asRecord(record?.function);
  if (record?.type === "function" && typeof fn?.name === "string") {
    return { type: "tool", name: fn.name };
  }
  if (record?.type === "function" && typeof record.name === "string") {
    return { type: "tool", name: record.name };
  }
  return undefined;
}

function chatToolChoiceToResponses(toolChoice: unknown) {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  const record = asRecord(toolChoice);
  const fn = asRecord(record?.function);
  if (record?.type === "function" && typeof fn?.name === "string") {
    return { type: "function", name: fn.name };
  }
  return toolChoice;
}

function responsesToolChoiceToChat(toolChoice: unknown) {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  const record = asRecord(toolChoice);
  if (record?.type === "function" && typeof record.name === "string") {
    return {
      type: "function",
      function: {
        name: record.name,
      },
    };
  }
  return toolChoice;
}

function chatResponseFormatToResponses(responseFormat: unknown) {
  const record = asRecord(responseFormat);
  if (!record || typeof record.type !== "string") return undefined;

  if (record.type === "json_object") {
    return { format: { type: "json_object" } };
  }

  if (record.type === "json_schema") {
    const schema = asRecord(record.json_schema);
    return {
      format: {
        type: "json_schema",
        name: typeof schema?.name === "string" ? schema.name : "response",
        schema: asRecord(schema?.schema) ?? schema?.schema ?? {},
        strict: typeof schema?.strict === "boolean" ? schema.strict : undefined,
      },
    };
  }

  return undefined;
}

function responsesTextFormatToChat(text: unknown) {
  const record = asRecord(text);
  const format = asRecord(record?.format);
  if (!format || typeof format.type !== "string") return undefined;

  if (format.type === "json_object") {
    return { type: "json_object" };
  }

  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: typeof format.name === "string" ? format.name : "response",
        schema: asRecord(format.schema) ?? format.schema ?? {},
        strict: typeof format.strict === "boolean" ? format.strict : undefined,
      },
    };
  }

  return undefined;
}

export function estimateRequestTokensForProtocol(body: JsonRecord, protocol: GatewayProtocol) {
  const text = countInputText(body, protocol);
  const maxTokens = Number(
    protocol === "responses"
      ? body.max_output_tokens ?? 256
      : protocol === "anthropic_messages"
        ? body.max_tokens ?? 256
      : body.max_tokens ?? 256,
  );
  const outputReserve = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 256;
  return Math.max(1, Math.ceil(text.length / 4) + Math.min(outputReserve, 4096));
}

export function countInputText(body: JsonRecord, protocol: GatewayProtocol) {
  const messages = protocol === "responses"
    ? normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined)
    : protocol === "anthropic_messages"
      ? normalizeAnthropicMessages(body.messages, body.system)
    : normalizeChatMessages(body.messages);

  return messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function countPromptTokensForProtocol(body: JsonRecord, protocol: GatewayProtocol, model: string) {
  return Math.max(0, countTextTokens(countInputText(body, protocol), model));
}

export function getStreamFlag(body: JsonRecord) {
  return body.stream === true;
}

export function adaptRequestBody(
  body: JsonRecord,
  inboundProtocol: GatewayProtocol,
  outboundProtocol: GatewayProtocol,
  realModel: string,
) {
  if (inboundProtocol === outboundProtocol) {
    return {
      ...body,
      model: realModel,
    };
  }

  if (outboundProtocol === "anthropic_messages") {
    const normalized = inboundProtocol === "chat_completions"
      ? normalizeChatMessages(body.messages)
      : inboundProtocol === "responses"
        ? normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined)
        : normalizeAnthropicMessages(body.messages, body.system);

    const systemBlocks = normalized
      .filter((message) => message.role === "system")
      .flatMap((message) => normalizedPartsToAnthropicContent(message.content));

    const messages = normalized
      .filter((message) => message.role !== "system")
      .flatMap((message) => {
        if (message.role === "tool") {
          return [{
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
            }],
          }];
        }

        const content = normalizedPartsToAnthropicContent(message.content);
        for (const toolCall of message.tool_calls ?? []) {
          let parsedInput: unknown = {};
          try {
            parsedInput = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
          } catch {
            parsedInput = { raw: toolCall.arguments ?? "" };
          }
          content.push({
            type: "tool_use",
            id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
            name: toolCall.name ?? "",
            input: parsedInput,
          });
        }

        return [{
          role: message.role === "assistant" ? "assistant" : "user",
          content,
        }];
      });

    const next: JsonRecord = {
      model: realModel,
      messages,
      stream: body.stream === true,
    };

    if (systemBlocks.length > 0) {
      next.system = systemBlocks.length === 1 && systemBlocks[0]?.type === "text" ? systemBlocks[0].text : systemBlocks;
    }
    next.max_tokens = body.max_output_tokens ?? body.max_tokens ?? 8192;
    if (body.temperature !== undefined) next.temperature = body.temperature;
    if (body.top_p !== undefined) next.top_p = body.top_p;
    if (body.stop !== undefined) next.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.stop_sequences !== undefined) next.stop_sequences = body.stop_sequences;

    const tools = inboundProtocol === "anthropic_messages" ? body.tools : toolsToAnthropicTools(body.tools);
    if (tools && asArray(tools).length > 0) next.tools = tools;

    const toolChoice = toolChoiceToAnthropic(body.tool_choice);
    if (toolChoice) next.tool_choice = toolChoice;

    return next;
  }

  if (inboundProtocol === "chat_completions" && outboundProtocol === "responses") {
    const next: JsonRecord = {
      model: realModel,
      input: normalizeChatMessages(body.messages).flatMap((message) => {
        const items: JsonRecord[] = [];
        const reasoningText = extractThinkingText(message.content);
        if (reasoningText) {
          items.push({
            type: "reasoning",
            id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
            summary: [],
            content: [{ type: "reasoning_text", text: reasoningText }],
          });
        }
        if (message.content.length > 0 || message.role !== "assistant") {
          items.push({
            type: "message",
            role: message.role,
            content: normalizedPartsToResponseContent(message.content),
          });
        }

        for (const toolCall of message.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments ?? "",
          });
        }

        if (message.role === "tool" && message.tool_call_id) {
          items.push({
            type: "function_call_output",
            call_id: message.tool_call_id,
            output: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
          });
        }

        return items;
      }),
      stream: body.stream === true,
    };

    if (body.temperature !== undefined) next.temperature = body.temperature;
    if (body.top_p !== undefined) next.top_p = body.top_p;
    if (body.max_tokens !== undefined) next.max_output_tokens = body.max_tokens;
    if (body.tools !== undefined) next.tools = chatToolsToResponsesTools(body.tools);
    if (body.tool_choice !== undefined) next.tool_choice = chatToolChoiceToResponses(body.tool_choice);
    if (body.parallel_tool_calls !== undefined) next.parallel_tool_calls = body.parallel_tool_calls;
    if (body.stream_options !== undefined) next.stream_options = body.stream_options;
    if (body.user !== undefined) next.user = body.user;
    if (body.metadata !== undefined) next.metadata = body.metadata;

    const text = chatResponseFormatToResponses(body.response_format);
    if (text) next.text = text;

    return next;
  }

  const next: JsonRecord = {
    model: realModel,
    messages: (inboundProtocol === "anthropic_messages"
      ? normalizeAnthropicMessages(body.messages, body.system)
      : normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined)
    ).map((message) => {
      const reasoningText = extractThinkingText(message.content);
      if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
        return {
          role: "assistant",
          content: normalizedPartsToChatContent(message.content),
          reasoning: reasoningText || undefined,
          tool_calls: message.tool_calls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments ?? "",
            },
          })),
        };
      }

      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: normalizedPartsToChatContent(message.content),
        };
      }

      return {
        role: message.role,
        content: normalizedPartsToChatContent(message.content),
        reasoning: message.role === "assistant" && reasoningText ? reasoningText : undefined,
      };
    }),
    stream: body.stream === true,
  };

  if (body.temperature !== undefined) next.temperature = body.temperature;
  if (body.top_p !== undefined) next.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) next.max_tokens = body.max_output_tokens;
  if (body.tools !== undefined) next.tools = responsesToolsToChatTools(body.tools);
  if (body.tool_choice !== undefined) next.tool_choice = responsesToolChoiceToChat(body.tool_choice);
  if (body.parallel_tool_calls !== undefined) next.parallel_tool_calls = body.parallel_tool_calls;
  if (body.user !== undefined) next.user = body.user;
  if (body.metadata !== undefined) next.metadata = body.metadata;
  if (inboundProtocol === "anthropic_messages" && body.tools !== undefined) {
    next.tools = anthropicToolsToChatTools(body.tools);
  }
  if (inboundProtocol === "anthropic_messages" && body.tool_choice !== undefined) {
    next.tool_choice = anthropicToolChoiceToChat(body.tool_choice);
  }

  const responseFormat = responsesTextFormatToChat(body.text);
  if (responseFormat) next.response_format = responseFormat;

  return next;
}

function extractChatMessageText(message: JsonRecord | null) {
  if (!message) return "";
  const content = normalizeContentParts(message.content);
  return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function extractChatToolCalls(message: JsonRecord | null) {
  return asArray(message?.tool_calls)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record || !fn) return null;
      return {
        id: typeof record.id === "string" ? record.id : undefined,
        type: "function",
        function: {
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "",
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function buildResponsesOutputFromChat(parsed: JsonRecord) {
  const choices = asArray(parsed.choices);
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const text = extractChatMessageText(message);
  const toolCalls = extractChatToolCalls(message);
  const reasoningText = typeof message?.reasoning === "string"
    ? message.reasoning
    : typeof message?.reasoning_content === "string"
      ? message.reasoning_content
      : "";

  const output: JsonRecord[] = [];
  if (reasoningText) {
    output.push({
      id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: reasoningText }],
    });
  }
  if (text || toolCalls.length === 0) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: text ? [{ type: "output_text", text, annotations: [] }] : [],
    });
  }

  for (const toolCall of toolCalls) {
    output.push({
      type: "function_call",
      id: toolCall.id ?? `fc_${crypto.randomUUID().replace(/-/g, "")}`,
      call_id: toolCall.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: "completed",
    });
  }

  const usage = asRecord(parsed.usage);
  const promptTokens = Number(usage?.prompt_tokens ?? 0);
  const completionTokens = Number(usage?.completion_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);
  const created = Number(parsed.created ?? Math.floor(Date.now() / 1000));

  return {
    id: typeof parsed.id === "string" ? parsed.id : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: created,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: typeof parsed.model === "string" ? parsed.model : null,
    output,
    output_text: text,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  };
}

function extractResponsesMessage(output: unknown) {
  const items = asArray(output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
  const messageItems = items.filter((item) => item.type === "message" && item.role === "assistant");
  const functionCalls = items.filter((item) => item.type === "function_call");
  const reasoningItems = items.filter((item) => item.type === "reasoning");

  const text = messageItems
    .flatMap((item) => normalizeContentParts(item.content))
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

  const toolCalls = functionCalls.map((item) => ({
    id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined,
    type: "function",
    function: {
      name: typeof item.name === "string" ? item.name : "",
      arguments: typeof item.arguments === "string" ? item.arguments : "",
    },
  }));

  const reasoning = reasoningItems
    .flatMap((item) => normalizeContentParts(item.content))
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");

  return { text, toolCalls, reasoning };
}

export function extractCompletionTextFromBody(text: string, protocol: GatewayProtocol) {
  try {
    const parsed = JSON.parse(text) as JsonRecord;
    if (protocol === "chat_completions") {
      const choices = asArray(parsed.choices);
      const firstChoice = asRecord(choices[0]);
      return extractChatMessageText(asRecord(firstChoice?.message));
    }

    if (protocol === "anthropic_messages") {
      return asArray(parsed.content)
        .flatMap((item) => {
          const record = asRecord(item);
          if (!record) return [];
          if (record.type === "text" && typeof record.text === "string") return [record.text];
          if (record.type === "thinking" && typeof record.thinking === "string") return [record.thinking];
          return [];
        })
        .join("\n");
    }

    const extracted = extractResponsesMessage(parsed.output);
    return [extracted.reasoning, extracted.text].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

export function getUsageFromBody(text: string, protocol: GatewayProtocol) {
  try {
    const parsed = JSON.parse(text) as JsonRecord;
    const usage = asRecord(parsed.usage);
    if (protocol === "chat_completions") {
      const promptTokens = Number(usage?.prompt_tokens ?? 0);
      const completionTokens = Number(usage?.completion_tokens ?? 0);
      const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);
      return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
    }

    if (protocol === "anthropic_messages") {
      const inputTokens = Number(usage?.input_tokens ?? 0);
      const outputTokens = Number(usage?.output_tokens ?? 0);
      const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
      return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens };
    }

    const inputTokens = Number(usage?.input_tokens ?? 0);
    const outputTokens = Number(usage?.output_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
    return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens };
  } catch {
    return null;
  }
}

export function adaptResponseBody(text: string, outboundProtocol: GatewayProtocol, inboundProtocol: GatewayProtocol) {
  if (outboundProtocol === inboundProtocol) return text;

  const parsed = JSON.parse(text) as JsonRecord;
  if (outboundProtocol === "chat_completions") {
    if (inboundProtocol === "responses") {
      return JSON.stringify(buildResponsesOutputFromChat(parsed));
    }

    const choices = asArray(parsed.choices);
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice?.message);
    const toolCalls = extractChatToolCalls(message);
    const content = [];
    const reasoningText = typeof message?.reasoning === "string"
      ? message.reasoning
      : typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : "";

    if (reasoningText) {
      content.push({ type: "thinking", thinking: reasoningText });
    }

    const textContent = extractChatMessageText(message);
    if (textContent) {
      content.push({ type: "text", text: textContent });
    }
    for (const toolCall of toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        input = { raw: toolCall.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
        name: toolCall.function.name,
        input,
      });
    }
    const usage = asRecord(parsed.usage);
    return JSON.stringify({
      id: typeof parsed.id === "string" ? parsed.id : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: typeof parsed.model === "string" ? parsed.model : null,
      content,
      stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: Number(usage?.prompt_tokens ?? 0),
        output_tokens: Number(usage?.completion_tokens ?? 0),
      },
    });
  }

  if (outboundProtocol === "anthropic_messages") {
    if (inboundProtocol === "chat_completions") {
      const choices = asArray(parsed.choices);
      const firstChoice = asRecord(choices[0]);
      const message = asRecord(firstChoice?.message);
      const toolCalls = extractChatToolCalls(message);
      const content = [];
      const reasoningText = typeof message?.reasoning === "string"
        ? message.reasoning
        : typeof message?.reasoning_content === "string"
          ? message.reasoning_content
          : "";

      if (reasoningText) {
        content.push({ type: "thinking", thinking: reasoningText });
      }
      const textContent = extractChatMessageText(message);
      if (textContent) {
        content.push({ type: "text", text: textContent });
      }
      for (const toolCall of toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          input = { raw: toolCall.function.arguments };
        }
        content.push({
          type: "tool_use",
          id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
          name: toolCall.function.name,
          input,
        });
      }
      const usage = asRecord(parsed.usage);
      return JSON.stringify({
        id: typeof parsed.id === "string" ? parsed.id : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model: typeof parsed.model === "string" ? parsed.model : null,
        content,
        stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Number(usage?.prompt_tokens ?? 0),
          output_tokens: Number(usage?.completion_tokens ?? 0),
        },
      });
    }

    const usage = asRecord(parsed.usage);
    const anthropicContent = asArray(parsed.content).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
    const reasoningText = anthropicContent
      .filter((item) => item.type === "thinking")
      .map((item) => (typeof item.thinking === "string" ? item.thinking : ""))
      .join("");
    const textContent = anthropicContent
      .filter((item) => item.type === "text")
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .join("");
    const toolCalls = anthropicContent
      .filter((item) => item.type === "tool_use")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : undefined,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments: JSON.stringify(asRecord(item.input) ?? item.input ?? {}),
        },
      }));
    return JSON.stringify({
      id: typeof parsed.id === "string" ? parsed.id : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      error: null,
      incomplete_details: null,
      model: typeof parsed.model === "string" ? parsed.model : null,
      output: [
        ...(reasoningText ? [{
          id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: reasoningText }],
        }] : []),
        ...(textContent || toolCalls.length === 0 ? [{
          id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: textContent ? [{ type: "output_text", text: textContent, annotations: [] }] : [],
        }] : []),
        ...toolCalls.map((toolCall) => ({
          type: "function_call",
          id: toolCall.id ?? `fc_${crypto.randomUUID().replace(/-/g, "")}`,
          call_id: toolCall.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          status: "completed",
        })),
      ],
      output_text: textContent,
      usage: {
        input_tokens: Number(usage?.input_tokens ?? 0),
        output_tokens: Number(usage?.output_tokens ?? 0),
        total_tokens: Number(usage?.total_tokens ?? Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0)),
      },
    });
  }

  if (inboundProtocol === "anthropic_messages") {
    const usage = asRecord(parsed.usage);
    const message = extractResponsesMessage(parsed.output);
    const content = [];
    if (message.reasoning) content.push({ type: "thinking", thinking: message.reasoning });
    if (message.text) content.push({ type: "text", text: message.text });
    for (const toolCall of message.toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        input = { raw: toolCall.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
        name: toolCall.function.name,
        input,
      });
    }
    return JSON.stringify({
      id: typeof parsed.id === "string" ? parsed.id : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: typeof parsed.model === "string" ? parsed.model : null,
      content,
      stop_reason: message.toolCalls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: Number(usage?.input_tokens ?? 0),
        output_tokens: Number(usage?.output_tokens ?? 0),
      },
    });
  }

  const usage = asRecord(parsed.usage);
  const message = extractResponsesMessage(parsed.output);
  const createdRaw = parsed.created_at ?? parsed.created ?? Math.floor(Date.now() / 1000);
  const created = typeof createdRaw === "string"
    ? Math.floor(new Date(createdRaw).getTime() / 1000)
    : Number(createdRaw);

  return JSON.stringify({
    id: typeof parsed.id === "string" ? parsed.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Number.isFinite(created) ? created : Math.floor(Date.now() / 1000),
    model: typeof parsed.model === "string" ? parsed.model : null,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: message.text,
          reasoning: message.reasoning || undefined,
          tool_calls: message.toolCalls.length > 0 ? message.toolCalls : undefined,
        },
        finish_reason: message.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: Number(usage?.input_tokens ?? 0),
      completion_tokens: Number(usage?.output_tokens ?? 0),
      total_tokens: Number(usage?.total_tokens ?? Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0)),
    },
  });
}

function parseChatChunkEvent(data: string) {
  const parsed = JSON.parse(data) as JsonRecord;
  const choices = asArray(parsed.choices);
  const firstChoice = asRecord(choices[0]);
  const delta = asRecord(firstChoice?.delta);
  const toolCalls = asArray(delta?.tool_calls)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record) return null;
      return {
        index: Number(record.index ?? 0),
        id: typeof record.id === "string" ? record.id : "",
        name: typeof fn?.name === "string" ? fn.name : "",
        arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const usage = asRecord(parsed.usage);
  return {
    id: typeof parsed.id === "string" ? parsed.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof parsed.model === "string" ? parsed.model : null,
    created: Number(parsed.created ?? Math.floor(Date.now() / 1000)),
    content: typeof delta?.content === "string" ? delta.content : "",
    reasoning: typeof delta?.reasoning === "string"
      ? delta.reasoning
      : typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : "",
    toolCalls,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
    usage: usage
      ? {
          prompt_tokens: Number(usage.prompt_tokens ?? 0),
          completion_tokens: Number(usage.completion_tokens ?? 0),
          total_tokens: Number(usage.total_tokens ?? 0),
        }
      : null,
  };
}

type ResponsesSseEvent = {
  event: string;
  data: JsonRecord | string;
};

function parseResponsesSseEvent(event: string, data: string): ResponsesSseEvent {
  try {
    const parsed = JSON.parse(data) as JsonRecord;
    const actualEvent = event || (typeof parsed.type === "string" ? parsed.type : "message");
    return { event: actualEvent, data: parsed };
  } catch {
    return { event: event || "message", data };
  }
}

type AnthropicSseEvent = {
  event: string;
  data: JsonRecord | string;
};

function parseAnthropicSseEvent(event: string, data: string): AnthropicSseEvent {
  try {
    return { event, data: JSON.parse(data) as JsonRecord };
  } catch {
    return { event, data };
  }
}

function toSseBlock(event: string | null, data: unknown) {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  const json = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of json.split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

type StreamTransformResult = {
  stream: ReadableStream<Uint8Array>;
  completionText: () => string;
  firstTokenAt: () => number | null;
};

export function createTransformedStream(
  upstream: ReadableStream<Uint8Array>,
  outboundProtocol: GatewayProtocol,
  inboundProtocol: GatewayProtocol,
) : StreamTransformResult {
  if (outboundProtocol === inboundProtocol) {
    return createPassthroughStream(upstream, outboundProtocol);
  }

  return outboundProtocol === "chat_completions"
    ? inboundProtocol === "responses"
      ? createChatToResponsesStream(upstream)
      : createChatToAnthropicStream(upstream)
    : outboundProtocol === "responses"
      ? inboundProtocol === "chat_completions"
        ? createResponsesToChatStream(upstream)
        : createResponsesToAnthropicStream(upstream)
      : inboundProtocol === "chat_completions"
        ? createAnthropicToChatStream(upstream)
        : createAnthropicToResponsesStream(upstream);
}

function createPassthroughStream(upstream: ReadableStream<Uint8Array>, protocol: GatewayProtocol): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let completionText = "";
  let buffer = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          controller.enqueue(value);
          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded.replace(/\r\n/g, "\n");

          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let eventName = "";
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            try {
              if (protocol === "chat_completions") {
                const event = parseChatChunkEvent(data);
                if (event.content) {
                  markFirstToken();
                  completionText += event.content;
                } else if (event.reasoning) {
                  markFirstToken();
                }
              } else if (protocol === "anthropic_messages") {
                const parsed = parseAnthropicSseEvent(eventName, data);
                const payload = asRecord(parsed.data);
                if (parsed.event === "content_block_delta") {
                  const delta = asRecord(payload?.delta);
                  if (delta?.type === "text_delta" && typeof delta.text === "string") {
                    markFirstToken();
                    completionText += delta.text;
                  } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                    markFirstToken();
                  }
                }
              } else {
                const parsed = parseResponsesSseEvent(eventName, data);
                if (parsed.event === "response.output_text.delta" && typeof (parsed.data as JsonRecord).delta === "string") {
                  markFirstToken();
                  completionText += (parsed.data as JsonRecord).delta as string;
                } else if (parsed.event === "response.reasoning_text.delta" && typeof (parsed.data as JsonRecord).delta === "string") {
                  markFirstToken();
                  completionText += (parsed.data as JsonRecord).delta as string;
                }
              }
            } catch {
              // Ignore malformed event for metrics capture only.
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    completionText: () => completionText,
    firstTokenAt: () => firstTokenAt,
  };
}

function createAnthropicToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };
  let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  const created = Math.floor(Date.now() / 1000);
  let roleEmitted = false;
  let finished = false;
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  const toolUseByIndex = new Map<number, { id: string; name: string }>();
  const thinkingByIndex = new Map<number, { signature?: string }>();

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, delta: JsonRecord, reason: string | null = null) => {
    controller.enqueue(encoder.encode(toSseBlock(null, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta,
        finish_reason: reason,
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = rawEvent.split("\n");
            let eventName = "";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const event = parseAnthropicSseEvent(eventName, dataLines.join("\n"));
            const payload = asRecord(event.data);

            if (event.event === "message_start") {
              const message = asRecord(payload?.message);
              if (typeof message?.id === "string") id = message.id;
              if (typeof message?.model === "string") model = message.model;
              const usage = asRecord(message?.usage);
              promptTokens = Number(usage?.input_tokens ?? 0);
              if (!roleEmitted) {
                emit(controller, { role: "assistant" });
                roleEmitted = true;
              }
              continue;
            }

            if (event.event === "content_block_start") {
              const block = asRecord(payload?.content_block);
              const indexNum = Number(payload?.index ?? 0);
              if (block?.type === "thinking" || block?.type === "redacted_thinking") {
                thinkingByIndex.set(indexNum, {});
              }
              if (block?.type === "tool_use") {
                const toolId = typeof block.id === "string" ? block.id : `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
                const toolName = typeof block.name === "string" ? block.name : "";
                toolUseByIndex.set(indexNum, { id: toolId, name: toolName });
                emit(controller, {
                  tool_calls: [{
                    index: indexNum,
                    id: toolId,
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: "",
                    },
                  }],
                });
              }
              continue;
            }

            if (event.event === "content_block_delta") {
              const delta = asRecord(payload?.delta);
              const indexNum = Number(payload?.index ?? 0);
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                markFirstToken();
                completionText += delta.text;
                emit(controller, { content: delta.text });
              } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                markFirstToken();
                reasoningText += delta.thinking;
                emit(controller, { reasoning: delta.thinking });
              } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
                const thinking = thinkingByIndex.get(indexNum) ?? {};
                thinking.signature = delta.signature;
                thinkingByIndex.set(indexNum, thinking);
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const tool = toolUseByIndex.get(indexNum);
                if (tool) {
                  emit(controller, {
                    tool_calls: [{
                      index: indexNum,
                      id: tool.id,
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: delta.partial_json,
                      },
                    }],
                  });
                }
              }
              continue;
            }

            if (event.event === "message_delta") {
              const delta = asRecord(payload?.delta);
              finishReason = typeof delta?.stop_reason === "string"
                ? (delta.stop_reason === "tool_use" ? "tool_calls" : "stop")
                : finishReason;
              const usage = asRecord(payload?.usage);
              completionTokens = Number(usage?.output_tokens ?? completionTokens);
              continue;
            }

            if (event.event === "message_stop" && !finished) {
              finished = true;
              emit(controller, {}, finishReason ?? "stop");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          }
        }
        if (!finished) {
          emit(controller, {}, finishReason ?? "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { stream, completionText: () => `${reasoningText}${completionText}`, firstTokenAt: () => firstTokenAt };
}

function createAnthropicToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const chat = createAnthropicToChatStream(upstream);
  return createChatToResponsesStream(chat.stream);
}

function createChatToAnthropicStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };
  let started = false;
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  let thinkingStarted = false;
  let model: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, payload: unknown) => {
    controller.enqueue(encoder.encode(toSseBlock(event, payload)));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines = rawEvent.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;
            const parsed = parseChatChunkEvent(data);
            model = parsed.model;
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens;
              completionTokens = parsed.usage.completion_tokens;
            }
            if (!started) {
              started = true;
              emit(controller, "message_start", {
                type: "message_start",
                message: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: promptTokens,
                    output_tokens: 0,
                  },
                },
              });
            }

            if (parsed.reasoning) {
              markFirstToken();
              reasoningText += parsed.reasoning;
              if (!thinkingStarted) {
                thinkingStarted = true;
                emit(controller, "content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "thinking", thinking: "" },
                });
              }
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: parsed.reasoning },
              });
            }

            if (parsed.content) {
              markFirstToken();
              if (completionText.length === 0) {
                emit(controller, "content_block_start", {
                  type: "content_block_start",
                  index: thinkingStarted ? 1 : 0,
                  content_block: { type: "text", text: "" },
                });
              }
              completionText += parsed.content;
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: thinkingStarted ? 1 : 0,
                delta: { type: "text_delta", text: parsed.content },
              });
            }

            for (const toolCall of parsed.toolCalls) {
              emit(controller, "content_block_start", {
                type: "content_block_start",
                index: toolCall.index + (thinkingStarted ? 2 : 1),
                content_block: {
                  type: "tool_use",
                  id: toolCall.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                  name: toolCall.name,
                  input: {},
                },
              });
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: toolCall.index + (thinkingStarted ? 2 : 1),
                delta: {
                  type: "input_json_delta",
                  partial_json: toolCall.arguments,
                },
              });
            }

            if (parsed.finishReason) {
              if (thinkingStarted) {
                emit(controller, "content_block_stop", { type: "content_block_stop", index: 0 });
              }
              if (completionText.length > 0) {
                emit(controller, "content_block_stop", { type: "content_block_stop", index: thinkingStarted ? 1 : 0 });
              }
              emit(controller, "message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: parsed.finishReason === "tool_calls" ? "tool_use" : "end_turn",
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: completionTokens,
                },
              });
              emit(controller, "message_stop", { type: "message_stop" });
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return { stream, completionText: () => `${reasoningText}${completionText}`, firstTokenAt: () => firstTokenAt };
}

function createResponsesToAnthropicStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const chat = createResponsesToChatStream(upstream);
  return createChatToAnthropicStream(chat.stream);
}

function createChatToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const outputMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolCalls = new Map<number, ToolCallState>();
  let started = false;
  let emittedDone = false;
  let reasoningStarted = false;
  let reasoningText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  const emitStart = (controller: ReadableStreamDefaultController<Uint8Array>, model: string | null, created: number) => {
    if (started) return;
    started = true;
    controller.enqueue(encoder.encode(toSseBlock("response.created", {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        created_at: created,
        model,
        status: "in_progress",
        output: [],
      },
    })));
    controller.enqueue(encoder.encode(toSseBlock("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: responseId,
        object: "response",
        created_at: created,
        model,
        status: "in_progress",
        output: [],
      },
    })));
  };

  const emitMessageStart = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(encoder.encode(toSseBlock("response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: 0,
      item: {
        id: outputMessageId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })));
    controller.enqueue(encoder.encode(toSseBlock("response.content_part.added", {
      type: "response.content_part.added",
      response_id: responseId,
      item_id: outputMessageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
      },
    })));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const dataLines = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            const parsed = parseChatChunkEvent(data);
            emitStart(controller, parsed.model, parsed.created);

            if ((parsed.content || parsed.reasoning) && completionText.length === 0) {
              if (parsed.reasoning && !reasoningStarted) {
                reasoningStarted = true;
                controller.enqueue(encoder.encode(toSseBlock("response.output_item.added", {
                  type: "response.output_item.added",
                  response_id: responseId,
                  output_index: 0,
                  item: {
                    id: reasoningItemId,
                    type: "reasoning",
                    summary: [],
                    content: [],
                    status: "in_progress",
                  },
                })));
              }
              if (parsed.content) {
                emitMessageStart(controller);
              }
            }

            if (parsed.reasoning) {
              markFirstToken();
              reasoningText += parsed.reasoning;
              controller.enqueue(encoder.encode(toSseBlock("response.reasoning_text.delta", {
                type: "response.reasoning_text.delta",
                response_id: responseId,
                item_id: reasoningItemId,
                output_index: 0,
                content_index: 0,
                delta: parsed.reasoning,
              })));
            }

            if (parsed.content) {
              markFirstToken();
              if (completionText.length === 0) {
                emitMessageStart(controller);
              }
              completionText += parsed.content;
              controller.enqueue(encoder.encode(toSseBlock("response.output_text.delta", {
                type: "response.output_text.delta",
                response_id: responseId,
                item_id: outputMessageId,
                output_index: 0,
                content_index: 0,
                delta: parsed.content,
              })));
            }

            for (const toolCall of parsed.toolCalls) {
              const existing = toolCalls.get(toolCall.index);
              if (!existing) {
                const state: ToolCallState = {
                  index: toolCall.index,
                  id: toolCall.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                };
                toolCalls.set(toolCall.index, state);
                controller.enqueue(encoder.encode(toSseBlock("response.output_item.added", {
                  type: "response.output_item.added",
                  response_id: responseId,
                  output_index: toolCall.index + 1,
                  item: {
                    type: "function_call",
                    id: state.id,
                    call_id: state.id,
                    name: state.name,
                    arguments: state.arguments,
                    status: "in_progress",
                  },
                })));
              } else {
                existing.arguments += toolCall.arguments;
                if (toolCall.name) existing.name = toolCall.name;
              }

              controller.enqueue(encoder.encode(toSseBlock("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                response_id: responseId,
                item_id: toolCalls.get(toolCall.index)?.id ?? "",
                output_index: toolCall.index + 1,
                delta: toolCall.arguments,
              })));
            }

            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens;
              completionTokens = parsed.usage.completion_tokens;
              totalTokens = parsed.usage.total_tokens;
            }

            if (parsed.finishReason && !emittedDone) {
              emittedDone = true;
              if (reasoningStarted) {
                controller.enqueue(encoder.encode(toSseBlock("response.reasoning_text.done", {
                  type: "response.reasoning_text.done",
                  response_id: responseId,
                  item_id: reasoningItemId,
                  output_index: 0,
                  content_index: 0,
                  text: reasoningText,
                })));
                controller.enqueue(encoder.encode(toSseBlock("response.output_item.done", {
                  type: "response.output_item.done",
                  response_id: responseId,
                  output_index: 0,
                  item: {
                    id: reasoningItemId,
                    type: "reasoning",
                    summary: [],
                    content: [{ type: "reasoning_text", text: reasoningText }],
                    status: "completed",
                  },
                })));
              }
              controller.enqueue(encoder.encode(toSseBlock("response.output_text.done", {
                type: "response.output_text.done",
                response_id: responseId,
                item_id: outputMessageId,
                output_index: 0,
                content_index: 0,
                text: completionText,
              })));
              controller.enqueue(encoder.encode(toSseBlock("response.completed", {
                type: "response.completed",
                response: {
                  id: responseId,
                  object: "response",
                  status: "completed",
                  output: (reasoningStarted || completionText)
                    ? [
                        ...(reasoningStarted ? [{
                          id: reasoningItemId,
                          type: "reasoning",
                          summary: [],
                          content: [{ type: "reasoning_text", text: reasoningText }],
                          status: "completed",
                        }] : []),
                        ...(completionText ? [{
                        id: outputMessageId,
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: completionText, annotations: [] }],
                      }] : []),
                      ]
                    : [],
                  output_text: completionText,
                  usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens,
                    total_tokens: totalTokens,
                  },
                },
              })));
            }
          }
        }

        if (!emittedDone) {
          controller.enqueue(encoder.encode(toSseBlock("response.completed", {
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              output: (reasoningStarted || completionText)
                ? [
                    ...(reasoningStarted ? [{
                      id: reasoningItemId,
                      type: "reasoning",
                      summary: [],
                      content: [{ type: "reasoning_text", text: reasoningText }],
                      status: "completed",
                    }] : []),
                    ...(completionText ? [{
                    id: outputMessageId,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: completionText, annotations: [] }],
                  }] : []),
                  ]
                : [],
              output_text: completionText,
              usage: {
                input_tokens: promptTokens,
                output_tokens: completionTokens,
                total_tokens: totalTokens,
              },
            },
          })));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    completionText: () => `${reasoningText}${completionText}`,
    firstTokenAt: () => firstTokenAt,
  };
}

function createResponsesToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };
  let responseId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let finished = false;
  let finishReason = "stop";
  const toolCalls = new Map<string, ToolCallState>();
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  const emitChatChunk = (controller: ReadableStreamDefaultController<Uint8Array>, delta: JsonRecord, reason: string | null = null) => {
    controller.enqueue(encoder.encode(toSseBlock(null, {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: reason,
        },
      ],
      ...(usage ? { usage } : {}),
    })));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const idx = buffer.indexOf("\n\n");
            if (idx === -1) break;
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            let eventName = "";
            const dataLines: string[] = [];
            for (const line of rawEvent.split("\n")) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }

            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            const event = parseResponsesSseEvent(eventName, data);
            const payload = asRecord(event.data);
            const response = asRecord(payload?.response);

            if (response) {
              if (typeof response.id === "string") responseId = response.id;
              if (typeof response.model === "string") model = response.model;
              const createdRaw = response.created_at ?? response.created;
              const nextCreated = typeof createdRaw === "string"
                ? Math.floor(new Date(createdRaw).getTime() / 1000)
                : Number(createdRaw);
              if (Number.isFinite(nextCreated)) created = nextCreated;
            }

            if (event.event === "response.output_text.delta" && typeof payload?.delta === "string") {
              markFirstToken();
              completionText += payload.delta;
              emitChatChunk(controller, { content: payload.delta });
              continue;
            }

            if (event.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
              markFirstToken();
              reasoningText += payload.delta;
              emitChatChunk(controller, { reasoning: payload.delta });
              continue;
            }

            if (event.event === "response.output_item.added") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                finishReason = "tool_calls";
                const callId = typeof item.call_id === "string"
                  ? item.call_id
                  : typeof item.id === "string"
                    ? item.id
                    : `call_${crypto.randomUUID().replace(/-/g, "")}`;
                const callState: ToolCallState = {
                  index: Number(payload?.output_index ?? toolCalls.size),
                  id: callId,
                  name: typeof item.name === "string" ? item.name : "",
                  arguments: typeof item.arguments === "string" ? item.arguments : "",
                };
                toolCalls.set(callId, callState);
                emitChatChunk(controller, {
                  tool_calls: [{
                    index: callState.index,
                    id: callState.id,
                    type: "function",
                    function: {
                      name: callState.name,
                      arguments: callState.arguments,
                    },
                  }],
                });
              }
              continue;
            }

            if (event.event === "response.function_call_arguments.delta" && typeof payload?.delta === "string") {
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const existing = toolCalls.get(itemId);
              if (existing) {
                existing.arguments += payload.delta;
                emitChatChunk(controller, {
                  tool_calls: [{
                    index: existing.index,
                    id: existing.id,
                    type: "function",
                    function: {
                      name: existing.name,
                      arguments: payload.delta,
                    },
                  }],
                });
              }
              continue;
            }

            if (event.event === "response.completed") {
              const completedUsage = asRecord(response?.usage);
              usage = completedUsage
                ? {
                    prompt_tokens: Number(completedUsage.input_tokens ?? 0),
                    completion_tokens: Number(completedUsage.output_tokens ?? 0),
                    total_tokens: Number(completedUsage.total_tokens ?? 0),
                  }
                : usage;
              if (!finished) {
                finished = true;
                emitChatChunk(controller, {}, finishReason);
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
            }
          }
        }

        if (!finished) {
          emitChatChunk(controller, {}, finishReason);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    completionText: () => `${reasoningText}${completionText}`,
    firstTokenAt: () => firstTokenAt,
  };
}
