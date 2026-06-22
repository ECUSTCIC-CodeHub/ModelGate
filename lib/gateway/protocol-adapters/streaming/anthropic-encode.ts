import type { JsonRecord } from "@/lib/gateway/normalized-message";
import type { ResponseAdapterOptions } from "@/lib/gateway/protocol-adapters/intermediate";
import {
  toSseBlock,
  type IntermediateStreamEvent,
} from "@/lib/gateway/protocol-adapters/streaming/common";

export function encodeAnthropicMessagesStream(events: ReadableStream<IntermediateStreamEvent>, options?: ResponseAdapterOptions) {
  const reader = events.getReader();
  const encoder = new TextEncoder();
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null | undefined = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let started = false;
  let finished = false;
  let nextBlockIndex = 0;
  let thinkingIndex: number | null = null;
  let textIndex: number | null = null;
  const openBlocks = new Set<number>();
  const toolBlockByIndex = new Map<number, number>();

  const thinkingEnabled = options?.thinkingEnabled ?? false;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, payload: unknown) => {
    controller.enqueue(encoder.encode(toSseBlock(event, payload)));
  };

  const ensureStarted = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (started) return;
    started = true;
    emit(controller, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: 0,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens,
        },
      },
    });
  };

  const startBlock = (controller: ReadableStreamDefaultController<Uint8Array>, contentBlock: JsonRecord) => {
    const index = nextBlockIndex;
    nextBlockIndex += 1;
    openBlocks.add(index);
    emit(controller, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: contentBlock,
    });
    return index;
  };

  const stopOpenBlocks = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const index of [...openBlocks].sort((a, b) => a - b)) {
      emit(controller, "content_block_stop", { type: "content_block_stop", index });
      openBlocks.delete(index);
    }
  };

  const emitDone = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string | null) => {
    if (finished) return;
    finished = true;
    stopOpenBlocks(controller);
    emit(controller, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: reason === "tool_calls" ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: completionTokens,
      },
    });
    emit(controller, "message_stop", { type: "message_stop" });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === "start") {
            model = options?.requestedModel ?? value.model;
            if (value.usage) {
              promptTokens = value.usage.prompt_tokens;
              completionTokens = value.usage.completion_tokens;
              cacheReadTokens = value.usage.cache_read_tokens;
              cacheCreationTokens = value.usage.cache_creation_tokens;
            }
            ensureStarted(controller);
            continue;
          }

          if (value.type === "usage") {
            promptTokens = value.usage.prompt_tokens;
            completionTokens = value.usage.completion_tokens;
            cacheReadTokens = value.usage.cache_read_tokens;
            cacheCreationTokens = value.usage.cache_creation_tokens;
            continue;
          }

          if (value.type === "reasoning_delta") {
            ensureStarted(controller);
            if (thinkingEnabled) {
              if (thinkingIndex === null) {
                thinkingIndex = startBlock(controller, { type: "thinking", thinking: "" });
              }
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: thinkingIndex,
                delta: { type: "thinking_delta", thinking: value.text },
              });
            }
            continue;
          }

          if (value.type === "reasoning_signature") {
            ensureStarted(controller);
            if (thinkingEnabled && thinkingIndex !== null) {
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index: thinkingIndex,
                delta: { type: "signature_delta", signature: value.signature },
              });
            }
            continue;
          }

          if (value.type === "text_delta") {
            ensureStarted(controller);
            if (textIndex === null) {
              textIndex = startBlock(controller, { type: "text", text: "" });
            }
            emit(controller, "content_block_delta", {
              type: "content_block_delta",
              index: textIndex,
              delta: { type: "text_delta", text: value.text },
            });
            continue;
          }

          if (value.type === "tool_call_start") {
            ensureStarted(controller);
            const index = startBlock(controller, {
              type: "tool_use",
              id: value.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
              name: value.name,
              input: {},
            });
            toolBlockByIndex.set(value.index, index);
            if (value.arguments) {
              emit(controller, "content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: value.arguments },
              });
            }
            continue;
          }

          if (value.type === "tool_call_delta") {
            ensureStarted(controller);
            const index = toolBlockByIndex.get(value.index)
              ?? startBlock(controller, {
                type: "tool_use",
                id: value.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                name: value.name ?? "",
                input: {},
              });
            toolBlockByIndex.set(value.index, index);
            emit(controller, "content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: value.arguments },
            });
            continue;
          }

          if (value.type === "finish") {
            ensureStarted(controller);
            emitDone(controller, value.reason);
          }
        }

        ensureStarted(controller);
        emitDone(controller, "stop");
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
