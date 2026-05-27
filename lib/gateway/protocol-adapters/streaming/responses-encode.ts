import {
  toSseBlock,
  type IntermediateStreamEvent,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import { responseUsage } from "@/lib/gateway/protocol-adapters/streaming/responses-events";

type EncodedToolState = {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
  done: boolean;
};

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

  const ensureTool = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    value: Extract<IntermediateStreamEvent, { type: "tool_call_start" | "tool_call_delta" }>,
  ) => {
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
