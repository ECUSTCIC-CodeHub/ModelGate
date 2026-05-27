import { asRecord, type JsonRecord } from "@/lib/gateway/normalized-message";
import {
  toSseBlock,
  type IntermediateStreamEvent,
  type IntermediateStreamResult,
  type StreamUsage,
} from "@/lib/gateway/protocol-adapters/streaming/common";

type AnthropicSseEvent = {
  event: string;
  data: JsonRecord | string;
};

export function parseAnthropicSseEvent(event: string, data: string): AnthropicSseEvent {
  try {
    return { event, data: JSON.parse(data) as JsonRecord };
  } catch {
    return { event, data };
  }
}

export function trackAnthropicMessagesStreamEvent(eventName: string, data: string) {
  const parsed = parseAnthropicSseEvent(eventName, data);
  const payload = asRecord(parsed.data);
  if (parsed.event !== "content_block_delta") return null;
  const delta = asRecord(payload?.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return { completionText: delta.text };
  }
  if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
    return { firstToken: true };
  }
  return null;
}

export function decodeAnthropicMessagesStream(upstream: ReadableStream<Uint8Array>): IntermediateStreamResult {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completionText = "";
  let reasoningText = "";
  let firstTokenAt: number | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: string | null = null;
  const toolUseByIndex = new Map<number, { id: string; name: string }>();
  const markFirstToken = () => {
    if (firstTokenAt === null) firstTokenAt = Date.now();
  };

  const usage = (): StreamUsage => ({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  });

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
            const lines = rawEvent.split("\n");
            let eventName = "";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;

            const event = parseAnthropicSseEvent(eventName, dataLines.join("\n"));
            const payload = asRecord(event.data);

            if (event.event === "message_start") {
              const message = asRecord(payload?.message);
              const nextUsage = asRecord(message?.usage);
              promptTokens = Number(nextUsage?.input_tokens ?? 0);
              controller.enqueue({
                type: "start",
                id: typeof message?.id === "string" ? message.id : undefined,
                model: typeof message?.model === "string" ? message.model : null,
                usage: usage(),
              });
              continue;
            }

            if (event.event === "content_block_start") {
              const block = asRecord(payload?.content_block);
              const index = Number(payload?.index ?? 0);
              if (block?.type === "tool_use") {
                const id = typeof block.id === "string" ? block.id : `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
                const name = typeof block.name === "string" ? block.name : "";
                toolUseByIndex.set(index, { id, name });
                controller.enqueue({ type: "tool_call_start", index, id, name });
              }
              continue;
            }

            if (event.event === "content_block_delta") {
              const delta = asRecord(payload?.delta);
              const index = Number(payload?.index ?? 0);
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                markFirstToken();
                completionText += delta.text;
                controller.enqueue({ type: "text_delta", text: delta.text });
              } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                markFirstToken();
                reasoningText += delta.thinking;
                controller.enqueue({ type: "reasoning_delta", text: delta.thinking });
              } else if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
                controller.enqueue({ type: "reasoning_signature", signature: delta.signature });
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const tool = toolUseByIndex.get(index);
                controller.enqueue({
                  type: "tool_call_delta",
                  index,
                  id: tool?.id,
                  name: tool?.name,
                  arguments: delta.partial_json,
                });
              }
              continue;
            }

            if (event.event === "message_delta") {
              const delta = asRecord(payload?.delta);
              finishReason = typeof delta?.stop_reason === "string"
                ? (delta.stop_reason === "tool_use" ? "tool_calls" : "stop")
                : finishReason;
              const nextUsage = asRecord(payload?.usage);
              completionTokens = Number(nextUsage?.output_tokens ?? completionTokens);
              controller.enqueue({ type: "usage", usage: usage() });
              continue;
            }

            if (event.event === "message_stop") {
              controller.enqueue({ type: "finish", reason: finishReason ?? "stop" });
            }
          }
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

export function encodeAnthropicMessagesStream(events: ReadableStream<IntermediateStreamEvent>, thinkingEnabled = false) {
  const reader = events.getReader();
  const encoder = new TextEncoder();
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  let model: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let started = false;
  let finished = false;
  let nextBlockIndex = 0;
  let thinkingIndex: number | null = null;
  let textIndex: number | null = null;
  const openBlocks = new Set<number>();
  const toolBlockByIndex = new Map<number, number>();

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
            if (value.model !== undefined) model = value.model;
            if (value.usage) {
              promptTokens = value.usage.prompt_tokens;
              completionTokens = value.usage.completion_tokens;
            }
            ensureStarted(controller);
            continue;
          }

          if (value.type === "usage") {
            promptTokens = value.usage.prompt_tokens;
            completionTokens = value.usage.completion_tokens;
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
