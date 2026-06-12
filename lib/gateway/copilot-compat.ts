import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import type { StreamTransformResult } from "@/lib/gateway/protocol-adapters/streaming";

type ToolNamePolicy = {
  allowedNames: Set<string>;
  fallbackName: string | null;
};

type StreamToolState = {
  id: string;
  name: string;
  valid: boolean;
};

type StreamChoiceState = {
  toolCalls: Map<number, StreamToolState>;
  emittedToolCall: boolean;
  emittedContent: boolean;
  droppedToolText: boolean;
  pendingToolText: string;
};

const TOOL_FINISH_REASONS = new Set(["tool_calls", "function_call"]);
const TOOL_CALL_START = "<tool_call";

const REASONING_EFFORT_BUDGETS: Record<string, number> = {
  minimal: 256,
  low: 512,
  medium: 1024,
  high: 2048,
};
const DEFAULT_THINKING = { enableThinking: true, thinkingTokenBudget: 1024 };

function getOpenAiReasoningEffort(body: Record<string, unknown>) {
  if (typeof body.reasoning_effort === "string") return body.reasoning_effort;
  const reasoning = asRecord(body.reasoning);
  if (typeof reasoning?.effort === "string") return reasoning.effort;
  return null;
}

function openAiReasoningToThinking(body: Record<string, unknown>) {
  const effort = getOpenAiReasoningEffort(body)?.toLowerCase();
  if (!effort) return null;

  if (effort === "none" || effort === "off" || effort === "disabled") {
    return { enableThinking: false, thinkingTokenBudget: 0 };
  }

  const budget = REASONING_EFFORT_BUDGETS[effort];
  return budget === undefined ? null : { enableThinking: true, thinkingTokenBudget: budget };
}

export function normalizeCopilotChatCompletionRequest(body: Record<string, unknown>) {
  const thinking = openAiReasoningToThinking(body) ?? DEFAULT_THINKING;

  const chatTemplateKwargs = asRecord(body.chat_template_kwargs);
  const next: Record<string, unknown> = { ...body };
  if (typeof chatTemplateKwargs?.enable_thinking !== "boolean") {
    next.chat_template_kwargs = {
      ...(chatTemplateKwargs ?? {}),
      enable_thinking: thinking.enableThinking,
    };
  }
  if (next.thinking_token_budget === undefined) {
    next.thinking_token_budget = thinking.thinkingTokenBudget;
  }
  return next;
}

function preserveReasoningDelta(delta: JsonRecord) {
  return { ...delta };
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizePseudoToolArgumentValue(value: string) {
  const decoded = decodeXmlEntities(value).trim();
  const markdownLink = decoded.match(/^\[([^\]]+)\]\([^)]+\)$/);
  return markdownLink?.[1] ?? decoded;
}

function parsePseudoToolArguments(raw: string) {
  const args: Record<string, string> = {};
  const pattern = /<parameter\s*=\s*["']?([^>\s"']+)["']?\s*>([\s\S]*?)<\/parameter\s*>/g;
  for (const match of raw.matchAll(pattern)) {
    const key = match[1]?.trim();
    if (key) args[key] = normalizePseudoToolArgumentValue(match[2] ?? "");
  }
  return JSON.stringify(args);
}

function parsePseudoToolCall(raw: string, index: number, policy: ToolNamePolicy): JsonRecord | null {
  const match = raw.match(/<tool_call\b[^>]*>\s*<function\s*=\s*["']?([^>\s"']+)["']?\s*>([\s\S]*?)(?:<\/function(?:\s*=\s*[^>\s]+)?\s*>|<\/tool_call\s*>)/);
  const rawName = match?.[1]?.trim();
  const name = normalizeToolName(rawName, "", policy);
  if (!match || !name) return null;

  return {
    index,
    id: buildToolCallId(null),
    type: "function",
    function: {
      name,
      arguments: parsePseudoToolArguments(match[2] ?? ""),
    },
  };
}

