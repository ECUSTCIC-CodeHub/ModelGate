import {
  extractThinkingText,
  normalizeChatMessages,
  normalizedPartsToChatContent,
  type JsonRecord,
  type NormalizedContentPart,
  type NormalizedMessage,
} from "@/lib/gateway/normalized-message";
import {
  omitKeys,
  type IntermediateRequest,
} from "@/lib/gateway/protocol-adapters/intermediate";
import {
  ANTHROPIC_ONLY_EXTRA_KEYS,
  RESPONSES_ONLY_EXTRA_KEYS,
} from "@/lib/gateway/protocol-adapters/protocol-extra";

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
  "max_completion_tokens",
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
  "reasoning_effort",
  "reasoning",
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
  const reasoning = typeof body.reasoning === "object" && body.reasoning !== null
    ? body.reasoning as JsonRecord
    : null;
  return {
    sourceProtocol: "chat_completions",
    model: realModel,
    messages: normalizeChatMessages(body.messages),
    stream: body.stream === true,
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
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
    reasoning_effort: typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : typeof reasoning?.effort === "string"
        ? reasoning.effort
        : undefined,
    response_format: body.response_format,
    extra: omitKeys(body, REQUEST_KEYS),
  };
}

function normalizeResponsesInstructions(messages: NormalizedMessage[], instructions: unknown): NormalizedMessage[] {
  if (typeof instructions !== "string" || !instructions.trim()) {
    return messages;
  }

  const prefix: NormalizedMessage = {
    role: "system",
    content: [{ type: "text", text: instructions }],
  };
  return [prefix, ...messages];
}

function normalizeChatMessageRole(role: string) {
  if (role === "developer") return "system";
  return role;
}

function chatReasoningFields(role: string, reasoningText: string): JsonRecord {
  if (role !== "assistant" || !reasoningText) return {};
  return {
    reasoning: reasoningText,
    reasoning_content: reasoningText,
  };
}

function isAssistantThinkingOnly(message: NormalizedMessage) {
  return message.role === "assistant" &&
    !message.tool_calls?.length &&
    message.content.length > 0 &&
    message.content.every((part) => part.type === "thinking");
}

function flushPendingThinking(messages: NormalizedMessage[], pendingThinking: NormalizedContentPart[]) {
  if (pendingThinking.length === 0) return;
  messages.push({
    role: "assistant",
    content: [...pendingThinking],
  });
  pendingThinking.length = 0;
}

function toolCallIds(message: NormalizedMessage | null) {
  return new Set((message?.tool_calls ?? [])
    .map((toolCall) => toolCall.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0));
}

function toolOutputIds(messages: NormalizedMessage[]) {
  return new Set(messages
    .map((message) => message.tool_call_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0));
}

function toolGroupComplete(toolGroup: NormalizedMessage | null, toolOutputs: NormalizedMessage[]) {
  const expected = toolCallIds(toolGroup);
  if (expected.size === 0) return false;
  const fulfilled = toolOutputIds(toolOutputs);
  return [...expected].every((id) => fulfilled.has(id));
}

function matchingToolOutputs(toolGroup: NormalizedMessage, toolOutputs: NormalizedMessage[]) {
  const expected = toolCallIds(toolGroup);
  return toolOutputs.filter((message) => message.tool_call_id && expected.has(message.tool_call_id));
}

function flushToolGroup(
  messages: NormalizedMessage[],
  state: {
    toolGroup: NormalizedMessage | null;
    toolOutputs: NormalizedMessage[];
    deferred: NormalizedMessage[];
  },
) {
  if (!state.toolGroup) return;

  const outputs = matchingToolOutputs(state.toolGroup, state.toolOutputs);
  const outputIds = toolOutputIds(outputs);
  const toolCalls = (state.toolGroup.tool_calls ?? []).filter((toolCall) => toolCall.id && outputIds.has(toolCall.id));

  if (toolCalls.length > 0) {
    messages.push({
      ...state.toolGroup,
      tool_calls: toolCalls,
    });
    messages.push(...outputs);
  } else if (state.toolGroup.content.length > 0) {
    messages.push({
      role: "assistant",
      content: state.toolGroup.content,
    });
  }

  messages.push(...state.deferred);
  state.toolGroup = null;
  state.toolOutputs = [];
  state.deferred = [];
}

