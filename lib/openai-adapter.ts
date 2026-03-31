import { countTextTokens } from "@/lib/tokenizer";
import type { GatewayProtocol } from "@/lib/protocols";

type JsonRecord = Record<string, unknown>;

type NormalizedContentPart =
  | { type: "text"; text: string }
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

    normalized.push({
      role,
      content: normalizeContentParts(record.content),
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

    if (typeof record.role === "string" || Array.isArray(record.content)) {
      normalized.push({
        role: typeof record.role === "string" ? record.role : "user",
        content: normalizeContentParts(record.content),
      });
    }
  }

  return normalized;
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
      : body.max_tokens ?? 256,
  );
  const outputReserve = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 256;
  return Math.max(1, Math.ceil(text.length / 4) + Math.min(outputReserve, 4096));
}

export function countInputText(body: JsonRecord, protocol: GatewayProtocol) {
  const messages = protocol === "responses"
    ? normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined)
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

  if (inboundProtocol === "chat_completions" && outboundProtocol === "responses") {
    const next: JsonRecord = {
      model: realModel,
      input: normalizeChatMessages(body.messages).flatMap((message) => {
        const items: JsonRecord[] = [];
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
    if (body.user !== undefined) next.user = body.user;
    if (body.metadata !== undefined) next.metadata = body.metadata;

    const text = chatResponseFormatToResponses(body.response_format);
    if (text) next.text = text;

    return next;
  }

  const next: JsonRecord = {
    model: realModel,
    messages: normalizeResponsesInput(body.input, typeof body.instructions === "string" ? body.instructions : undefined).map((message) => {
      if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
        return {
          role: "assistant",
          content: normalizedPartsToChatContent(message.content),
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

  const output: JsonRecord[] = [];
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

  return { text, toolCalls };
}

export function extractCompletionTextFromBody(text: string, protocol: GatewayProtocol) {
  try {
    const parsed = JSON.parse(text) as JsonRecord;
    if (protocol === "chat_completions") {
      const choices = asArray(parsed.choices);
      const firstChoice = asRecord(choices[0]);
      return extractChatMessageText(asRecord(firstChoice?.message));
    }

    return extractResponsesMessage(parsed.output).text;
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
    return JSON.stringify(buildResponsesOutputFromChat(parsed));
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
    ? createChatToResponsesStream(upstream)
    : createResponsesToChatStream(upstream);
}

function createPassthroughStream(upstream: ReadableStream<Uint8Array>, protocol: GatewayProtocol): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let completionText = "";
  let buffer = "";

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
            const dataLines = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");
            if (data === "[DONE]") continue;

            try {
              if (protocol === "chat_completions") {
                const event = parseChatChunkEvent(data);
                completionText += event.content;
              } else {
                const parsed = parseResponsesSseEvent("", data);
                if (parsed.event === "response.output_text.delta" && typeof (parsed.data as JsonRecord).delta === "string") {
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
  };
}

function createChatToResponsesStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const outputMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolCalls = new Map<number, ToolCallState>();
  let started = false;
  let emittedDone = false;
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
              emitMessageStart(controller);
            }

            if (parsed.content) {
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
                  output: completionText
                    ? [{
                        id: outputMessageId,
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: completionText, annotations: [] }],
                      }]
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
              output: completionText
                ? [{
                    id: outputMessageId,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: completionText, annotations: [] }],
                  }]
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
    completionText: () => completionText,
  };
}

function createResponsesToChatStream(upstream: ReadableStream<Uint8Array>): StreamTransformResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completionText = "";
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
              completionText += payload.delta;
              emitChatChunk(controller, { content: payload.delta });
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
    completionText: () => completionText,
  };
}
