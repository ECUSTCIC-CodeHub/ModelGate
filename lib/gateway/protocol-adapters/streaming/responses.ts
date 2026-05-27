import { asArray, asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import {
  toSseBlock,
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";

type ResponsesSseEvent = {
  event: string;
  data: JsonRecord | string;
};

type ResponsesToolState = {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
};

type EncodedToolState = {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
  done: boolean;
};

export function parseResponsesSseEvent(event: string, data: string): ResponsesSseEvent {
  try {
    const parsed = JSON.parse(data) as JsonRecord;
    const actualEvent = event || (typeof parsed.type === "string" ? parsed.type : "message");
    return { event: actualEvent, data: parsed };
  } catch {
    return { event: event || "message", data };
  }
}

export function trackResponsesStreamEvent(eventName: string, data: string) {
  const parsed = parseResponsesSseEvent(eventName, data);
  const payload = asRecord(parsed.data);
  if (parsed.event === "response.output_text.delta" && typeof payload?.delta === "string") {
    return { completionText: payload.delta };
  }
  if (parsed.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
    return { completionText: payload.delta };
  }
  return null;
}

function createdToUnix(value: unknown) {
  const created = typeof value === "string"
    ? Math.floor(new Date(value).getTime() / 1000)
    : Number(value);
  return Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
}

function usageFromResponses(value: unknown): StreamUsage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
  };
}

function responseUsage(usage: StreamUsage | null) {
  return usage
    ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
    : undefined;
}