function trailingToolCallStartPrefixLength(value: string) {
  const maxLength = Math.min(value.length, TOOL_CALL_START.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (TOOL_CALL_START.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function findPseudoToolCallEnd(value: string, fromIndex: number) {
  const pattern = /<\/tool_call\s*>/g;
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(value);
  return match ? match.index + match[0].length : -1;
}

function normalizePseudoToolTextContent(
  content: unknown,
  policy: ToolNamePolicy,
): { content: unknown; toolCalls: JsonRecord[]; droppedToolText: boolean } {
  if (typeof content !== "string" || !content.includes(TOOL_CALL_START)) {
    return { content, toolCalls: [], droppedToolText: false };
  }

  const toolCalls: JsonRecord[] = [];
  const visibleParts: string[] = [];
  let droppedToolText = false;
  let cursor = 0;

  while (cursor < content.length) {
    const start = content.indexOf(TOOL_CALL_START, cursor);
    if (start === -1) {
      visibleParts.push(content.slice(cursor));
      break;
    }

    visibleParts.push(content.slice(cursor, start));
    const end = findPseudoToolCallEnd(content, start);
    if (end === -1) {
      visibleParts.push(content.slice(start));
      break;
    }

    const rawToolCall = content.slice(start, end);
    const toolCall = parsePseudoToolCall(rawToolCall, toolCalls.length, policy);
    if (toolCall) {
      toolCalls.push(toolCall);
    } else {
      droppedToolText = true;
    }
    cursor = end;
  }

  const visibleContent = visibleParts.join("").trim();
  return {
    content: visibleContent || (droppedToolText ? "模型返回了无法解析的工具调用，请重试。" : ""),
    toolCalls,
    droppedToolText,
  };
}

function normalizePseudoResponseToolCalls(toolCalls: JsonRecord[]) {
  return toolCalls.map((toolCall) => {
    const nextToolCall = { ...toolCall };
    delete nextToolCall.index;
    return nextToolCall;
  });
}

function createToolNamePolicy(requestBody: Record<string, unknown>): ToolNamePolicy {
  const names: string[] = [];
  for (const tool of asArray(requestBody.tools)) {
    const record = asRecord(tool);
    const fn = asRecord(record?.function);
    if (record?.type === "function" && typeof fn?.name === "string" && fn.name) {
      names.push(fn.name);
    }
  }

  for (const fn of asArray(requestBody.functions)) {
    const record = asRecord(fn);
    if (typeof record?.name === "string" && record.name) {
      names.push(record.name);
    }
  }

  const allowedNames = new Set(names);
  return {
    allowedNames,
    fallbackName: allowedNames.size === 1 ? [...allowedNames][0] : null,
  };
}

function normalizeToolName(name: unknown, existing: string, policy: ToolNamePolicy) {
  if (typeof name === "string" && name) {
    if (policy.allowedNames.size === 0) return name;
    return policy.allowedNames.has(name) ? name : null;
  }
  if (existing) return existing;
  return policy.fallbackName;
}

function buildToolCallId(value: unknown, existing?: string) {
  if (typeof value === "string" && value) return value;
  if (existing) return existing;
  return `call_${crypto.randomUUID().replace(/-/g, "")}`;
}

function normalizeResponseToolCall(
  raw: unknown,
  policy: ToolNamePolicy,
): JsonRecord | null {
  const record = asRecord(raw);
  const fn = asRecord(record?.function);
  if (!record || !fn) return null;

  const name = normalizeToolName(fn.name, "", policy);
  if (!name) return null;

  return {
    id: buildToolCallId(record.id),
    type: "function",
    function: {
      name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    },
  };
}

function normalizePseudoStreamToolText(
  content: string,
  state: StreamChoiceState,
  policy: ToolNamePolicy,
) {
  const toolCalls: JsonRecord[] = [];
  let visibleContent = "";
  let incoming = content;

  if (state.pendingToolText) {
    incoming = state.pendingToolText + incoming;
    state.pendingToolText = "";
  }

  while (incoming) {
    const start = incoming.indexOf(TOOL_CALL_START);
    if (start === -1) {
      const pendingPrefixLength = trailingToolCallStartPrefixLength(incoming);
      if (pendingPrefixLength > 0) {
        visibleContent += incoming.slice(0, -pendingPrefixLength);
        state.pendingToolText = incoming.slice(-pendingPrefixLength);
      } else {
        visibleContent += incoming;
      }
      break;
    }

    visibleContent += incoming.slice(0, start);
    const end = findPseudoToolCallEnd(incoming, start);
    if (end === -1) {
      state.pendingToolText = incoming.slice(start);
      break;
    }

    const rawToolCall = incoming.slice(start, end);
    const toolCall = parsePseudoToolCall(rawToolCall, state.toolCalls.size + toolCalls.length, policy);
    if (toolCall) {
      state.emittedToolCall = true;
      toolCalls.push(toolCall);
    } else {
      state.droppedToolText = true;
    }
    incoming = incoming.slice(end);
  }

  return { visibleContent, toolCalls };
}

function legacyFunctionCallToToolCall(functionCall: JsonRecord) {
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "function",
    function: {
      name: functionCall.name,
      arguments: typeof functionCall.arguments === "string" ? functionCall.arguments : "",
    },
  };
}

export function normalizeCopilotChatCompletionText(text: string, requestBody: Record<string, unknown>) {
  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(text) as JsonRecord;
  } catch {
    return text;
  }

  const policy = createToolNamePolicy(requestBody);
  const choices = asArray(parsed.choices);
  if (choices.length === 0) return text;

  const normalizedChoices = choices.map((choice) => {
    const choiceRecord = asRecord(choice);
    const message = asRecord(choiceRecord?.message);
    if (!choiceRecord || !message) return choice;

    const rawToolCalls = [...asArray(message.tool_calls)];
    const legacyFunctionCall = asRecord(message.function_call);
    if (legacyFunctionCall) rawToolCalls.push(legacyFunctionCallToToolCall(legacyFunctionCall));

    const normalizedPseudoToolText = normalizePseudoToolTextContent(message.content, policy);
    const toolCalls = [
      ...rawToolCalls
      .map((toolCall) => normalizeResponseToolCall(toolCall, policy))
      .filter((toolCall): toolCall is JsonRecord => Boolean(toolCall)),
      ...normalizePseudoResponseToolCalls(normalizedPseudoToolText.toolCalls),
    ];
    const nextMessage: JsonRecord = preserveReasoningDelta(message);
    nextMessage.content = normalizedPseudoToolText.content;
    delete nextMessage.function_call;

    if (toolCalls.length > 0) {
      nextMessage.tool_calls = toolCalls;
    } else {
      delete nextMessage.tool_calls;
    }

    const finishReason = typeof choiceRecord.finish_reason === "string" ? choiceRecord.finish_reason : null;
    return {
      ...choiceRecord,
      message: nextMessage,
      finish_reason: TOOL_FINISH_REASONS.has(finishReason ?? "") || normalizedPseudoToolText.toolCalls.length > 0
        ? toolCalls.length > 0 ? "tool_calls" : "stop"
        : choiceRecord.finish_reason,
    };
  });

  return JSON.stringify({
    ...parsed,
    choices: normalizedChoices,
  });
}

function choiceState(states: Map<number, StreamChoiceState>, choiceIndex: number) {
  const existing = states.get(choiceIndex);
  if (existing) return existing;
  const next = {
    toolCalls: new Map<number, StreamToolState>(),
    emittedToolCall: false,
    emittedContent: false,
    droppedToolText: false,
    pendingToolText: "",
  };
  states.set(choiceIndex, next);
  return next;
}

function normalizeStreamToolCall(
  raw: unknown,
  fallbackIndex: number,
  state: StreamChoiceState,
  policy: ToolNamePolicy,
): JsonRecord | null {
  const record = asRecord(raw);
  if (!record) return null;

  const fn = asRecord(record.function);
  const index = Number.isFinite(Number(record.index)) ? Number(record.index) : fallbackIndex;
  const existing = state.toolCalls.get(index);
  const incomingName = typeof fn?.name === "string" && fn.name ? fn.name : "";
  if (existing && !existing.valid && !incomingName) return null;

  const name = normalizeToolName(fn?.name, existing?.name ?? "", policy);
  if (!name) {
    state.toolCalls.set(index, {
      id: existing?.id ?? buildToolCallId(record.id),
      name: existing?.name ?? "",
      valid: false,
    });
    return null;
  }

  const id = buildToolCallId(record.id, existing?.id);
  const nextState = {
    id,
    name,
    valid: true,
  };
  state.toolCalls.set(index, nextState);
  state.emittedToolCall = true;

  return {
    index,
    id,
    type: "function",
    function: {
      name,
      arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
    },
  };
}

function normalizeStreamDelta(delta: JsonRecord, state: StreamChoiceState, policy: ToolNamePolicy) {
  const nextDelta: JsonRecord = preserveReasoningDelta(delta);
  const rawToolCalls = [...asArray(delta.tool_calls)];
  const content = typeof nextDelta.content === "string" ? nextDelta.content : "";
  const pseudoToolText = content ? normalizePseudoStreamToolText(content, state, policy) : { visibleContent: "", toolCalls: [] };
  if (content) {
    if (pseudoToolText.visibleContent) {
      nextDelta.content = pseudoToolText.visibleContent;
      state.emittedContent = true;
    } else {
      delete nextDelta.content;
    }
    rawToolCalls.push(...pseudoToolText.toolCalls);
  }

  const functionCall = asRecord(delta.function_call);
  if (functionCall) {
    rawToolCalls.push({
      index: 0,
      function: {
        name: functionCall.name,
        arguments: typeof functionCall.arguments === "string" ? functionCall.arguments : "",
      },
    });
  }

  delete nextDelta.function_call;

  if (rawToolCalls.length === 0) return nextDelta;

  const toolCalls = rawToolCalls
    .map((toolCall, index) => normalizeStreamToolCall(toolCall, index, state, policy))
    .filter((toolCall): toolCall is JsonRecord => Boolean(toolCall));

  if (toolCalls.length > 0) {
    nextDelta.tool_calls = toolCalls;
  } else {
    delete nextDelta.tool_calls;
  }

  return nextDelta;
}

function normalizeCopilotChatChunk(
  chunk: JsonRecord,
  states: Map<number, StreamChoiceState>,
  policy: ToolNamePolicy,
) {
  const choices = asArray(chunk.choices);
  if (choices.length === 0) return chunk;

  const normalizedChoices = choices.map((choice) => {
    const choiceRecord = asRecord(choice);
    if (!choiceRecord) return choice;

    const index = Number.isFinite(Number(choiceRecord.index)) ? Number(choiceRecord.index) : 0;
    const state = choiceState(states, index);
    const delta = asRecord(choiceRecord.delta);
    const nextDelta = delta ? normalizeStreamDelta(delta, state, policy) : choiceRecord.delta;
    const finishReason = typeof choiceRecord.finish_reason === "string" ? choiceRecord.finish_reason : null;
    if (finishReason && state.droppedToolText && !state.emittedToolCall && !state.emittedContent) {
      state.emittedContent = true;
      return {
        ...choiceRecord,
        delta: { content: "模型返回了无法解析的工具调用，请重试。" },
        finish_reason: "stop",
      };
    }

    return {
      ...choiceRecord,
      delta: nextDelta,
      finish_reason: finishReason && (state.emittedToolCall || TOOL_FINISH_REASONS.has(finishReason))
        ? state.emittedToolCall ? "tool_calls" : "stop"
        : choiceRecord.finish_reason,
    };
  });

  return {
    ...chunk,
    choices: normalizedChoices,
  };
}

function normalizeSseEvent(
  rawEvent: string,
  states: Map<number, StreamChoiceState>,
  policy: ToolNamePolicy,
) {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return `${rawEvent}\n\n`;

  const data = dataLines.join("\n");
  if (data === "[DONE]") return "data: [DONE]\n\n";

  try {
    const parsed = JSON.parse(data) as JsonRecord;
    return `data: ${JSON.stringify(normalizeCopilotChatChunk(parsed, states, policy))}\n\n`;
  } catch {
    return `${rawEvent}\n\n`;
  }
}

export function applyCopilotCompatibilityToChatStream(
  result: StreamTransformResult,
  requestBody: Record<string, unknown>,
): StreamTransformResult {
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const states = new Map<number, StreamChoiceState>();
  const policy = createToolNamePolicy(requestBody);
  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const index = buffer.indexOf("\n\n");
            if (index === -1) break;
            const rawEvent = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            controller.enqueue(encoder.encode(normalizeSseEvent(rawEvent, states, policy)));
          }
        }

        if (buffer.trim()) {
          controller.enqueue(encoder.encode(normalizeSseEvent(buffer, states, policy)));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return {
    ...result,
    stream,
  };
}
