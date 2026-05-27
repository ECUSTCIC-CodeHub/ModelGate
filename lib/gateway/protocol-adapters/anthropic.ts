import {
  asArray,
  asRecord,
  normalizeAnthropicMessages,
  normalizedPartsToAnthropicContent,
  type JsonRecord,
} from "@/lib/gateway/normalized-message";
import {
  finishReasonToAnthropic,
  normalizeUsage,
  omitKeys,
  parseToolArguments,
  type ProtocolBodyAdapter,
  type ResponseAdapterOptions,
} from "@/lib/gateway/protocol-adapters/intermediate";
import {
  anthropicToolChoiceToIntermediate,
  anthropicToolsToIntermediate,
  toolChoiceFromIntermediateForAnthropic,
  toolsFromIntermediateForAnthropic,
} from "@/lib/gateway/protocol-adapters/tools";

const REQUEST_KEYS = [
  "model",
  "messages",
  "system",
  "stream",
  "max_tokens",
  "temperature",
  "top_p",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
];

const RESPONSE_KEYS = ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"];

function contentBlocksFromResponse(content: unknown) {
  return asArray(content).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
}

function thinkingBlocks(content: JsonRecord[]) {
  return content
    .filter((item) => item.type === "thinking" || item.type === "redacted_thinking")
    .map((item) => {
      if (item.type === "redacted_thinking") {
        return {
          type: "thinking" as const,
          thinking: typeof item.data === "string" ? item.data : "",
          signature: typeof item.signature === "string" ? item.signature : undefined,
          redacted: true,
        };
      }
      return {
        type: "thinking" as const,
        thinking: typeof item.thinking === "string" ? item.thinking : "",
        signature: typeof item.signature === "string" ? item.signature : undefined,
      };
    })
    .filter((item) => item.thinking);
}

export const anthropicAdapter: ProtocolBodyAdapter = {
  requestToIntermediate(body, realModel) {
    return {
      sourceProtocol: "anthropic_messages",
      model: realModel,
      messages: normalizeAnthropicMessages(body.messages, body.system),
      stream: body.stream === true,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop_sequences: body.stop_sequences,
      tools: body.tools !== undefined ? anthropicToolsToIntermediate(body.tools) : undefined,
      tool_choice: body.tool_choice !== undefined ? anthropicToolChoiceToIntermediate(body.tool_choice) : undefined,
      thinking: body.thinking,
      extra: omitKeys(body, REQUEST_KEYS),
    };
  },

  requestFromIntermediate(request) {
    const systemBlocks = request.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => normalizedPartsToAnthropicContent(message.content));

    const messages = request.messages
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
          content.push({
            type: "tool_use",
            id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
            name: toolCall.name ?? "",
            input: parseToolArguments(toolCall.arguments),
          });
        }

        if (content.length === 0) return [];

        return [{
          role: message.role === "assistant" ? "assistant" : "user",
          content,
        }];
      });

    const next: JsonRecord = {
      ...request.extra,
      model: request.model,
      messages,
      stream: request.stream,
    };

    if (systemBlocks.length > 0) {
      next.system = systemBlocks.length === 1 && systemBlocks[0]?.type === "text" ? systemBlocks[0].text : systemBlocks;
    }
    if (request.thinking !== undefined) next.thinking = request.thinking;
    next.max_tokens = request.maxTokens ?? 8192;
    if (request.temperature !== undefined) next.temperature = request.temperature;
    if (request.top_p !== undefined) next.top_p = request.top_p;
    if (request.stop_sequences !== undefined) next.stop_sequences = request.stop_sequences;
    if (request.stop !== undefined && request.stop_sequences === undefined) {
      next.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (request.tools !== undefined) next.tools = toolsFromIntermediateForAnthropic(request.tools);
    if (request.tool_choice !== undefined) next.tool_choice = toolChoiceFromIntermediateForAnthropic(request.tool_choice);

    return next;
  },

  responseToIntermediate(body) {
    const content = contentBlocksFromResponse(body.content);
    const normalizedContent = [
      ...thinkingBlocks(content),
      ...content
        .filter((item) => item.type === "text")
        .map((item) => ({ type: "text" as const, text: typeof item.text === "string" ? item.text : "" }))
        .filter((item) => item.text),
    ];
    const toolCalls = content
      .filter((item) => item.type === "tool_use")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : undefined,
        name: typeof item.name === "string" ? item.name : "",
        arguments: JSON.stringify(asRecord(item.input) ?? item.input ?? {}),
      }));
    const usage = asRecord(body.usage);
    const inputTokens = Number(usage?.input_tokens ?? 0);
    const outputTokens = Number(usage?.output_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);

    if (normalizedContent.length === 0 && toolCalls.length === 0) {
      normalizedContent.push({ type: "text", text: "" });
    }

    return {
      sourceProtocol: "anthropic_messages",
      id: typeof body.id === "string" ? body.id : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      model: typeof body.model === "string" ? body.model : null,
      created: Math.floor(Date.now() / 1000),
      role: "assistant",
      content: normalizedContent,
      tool_calls: toolCalls,
      stop_reason: typeof body.stop_reason === "string" ? body.stop_reason : null,
      usage: normalizeUsage(inputTokens, outputTokens, totalTokens),
      extra: omitKeys(body, RESPONSE_KEYS),
    };
  },

  responseFromIntermediate(response, options?: ResponseAdapterOptions) {
    const content: JsonRecord[] = [];
    if (options?.thinkingEnabled) {
      for (const part of response.content) {
        if (part.type !== "thinking") continue;
        content.push(part.redacted
          ? { type: "redacted_thinking", data: part.thinking, signature: part.signature ?? undefined }
          : { type: "thinking", thinking: part.thinking, signature: part.signature ?? undefined });
      }
    }

    const textContent = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (textContent || (content.length === 0 && response.tool_calls.length === 0)) {
      content.push({ type: "text", text: textContent || "" });
    }

    for (const toolCall of response.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
        name: toolCall.name,
        input: parseToolArguments(toolCall.arguments),
      });
    }

    return {
      ...response.extra,
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model,
      content,
      stop_reason: finishReasonToAnthropic(response.stop_reason, response.tool_calls.length > 0),
      stop_sequence: null,
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      } : undefined,
    };
  },
};
