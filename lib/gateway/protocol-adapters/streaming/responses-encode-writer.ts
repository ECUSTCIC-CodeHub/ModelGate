import {
  toSseBlock,
  type IntermediateStreamEvent,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";
import {
  createReasoningOutputItem,
  createTextOutputItem,
  createToolOutputItem,
  type EncodedToolState,
} from "@/lib/gateway/protocol-adapters/streaming/responses-encode-items";
import { responseUsage } from "@/lib/gateway/protocol-adapters/streaming/responses-events";

export class ResponsesStreamWriter {
  private responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  private model: string | null = null;
  private created = Math.floor(Date.now() / 1000);
  private usage: StreamUsage | null = null;
  private started = false;
  private finished = false;
  private nextOutputIndex = 0;
  private reasoningStarted = false;
  private reasoningDone = false;
  private reasoningText = "";
  private reasoningOutputIndex = 0;
  private readonly reasoningItemId = `rs_${crypto.randomUUID().replace(/-/g, "")}`;
  private textStarted = false;
  private textDone = false;
  private text = "";
  private textOutputIndex = 0;
  private readonly outputMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  private readonly tools = new Map<number, EncodedToolState>();

  constructor(private readonly encoder: TextEncoder) {}

  applyStart(event: Extract<IntermediateStreamEvent, { type: "start" }>, controller: ReadableStreamDefaultController<Uint8Array>) {
    if (event.id) this.responseId = event.id;
    if (event.model !== undefined) this.model = event.model;
    if (event.created) this.created = event.created;
    if (event.usage) this.usage = event.usage;
    this.ensureStarted(controller);
  }

  applyUsage(event: Extract<IntermediateStreamEvent, { type: "usage" }>) {
    this.usage = event.usage;
  }

  writeReasoningDelta(
    event: Extract<IntermediateStreamEvent, { type: "reasoning_delta" }>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    this.ensureReasoning(controller);
    this.reasoningText += event.text;
    this.emit(controller, "response.reasoning_text.delta", {
      type: "response.reasoning_text.delta",
      response_id: this.responseId,
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      content_index: 0,
      delta: event.text,
    });
  }

  writeTextDelta(
    event: Extract<IntermediateStreamEvent, { type: "text_delta" }>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    this.ensureText(controller);
    this.text += event.text;
    this.emit(controller, "response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: this.responseId,
      item_id: this.outputMessageId,
      output_index: this.textOutputIndex,
      content_index: 0,
      delta: event.text,
    });
  }

  ensureToolCall(
    event: Extract<IntermediateStreamEvent, { type: "tool_call_start" | "tool_call_delta" }>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    const existing = this.tools.get(event.index);
    if (existing) return existing;
    this.ensureStarted(controller);
    const callId = event.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const tool: EncodedToolState = {
      index: event.index,
      itemId: `fc_${crypto.randomUUID().replace(/-/g, "")}`,
      callId,
      name: event.name ?? "",
      arguments: event.type === "tool_call_start" ? event.arguments ?? "" : "",
      outputIndex: this.nextOutputIndex,
      done: false,
    };
    this.nextOutputIndex += 1;
    this.tools.set(event.index, tool);
    this.emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: this.responseId,
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
  }

  writeToolCallDelta(
    event: Extract<IntermediateStreamEvent, { type: "tool_call_delta" }>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    const tool = this.ensureToolCall(event, controller);
    if (event.name) tool.name = event.name;
    tool.arguments += event.arguments;
    this.emit(controller, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: this.responseId,
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      delta: event.arguments,
    });
  }

  writeDone(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (this.finished) return;
    this.finished = true;
    this.ensureStarted(controller);
    this.doneReasoning(controller);
    this.doneText(controller);
    for (const tool of this.sortedTools()) {
      this.doneTool(controller, tool);
    }

    const output = [
      ...(this.reasoningStarted ? [this.reasoningOutputItem()] : []),
      ...(this.textStarted || this.tools.size === 0 ? [this.textOutputItem()] : []),
      ...this.sortedTools().map((tool) => this.toolOutputItem(tool)),
    ];
    this.emit(controller, "response.completed", {
      type: "response.completed",
      response: {
        ...this.responseBase("completed"),
        output,
        output_text: this.text,
        usage: responseUsage(this.usage),
      },
    });
  }

  private emit(controller: ReadableStreamDefaultController<Uint8Array>, event: string, payload: unknown) {
    controller.enqueue(this.encoder.encode(toSseBlock(event, payload)));
  }

  private responseBase(status: "in_progress" | "completed") {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.created,
      model: this.model,
      status,
    };
  }

  private ensureStarted(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (this.started) return;
    this.started = true;
    this.emit(controller, "response.created", {
      type: "response.created",
      response: {
        ...this.responseBase("in_progress"),
        output: [],
      },
    });
    this.emit(controller, "response.in_progress", {
      type: "response.in_progress",
      response: {
        ...this.responseBase("in_progress"),
        output: [],
      },
    });
  }

  private ensureReasoning(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (this.reasoningStarted) return;
    this.ensureStarted(controller);
    this.reasoningStarted = true;
    this.reasoningOutputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: this.responseId,
      output_index: this.reasoningOutputIndex,
      item: {
        id: this.reasoningItemId,
        type: "reasoning",
        summary: [],
        content: [],
        status: "in_progress",
      },
    });
  }

  private ensureText(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (this.textStarted) return;
    this.ensureStarted(controller);
    this.textStarted = true;
    this.textOutputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.emit(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: this.responseId,
      output_index: this.textOutputIndex,
      item: {
        id: this.outputMessageId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    this.emit(controller, "response.content_part.added", {
      type: "response.content_part.added",
      response_id: this.responseId,
      item_id: this.outputMessageId,
      output_index: this.textOutputIndex,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
      },
    });
  }

  private reasoningOutputItem() {
    return createReasoningOutputItem(this.reasoningItemId, this.reasoningText);
  }

  private textOutputItem() {
    return createTextOutputItem(this.outputMessageId, this.text);
  }

  private toolOutputItem(tool: EncodedToolState) {
    return createToolOutputItem(tool);
  }

  private doneReasoning(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!this.reasoningStarted || this.reasoningDone) return;
    this.reasoningDone = true;
    this.emit(controller, "response.reasoning_text.done", {
      type: "response.reasoning_text.done",
      response_id: this.responseId,
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      content_index: 0,
      text: this.reasoningText,
    });
    this.emit(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: this.responseId,
      output_index: this.reasoningOutputIndex,
      item: this.reasoningOutputItem(),
    });
  }

  private doneText(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!this.textStarted || this.textDone) return;
    this.textDone = true;
    this.emit(controller, "response.output_text.done", {
      type: "response.output_text.done",
      response_id: this.responseId,
      item_id: this.outputMessageId,
      output_index: this.textOutputIndex,
      content_index: 0,
      text: this.text,
    });
    this.emit(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: this.responseId,
      output_index: this.textOutputIndex,
      item: this.textOutputItem(),
    });
  }

  private doneTool(controller: ReadableStreamDefaultController<Uint8Array>, tool: EncodedToolState) {
    if (tool.done) return;
    tool.done = true;
    this.emit(controller, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: this.responseId,
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      arguments: tool.arguments,
    });
    this.emit(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: this.responseId,
      output_index: tool.outputIndex,
      item: this.toolOutputItem(tool),
    });
  }

  private sortedTools() {
    return [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex);
  }
}
