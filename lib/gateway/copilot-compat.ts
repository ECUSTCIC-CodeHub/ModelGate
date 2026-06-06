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
};

const TOOL_FINISH_REASONS = new Set(["tool_calls", "function_call"]);

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

    const toolCalls = rawToolCalls
      .map((toolCall) => normalizeResponseToolCall(toolCall, policy))
      .filter((toolCall): toolCall is JsonRecord => Boolean(toolCall));
    const nextMessage: JsonRecord = { ...message };
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
      finish_reason: TOOL_FINISH_REASONS.has(finishReason ?? "")
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
  const next = { toolCalls: new Map<number, StreamToolState>(), emittedToolCall: false };
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
  const nextDelta: JsonRecord = { ...delta };
  const rawToolCalls = [...asArray(delta.tool_calls)];
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

    return {
      ...choiceRecord,
      delta: nextDelta,
      finish_reason: TOOL_FINISH_REASONS.has(finishReason ?? "")
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