export function decodeResponsesStream(upstream: ReadableStream<Uint8Array>): IntermediateStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let usage: StreamUsage | null = null;
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let started = false;
  let finished = false;
  let finishReason: string | null = null;
  const toolsByItemId = new Map<string, ResponsesToolState>();
  const toolsByIndex = new Map<number, ResponsesToolState>();

  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const updateResponseMetadata = (response: JsonRecord | null) => {
    if (!response) return;
    if (typeof response.id === "string") responseId = response.id;
    if (typeof response.model === "string") model = response.model;
    if (response.created_at !== undefined || response.created !== undefined) {
      created = createdToUnix(response.created_at ?? response.created);
    }
    usage = usageFromResponses(response.usage) ?? usage;
    const output = asArray(response.output).map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
    if (output.some((item) => item.type === "function_call")) {
      finishReason = "tool_calls";
    }
  };

  const rememberTool = (item: JsonRecord | null, itemId: string, outputIndex: number) => {
    const existing = toolsByItemId.get(itemId);
    if (existing) return existing;

    const callId = typeof item?.call_id === "string"
      ? item.call_id
      : typeof item?.id === "string"
        ? item.id
        : itemId || `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const state: ResponsesToolState = {
      index: outputIndex,
      itemId: typeof item?.id === "string" ? item.id : itemId || callId,
      callId,
      name: typeof item?.name === "string" ? item.name : "",
      arguments: typeof item?.arguments === "string" ? item.arguments : "",
    };
    toolsByItemId.set(state.itemId, state);
    toolsByItemId.set(state.callId, state);
    toolsByIndex.set(state.index, state);
    finishReason = "tool_calls";
    return state;
  };

  const emitMissingToolArguments = (
    controller: ReadableStreamDefaultController<IntermediateStreamEvent>,
    state: ResponsesToolState,
    finalArguments: string,
  ) => {
    const delta = finalArguments.startsWith(state.arguments)
      ? finalArguments.slice(state.arguments.length)
      : finalArguments;
    state.arguments = finalArguments;
    if (!delta) return;
    controller.enqueue({
      type: "tool_call_delta",
      index: state.index,
      id: state.callId,
      name: state.name,
      arguments: delta,
    });
  };

  const emitStart = (controller: ReadableStreamDefaultController<IntermediateStreamEvent>) => {
    if (started) return;
    started = true;
    controller.enqueue({ type: "start", id: responseId, model, created, usage });
  };

  const stream = new ReadableStream<IntermediateStreamEvent>({
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
            updateResponseMetadata(response);

            if (event.event === "response.created" || event.event === "response.in_progress") {
              emitStart(controller);
              continue;
            }

            if (event.event === "response.output_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              completionText += payload.delta;
              controller.enqueue({ type: "text_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.reasoning_text.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              markFirstToken();
              reasoningText += payload.delta;
              controller.enqueue({ type: "reasoning_delta", text: payload.delta });
              continue;
            }

            if (event.event === "response.output_item.added") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                emitStart(controller);
                const outputIndex = Number(payload?.output_index ?? toolsByIndex.size);
                const itemId = typeof item.id === "string" ? item.id : typeof payload?.item_id === "string" ? payload.item_id : "";
                const tool = rememberTool(item, itemId, outputIndex);
                controller.enqueue({
                  type: "tool_call_start",
                  index: tool.index,
                  id: tool.callId,
                  name: tool.name,
                  arguments: tool.arguments || undefined,
                });
              }
              continue;
            }

            if (event.event === "response.function_call_arguments.delta" && typeof payload?.delta === "string") {
              emitStart(controller);
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const outputIndex = Number(payload.output_index ?? toolsByIndex.size);
              const tool = toolsByItemId.get(itemId) ?? rememberTool(null, itemId, outputIndex);
              tool.arguments += payload.delta;
              controller.enqueue({
                type: "tool_call_delta",
                index: tool.index,
                id: tool.callId,
                name: tool.name,
                arguments: payload.delta,
              });
              continue;
            }

            if (event.event === "response.function_call_arguments.done" && typeof payload?.arguments === "string") {
              emitStart(controller);
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const outputIndex = Number(payload.output_index ?? toolsByIndex.size);
              const tool = toolsByItemId.get(itemId) ?? rememberTool(null, itemId, outputIndex);
              emitMissingToolArguments(controller, tool, payload.arguments);
              continue;
            }

            if (event.event === "response.output_item.done") {
              const item = asRecord(payload?.item);
              if (item?.type === "function_call") {
                emitStart(controller);
                const outputIndex = Number(payload?.output_index ?? toolsByIndex.size);
                const itemId = typeof item.id === "string" ? item.id : typeof payload?.item_id === "string" ? payload.item_id : "";
                const tool = toolsByItemId.get(itemId) ?? rememberTool(item, itemId, outputIndex);
                if (typeof item.arguments === "string") {
                  emitMissingToolArguments(controller, tool, item.arguments);
                }
              }
              continue;
            }

            if (event.event === "response.completed") {
              emitStart(controller);
              if (usage) controller.enqueue({ type: "usage", usage });
              if (!finished) {
                finished = true;
                controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
              }
            }
          }
        }

        if (started && !finished) {
          controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
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

export function encodeResponsesStream(events: ReadableStream<IntermediateStreamEvent>) {
  const reader = events.getReader();
  const encoder = new TextEncoder();
  let responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let created = Math.floor(Date.now() / 1000);
  let usage: StreamUsage | null = null;
  let started = false;
  let finished = false;
  let nextOutputIndex = 0;
  let reasoningStarted = false;
  let reasoningDone = false;
  let reasoningText = "";
  let reasoningOutputIndex = 0;
  const reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "")}`;
  let textStarted = false;
  let textDone = false;
  let text = "";
  let textOutputIndex = 0;
  const outputMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const tools = new Map<number, EncodedToolState>();

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, payload: unknown) => {
    controller.enqueue(encoder.encode(toSseBlock(event, payload)));
  };

  const responseBase = (status: "in_progress" | "completed") => ({
    id: responseId,
    object: "response",
    created_at: created,
    model,
    status,
  });

  const ensureStarted = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (started) return;
    started = true;
    emit(controller, "response.created", {
      type: "response.created",
      response: {
        ...responseBase("in_progress"),
        output: [],
      },
    });
    emit(controller, "response.in_progress", {
      type: "response.in_progress",
      response: {
        ...responseBase("in_progress"),
        output: [],
      },
    });
  };

  const ensureReasoning = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (reasoningStarted) return;
    ensureStarted(controller);
    reasoningStarted = true;
    reasoningOutputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: reasoningOutputIndex,
      item: {
        id: reasoningItemId,
        type: "reasoning",
        summary: [],
        content: [],
        status: "in_progress",
      },
    });
  };

  const ensureText = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (textStarted) return;
    ensureStarted(controller);
    textStarted = true;
    textOutputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: textOutputIndex,
      item: {
        id: outputMessageId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    emit(controller, "response.content_part.added", {
      type: "response.content_part.added",
      response_id: responseId,
      item_id: outputMessageId,
      output_index: textOutputIndex,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
      },
    });
  };

  const ensureTool = (controller: ReadableStreamDefaultController<Uint8Array>, value: Extract<IntermediateStreamEvent, { type: "tool_call_start" | "tool_call_delta" }>) => {
    const existing = tools.get(value.index);
    if (existing) return existing;
    ensureStarted(controller);
    const callId = value.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const tool: EncodedToolState = {
      index: value.index,
      itemId: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
      callId,
      name: value.name ?? "",
      arguments: value.type === "tool_call_start" ? value.arguments ?? "" : "",
      outputIndex: nextOutputIndex,
      done: false,
    };
    nextOutputIndex += 1;
    tools.set(value.index, tool);
    emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: tool.outputIndex,
      item: {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
        status: "in_progress",
      },
    });
    return tool;
  };

  const doneReasoning = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!reasoningStarted || reasoningDone) return;
    reasoningDone = true;
    emit(controller, "response.reasoning_text.done", {
      type: "response.reasoning_text.done",
      response_id: responseId,
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      content_index: 0,
      text: reasoningText,
    });
    emit(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: reasoningOutputIndex,
      item: reasoningOutputItem(),
    });
  };

  const doneText = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!textStarted || textDone) return;
    textDone = true;
    emit(controller, "response.output_text.done", {
      type: "response.output_text.done",
      response_id: responseId,
      item_id: outputMessageId,
      output_index: textOutputIndex,
      content_index: 0,
      text,
    });
    emit(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: textOutputIndex,
      item: textOutputItem(),
    });
  };

  const doneTool = (controller: ReadableStreamDefaultController<Uint8Array>, tool: EncodedToolState) => {
    if (tool.done) return;
    tool.done = true;
    emit(controller, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: responseId,
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      arguments: tool.arguments,
    });
    emit(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: tool.outputIndex,
      item: toolOutputItem(tool),
    });
  };

  const reasoningOutputItem = () => ({
    id: reasoningItemId,
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: reasoningText }],
    status: "completed",
  });

  const textOutputItem = () => ({
    id: outputMessageId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: text ? [{ type: "output_text", text, annotations: [] }] : [],
  });

  const toolOutputItem = (tool: EncodedToolState) => ({
    type: "function_call",
    id: tool.itemId,
    call_id: tool.callId,
    name: tool.name,
    arguments: tool.arguments,
    status: "completed",
  });

  const emitDone = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    ensureStarted(controller);
    doneReasoning(controller);
    doneText(controller);
    for (const tool of [...tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      doneTool(controller, tool);
    }

    const output = [
      ...(reasoningStarted ? [reasoningOutputItem()] : []),
      ...(textStarted || tools.size === 0 ? [textOutputItem()] : []),
      ...[...tools.values()].sort((a, b) => a.outputIndex - b.outputIndex).map((tool) => toolOutputItem(tool)),
    ];
    emit(controller, "response.completed", {
      type: "response.completed",
      response: {
        ...responseBase("completed"),
        output,
        output_text: text,
        usage: responseUsage(usage),
      },
    });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === "start") {
            if (value.id) responseId = value.id;
            if (value.model !== undefined) model = value.model;
            if (value.created) created = value.created;
            if (value.usage) usage = value.usage;
            ensureStarted(controller);
            continue;
          }

          if (value.type === "usage") {
            usage = value.usage;
            continue;
          }

          if (value.type === "reasoning_delta") {
            ensureReasoning(controller);
            reasoningText += value.text;
            emit(controller, "response.reasoning_text.delta", {
              type: "response.reasoning_text.delta",
              response_id: responseId,
              item_id: reasoningItemId,
              output_index: reasoningOutputIndex,
              content_index: 0,
              delta: value.text,
            });
            continue;
          }

          if (value.type === "reasoning_signature") {
            continue;
          }

          if (value.type === "text_delta") {
            ensureText(controller);
            text += value.text;
            emit(controller, "response.output_text.delta", {
              type: "response.output_text.delta",
              response_id: responseId,
              item_id: outputMessageId,
              output_index: textOutputIndex,
              content_index: 0,
              delta: value.text,
            });
            continue;
          }

          if (value.type === "tool_call_start") {
            ensureTool(controller, value);
            continue;
          }

          if (value.type === "tool_call_delta") {
            const tool = ensureTool(controller, value);
            if (value.name) tool.name = value.name;
            tool.arguments += value.arguments;
            emit(controller, "response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              response_id: responseId,
              item_id: tool.itemId,
              output_index: tool.outputIndex,
              delta: value.arguments,
            });
            continue;
          }

          if (value.type === "finish") {
            emitDone(controller);
          }
        }

        emitDone(controller);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
