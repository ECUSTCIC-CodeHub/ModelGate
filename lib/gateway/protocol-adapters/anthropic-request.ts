import {
  normalizeAnthropicMessages,
  normalizedPartsToAnthropicContent,
  type JsonRecord,
} from "@/lib/gateway/normalized-message";
import {
  omitKeys,
  parseToolArguments,
  type IntermediateRequest,
} from "@/lib/gateway/protocol-adapters/intermediate";
import {
  CHAT_COMPLETIONS_ONLY_EXTRA_KEYS,
  RESPONSES_ONLY_EXTRA_KEYS,
} from "@/lib/gateway/protocol-adapters/protocol-extra";
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
  "metadata",
  "store",
];

export function anthropicRequestToIntermediate(body: JsonRecord, realModel: string): IntermediateRequest {
  const tools = body.tools !== undefined ? anthropicToolsToIntermediate(body.tools) : undefined;
  let toolChoice = body.tool_choice !== undefined ? anthropicToolChoiceToIntermediate(body.tool_choice) : undefined;
  // If tool_choice points to a specific function that was filtered out
  // (e.g. an Anthropic beta tool like computer_*), downgrade to "auto".
  if (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function") {
    const availableNames = new Set((tools ?? []).map((t) => t.name));
    if (!availableNames.has(toolChoice.name)) {
      toolChoice = "auto";
    }
  }
  return {
    sourceProtocol: "anthropic_messages",
    model: realModel,
    messages: normalizeAnthropicMessages(body.messages, body.system),
    stream: body.stream === true,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: body.stop_sequences,
    tools,
    tool_choice: toolChoice,
    thinking: body.thinking,
    metadata: body.metadata,
    extra: omitKeys(body, REQUEST_KEYS),
  };
}

const CROSS_PROTOCOL_EXTRA_KEYS = [
  "text",
  "reasoning_effort",
  "context_management",
  "parallel_tool_calls",
  "stream_options",
  "user",
  "instructions",
  "service_tier",
  "store",
];

export function anthropicRequestFromIntermediate(request: IntermediateRequest): JsonRecord {
  const extra = request.sourceProtocol === "responses"
    ? omitKeys(request.extra, [...CROSS_PROTOCOL_EXTRA_KEYS, ...RESPONSES_ONLY_EXTRA_KEYS])
    : request.sourceProtocol === "chat_completions"
      ? omitKeys(request.extra, [...CROSS_PROTOCOL_EXTRA_KEYS, ...CHAT_COMPLETIONS_ONLY_EXTRA_KEYS])
      : omitKeys(request.extra, CROSS_PROTOCOL_EXTRA_KEYS);
  const systemBlocks = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => normalizedPartsToAnthropicContent(message.content));

  const messages = request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
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
    ...extra,
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
    const stop = request.stop;
    if (stop !== null) {
      next.stop_sequences = Array.isArray(stop) ? stop : [stop];
    }
  }
  // Anthropic 缺省 tool_choice 为 auto，仅省略该字段模型仍可自行调用工具；
  // tool_choice=none 时连同 tools 列表一起省略，才能等效禁用工具调用、保持客户端意图
  const toolsDisabled = request.tool_choice === "none";
  if (request.tools !== undefined && !toolsDisabled) next.tools = toolsFromIntermediateForAnthropic(request.tools);
  if (request.tool_choice !== undefined) {
    const toolChoice = toolChoiceFromIntermediateForAnthropic(request.tool_choice);
    if (toolChoice !== undefined) next.tool_choice = toolChoice;
  }
  // Anthropic Messages 的 metadata 是独立合法字段，无需 OpenAI 的 store 开关；
  // 注入 store 会被严格上游当作未知字段拒绝
  if (request.metadata !== undefined) next.metadata = request.metadata;

  return next;
}
