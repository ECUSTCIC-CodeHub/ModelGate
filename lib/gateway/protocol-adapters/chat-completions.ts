import {
  asArray,
  asRecord,
  extractThinkingText,
  normalizeChatMessages,
  normalizeContentParts,
  normalizedPartsToChatContent,
  type JsonRecord,
  type NormalizedContentPart,
} from "@/lib/gateway/normalized-message";
import {
  finishReasonFromAnthropic,
  normalizeUsage,
  omitKeys,
  type ProtocolBodyAdapter,
  type ResponseAdapterOptions,
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

const RESPONSE_KEYS = ["id", "object", "created", "model", "choices", "usage"];

export function extractChatMessageText(message: JsonRecord | null) {
  if (!message) return "";
  const content = normalizeContentParts(message.content);
  return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export function extractChatToolCalls(message: JsonRecord | null) {
  return asArray(message?.tool_calls)
    .map((item) => {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (!record || !fn) return null;
      return {
        id: typeof record.id === "string" ? record.id : undefined,
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function chatResponseFormatToIntermediate(responseFormat: unknown) {
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

function chatResponseFormatFromIntermediate(text: unknown) {
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

function chatContentFromIntermediate(content: NormalizedContentPart[], options?: ResponseAdapterOptions) {
  const thinkingBlocks = content.filter((part) => part.type === "thinking");
  const textContent = content.filter((part) => part.type === "text").map((part) => part.text).join("");
  if (options?.thinkingEnabled && thinkingBlocks.length > 0) {
    return normalizedPartsToChatContent(content, { preserveThinking: true });
  }
  return textContent;
}

export const chatCompletionsAdapter: ProtocolBodyAdapter = {
  requestToIntermediate(body, realModel) {
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
  },

  requestFromIntermediate(request) {
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
  },

  responseToIntermediate(body) {
    const choices = asArray(body.choices);
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice?.message);
    const content = normalizeContentParts(message?.content);
    const reasoningText = typeof message?.reasoning === "string"
      ? message.reasoning
      : typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : "";
    if (reasoningText && !content.some((part) => part.type === "thinking" && part.thinking === reasoningText)) {
      content.unshift({ type: "thinking", thinking: reasoningText });
    }

    const usage = asRecord(body.usage);
    const promptTokens = Number(usage?.prompt_tokens ?? 0);
    const completionTokens = Number(usage?.completion_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);
    const toolCalls = extractChatToolCalls(message);

    return {
      sourceProtocol: "chat_completions",
      id: typeof body.id === "string" ? body.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
      model: typeof body.model === "string" ? body.model : null,
      created: Number(body.created ?? Math.floor(Date.now() / 1000)),
      role: "assistant",
      content,
      tool_calls: toolCalls,
      stop_reason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
      usage: normalizeUsage(promptTokens, completionTokens, totalTokens),
      extra: omitKeys(body, RESPONSE_KEYS),
    };
  },

  responseFromIntermediate(response, options) {
    const messageContent = chatContentFromIntermediate(response.content, options);
    const reasoningText = response.content
      .flatMap((part) => part.type === "thinking" && !part.redacted ? [part.thinking] : [])
      .join("");
    const toolCalls = response.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }));

    return {
      ...response.extra,
      id: response.id,
      object: "chat.completion",
      created: response.created,
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: messageContent,
          reasoning: reasoningText || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: response.sourceProtocol === "anthropic_messages"
          ? finishReasonFromAnthropic(response.stop_reason, toolCalls.length > 0)
          : toolCalls.length > 0 ? "tool_calls" : response.stop_reason ?? "stop",
      }],
      usage: response.usage ? {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      } : undefined,
    };
  },
};