function startOrMergeToolGroup(
  state: {
    toolGroup: NormalizedMessage | null;
    toolOutputs: NormalizedMessage[];
    deferred: NormalizedMessage[];
  },
  message: NormalizedMessage,
  pendingThinking: NormalizedContentPart[],
) {
  if (state.toolGroup && toolGroupComplete(state.toolGroup, state.toolOutputs)) {
    return false;
  }

  if (!state.toolGroup) {
    state.toolGroup = {
      ...message,
      content: [...pendingThinking, ...message.content],
      tool_calls: [...(message.tool_calls ?? [])],
    };
  } else {
    state.toolGroup = {
      ...state.toolGroup,
      content: [...state.toolGroup.content, ...pendingThinking, ...message.content],
      tool_calls: [...(state.toolGroup.tool_calls ?? []), ...(message.tool_calls ?? [])],
    };
  }
  pendingThinking.length = 0;
  return true;
}

function normalizeResponsesMessagesForChat(messages: NormalizedMessage[]) {
  const merged: NormalizedMessage[] = [];
  const pendingThinking: NormalizedContentPart[] = [];
  const toolState: {
    toolGroup: NormalizedMessage | null;
    toolOutputs: NormalizedMessage[];
    deferred: NormalizedMessage[];
  } = {
    toolGroup: null,
    toolOutputs: [],
    deferred: [],
  };

  for (const message of messages) {
    if (isAssistantThinkingOnly(message)) {
      if (toolState.toolGroup && !toolGroupComplete(toolState.toolGroup, toolState.toolOutputs)) {
        toolState.toolGroup.content.push(...message.content);
      } else {
        pendingThinking.push(...message.content);
      }
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      if (!startOrMergeToolGroup(toolState, message, pendingThinking)) {
        flushToolGroup(merged, toolState);
        startOrMergeToolGroup(toolState, message, pendingThinking);
      }
      continue;
    }

    if (message.role === "tool") {
      if (toolState.toolGroup) {
        toolState.toolOutputs.push(message);
        if (toolGroupComplete(toolState.toolGroup, toolState.toolOutputs)) {
          flushToolGroup(merged, toolState);
        }
      } else {
        flushPendingThinking(merged, pendingThinking);
        merged.push(message);
      }
      continue;
    }

    if (message.role === "assistant" && toolState.toolGroup && !toolGroupComplete(toolState.toolGroup, toolState.toolOutputs)) {
      toolState.toolGroup.content.push(...pendingThinking, ...message.content);
      pendingThinking.length = 0;
      continue;
    }

    if (toolState.toolGroup) {
      if (toolGroupComplete(toolState.toolGroup, toolState.toolOutputs)) {
        flushToolGroup(merged, toolState);
      } else {
        toolState.deferred.push(message);
        continue;
      }
    }

    if (pendingThinking.length > 0 && message.role === "assistant") {
      merged.push({
        ...message,
        content: [...pendingThinking, ...message.content],
      });
      pendingThinking.length = 0;
      continue;
    }

    flushPendingThinking(merged, pendingThinking);
    merged.push(message);
  }

  flushToolGroup(merged, toolState);
  flushPendingThinking(merged, pendingThinking);
  return merged;
}

export function chatCompletionsRequestFromIntermediate(request: IntermediateRequest): JsonRecord {
  const crossProtocolKeys = [
    "instructions",
    "context_management",
    "text",
    "reasoning_effort",
  ];
  const extra = request.sourceProtocol === "responses"
    ? omitKeys(request.extra, [...crossProtocolKeys, ...RESPONSES_ONLY_EXTRA_KEYS])
    : request.sourceProtocol === "anthropic_messages"
      ? omitKeys(request.extra, [...crossProtocolKeys, ...ANTHROPIC_ONLY_EXTRA_KEYS])
      : omitKeys(request.extra, crossProtocolKeys);
  const sourceMessages = normalizeResponsesInstructions(request.messages, request.extra.instructions);
  const messagesForChat = request.sourceProtocol === "responses"
    ? normalizeResponsesMessagesForChat(sourceMessages)
    : sourceMessages;
  const messages = messagesForChat.map((message) => {
    const role = normalizeChatMessageRole(message.role);
    const reasoningText = extractThinkingText(message.content);
    const preserveThinking = request.sourceProtocol === "anthropic_messages" && message.role === "assistant";
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: normalizedPartsToChatContent(message.content, {
          preserveThinking,
        }),
        ...chatReasoningFields("assistant", reasoningText),
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
      role,
      content: normalizedPartsToChatContent(message.content, {
        preserveThinking,
      }),
      ...chatReasoningFields(message.role, reasoningText),
    };
  });

  const next: JsonRecord = {
    ...extra,
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
  if (request.metadata !== undefined) { next.metadata = request.metadata; next.store = true; }
  if (request.tools !== undefined) next.tools = toolsFromIntermediateForChat(request.tools);
  if (request.tool_choice !== undefined) next.tool_choice = toolChoiceFromIntermediateForChat(request.tool_choice);

  const responseFormat = chatResponseFormatFromIntermediate(request.text);
  if (responseFormat) next.response_format = responseFormat;

  return next;
}
