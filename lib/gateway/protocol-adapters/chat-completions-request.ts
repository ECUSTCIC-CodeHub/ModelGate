import {
  extractThinkingText,
  normalizeChatMessages,
  normalizedPartsToChatContent,
  type JsonRecord,
} from "@/lib/gateway/normalized-message";
import {
  omitKeys,
  type IntermediateRequest,
} from "@/lib/gateway/protocol-adapters/intermediate";
import {
  chatToolChoiceToIntermediate,
  chatToolsToIntermediate,
  toolChoiceFromIntermediateForChat,
  toolsFromIntermediateForChat,
} from "@/lib/gateway/protocol-adapters/tools";

const REQUEST_KEYS = [
  "model",
  "messages",
  "stream",
  "max_tokens",
  "temperature",
  "top_p",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream_options",
  "user",
  "metadata",
  "response_format",
];

function chatResponseFormatToIntermediate(responseFormat: unknown) {
  const record = typeof responseFormat === "object" && responseFormat !== null
    ? responseFormat as JsonRecord
    : null;
  if (!record || typeof record.type !== "string") return undefined;

  if (record.type === "json_object") {
    return { format: { type: "json_object" } };
  }

  if (record.type === "json_schema") {
    const schema = typeof record.json_schema === "object" && record.json_schema !== null
      ? record.json_schema as JsonRecord
      : null;
    return {
      format: {
        type: "json_schema",
        name: typeof schema?.name === "string" ? schema.name : "response",
        schema: typeof schema?.schema === "object" && schema.schema !== null ? schema.schema : {},
        strict: typeof schema?.strict === "boolean" ? schema.strict : undefined,
      },
    };
  }

  return undefined;
}

function chatResponseFormatFromIntermediate(text: unknown) {
  const record = typeof text === "object" && text !== null ? text as JsonRecord : null;
  const format = typeof record?.format === "object" && record.format !== null ? record.format as JsonRecord : null;
  if (!format || typeof format.type !== "string") return undefined;

  if (format.type === "json_object") {
    return { type: "json_object" };
  }

  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: typeof format.name === "string" ? format.name : "response",
        schema: typeof format.schema === "object" && format.schema !== null ? format.schema : {},
        strict: typeof format.strict === "boolean" ? format.strict : undefined,
      },
    };
  }

  return undefined;
}

export function chatCompletionsRequestToIntermediate(body: JsonRecord, realModel: string): IntermediateRequest {
  return {
    sourceProtocol: "chat_completions",
    model: realModel,
    messages: normalizeChatMessages(body.messages),
    stream: body.stream === true,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    tools: body.tools !== undefined ? chatToolsToIntermediate(body.tools) : undefined,
    tool_choice: body.tool_choice !== undefined ? chatToolChoiceToIntermediate(body.tool_choice) : undefined,
    parallel_tool_calls: body.parallel_tool_calls,
    stream_options: body.stream_options,
    user: body.user,
    metadata: body.metadata,
    text: chatResponseFormatToIntermediate(body.response_format),
    response_format: body.response_format,
    extra: omitKeys(body, REQUEST_KEYS),
  };
}

export function chatCompletionsRequestFromIntermediate(request: IntermediateRequest): JsonRecord {
  const messages = request.messages.map((message) => {
    const reasoningText = extractThinkingText(message.content);
    const preserveThinking = request.sourceProtocol === "anthropic_messages" && message.role === "assistant";
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: normalizedPartsToChatContent(message.content, { preserveThinking }),
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
      content: normalizedPartsToChatContent(message.content, { preserveThinking }),
      reasoning: message.role === "assistant" && reasoningText ? reasoningText : undefined,
    };
  });

  const next: JsonRecord = {
    ...request.extra,
    model: request.model,
    messages,
    stream: request.stream,
  };

  if (request.temperature !== undefined) next.temperature = request.temperature;
  if (request.top_p !== undefined) next.top_p = request.top_p;
  if (request.maxTokens !== undefined) next.max_tokens = request.maxTokens;
  if (request.stop !== undefined) next.stop = request.stop;
  if (request.parallel_tool_calls !== undefined) next.parallel_tool_calls = request.parallel_tool_calls;
  if (request.stream_options !== undefined) next.stream_options = request.stream_options;
  if (request.user !== undefined) next.user = request.user;
  if (request.metadata !== undefined) next.metadata = request.metadata;
  if (request.tools !== undefined) next.tools = toolsFromIntermediateForChat(request.tools);
  if (request.tool_choice !== undefined) next.tool_choice = toolChoiceFromIntermediateForChat(request.tool_choice);

  const responseFormat = chatResponseFormatFromIntermediate(request.text);
  if (responseFormat) next.response_format = responseFormat;

  return next;
}
